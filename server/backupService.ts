import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { BACKUP_ROOT, db, restoreDatabaseFromFile } from './db.ts';
import { type AuthUser, notifyAdmins, sweepExpiredSessions, writeAuditLog } from './auth.ts';
import { dispatchOutlookEmail } from './integrations.ts';
import { sendToSuperAdmins } from './realtime.ts';
import { uploadVersionedBackupToDrive } from './driveSyncService.ts';
import { appendSystemLog } from './logCapture.ts';

export type BackupType = 'daily' | 'manual' | 'pre_restore';

export interface BackupVerificationResult {
  valid: boolean;
  sha256: string;
  fileSizeBytes: number;
  integrityCheck: string;
  recordCounts: Record<string, number>;
  error?: string;
}

let schedulerStarted = false;
let lastIntegritySweepAt = 0;

function computeFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

function formatBytesHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function verifySqliteBackupFile(filePath: string, expectedSha256?: string | null): BackupVerificationResult {
  if (!fs.existsSync(filePath)) {
    return {
      valid: false,
      sha256: '',
      fileSizeBytes: 0,
      integrityCheck: 'missing',
      recordCounts: {},
      error: 'Backup file is missing from protected storage.',
    };
  }

  const stat = fs.statSync(filePath);
  const sha256 = computeFileSha256(filePath);

  if (expectedSha256 && sha256 !== expectedSha256) {
    return {
      valid: false,
      sha256,
      fileSizeBytes: stat.size,
      integrityCheck: 'checksum_mismatch',
      recordCounts: {},
      error: `SHA-256 checksum mismatch (expected ${expectedSha256.slice(0, 12)}, got ${sha256.slice(0, 12)}).`,
    };
  }

  let testDb: Database.Database | null = null;
  try {
    testDb = new Database(filePath, { readonly: true });
    const integrityCheck = String(testDb.pragma('integrity_check', { simple: true }) || '');
    if (integrityCheck.toLowerCase() !== 'ok') {
      return {
        valid: false,
        sha256,
        fileSizeBytes: stat.size,
        integrityCheck,
        recordCounts: {},
        error: `SQLite integrity_check returned: ${integrityCheck}`,
      };
    }

    const safeCount = (table: string) => {
      try {
        const row = testDb!.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number } | undefined;
        return Number(row?.c || 0);
      } catch {
        return 0;
      }
    };

    const recordCounts = {
      tickets: safeCount('tickets'),
      chats: safeCount('direct_messages'),
      ticket_activities: safeCount('ticket_activities'),
      asset_history: safeCount('asset_history'),
      it_assets: safeCount('it_assets'),
      audit_logs: safeCount('audit_logs'),
      saved_reports: safeCount('saved_reports'),
      users: safeCount('users'),
    };

    return {
      valid: true,
      sha256,
      fileSizeBytes: stat.size,
      integrityCheck: 'ok',
      recordCounts,
    };
  } catch (err: any) {
    return {
      valid: false,
      sha256,
      fileSizeBytes: stat.size,
      integrityCheck: 'error',
      recordCounts: {},
      error: err?.message || 'Unable to read SQLite backup file.',
    };
  } finally {
    try {
      testDb?.close();
    } catch {
      // ignore close error
    }
  }
}

function getSuperAdminRecipientEmails(): string[] {
  const rows = db
    .prepare(
      `SELECT u.email
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE r.name = 'super_admin' AND u.status = 'Active'`
    )
    .all() as Array<{ email: string }>;

  const emails = Array.from(new Set(rows.map((r) => (r.email || '').trim()).filter(Boolean)));
  if (emails.length === 0) {
    return ['techsupport@sdgloballogistics.com'];
  }
  return emails;
}

async function sendBackupEmailNotification(params: {
  status: 'Verified' | 'Failed';
  backupType: BackupType;
  filename: string;
  fileSizeBytes: number;
  sha256: string;
  createdAtIso: string;
  recordCounts: Record<string, number>;
  errorMessage?: string;
}): Promise<string> {
  const recipients = getSuperAdminRecipientEmails();
  const dateObj = new Date(params.createdAtIso);
  const dateStr = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const subject =
    params.status === 'Verified'
      ? `[SD Global IT CRM] ${params.backupType.toUpperCase()} Database Backup Completed (${dateStr})`
      : `[ALERT - SD Global IT CRM] ${params.backupType.toUpperCase()} Database Backup FAILED (${dateStr})`;

  const countsLines = Object.entries(params.recordCounts)
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n');

  const body =
    params.status === 'Verified'
      ? [
          'SD Global IT Service Desk — Automated Backup & Integrity Report',
          '',
          `Status: ${params.status} (PRAGMA integrity_check = ok)`,
          `Backup Type: ${params.backupType}`,
          `Date: ${dateStr}`,
          `Time: ${timeStr} (${params.createdAtIso})`,
          `File Name: ${params.filename}`,
          `File Size: ${formatBytesHuman(params.fileSizeBytes)} (${params.fileSizeBytes} bytes)`,
          `SHA-256 Checksum: ${params.sha256}`,
          '',
          'Backed-Up CRM Records Summary:',
          countsLines || '  - Complete SQLite database snapshot verified.',
          '',
          'This backup is stored securely in protected server storage.',
        ].join('\n')
      : [
          'CRITICAL: SD Global IT CRM Database Backup Failed',
          '',
          `Backup Type: ${params.backupType}`,
          `Date: ${dateStr}`,
          `Time: ${timeStr} (${params.createdAtIso})`,
          `File Attempted: ${params.filename}`,
          `Error: ${params.errorMessage || 'Unknown backup error'}`,
          '',
          'Please inspect the Super Admin Security & Backups dashboard immediately.',
        ].join('\n');

  let finalStatus = 'Not Sent';
  for (const to of recipients) {
    try {
      const res = await dispatchOutlookEmail({ to, subject, body });
      finalStatus = res.status;
    } catch {
      finalStatus = 'Failed';
    }
  }
  return finalStatus;
}

export async function runCrmBackup(options: {
  backupType: BackupType;
  triggeredByUserId?: number | null;
  maxRetries?: number;
}): Promise<any> {
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const nowIso = new Date().toISOString();
  const stamp = nowIso.replace(/[:.]/g, '-').slice(0, 19);
  const rand = crypto.randomBytes(3).toString('hex');
  const filename = `sdglobal-crm-${options.backupType}-${stamp}-${rand}.db`;
  const destPath = path.join(BACKUP_ROOT, filename);

  let lastError = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // ignore if WAL checkpoint not needed
      }

      await db.backup(destPath);
      const verification = verifySqliteBackupFile(destPath);
      if (!verification.valid) {
        throw new Error(verification.error || 'Backup file failed post-write integrity verification.');
      }

      const emailStatus = await sendBackupEmailNotification({
        status: 'Verified',
        backupType: options.backupType,
        filename,
        fileSizeBytes: verification.fileSizeBytes,
        sha256: verification.sha256,
        createdAtIso: nowIso,
        recordCounts: verification.recordCounts,
      });

      const ins = db
        .prepare(
          `INSERT INTO crm_backups (
            filename, storage_path, backup_type, status, file_size_bytes, checksum_sha256,
            integrity_status, last_verified_at, record_counts_json, email_status,
            retry_count, triggered_by_user_id, created_at
          ) VALUES (?, ?, ?, 'Completed', ?, ?, 'Verified', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          filename,
          destPath,
          options.backupType,
          verification.fileSizeBytes,
          verification.sha256,
          nowIso,
          JSON.stringify(verification.recordCounts),
          emailStatus,
          attempt - 1,
          options.triggeredByUserId ?? null,
          nowIso
        );

      const backupRow = db.prepare('SELECT * FROM crm_backups WHERE id = ?').get(Number(ins.lastInsertRowid));

      writeAuditLog({
        userId: options.triggeredByUserId ?? null,
        action: 'RUN_DB_BACKUP',
        entityType: 'database',
        entityId: filename,
        details: {
          backup_type: options.backupType,
          file_size_bytes: verification.fileSizeBytes,
          checksum_sha256: verification.sha256,
          integrity: 'Verified',
          email_status: emailStatus,
          attempts: attempt,
        },
      });

      if (options.backupType !== 'pre_restore') {
        notifyAdmins({
          title: `${options.backupType === 'daily' ? 'Daily' : 'Manual'} CRM Backup Verified`,
          message: `Snapshot ${filename} (${formatBytesHuman(verification.fileSizeBytes)}) completed and passed SHA-256 + SQLite integrity verification.`,
          type: 'success',
        });
      }

      sendToSuperAdmins('backup:updated', { action: 'created', backup: backupRow });
      appendSystemLog(
        'DB',
        'backup',
        `Verified ${options.backupType} backup ${filename} (${formatBytesHuman(verification.fileSizeBytes)}, sha256=${verification.sha256.slice(0, 12)}).`
      );
      uploadVersionedBackupToDrive(destPath, filename).catch(() => {});
      return backupRow;
    } catch (err: any) {
      lastError = err?.message || 'Backup write error';
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {
        // ignore cleanup failure
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  // All retry attempts failed -> log failed backup and alert Super Admin immediately
  const emailStatus = await sendBackupEmailNotification({
    status: 'Failed',
    backupType: options.backupType,
    filename,
    fileSizeBytes: 0,
    sha256: '',
    createdAtIso: nowIso,
    recordCounts: {},
    errorMessage: lastError,
  });

  const failIns = db
    .prepare(
      `INSERT INTO crm_backups (
        filename, storage_path, backup_type, status, file_size_bytes, checksum_sha256,
        integrity_status, record_counts_json, email_status, error_message,
        retry_count, triggered_by_user_id, created_at
      ) VALUES (?, ?, ?, 'Failed', 0, '', 'Failed', '{}', ?, ?, ?, ?, ?)`
    )
    .run(
      filename,
      destPath,
      options.backupType,
      emailStatus,
      lastError,
      maxRetries,
      options.triggeredByUserId ?? null,
      nowIso
    );

  const failedRow = db.prepare('SELECT * FROM crm_backups WHERE id = ?').get(Number(failIns.lastInsertRowid));

  writeAuditLog({
    userId: options.triggeredByUserId ?? null,
    action: 'BACKUP_FAILED',
    entityType: 'database',
    entityId: filename,
    details: { backup_type: options.backupType, error: lastError, retries: maxRetries },
  });

  notifyAdmins({
    title: 'CRITICAL: Database Backup Failed',
    message: `${options.backupType.toUpperCase()} backup failed after ${maxRetries} attempts: ${lastError}`,
    type: 'critical',
  });

  sendToSuperAdmins('backup:updated', { action: 'failed', backup: failedRow });
  throw new Error(`Backup failed after ${maxRetries} attempts: ${lastError}`);
}

export function verifyStoredBackup(backupId: number, actorUser?: AuthUser | null) {
  const row = db.prepare('SELECT * FROM crm_backups WHERE id = ?').get(backupId) as any;
  if (!row) {
    throw new Error('Backup record not found');
  }

  const resolvedPath = path.resolve(row.storage_path || path.join(BACKUP_ROOT, row.filename));
  if (!resolvedPath.startsWith(path.resolve(BACKUP_ROOT))) {
    throw new Error('Invalid backup storage path');
  }

  const result = verifySqliteBackupFile(resolvedPath, row.checksum_sha256 || undefined);
  const nowIso = new Date().toISOString();
  const nextIntegrity = result.valid ? 'Verified' : 'Corrupted';

  db.prepare(
    `UPDATE crm_backups
     SET integrity_status = ?, last_verified_at = ?, error_message = ?, record_counts_json = COALESCE(?, record_counts_json)
     WHERE id = ?`
  ).run(
    nextIntegrity,
    nowIso,
    result.valid ? null : result.error || 'Verification failed',
    result.valid && Object.keys(result.recordCounts).length ? JSON.stringify(result.recordCounts) : null,
    backupId
  );

  if (actorUser) {
    writeAuditLog({
      userId: actorUser.id,
      userEmail: actorUser.email,
      roleName: actorUser.role,
      action: 'VERIFY_DB_BACKUP',
      entityType: 'database',
      entityId: row.filename,
      details: { valid: result.valid, integrityCheck: result.integrityCheck, error: result.error || null },
    });
  }

  if (!result.valid) {
    notifyAdmins({
      title: 'Backup Integrity Alert',
      message: `Backup ${row.filename} failed integrity verification: ${result.error || result.integrityCheck}`,
      type: 'critical',
    });
  }

  const updated = db.prepare('SELECT * FROM crm_backups WHERE id = ?').get(backupId);
  sendToSuperAdmins('backup:updated', { action: 'verified', backup: updated });
  return { backup: updated, verification: result };
}

export async function restoreStoredBackup(backupId: number, actorUser: AuthUser) {
  const row = db.prepare('SELECT * FROM crm_backups WHERE id = ?').get(backupId) as any;
  if (!row) {
    throw new Error('Backup record not found');
  }
  const resolvedPath = path.resolve(row.storage_path || path.join(BACKUP_ROOT, row.filename));
  if (!resolvedPath.startsWith(path.resolve(BACKUP_ROOT))) {
    throw new Error('Invalid backup storage path');
  }

  const preCheck = verifySqliteBackupFile(resolvedPath, row.checksum_sha256 || undefined);
  if (!preCheck.valid) {
    throw new Error(preCheck.error || 'Selected backup failed integrity verification and cannot be restored.');
  }

  const { preRestoreFilename, preRestorePath } = await restoreDatabaseFromFile(resolvedPath);

  // Record the pre-restore safety snapshot inside the newly restored DB so rollback remains visible
  try {
    const safetyVerify = verifySqliteBackupFile(preRestorePath);
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO crm_backups (
        filename, storage_path, backup_type, status, file_size_bytes, checksum_sha256,
        integrity_status, last_verified_at, record_counts_json, email_status,
        retry_count, triggered_by_user_id, created_at
      ) VALUES (?, ?, 'pre_restore', 'Completed', ?, ?, ?, ?, ?, 'Local Safety Snapshot', 0, ?, ?)`
    ).run(
      preRestoreFilename,
      preRestorePath,
      safetyVerify.fileSizeBytes,
      safetyVerify.sha256,
      safetyVerify.valid ? 'Verified' : 'Corrupted',
      nowIso,
      JSON.stringify(safetyVerify.recordCounts),
      actorUser.id,
      nowIso
    );
  } catch {
    // ignore metadata insert failure after restore
  }

  writeAuditLog({
    userId: actorUser.id,
    userEmail: actorUser.email,
    roleName: actorUser.role,
    sessionId: actorUser.session_id,
    action: 'DATABASE_RESTORED',
    entityType: 'database',
    entityId: row.filename,
    details: {
      restored_from: row.filename,
      restored_checksum: preCheck.sha256,
      pre_restore_snapshot: preRestoreFilename,
    },
  });

  notifyAdmins({
    title: 'CRM Database Restored',
    message: `Super Admin ${actorUser.full_name} restored database from ${row.filename}. Pre-restore snapshot saved as ${preRestoreFilename}.`,
    type: 'warning',
  });

  sendToSuperAdmins('system:restored', { restoredFrom: row.filename, preRestoreFilename });
  return { restoredFrom: row.filename, preRestoreFilename };
}

export async function ensureDailyBackupUpToDate() {
  const latest = db
    .prepare(
      `SELECT id, created_at
       FROM crm_backups
       WHERE status = 'Completed' AND backup_type IN ('daily', 'manual')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get() as { id: number; created_at: string } | undefined;

  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  const needsBackup =
    !latest || !latest.created_at || Date.now() - new Date(latest.created_at).getTime() >= twentyFourHoursMs;

  if (needsBackup) {
    await runCrmBackup({ backupType: 'daily', triggeredByUserId: null, maxRetries: 3 });
  }
}

export function verifyRecentBackupsOnSchedule() {
  const recent = db
    .prepare(
      `SELECT id, filename, storage_path, checksum_sha256
       FROM crm_backups
       WHERE status = 'Completed'
       ORDER BY created_at DESC LIMIT 3`
    )
    .all() as Array<{ id: number; filename: string; storage_path: string; checksum_sha256: string }>;

  for (const b of recent) {
    try {
      verifyStoredBackup(b.id, null);
    } catch {
      // already alerts via verifyStoredBackup if corrupted
    }
  }
}

export function startBackupScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Startup check after 4s so initial boot stays fast
  setTimeout(() => {
    try {
      sweepExpiredSessions();
    } catch {
      // ignore
    }
    ensureDailyBackupUpToDate().catch((err) => {
      console.error('Initial daily backup check failed:', err?.message || err);
    });
  }, 4000);

  // Every 15 minutes: idle session cleanup, 24h daily backup check, and 6h integrity sweep
  setInterval(() => {
    try {
      sweepExpiredSessions();
    } catch {
      // ignore
    }
    ensureDailyBackupUpToDate().catch((err) => {
      console.error('Scheduled daily backup failed:', err?.message || err);
    });

    if (Date.now() - lastIntegritySweepAt >= 6 * 60 * 60 * 1000) {
      lastIntegritySweepAt = Date.now();
      verifyRecentBackupsOnSchedule();
    }
  }, 15 * 60 * 1000);
}
