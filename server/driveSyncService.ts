import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  BACKUP_ROOT,
  DB_PATH,
  db,
  initializeDatabase,
  restoreDatabaseFromFile,
  syncDepartmentDropdownOptions,
} from './db.ts';
import { type AuthUser, signToken, writeAuditLog } from './auth.ts';
import { sendToSuperAdmins } from './realtime.ts';
import { seedDatabaseIfEmpty } from './seed.ts';
import { appendSystemLog, getConsoleLogText, getConsoleLogVersion, getConsoleLogs } from './logCapture.ts';

export const DEFAULT_DRIVE_FOLDER_ID = '1OlM-Weze7_FAu7C8tU7pidbN0AcMAM6N';
export const DEFAULT_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/1OlM-Weze7_FAu7C8tU7pidbN0AcMAM6N?usp=drive_link';

export type DriveSyncMode = 'smart_1s' | 'continuous_1s';

export interface AttachedLaptopDbInfo {
  filename: string;
  sizeBytes: number;
  sha256: string;
  attachedAt: string;
  attachedBy: string;
  source: 'laptop_upload' | 'laptop_handle' | 'drive_restore';
  localPathHint?: string;
}

export interface DriveSyncConfig {
  folderId: string;
  folderUrl: string;
  folderName: string | null;
  autoSyncEnabled: boolean;
  syncIntervalMs: number;
  syncMode: DriveSyncMode;
  attachedLaptopDb: AttachedLaptopDbInfo | null;
  driveFileIds: {
    liveDb?: string;
    fullExportJson?: string;
    auditLogsJson?: string;
    consoleLogs?: string;
    manifestJson?: string;
  };
  connectedGoogleEmail: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: 'Idle' | 'Syncing' | 'Synced' | 'Waiting Google Sign-In' | 'Error';
  lastSyncError: string | null;
  lastSyncDurationMs: number;
  lastDbDigest: string | null;
  lastLogVersion: number;
  totalSyncCount: number;
}

export interface DriveRemoteFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

// Volatile in-memory OAuth access token (never persisted to SQLite, disk, or localStorage)
let activeDriveAccessToken: string | null = null;
let syncLoopTimer: ReturnType<typeof setInterval> | null = null;
let syncInFlight = false;
let backoffUntilMs = 0;
let lastKnownFingerprint = '';
let lastHeartbeatBroadcastAt = 0;

export function extractDriveFolderId(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return DEFAULT_DRIVE_FOLDER_ID;
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch?.[1]) return folderMatch[1];
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParamMatch?.[1]) return idParamMatch[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  throw new Error('Invalid Google Drive folder URL or folder ID.');
}

function getDefaultConfig(): DriveSyncConfig {
  return {
    folderId: DEFAULT_DRIVE_FOLDER_ID,
    folderUrl: DEFAULT_DRIVE_FOLDER_URL,
    folderName: null,
    autoSyncEnabled: true,
    syncIntervalMs: 1000,
    syncMode: 'smart_1s',
    attachedLaptopDb: null,
    driveFileIds: {},
    connectedGoogleEmail: null,
    lastSyncAt: null,
    lastSyncStatus: 'Waiting Google Sign-In',
    lastSyncError: null,
    lastSyncDurationMs: 0,
    lastDbDigest: null,
    lastLogVersion: 0,
    totalSyncCount: 0,
  };
}

export function getDriveSyncConfig(): DriveSyncConfig {
  const defaults = getDefaultConfig();
  try {
    const row = db
      .prepare("SELECT value_json FROM integration_settings WHERE key = 'google_drive_sync'")
      .get() as { value_json: string } | undefined;
    if (!row?.value_json) return defaults;
    const parsed = JSON.parse(row.value_json);
    return {
      ...defaults,
      ...parsed,
      folderId: parsed.folderId || DEFAULT_DRIVE_FOLDER_ID,
      folderUrl: parsed.folderUrl || DEFAULT_DRIVE_FOLDER_URL,
      syncIntervalMs: 1000,
      driveFileIds: { ...(parsed.driveFileIds || {}) },
    };
  } catch {
    return defaults;
  }
}

export function saveDriveSyncConfig(next: Partial<DriveSyncConfig>, updatedByUserId?: number | null): DriveSyncConfig {
  const current = getDriveSyncConfig();
  const merged: DriveSyncConfig = {
    ...current,
    ...next,
    driveFileIds: {
      ...current.driveFileIds,
      ...(next.driveFileIds || {}),
    },
    syncIntervalMs: 1000,
  };
  db.prepare(
    `INSERT INTO integration_settings (key, value_json, updated_by, updated_at)
     VALUES ('google_drive_sync', ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_by = COALESCE(excluded.updated_by, integration_settings.updated_by),
       updated_at = datetime('now')`
  ).run(JSON.stringify(merged), updatedByUserId ?? null);
  return merged;
}

export function isDriveConnectedInMemory(): boolean {
  return Boolean(activeDriveAccessToken);
}

export function getDriveSyncStatusSnapshot() {
  const cfg = getDriveSyncConfig();
  const dbStat = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
  const walPath = `${DB_PATH}-wal`;
  const walStat = fs.existsSync(walPath) ? fs.statSync(walPath) : null;

  const tableCounts: Record<string, number> = {};
  const trackedTables = [
    'users',
    'employees',
    'moderators',
    'tickets',
    'ticket_activities',
    'ticket_comments',
    'direct_messages',
    'it_assets',
    'asset_history',
    'it_budgets',
    'expenses',
    'audit_logs',
    'login_sessions',
    'crm_backups',
    'saved_reports',
  ];
  for (const tbl of trackedTables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get() as { c: number } | undefined;
      tableCounts[tbl] = Number(row?.c || 0);
    } catch {
      tableCounts[tbl] = 0;
    }
  }

  return {
    ...cfg,
    tokenActive: Boolean(activeDriveAccessToken),
    workerRunning: Boolean(syncLoopTimer),
    syncInFlight,
    dbFilePath: 'data/it_crm.db',
    dbFileSizeBytes: (dbStat?.size || 0) + (walStat?.size || 0),
    dbModifiedAt: dbStat?.mtime ? dbStat.mtime.toISOString() : null,
    consoleLogLines: getConsoleLogVersion(),
    tableCounts,
  };
}

function broadcastDriveStatus() {
  try {
    sendToSuperAdmins('drive:sync-status', getDriveSyncStatusSnapshot());
  } catch {
    // ignore ws broadcast error
  }
}

export async function verifyGoogleDriveTokenAndFolder(accessToken: string, folderId: string) {
  const aboutRes = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!aboutRes.ok) {
    const errText = await aboutRes.text().catch(() => '');
    if (aboutRes.status === 401) {
      throw new Error('Google Drive authorization expired or invalid. Please sign in with Google again.');
    }
    throw new Error(`Google Drive authentication check failed (${aboutRes.status}): ${errText.slice(0, 200)}`);
  }
  const aboutData = (await aboutRes.json()) as { user?: { emailAddress?: string; displayName?: string } };

  const folderRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed,webViewLink&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!folderRes.ok) {
    const errBody = await folderRes.text().catch(() => '');
    if (folderRes.status === 404) {
      throw new Error(
        `Google Drive folder (${folderId}) was not found or is not accessible to ${aboutData.user?.emailAddress || 'this Google account'}.`
      );
    }
    throw new Error(`Unable to access target Google Drive folder (${folderRes.status}): ${errBody.slice(0, 200)}`);
  }
  const folderData = (await folderRes.json()) as {
    id: string;
    name: string;
    mimeType: string;
    trashed?: boolean;
    webViewLink?: string;
  };
  if (folderData.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error(`Target Drive ID (${folderId}) is not a folder.`);
  }
  if (folderData.trashed) {
    throw new Error(`Target Drive folder "${folderData.name}" is in Trash.`);
  }

  return {
    googleEmail: aboutData.user?.emailAddress || null,
    googleName: aboutData.user?.displayName || null,
    folderId: folderData.id,
    folderName: folderData.name,
    folderUrl: folderData.webViewLink || `https://drive.google.com/drive/folders/${folderData.id}`,
  };
}

export async function connectGoogleDriveSession(params: {
  accessToken: string;
  folderId?: string;
  userId?: number;
  userEmail?: string;
  roleName?: string;
}) {
  const cfg = getDriveSyncConfig();
  const targetFolderId = params.folderId ? extractDriveFolderId(params.folderId) : cfg.folderId;
  const verified = await verifyGoogleDriveTokenAndFolder(params.accessToken, targetFolderId);

  activeDriveAccessToken = params.accessToken;
  backoffUntilMs = 0;

  const updated = saveDriveSyncConfig(
    {
      folderId: verified.folderId,
      folderUrl: verified.folderUrl,
      folderName: verified.folderName,
      connectedGoogleEmail: verified.googleEmail,
      lastSyncStatus: cfg.autoSyncEnabled ? 'Syncing' : 'Idle',
      lastSyncError: null,
      driveFileIds: verified.folderId !== cfg.folderId ? {} : cfg.driveFileIds,
    },
    params.userId ?? null
  );

  appendSystemLog(
    'SYNC',
    'google-drive',
    `Connected Google Drive folder "${verified.folderName}" (${verified.folderId}) as ${verified.googleEmail || 'Google User'}.`
  );

  if (params.userId) {
    writeAuditLog({
      userId: params.userId,
      userEmail: params.userEmail,
      roleName: params.roleName,
      action: 'CONNECT_GOOGLE_DRIVE_SYNC',
      entityType: 'google_drive',
      entityId: verified.folderId,
      details: {
        folderName: verified.folderName,
        googleEmail: verified.googleEmail,
        autoSyncEnabled: updated.autoSyncEnabled,
      },
    });
  }

  startDriveAutoSyncLoop();

  // Trigger an immediate sync right after connecting if autosync is enabled
  if (updated.autoSyncEnabled) {
    runDriveSyncCycle({ force: true, accessToken: params.accessToken }).catch((err) => {
      appendSystemLog('ERROR', 'google-drive', `Initial sync error: ${err?.message || err}`);
    });
  } else {
    broadcastDriveStatus();
  }

  return { verified, status: getDriveSyncStatusSnapshot() };
}

export function disconnectGoogleDriveSession(actor?: { userId?: number; userEmail?: string; roleName?: string }) {
  activeDriveAccessToken = null;
  backoffUntilMs = 0;
  stopDriveAutoSyncLoop();

  saveDriveSyncConfig(
    {
      lastSyncStatus: 'Waiting Google Sign-In',
      lastSyncError: null,
    },
    actor?.userId ?? null
  );

  appendSystemLog('SYNC', 'google-drive', 'Disconnected Google Drive session and stopped live sync worker.');

  if (actor?.userId) {
    writeAuditLog({
      userId: actor.userId,
      userEmail: actor.userEmail,
      roleName: actor.roleName,
      action: 'DISCONNECT_GOOGLE_DRIVE_SYNC',
      entityType: 'google_drive',
      entityId: getDriveSyncConfig().folderId,
    });
  }

  broadcastDriveStatus();
  return getDriveSyncStatusSnapshot();
}

function buildMultipartBody(metadata: Record<string, any>, contentType: string, contentBuffer: Buffer) {
  const boundary = `sdglobal_drive_${crypto.randomBytes(12).toString('hex')}`;
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
      metadata
    )}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  return {
    boundary,
    body: Buffer.concat([preamble, contentBuffer, epilogue]),
  };
}

async function findDriveFileByName(accessToken: string, folderId: string, name: string): Promise<string | null> {
  const safeName = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`'${folderId}' in parents and name = '${safeName}' and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return data.files?.[0]?.id || null;
}

async function uploadOrUpdateDriveFile(params: {
  accessToken: string;
  folderId: string;
  existingFileId?: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}): Promise<DriveRemoteFile> {
  let targetId = params.existingFileId;
  if (!targetId) {
    targetId = (await findDriveFileByName(params.accessToken, params.folderId, params.filename)) || undefined;
  }

  const doUpload = async (fileId?: string) => {
    const metadata = fileId
      ? { name: params.filename, mimeType: params.mimeType }
      : { name: params.filename, mimeType: params.mimeType, parents: [params.folderId] };
    const { boundary, body } = buildMultipartBody(metadata, params.mimeType, params.content);
    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(
          fileId
        )}?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,webViewLink&supportsAllDrives=true`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,webViewLink&supportsAllDrives=true`;

    const res = await fetch(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    return res;
  };

  let res = await doUpload(targetId);
  if (res.status === 404 && targetId) {
    // Cached file ID no longer exists -> create fresh file in target folder
    res = await doUpload(undefined);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err: any = new Error(`Drive upload failed for ${params.filename} (${res.status}): ${errText.slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }

  return (await res.json()) as DriveRemoteFile;
}

function computeDatabaseFingerprint(): { fingerprint: string; dbPart: string; logVersion: number } {
  let dataVersion = 0;
  try {
    dataVersion = Number(db.pragma('data_version', { simple: true }) || 0);
  } catch {
    dataVersion = 0;
  }
  const dbStat = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
  const walPath = `${DB_PATH}-wal`;
  const walStat = fs.existsSync(walPath) ? fs.statSync(walPath) : null;

  let totalRowsSig = '';
  try {
    const sig = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM tickets) as t,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM audit_logs) as al,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM direct_messages) as dm,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM ticket_activities) as ta,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM it_assets) as ast,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM asset_history) as ah,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM expenses) as ex,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM users) as us,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM login_sessions) as ls,
          (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM crm_backups) as bk`
      )
      .get() as Record<string, string>;
    totalRowsSig = Object.values(sig || {}).join('|');
  } catch {
    totalRowsSig = String(Date.now());
  }

  const dbPart = `${dataVersion}:${dbStat?.mtimeMs || 0}:${dbStat?.size || 0}:${walStat?.mtimeMs || 0}:${
    walStat?.size || 0
  }:${totalRowsSig}`;
  const logVersion = getConsoleLogVersion();
  return {
    fingerprint: `${dbPart}::LOG=${logVersion}`,
    dbPart,
    logVersion,
  };
}

function exportAllDatabaseTables(): { tables: Record<string, any[]>; tableCounts: Record<string, number> } {
  const tableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
    .all() as Array<{ name: string }>;

  const tables: Record<string, any[]> = {};
  const tableCounts: Record<string, number> = {};
  for (const { name } of tableRows) {
    try {
      const safeName = name.replace(/"/g, '""');
      const rows = db.prepare(`SELECT * FROM "${safeName}"`).all();
      tables[name] = rows;
      tableCounts[name] = rows.length;
    } catch {
      tables[name] = [];
      tableCounts[name] = 0;
    }
  }
  return { tables, tableCounts };
}

export async function runDriveSyncCycle(options?: {
  force?: boolean;
  accessToken?: string;
  onlyIfChanged?: boolean;
}): Promise<{ synced: boolean; skipped?: boolean; reason?: string; status: any }> {
  const token = options?.accessToken || activeDriveAccessToken;
  if (!token) {
    return { synced: false, skipped: true, reason: 'No active Google Drive session token', status: getDriveSyncStatusSnapshot() };
  }
  if (syncInFlight) {
    return { synced: false, skipped: true, reason: 'Sync already in progress', status: getDriveSyncStatusSnapshot() };
  }
  if (!options?.force && Date.now() < backoffUntilMs) {
    return { synced: false, skipped: true, reason: 'Rate-limit backoff active', status: getDriveSyncStatusSnapshot() };
  }

  const cfg = getDriveSyncConfig();
  const fp = computeDatabaseFingerprint();

  const dbChanged = options?.force || fp.dbPart !== cfg.lastDbDigest;
  const logsChanged = options?.force || fp.logVersion !== cfg.lastLogVersion;

  if (options?.onlyIfChanged && !dbChanged && !logsChanged && cfg.syncMode !== 'continuous_1s') {
    return { synced: false, skipped: true, reason: 'No DB or log changes since last 1s check', status: getDriveSyncStatusSnapshot() };
  }

  // If continuous_1s is selected and nothing changed in DB/logs, we still update the live console & manifest every second
  syncInFlight = true;
  const startMs = Date.now();
  const tmpSnapPath = path.join(
    os.tmpdir(),
    `sdglobal-drive-sync-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.db`
  );

  try {
    const nextFileIds = { ...cfg.driveFileIds };
    let dbSha256 = '';
    let dbBytes = 0;
    let integrity = 'ok';
    let tableCounts: Record<string, number> = {};

    if (dbChanged) {
      try {
        db.pragma('wal_checkpoint(PASSIVE)');
      } catch {
        // ignore if WAL checkpoint unavailable
      }
      await db.backup(tmpSnapPath);
      const dbBuffer = fs.readFileSync(tmpSnapPath);
      dbBytes = dbBuffer.length;
      dbSha256 = crypto.createHash('sha256').update(dbBuffer).digest('hex');

      const verifyDb = new Database(tmpSnapPath, { readonly: true });
      try {
        integrity = String(verifyDb.pragma('integrity_check', { simple: true }) || 'ok');
      } finally {
        verifyDb.close();
      }

      const liveDbFile = await uploadOrUpdateDriveFile({
        accessToken: token,
        folderId: cfg.folderId,
        existingFileId: nextFileIds.liveDb,
        filename: 'it_crm_live.db',
        mimeType: 'application/x-sqlite3',
        content: dbBuffer,
      });
      nextFileIds.liveDb = liveDbFile.id;

      const exported = exportAllDatabaseTables();
      tableCounts = exported.tableCounts;

      const fullExportPayload = {
        exportedAt: new Date().toISOString(),
        system: 'SD Global IT Service CRM',
        folderId: cfg.folderId,
        dbSha256,
        dbSizeBytes: dbBytes,
        integrityCheck: integrity,
        attachedLaptopDb: cfg.attachedLaptopDb,
        tableCounts,
        tables: exported.tables,
      };

      const fullExportFile = await uploadOrUpdateDriveFile({
        accessToken: token,
        folderId: cfg.folderId,
        existingFileId: nextFileIds.fullExportJson,
        filename: 'crm_full_database_export.json',
        mimeType: 'application/json',
        content: Buffer.from(JSON.stringify(fullExportPayload, null, 2), 'utf8'),
      });
      nextFileIds.fullExportJson = fullExportFile.id;

      const logsBundle = {
        syncedAt: new Date().toISOString(),
        audit_logs: exported.tables.audit_logs || [],
        ticket_activities: exported.tables.ticket_activities || [],
        asset_history: exported.tables.asset_history || [],
        login_sessions: exported.tables.login_sessions || [],
        email_communications: exported.tables.email_communications || [],
        whatsapp_communications: exported.tables.whatsapp_communications || [],
        crm_backups: exported.tables.crm_backups || [],
        console_logs_tail: getConsoleLogs(500),
      };

      const auditLogsFile = await uploadOrUpdateDriveFile({
        accessToken: token,
        folderId: cfg.folderId,
        existingFileId: nextFileIds.auditLogsJson,
        filename: 'crm_audit_and_activity_logs.json',
        mimeType: 'application/json',
        content: Buffer.from(JSON.stringify(logsBundle, null, 2), 'utf8'),
      });
      nextFileIds.auditLogsJson = auditLogsFile.id;
    }

    if (dbChanged || logsChanged || cfg.syncMode === 'continuous_1s') {
      const consoleLogText = getConsoleLogText(2000) || `[${new Date().toISOString()}] [INFO] No console entries yet.`;
      const consoleLogFile = await uploadOrUpdateDriveFile({
        accessToken: token,
        folderId: cfg.folderId,
        existingFileId: nextFileIds.consoleLogs,
        filename: 'server_console_logs.log',
        mimeType: 'text/plain',
        content: Buffer.from(consoleLogText, 'utf8'),
      });
      nextFileIds.consoleLogs = consoleLogFile.id;

      if (!Object.keys(tableCounts).length) {
        const snap = getDriveSyncStatusSnapshot();
        tableCounts = snap.tableCounts;
        dbBytes = snap.dbFileSizeBytes;
      }

      const manifestPayload = {
        syncedAt: new Date().toISOString(),
        syncCount: cfg.totalSyncCount + 1,
        syncMode: cfg.syncMode,
        syncIntervalMs: cfg.syncIntervalMs,
        folderId: cfg.folderId,
        folderUrl: cfg.folderUrl,
        folderName: cfg.folderName,
        connectedGoogleEmail: cfg.connectedGoogleEmail,
        dbPath: 'data/it_crm.db',
        dbSizeBytes: dbBytes,
        dbSha256: dbSha256 || undefined,
        integrityCheck: integrity,
        attachedLaptopDb: cfg.attachedLaptopDb,
        consoleLogLines: fp.logVersion,
        tableCounts,
        driveFileIds: nextFileIds,
      };

      const manifestFile = await uploadOrUpdateDriveFile({
        accessToken: token,
        folderId: cfg.folderId,
        existingFileId: nextFileIds.manifestJson,
        filename: 'database_sync_manifest.json',
        mimeType: 'application/json',
        content: Buffer.from(JSON.stringify(manifestPayload, null, 2), 'utf8'),
      });
      nextFileIds.manifestJson = manifestFile.id;
    }

    const nowIso = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    lastKnownFingerprint = fp.fingerprint;

    saveDriveSyncConfig({
      driveFileIds: nextFileIds,
      lastSyncAt: nowIso,
      lastSyncStatus: 'Synced',
      lastSyncError: null,
      lastSyncDurationMs: durationMs,
      lastDbDigest: fp.dbPart,
      lastLogVersion: fp.logVersion,
      totalSyncCount: cfg.totalSyncCount + 1,
    });

    if (dbChanged || Date.now() - lastHeartbeatBroadcastAt >= 2000) {
      lastHeartbeatBroadcastAt = Date.now();
      broadcastDriveStatus();
    }

    return { synced: true, status: getDriveSyncStatusSnapshot() };
  } catch (err: any) {
    const status = err?.status;
    const message = err?.message || 'Google Drive sync failed';

    if (status === 401) {
      activeDriveAccessToken = null;
      saveDriveSyncConfig({
        lastSyncStatus: 'Waiting Google Sign-In',
        lastSyncError: 'Google Drive session token expired. Please click "Sign in with Google" to resume auto-sync.',
      });
      appendSystemLog('WARN', 'google-drive', 'Google Drive OAuth token expired (401). Waiting for re-authentication.');
      broadcastDriveStatus();
    } else if (status === 429 || status === 403) {
      backoffUntilMs = Date.now() + 5000;
      saveDriveSyncConfig({
        lastSyncStatus: 'Error',
        lastSyncError: `Drive rate/permission response (${status}): ${message}`,
      });
      appendSystemLog('WARN', 'google-drive', `Drive backoff 5s due to ${status}: ${message}`);
      broadcastDriveStatus();
    } else {
      saveDriveSyncConfig({
        lastSyncStatus: 'Error',
        lastSyncError: message,
      });
      appendSystemLog('ERROR', 'google-drive', message);
      broadcastDriveStatus();
    }
    throw err;
  } finally {
    syncInFlight = false;
    try {
      if (fs.existsSync(tmpSnapPath)) fs.unlinkSync(tmpSnapPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

export function startDriveAutoSyncLoop() {
  if (syncLoopTimer) return;
  syncLoopTimer = setInterval(() => {
    const cfg = getDriveSyncConfig();
    if (!cfg.autoSyncEnabled || !activeDriveAccessToken) return;
    if (syncInFlight || Date.now() < backoffUntilMs) return;

    const fp = computeDatabaseFingerprint();
    const hasChanges = fp.fingerprint !== lastKnownFingerprint || fp.dbPart !== cfg.lastDbDigest || fp.logVersion !== cfg.lastLogVersion;
    if (!hasChanges && cfg.syncMode !== 'continuous_1s') {
      return;
    }

    runDriveSyncCycle({ onlyIfChanged: cfg.syncMode !== 'continuous_1s' }).catch(() => {
      // error already recorded & logged inside runDriveSyncCycle
    });
  }, 1000);
}

export function stopDriveAutoSyncLoop() {
  if (syncLoopTimer) {
    clearInterval(syncLoopTimer);
    syncLoopTimer = null;
  }
}

export async function listDriveFolderFiles(accessToken?: string): Promise<DriveRemoteFile[]> {
  const token = accessToken || activeDriveAccessToken;
  if (!token) {
    throw new Error('Sign in with Google Drive first to browse files in your target folder.');
  }
  const cfg = getDriveSyncConfig();
  const q = encodeURIComponent(`'${cfg.folderId}' in parents and trashed = false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=100&fields=files(id,name,mimeType,size,modifiedTime,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Unable to list Google Drive folder files (${res.status}): ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { files?: DriveRemoteFile[] };
  return data.files || [];
}

export async function trashDriveFile(fileId: string, accessToken?: string) {
  const token = accessToken || activeDriveAccessToken;
  if (!token) throw new Error('Google Drive authorization required.');

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to move Drive file to trash (${res.status}): ${errText.slice(0, 200)}`);
  }
  appendSystemLog('SYNC', 'google-drive', `Moved Google Drive file ${fileId} to Trash by Super Admin request.`);
  return { ok: true };
}

export async function uploadVersionedBackupToDrive(backupFilePath: string, filename: string) {
  if (!activeDriveAccessToken || !fs.existsSync(backupFilePath)) return null;
  const cfg = getDriveSyncConfig();
  if (!cfg.autoSyncEnabled) return null;

  try {
    const content = fs.readFileSync(backupFilePath);
    const uploaded = await uploadOrUpdateDriveFile({
      accessToken: activeDriveAccessToken,
      folderId: cfg.folderId,
      filename,
      mimeType: 'application/x-sqlite3',
      content,
    });
    appendSystemLog('SYNC', 'google-drive', `Uploaded versioned backup "${filename}" to Google Drive (${uploaded.id}).`);
    return uploaded;
  } catch (err: any) {
    appendSystemLog('WARN', 'google-drive', `Versioned backup upload skipped/failed: ${err?.message || err}`);
    return null;
  }
}

function ensureAdminSessionSurvivesDbSwap(actorUser: AuthUser): { refreshedToken: string } {
  seedDatabaseIfEmpty();
  syncDepartmentDropdownOptions();

  const superAdminRole = db.prepare("SELECT id, label FROM roles WHERE name = 'super_admin'").get() as
    | { id: number; label: string }
    | undefined;
  if (!superAdminRole) {
    throw new Error('Database schema error: super_admin role missing after initialization.');
  }

  let targetUser = db
    .prepare(
      `SELECT u.id, u.email, u.full_name, u.status, r.name as role, r.label as role_label
       FROM users u JOIN roles r ON u.role_id = r.id
       WHERE lower(u.email) = lower(?) AND r.name = 'super_admin'
       LIMIT 1`
    )
    .get(actorUser.email) as any;

  if (!targetUser) {
    targetUser = db
      .prepare(
        `SELECT u.id, u.email, u.full_name, u.status, r.name as role, r.label as role_label
         FROM users u JOIN roles r ON u.role_id = r.id
         WHERE r.name = 'super_admin' AND u.status = 'Active'
         ORDER BY u.id ASC LIMIT 1`
      )
      .get() as any;
  }

  if (!targetUser) {
    throw new Error('Attached database has no active Super Admin account.');
  }

  const nowIso = new Date().toISOString();
  const sessRes = db
    .prepare(
      `INSERT INTO login_sessions (user_id, role_name, login_at, last_activity_at, ip_address, user_agent, is_active)
       VALUES (?, 'super_admin', ?, ?, '127.0.0.1', 'Attached DB Session Continuity', 1)`
    )
    .run(targetUser.id, nowIso, nowIso);
  const newSessionId = Number(sessRes.lastInsertRowid);

  const refreshedToken = signToken({
    id: targetUser.id,
    email: targetUser.email,
    full_name: targetUser.full_name,
    role: 'super_admin',
    role_label: targetUser.role_label || 'Super Admin',
    session_id: newSessionId,
    employee_id: null,
    moderator_id: null,
  });

  return { refreshedToken };
}

export async function attachLocalOrDriveDatabaseFile(params: {
  sourceFilePath: string;
  originalFilename: string;
  sourceType: 'laptop_upload' | 'laptop_handle' | 'drive_restore';
  actorUser: AuthUser;
  localPathHint?: string;
  ipAddress?: string;
}) {
  if (!fs.existsSync(params.sourceFilePath)) {
    throw new Error('Uploaded or downloaded database file not found on server.');
  }

  const stat = fs.statSync(params.sourceFilePath);
  if (stat.size < 100) {
    throw new Error('File is too small to be a valid SQLite database.');
  }

  const fd = fs.openSync(params.sourceFilePath, 'r');
  const headerBuf = Buffer.alloc(16);
  fs.readSync(fd, headerBuf, 0, 16, 0);
  fs.closeSync(fd);
  if (!headerBuf.toString('utf8', 0, 15).startsWith('SQLite format 3')) {
    throw new Error('Invalid file format: selected file is not a valid SQLite 3 database (.db / .sqlite).');
  }

  const fileBuf = fs.readFileSync(params.sourceFilePath);
  const sha256 = crypto.createHash('sha256').update(fileBuf).digest('hex');

  // Preserve current Drive sync config settings so folderId & autosync stay active across DB attachment
  const prevDriveCfg = getDriveSyncConfig();

  const { preRestoreFilename, preRestorePath } = await restoreDatabaseFromFile(params.sourceFilePath);
  const { refreshedToken } = ensureAdminSessionSurvivesDbSwap(params.actorUser);

  const nowIso = new Date().toISOString();
  const attachedInfo: AttachedLaptopDbInfo = {
    filename: params.originalFilename,
    sizeBytes: stat.size,
    sha256,
    attachedAt: nowIso,
    attachedBy: params.actorUser.email,
    source: params.sourceType,
    localPathHint: params.localPathHint,
  };

  // Preserve Drive folder config & enable autoSync in the newly attached database
  saveDriveSyncConfig(
    {
      folderId: prevDriveCfg.folderId || DEFAULT_DRIVE_FOLDER_ID,
      folderUrl: prevDriveCfg.folderUrl || DEFAULT_DRIVE_FOLDER_URL,
      folderName: prevDriveCfg.folderName,
      autoSyncEnabled: true,
      syncMode: prevDriveCfg.syncMode || 'smart_1s',
      connectedGoogleEmail: prevDriveCfg.connectedGoogleEmail,
      driveFileIds: prevDriveCfg.driveFileIds,
      attachedLaptopDb: attachedInfo,
      lastDbDigest: null,
    },
    params.actorUser.id
  );

  // Also record safety snapshot in crm_backups table of the newly attached DB
  try {
    const safetyBuf = fs.readFileSync(preRestorePath);
    const safetySha = crypto.createHash('sha256').update(safetyBuf).digest('hex');
    db.prepare(
      `INSERT OR IGNORE INTO crm_backups (
        filename, storage_path, backup_type, status, file_size_bytes, checksum_sha256,
        integrity_status, last_verified_at, record_counts_json, email_status,
        retry_count, triggered_by_user_id, created_at
      ) VALUES (?, ?, 'pre_restore', 'Completed', ?, ?, 'Verified', ?, '{}', 'Pre-Attach Safety Snapshot', 0, ?, ?)`
    ).run(preRestoreFilename, preRestorePath, safetyBuf.length, safetySha, nowIso, params.actorUser.id, nowIso);
  } catch {
    // ignore backup metadata error
  }

  writeAuditLog({
    userId: params.actorUser.id,
    userEmail: params.actorUser.email,
    roleName: params.actorUser.role,
    action: params.sourceType === 'drive_restore' ? 'ATTACH_DRIVE_DATABASE' : 'ATTACH_LAPTOP_DATABASE',
    entityType: 'database',
    entityId: params.originalFilename,
    details: {
      filename: params.originalFilename,
      sizeBytes: stat.size,
      sha256,
      source: params.sourceType,
      preRestoreSnapshot: preRestoreFilename,
    },
    ipAddress: params.ipAddress,
  });

  appendSystemLog(
    'DB',
    'database',
    `Attached database "${params.originalFilename}" (${stat.size} bytes, sha256=${sha256.slice(0, 12)}) via ${params.sourceType}. Safety snapshot: ${preRestoreFilename}.`
  );

  // Ensure 1s auto-sync loop runs and triggers immediate sync if Google Drive token is active
  startDriveAutoSyncLoop();
  if (activeDriveAccessToken) {
    runDriveSyncCycle({ force: true }).catch((err) => {
      appendSystemLog('WARN', 'google-drive', `Post-attach sync warning: ${err?.message || err}`);
    });
  }

  sendToSuperAdmins('system:restored', {
    restoredFrom: params.originalFilename,
    preRestoreFilename,
  });

  return {
    attachedInfo,
    preRestoreFilename,
    refreshedToken,
    status: getDriveSyncStatusSnapshot(),
  };
}

export async function downloadAndAttachDriveFile(fileId: string, filename: string, actorUser: AuthUser, ipAddress?: string) {
  const token = activeDriveAccessToken;
  if (!token) {
    throw new Error('Google Drive is not signed in. Please click "Sign in with Google" first.');
  }

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to download file from Google Drive (${res.status}): ${errText.slice(0, 200)}`);
  }

  const arrayBuf = await res.arrayBuffer();
  const tmpPath = path.join(os.tmpdir(), `sdglobal-drive-dl-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.db`);
  fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));

  try {
    return await attachLocalOrDriveDatabaseFile({
      sourceFilePath: tmpPath,
      originalFilename: filename,
      sourceType: 'drive_restore',
      actorUser,
      ipAddress,
    });
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
  }
}

export async function createCleanLiveDbSnapshotFile(): Promise<{ tmpPath: string; filename: string; sha256: string; sizeBytes: number }> {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // ignore
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpPath = path.join(os.tmpdir(), `sdglobal-live-${stamp}-${crypto.randomBytes(3).toString('hex')}.db`);
  await db.backup(tmpPath);
  const buf = fs.readFileSync(tmpPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    tmpPath,
    filename: `sdglobal-it_crm-${stamp}.db`,
    sha256,
    sizeBytes: buf.length,
  };
}
