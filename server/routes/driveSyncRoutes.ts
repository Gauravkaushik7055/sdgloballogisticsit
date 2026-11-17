import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { type AuthRequest, requireAuth, requireRole, writeAuditLog } from '../auth.ts';
import {
  attachLocalOrDriveDatabaseFile,
  connectGoogleDriveSession,
  createCleanLiveDbSnapshotFile,
  disconnectGoogleDriveSession,
  downloadAndAttachDriveFile,
  extractDriveFolderId,
  getDriveSyncConfig,
  getDriveSyncStatusSnapshot,
  isDriveConnectedInMemory,
  listDriveFolderFiles,
  runDriveSyncCycle,
  saveDriveSyncConfig,
  startDriveAutoSyncLoop,
  stopDriveAutoSyncLoop,
  trashDriveFile,
} from '../driveSyncService.ts';
import { appendSystemLog, getConsoleLogs } from '../logCapture.ts';

const router = Router();

const dbFileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const safeExt = path.extname(file.originalname || '.db').replace(/[^a-zA-Z0-9.]/g, '') || '.db';
      cb(null, `sdglobal-upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${safeExt}`);
    },
  }),
  limits: { fileSize: 150 * 1024 * 1024, files: 1 },
});

function extractGoogleBearerToken(req: AuthRequest): string | undefined {
  const hdr = req.headers['x-google-drive-token'];
  if (typeof hdr === 'string' && hdr.trim()) {
    return hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : hdr.trim();
  }
  if (typeof req.body?.driveAccessToken === 'string' && req.body.driveAccessToken.trim()) {
    return req.body.driveAccessToken.trim();
  }
  return undefined;
}

// GET /api/auth/drive-sync/status
router.get('/drive-sync/status', requireAuth, requireRole('super_admin'), (_req, res) => {
  res.json({
    status: getDriveSyncStatusSnapshot(),
    consoleLogs: getConsoleLogs(200),
  });
});

// GET /api/auth/drive-sync/console-logs
router.get('/drive-sync/console-logs', requireAuth, requireRole('super_admin'), (req, res) => {
  const limit = Math.min(2000, Math.max(20, Number(req.query.limit) || 300));
  res.json({ logs: getConsoleLogs(limit) });
});

// PUT /api/auth/drive-sync/config
router.put('/drive-sync/config', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  try {
    const { folderUrlOrId, autoSyncEnabled, syncMode } = req.body as {
      folderUrlOrId?: string;
      autoSyncEnabled?: boolean;
      syncMode?: 'smart_1s' | 'continuous_1s';
    };

    const current = getDriveSyncConfig();
    let nextFolderId = current.folderId;
    let nextFolderUrl = current.folderUrl;
    let resetFileIds = false;

    if (typeof folderUrlOrId === 'string' && folderUrlOrId.trim()) {
      nextFolderId = extractDriveFolderId(folderUrlOrId);
      nextFolderUrl = folderUrlOrId.trim().startsWith('http')
        ? folderUrlOrId.trim()
        : `https://drive.google.com/drive/folders/${nextFolderId}`;
      if (nextFolderId !== current.folderId) {
        resetFileIds = true;
      }
    }

    const nextAuto = autoSyncEnabled !== undefined ? Boolean(autoSyncEnabled) : current.autoSyncEnabled;
    const nextMode = syncMode === 'continuous_1s' || syncMode === 'smart_1s' ? syncMode : current.syncMode;

    const updated = saveDriveSyncConfig(
      {
        folderId: nextFolderId,
        folderUrl: nextFolderUrl,
        folderName: resetFileIds ? null : current.folderName,
        driveFileIds: resetFileIds ? {} : current.driveFileIds,
        autoSyncEnabled: nextAuto,
        syncMode: nextMode,
        lastSyncStatus: !nextAuto
          ? 'Idle'
          : isDriveConnectedInMemory()
          ? 'Syncing'
          : 'Waiting Google Sign-In',
      },
      req.user!.id
    );

    if (updated.autoSyncEnabled && isDriveConnectedInMemory()) {
      startDriveAutoSyncLoop();
    } else if (!updated.autoSyncEnabled) {
      stopDriveAutoSyncLoop();
    }

    writeAuditLog({
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      action: 'UPDATE_DRIVE_SYNC_CONFIG',
      entityType: 'google_drive',
      entityId: updated.folderId,
      details: {
        folderId: updated.folderId,
        autoSyncEnabled: updated.autoSyncEnabled,
        syncMode: updated.syncMode,
      },
      ipAddress: req.ip,
    });

    appendSystemLog(
      'SYNC',
      'google-drive',
      `Drive sync config updated (folder=${updated.folderId}, autoSync=${updated.autoSyncEnabled}, mode=${updated.syncMode}).`
    );

    res.json({ status: getDriveSyncStatusSnapshot() });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Invalid Google Drive configuration' });
  }
});

// POST /api/auth/drive-sync/connect
router.post('/drive-sync/connect', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  const token = extractGoogleBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Google Drive OAuth access token is required in X-Google-Drive-Token header.' });
  }

  try {
    const folderInput = typeof req.body?.folderUrlOrId === 'string' ? req.body.folderUrlOrId : undefined;
    const result = await connectGoogleDriveSession({
      accessToken: token,
      folderId: folderInput,
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to connect Google Drive folder' });
  }
});

// POST /api/auth/drive-sync/disconnect
router.post('/drive-sync/disconnect', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const status = disconnectGoogleDriveSession({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
  });
  res.json({ ok: true, status });
});

// POST /api/auth/drive-sync/sync-now
router.post('/drive-sync/sync-now', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  const freshToken = extractGoogleBearerToken(req);
  try {
    if (freshToken && !isDriveConnectedInMemory()) {
      await connectGoogleDriveSession({
        accessToken: freshToken,
        userId: req.user!.id,
        userEmail: req.user!.email,
        roleName: req.user!.role,
      });
    }
    const result = await runDriveSyncCycle({
      force: true,
      accessToken: freshToken,
    });
    appendSystemLog('SYNC', 'google-drive', `Manual Drive sync completed by ${req.user!.email}.`);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Google Drive sync failed' });
  }
});

// GET /api/auth/drive-sync/files
router.get('/drive-sync/files', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  const token = extractGoogleBearerToken(req);
  try {
    const files = await listDriveFolderFiles(token);
    res.json({ files });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Unable to list files in Google Drive folder' });
  }
});

// POST /api/auth/drive-sync/restore-file
router.post('/drive-sync/restore-file', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  const { fileId, filename, confirm } = req.body as {
    fileId?: string;
    filename?: string;
    confirm?: string;
  };
  if (confirm !== 'CONFIRM_ATTACH_DATABASE') {
    return res.status(400).json({ error: 'Explicit confirmation CONFIRM_ATTACH_DATABASE is required.' });
  }
  if (!fileId || !filename) {
    return res.status(400).json({ error: 'fileId and filename are required.' });
  }

  try {
    const result = await downloadAndAttachDriveFile(fileId, filename, req.user!, req.ip);
    res.cookie('logicore_token', result.refreshedToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({
      ok: true,
      token: result.refreshedToken,
      attachedInfo: result.attachedInfo,
      preRestoreFilename: result.preRestoreFilename,
      status: result.status,
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to restore database from Google Drive' });
  }
});

// DELETE /api/auth/drive-sync/files/:fileId
router.delete('/drive-sync/files/:fileId', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  const { confirm } = (req.body || {}) as { confirm?: string };
  if (confirm !== 'CONFIRM_DRIVE_DELETE') {
    return res.status(400).json({ error: 'Explicit confirmation CONFIRM_DRIVE_DELETE is required.' });
  }
  const token = extractGoogleBearerToken(req);
  try {
    await trashDriveFile(req.params.fileId, token);
    writeAuditLog({
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      action: 'TRASH_DRIVE_FILE',
      entityType: 'google_drive',
      entityId: req.params.fileId,
      ipAddress: req.ip,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to delete Drive file' });
  }
});

// POST /api/auth/database/attach-local
router.post(
  '/database/attach-local',
  requireAuth,
  requireRole('super_admin'),
  dbFileUpload.single('database'),
  async (req: AuthRequest, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Please select a .db / .sqlite database file from your computer.' });
    }

    const confirm = req.body?.confirm;
    if (confirm !== 'CONFIRM_ATTACH_DATABASE') {
      try {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      } catch {}
      return res.status(400).json({ error: 'Explicit confirmation CONFIRM_ATTACH_DATABASE is required.' });
    }

    const sourceType = req.body?.sourceType === 'laptop_handle' ? 'laptop_handle' : 'laptop_upload';
    const localPathHint = typeof req.body?.localPathHint === 'string' ? req.body.localPathHint.slice(0, 240) : undefined;

    try {
      const result = await attachLocalOrDriveDatabaseFile({
        sourceFilePath: file.path,
        originalFilename: file.originalname || 'laptop_it_crm.db',
        sourceType,
        actorUser: req.user!,
        localPathHint,
        ipAddress: req.ip,
      });

      res.cookie('logicore_token', result.refreshedToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 12 * 60 * 60 * 1000,
      });

      res.json({
        ok: true,
        token: result.refreshedToken,
        attachedInfo: result.attachedInfo,
        preRestoreFilename: result.preRestoreFilename,
        status: result.status,
      });
    } catch (err: any) {
      res.status(400).json({ error: err?.message || 'Failed to attach laptop database file' });
    } finally {
      try {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      } catch {
        // ignore temp file cleanup
      }
    }
  }
);

// GET /api/auth/database/download-live
router.get('/database/download-live', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  let snap: { tmpPath: string; filename: string; sha256: string; sizeBytes: number } | null = null;
  try {
    snap = await createCleanLiveDbSnapshotFile();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${snap.filename}"`);
    res.setHeader('X-Database-Sha256', snap.sha256);

    const stream = fs.createReadStream(snap.tmpPath);
    stream.on('close', () => {
      try {
        if (snap && fs.existsSync(snap.tmpPath)) fs.unlinkSync(snap.tmpPath);
      } catch {
        // ignore cleanup error
      }
    });
    stream.pipe(res);
  } catch (err: any) {
    if (snap && fs.existsSync(snap.tmpPath)) {
      try {
        fs.unlinkSync(snap.tmpPath);
      } catch {}
    }
    res.status(500).json({ error: err?.message || 'Failed to export live database file' });
  }
});

export default router;
