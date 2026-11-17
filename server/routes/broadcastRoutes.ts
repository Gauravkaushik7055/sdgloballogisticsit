import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { db, UPLOAD_ROOT } from '../db.ts';
import { type AuthRequest, requireAuth, requireRole, writeAuditLog } from '../auth.ts';
import { broadcastAll, sendToUser } from '../realtime.ts';

const router = Router();

const VALID_CATEGORIES = new Set(['Important', 'Announcement', 'Warning', 'Urgent', 'General']);
const VALID_DISPLAY_MODES = new Set(['tab_only', 'tab_and_popup']);
const VALID_AUDIENCES = new Set(['everyone', 'admins', 'moderators', 'employees', 'selected']);

const broadcastUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, `bc-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported attachment type: ${file.mimetype}`));
  },
});

function parseIsoOrNull(val: unknown): string | null {
  if (typeof val !== 'string' || !val.trim()) return null;
  const d = new Date(val.trim());
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseUserIds(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
      }
    } catch {
      return raw
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
  }
  return [];
}

function resolveTargetUserIds(audience: string, selectedIds: number[]): number[] {
  if (audience === 'selected') {
    if (!selectedIds.length) return [];
    const placeholders = selectedIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'Active'`)
      .all(...selectedIds) as { id: number }[];
    return rows.map((r) => r.id);
  }

  let roleFilter = '';
  if (audience === 'admins') {
    roleFilter = "AND r.name IN ('super_admin', 'management')";
  } else if (audience === 'moderators') {
    roleFilter = "AND r.name = 'moderator'";
  } else if (audience === 'employees') {
    roleFilter = "AND r.name = 'employee'";
  }

  const rows = db
    .prepare(
      `SELECT u.id
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.status = 'Active' ${roleFilter}`
    )
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}

function userMatchesBroadcast(userId: number, role: string, audience: string, targetUserIdsJson: string): boolean {
  if (audience === 'everyone') return true;
  if (audience === 'admins') return role === 'super_admin' || role === 'management';
  if (audience === 'moderators') return role === 'moderator';
  if (audience === 'employees') return role === 'employee';
  if (audience === 'selected') {
    const ids = parseUserIds(targetUserIdsJson);
    return ids.includes(userId);
  }
  return false;
}

function computeLifecycleStatus(row: { is_active: number; starts_at: string | null; expires_at: string | null }): string {
  if (!row.is_active) return 'withdrawn';
  const nowMs = Date.now();
  if (row.starts_at) {
    const startMs = new Date(row.starts_at).getTime();
    if (!Number.isNaN(startMs) && startMs > nowMs) return 'scheduled';
  }
  if (row.expires_at) {
    const expMs = new Date(row.expires_at).getTime();
    if (!Number.isNaN(expMs) && expMs <= nowMs) return 'expired';
  }
  return 'published';
}

function ensureDeliveriesAndDispatch(broadcastRow: any, emitRealtime: boolean) {
  const lifecycle = computeLifecycleStatus(broadcastRow);
  if (lifecycle !== 'published') return 0;

  const selectedIds = parseUserIds(broadcastRow.target_user_ids_json);
  const targetIds = resolveTargetUserIds(broadcastRow.target_audience, selectedIds);
  if (targetIds.length === 0) return 0;

  const insDeliv = db.prepare(
    `INSERT OR IGNORE INTO broadcast_notification_deliveries (broadcast_id, user_id, delivered_at)
     VALUES (?, ?, ?)`
  );
  const nowIso = new Date().toISOString();
  let insertedCount = 0;

  for (const uid of targetIds) {
    const info = insDeliv.run(broadcastRow.id, uid, nowIso);
    if (info.changes > 0) insertedCount += 1;
  }

  if (emitRealtime) {
    const payload = {
      id: broadcastRow.id,
      title: broadcastRow.title,
      message: broadcastRow.message,
      category: broadcastRow.category,
      display_mode: broadcastRow.display_mode,
      attachment_path: broadcastRow.attachment_path,
      attachment_name: broadcastRow.attachment_name,
      attachment_mime: broadcastRow.attachment_mime,
      starts_at: broadcastRow.starts_at,
      expires_at: broadcastRow.expires_at,
      created_at: broadcastRow.created_at,
      is_read: 0,
      popup_seen: 0,
    };
    for (const uid of targetIds) {
      sendToUser(uid, 'broadcast:new', payload);
    }
    db.prepare('UPDATE broadcast_notifications SET scheduled_dispatched = 1 WHERE id = ?').run(broadcastRow.id);
  }

  return insertedCount;
}

// Background scheduler for scheduled broadcasts going live
let schedulerStarted = false;
export function startBroadcastScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setInterval(() => {
    try {
      const nowIso = new Date().toISOString();
      const pendingScheduled = db
        .prepare(
          `SELECT * FROM broadcast_notifications
           WHERE is_active = 1
             AND scheduled_dispatched = 0
             AND (starts_at IS NULL OR starts_at <= ?)
             AND (expires_at IS NULL OR expires_at > ?)`
        )
        .all(nowIso, nowIso) as any[];
      for (const row of pendingScheduled) {
        ensureDeliveriesAndDispatch(row, true);
      }
    } catch {
      // keep background loop safe
    }
  }, 30000);
}

// GET /api/broadcasts/audience-users (Super Admin selects individual target users)
router.get('/broadcasts/audience-users', requireAuth, requireRole('super_admin'), (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.full_name, u.email, r.name as role, r.label as role_label
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.status = 'Active'
       ORDER BY r.id ASC, u.full_name ASC`
    )
    .all();
  res.json({ users });
});

// GET /api/broadcasts/my — active broadcasts targeted at current authenticated user
router.get('/broadcasts/my', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const nowIso = new Date().toISOString();

  const candidateRows = db
    .prepare(
      `SELECT b.*, u.full_name as created_by_name
       FROM broadcast_notifications b
       LEFT JOIN users u ON b.created_by_user_id = u.id
       WHERE b.is_active = 1
         AND (b.starts_at IS NULL OR b.starts_at <= ?)
         AND (b.expires_at IS NULL OR b.expires_at > ?)
       ORDER BY
         CASE b.category WHEN 'Urgent' THEN 1 WHEN 'Warning' THEN 2 WHEN 'Important' THEN 3 ELSE 4 END,
         b.created_at DESC, b.id DESC`
    )
    .all(nowIso, nowIso) as any[];

  const matchedRows = candidateRows.filter((b) =>
    userMatchesBroadcast(user.id, user.role, b.target_audience, b.target_user_ids_json)
  );

  const insDeliv = db.prepare(
    `INSERT OR IGNORE INTO broadcast_notification_deliveries (broadcast_id, user_id, delivered_at)
     VALUES (?, ?, ?)`
  );
  const getDeliv = db.prepare(
    `SELECT is_read, read_at, popup_seen
     FROM broadcast_notification_deliveries
     WHERE broadcast_id = ? AND user_id = ?`
  );

  const broadcasts = matchedRows.map((b) => {
    insDeliv.run(b.id, user.id, nowIso);
    const deliv = getDeliv.get(b.id, user.id) as { is_read: number; read_at: string | null; popup_seen: number } | undefined;
    return {
      id: b.id,
      title: b.title,
      message: b.message,
      category: b.category,
      display_mode: b.display_mode,
      attachment_path: b.attachment_path,
      attachment_name: b.attachment_name,
      attachment_mime: b.attachment_mime,
      starts_at: b.starts_at,
      expires_at: b.expires_at,
      created_at: b.created_at,
      created_by_name: b.created_by_name || 'Super Admin',
      is_read: deliv?.is_read ?? 0,
      read_at: deliv?.read_at ?? null,
      popup_seen: deliv?.popup_seen ?? 0,
    };
  });

  const unreadCount = broadcasts.filter((b) => !b.is_read).length;
  const unseenPopups = broadcasts.filter((b) => b.display_mode === 'tab_and_popup' && !b.popup_seen);

  res.json({ broadcasts, unreadCount, unseenPopups });
});

// POST /api/broadcasts/:id/read
router.post('/broadcasts/:id/read', requireAuth, (req: AuthRequest, res) => {
  const broadcastId = Number(req.params.id);
  const userId = req.user!.id;
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO broadcast_notification_deliveries (broadcast_id, user_id, is_read, read_at, delivered_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(broadcast_id, user_id) DO UPDATE SET is_read = 1, read_at = COALESCE(read_at, excluded.read_at)`
  ).run(broadcastId, userId, nowIso, nowIso);
  res.json({ ok: true });
});

// POST /api/broadcasts/read-all
router.post('/broadcasts/read-all', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const nowIso = new Date().toISOString();
  db.prepare(
    `UPDATE broadcast_notification_deliveries
     SET is_read = 1, read_at = COALESCE(read_at, ?)
     WHERE user_id = ? AND is_read = 0`
  ).run(nowIso, userId);
  res.json({ ok: true });
});

// POST /api/broadcasts/:id/popup-seen — prevents duplicate popups across reloads/tabs
router.post('/broadcasts/:id/popup-seen', requireAuth, (req: AuthRequest, res) => {
  const broadcastId = Number(req.params.id);
  const userId = req.user!.id;
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO broadcast_notification_deliveries (broadcast_id, user_id, popup_seen, popup_seen_at, delivered_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(broadcast_id, user_id) DO UPDATE SET popup_seen = 1, popup_seen_at = COALESCE(popup_seen_at, excluded.popup_seen_at)`
  ).run(broadcastId, userId, nowIso, nowIso);
  res.json({ ok: true });
});

// GET /api/broadcasts/attachments/:filename — authenticated download/preview of broadcast attachments
router.get('/broadcasts/attachments/:filename', requireAuth, (req, res) => {
  const safeName = path.basename(req.params.filename || '');
  const fullPath = path.join(UPLOAD_ROOT, safeName);
  if (!safeName || !fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'Attachment not found' });
  }
  res.sendFile(fullPath);
});

// GET /api/broadcasts — Super Admin management list with lifecycle filters & delivery metrics
router.get('/broadcasts', requireAuth, requireRole('super_admin'), (req, res) => {
  const { status, category, search } = req.query as Record<string, string | undefined>;
  const rows = db
    .prepare(
      `SELECT b.*,
              u.full_name as created_by_name,
              (SELECT COUNT(*) FROM broadcast_notification_deliveries d WHERE d.broadcast_id = b.id) as delivered_count,
              (SELECT COUNT(*) FROM broadcast_notification_deliveries d WHERE d.broadcast_id = b.id AND d.is_read = 1) as read_count,
              (SELECT COUNT(*) FROM broadcast_notification_deliveries d WHERE d.broadcast_id = b.id AND d.popup_seen = 1) as popup_seen_count
       FROM broadcast_notifications b
       LEFT JOIN users u ON b.created_by_user_id = u.id
       ORDER BY b.created_at DESC, b.id DESC`
    )
    .all() as any[];

  const mapped = rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      message: r.message,
      category: r.category,
      display_mode: r.display_mode,
      target_audience: r.target_audience,
      target_user_ids: parseUserIds(r.target_user_ids_json),
      attachment_path: r.attachment_path,
      attachment_name: r.attachment_name,
      attachment_mime: r.attachment_mime,
      starts_at: r.starts_at,
      expires_at: r.expires_at,
      is_active: r.is_active,
      lifecycle_status: computeLifecycleStatus(r),
      created_by_name: r.created_by_name || 'Super Admin',
      created_at: r.created_at,
      updated_at: r.updated_at,
      delivered_count: r.delivered_count || 0,
      read_count: r.read_count || 0,
      popup_seen_count: r.popup_seen_count || 0,
    }))
    .filter((item) => {
      if (status && status !== 'all' && item.lifecycle_status !== status) return false;
      if (category && category !== 'All' && item.category !== category) return false;
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        if (!item.title.toLowerCase().includes(q) && !item.message.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });

  res.json({ broadcasts: mapped });
});

// POST /api/broadcasts — create & publish or schedule a broadcast notification
router.post(
  '/broadcasts',
  requireAuth,
  requireRole('super_admin'),
  broadcastUpload.single('attachment'),
  (req: AuthRequest, res) => {
    const {
      title,
      message,
      category,
      display_mode,
      target_audience,
      target_user_ids,
      starts_at,
      expires_at,
    } = req.body as Record<string, any>;

    const cleanTitle = (title || '').trim();
    const cleanMsg = (message || '').trim();
    if (!cleanTitle || !cleanMsg) {
      return res.status(400).json({ error: 'Notification title and message are required.' });
    }

    const cleanCategory = VALID_CATEGORIES.has(category) ? category : 'General';
    const cleanMode = VALID_DISPLAY_MODES.has(display_mode) ? display_mode : 'tab_only';
    const cleanAudience = VALID_AUDIENCES.has(target_audience) ? target_audience : 'everyone';
    const selectedIds = parseUserIds(target_user_ids);

    if (cleanAudience === 'selected' && selectedIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one target user when targeting selected users.' });
    }

    const startsIso = parseIsoOrNull(starts_at);
    const expiresIso = parseIsoOrNull(expires_at);
    if (startsIso && expiresIso && new Date(expiresIso).getTime() <= new Date(startsIso).getTime()) {
      return res.status(400).json({ error: 'Expiration date/time must be after the start date/time.' });
    }

    const file = req.file;
    const attachmentPath = file ? `/api/broadcasts/attachments/${file.filename}` : null;
    const attachmentName = file ? file.originalname : null;
    const attachmentMime = file ? file.mimetype : null;

    const nowIso = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO broadcast_notifications (
          title, message, category, display_mode, target_audience, target_user_ids_json,
          attachment_path, attachment_name, attachment_mime,
          starts_at, expires_at, is_active, scheduled_dispatched, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`
      )
      .run(
        cleanTitle,
        cleanMsg,
        cleanCategory,
        cleanMode,
        cleanAudience,
        JSON.stringify(selectedIds),
        attachmentPath,
        attachmentName,
        attachmentMime,
        startsIso,
        expiresIso,
        req.user!.id,
        nowIso,
        nowIso
      );

    const created = db.prepare('SELECT * FROM broadcast_notifications WHERE id = ?').get(info.lastInsertRowid) as any;
    ensureDeliveriesAndDispatch(created, true);

    writeAuditLog({
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      action: 'CREATE_BROADCAST_NOTIFICATION',
      entityType: 'broadcast',
      entityId: String(created.id),
      details: {
        title: cleanTitle,
        category: cleanCategory,
        display_mode: cleanMode,
        target_audience: cleanAudience,
      },
      ipAddress: req.ip,
    });

    res.status(201).json({ id: created.id, lifecycle_status: computeLifecycleStatus(created) });
  }
);

// PATCH /api/broadcasts/:id — edit, withdraw/deactivate, or reactivate a broadcast
router.patch(
  '/broadcasts/:id',
  requireAuth,
  requireRole('super_admin'),
  broadcastUpload.single('attachment'),
  (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM broadcast_notifications WHERE id = ?').get(id) as any;
    if (!existing) return res.status(404).json({ error: 'Broadcast notification not found' });

    const {
      title,
      message,
      category,
      display_mode,
      target_audience,
      target_user_ids,
      starts_at,
      expires_at,
      is_active,
      remove_attachment,
    } = req.body as Record<string, any>;

    const cleanTitle = title !== undefined ? String(title).trim() : existing.title;
    const cleanMsg = message !== undefined ? String(message).trim() : existing.message;
    if (!cleanTitle || !cleanMsg) {
      return res.status(400).json({ error: 'Title and message cannot be empty.' });
    }

    const cleanCategory = category && VALID_CATEGORIES.has(category) ? category : existing.category;
    const cleanMode = display_mode && VALID_DISPLAY_MODES.has(display_mode) ? display_mode : existing.display_mode;
    const cleanAudience = target_audience && VALID_AUDIENCES.has(target_audience) ? target_audience : existing.target_audience;
    const selectedIds =
      target_user_ids !== undefined ? parseUserIds(target_user_ids) : parseUserIds(existing.target_user_ids_json);

    if (cleanAudience === 'selected' && selectedIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one target user when targeting selected users.' });
    }

    const nextStarts = starts_at !== undefined ? parseIsoOrNull(starts_at) : existing.starts_at;
    const nextExpires = expires_at !== undefined ? parseIsoOrNull(expires_at) : existing.expires_at;
    if (nextStarts && nextExpires && new Date(nextExpires).getTime() <= new Date(nextStarts).getTime()) {
      return res.status(400).json({ error: 'Expiration date/time must be after start date/time.' });
    }

    const nextActive =
      is_active !== undefined
        ? is_active === false || is_active === 'false' || is_active === 0 || is_active === '0'
          ? 0
          : 1
        : existing.is_active;

    const file = req.file;
    let attachmentPath = existing.attachment_path;
    let attachmentName = existing.attachment_name;
    let attachmentMime = existing.attachment_mime;
    if (remove_attachment === 'true' || remove_attachment === true) {
      attachmentPath = null;
      attachmentName = null;
      attachmentMime = null;
    }
    if (file) {
      attachmentPath = `/api/broadcasts/attachments/${file.filename}`;
      attachmentName = file.originalname;
      attachmentMime = file.mimetype;
    }

    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE broadcast_notifications
       SET title = ?, message = ?, category = ?, display_mode = ?,
           target_audience = ?, target_user_ids_json = ?,
           attachment_path = ?, attachment_name = ?, attachment_mime = ?,
           starts_at = ?, expires_at = ?, is_active = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      cleanTitle,
      cleanMsg,
      cleanCategory,
      cleanMode,
      cleanAudience,
      JSON.stringify(selectedIds),
      attachmentPath,
      attachmentName,
      attachmentMime,
      nextStarts,
      nextExpires,
      nextActive,
      nowIso,
      id
    );

    const updated = db.prepare('SELECT * FROM broadcast_notifications WHERE id = ?').get(id) as any;
    if (updated.is_active === 1) {
      ensureDeliveriesAndDispatch(updated, true);
    }
    broadcastAll('broadcast:updated', { broadcastId: id });

    writeAuditLog({
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      action: 'UPDATE_BROADCAST_NOTIFICATION',
      entityType: 'broadcast',
      entityId: String(id),
      details: { is_active: nextActive, category: cleanCategory, display_mode: cleanMode },
      ipAddress: req.ip,
    });

    res.json({ ok: true, lifecycle_status: computeLifecycleStatus(updated) });
  }
);

// DELETE /api/broadcasts/:id
router.delete('/broadcasts/:id', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, title FROM broadcast_notifications WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'Broadcast notification not found' });

  db.prepare('DELETE FROM broadcast_notifications WHERE id = ?').run(id);
  broadcastAll('broadcast:updated', { broadcastId: id, deleted: true });

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'DELETE_BROADCAST_NOTIFICATION',
    entityType: 'broadcast',
    entityId: String(id),
    details: { title: existing.title },
    ipAddress: req.ip,
  });

  res.json({ ok: true });
});

export default router;
