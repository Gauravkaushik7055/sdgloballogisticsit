import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.ts';
import { disconnectSession, sendToUser } from './realtime.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'logicore-dev-secret-change-in-production';

const auditContextStorage = new AsyncLocalStorage<{ sessionId?: number | null; ip?: string | null }>();

export type RoleName = 'super_admin' | 'moderator' | 'employee' | 'management';

export interface AuthUser {
  id: number;
  email: string;
  full_name: string;
  role: RoleName;
  role_label: string;
  session_id: number;
  employee_id?: number | null;
  moderator_id?: number | null;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export interface SessionSecurityPolicy {
  idleTimeoutMinutes: number;
}

export function getSessionSecurityPolicy(): SessionSecurityPolicy {
  const row = db
    .prepare("SELECT value_json FROM integration_settings WHERE key = 'security_session_policy'")
    .get() as { value_json: string } | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value_json);
      const mins = Number(parsed?.idleTimeoutMinutes);
      if (Number.isFinite(mins) && mins >= 5 && mins <= 1440) {
        return { idleTimeoutMinutes: Math.round(mins) };
      }
    } catch {
      // fall through
    }
  }
  return { idleTimeoutMinutes: 60 };
}

export function setSessionSecurityPolicy(policy: SessionSecurityPolicy, updatedByUserId: number): SessionSecurityPolicy {
  const mins = Math.max(5, Math.min(1440, Math.round(Number(policy.idleTimeoutMinutes) || 60)));
  const clean = { idleTimeoutMinutes: mins };
  db.prepare(
    `INSERT INTO integration_settings (key, value_json, updated_by, updated_at)
     VALUES ('security_session_policy', ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(JSON.stringify(clean), updatedByUserId);
  return clean;
}

export function sweepExpiredSessions(): number {
  const { idleTimeoutMinutes } = getSessionSecurityPolicy();
  const cutoffIso = new Date(Date.now() - idleTimeoutMinutes * 60_000).toISOString();
  const stale = db
    .prepare(
      `SELECT ls.id, ls.user_id, ls.role_name, ls.login_at, ls.last_activity_at, u.email
       FROM login_sessions ls
       JOIN users u ON ls.user_id = u.id
       WHERE ls.is_active = 1
         AND COALESCE(ls.last_activity_at, ls.login_at) < ?`
    )
    .all(cutoffIso) as Array<{
    id: number;
    user_id: number;
    role_name: string;
    login_at: string;
    last_activity_at?: string | null;
    email: string;
  }>;

  if (stale.length === 0) return 0;

  const nowIso = new Date().toISOString();
  const upd = db.prepare(
    `UPDATE login_sessions
     SET is_active = 0,
         logout_at = ?,
         termination_reason = 'Idle Timeout',
         duration_minutes = MAX(duration_minutes, CAST(ROUND((julianday(?) - julianday(login_at)) * 1440) AS INTEGER))
     WHERE id = ? AND is_active = 1`
  );

  for (const s of stale) {
    upd.run(nowIso, nowIso, s.id);
    disconnectSession(s.id, 'Session expired due to inactivity.');
    writeAuditLog({
      userId: s.user_id,
      userEmail: s.email,
      roleName: s.role_name,
      sessionId: s.id,
      action: 'SESSION_EXPIRED',
      entityType: 'session',
      entityId: s.id,
      details: { reason: 'Idle Timeout', idle_timeout_minutes: idleTimeoutMinutes },
    });
  }

  return stale.length;
}

export function signToken(payload: AuthUser): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, JWT_SECRET) as AuthUser;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  let token = '';
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.headers.cookie) {
    const cookies = Object.fromEntries(
      req.headers.cookie.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k, decodeURIComponent(v.join('='))];
      })
    );
    if (cookies.logicore_token) {
      token = cookies.logicore_token;
    }
  } else if (typeof req.query.token === 'string') {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = verifyToken(token);
    const dbUser = db
      .prepare('SELECT u.id, u.email, u.full_name, u.status, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?')
      .get(decoded.id) as { id: number; email: string; full_name: string; status: string; role: RoleName } | undefined;

    if (!dbUser || dbUser.status !== 'Active') {
      return res.status(401).json({ error: 'Account inactive or not found' });
    }

    if (decoded.session_id) {
      const sess = db
        .prepare('SELECT id, is_active, login_at, last_activity_at, termination_reason FROM login_sessions WHERE id = ? AND user_id = ?')
        .get(decoded.session_id, dbUser.id) as
        | { id: number; is_active: number; login_at: string; last_activity_at?: string | null; termination_reason?: string | null }
        | undefined;

      if (!sess || !sess.is_active) {
        return res.status(401).json({
          error: sess?.termination_reason
            ? `Session ended (${sess.termination_reason}). Please sign in again.`
            : 'Session terminated or logged out. Please sign in again.',
          code: 'SESSION_REVOKED',
        });
      }

      const { idleTimeoutMinutes } = getSessionSecurityPolicy();
      const lastActivityTs = new Date(sess.last_activity_at || sess.login_at).getTime();
      const nowMs = Date.now();
      if (Number.isFinite(lastActivityTs) && nowMs - lastActivityTs > idleTimeoutMinutes * 60_000) {
        const nowIso = new Date(nowMs).toISOString();
        db.prepare(
          `UPDATE login_sessions
           SET is_active = 0,
               logout_at = ?,
               termination_reason = 'Idle Timeout',
               duration_minutes = MAX(duration_minutes, CAST(ROUND((julianday(?) - julianday(login_at)) * 1440) AS INTEGER))
           WHERE id = ? AND is_active = 1`
        ).run(nowIso, nowIso, sess.id);
        disconnectSession(sess.id, 'Session expired due to inactivity.');
        writeAuditLog({
          userId: dbUser.id,
          userEmail: dbUser.email,
          roleName: dbUser.role,
          sessionId: sess.id,
          action: 'SESSION_EXPIRED',
          entityType: 'session',
          entityId: sess.id,
          details: { reason: 'Idle Timeout', idle_timeout_minutes: idleTimeoutMinutes },
          ipAddress: req.ip,
        });
        return res.status(401).json({
          error: 'Session expired due to inactivity. Please sign in again.',
          code: 'SESSION_EXPIRED',
        });
      }

      const nowIso = new Date(nowMs).toISOString();
      db.prepare(
        `UPDATE login_sessions
         SET last_activity_at = ?,
             duration_minutes = MAX(duration_minutes, CAST(ROUND((julianday(?) - julianday(login_at)) * 1440) AS INTEGER))
         WHERE id = ? AND is_active = 1`
      ).run(nowIso, nowIso, decoded.session_id);
    }

    req.user = decoded;
    auditContextStorage.run({ sessionId: decoded.session_id ?? null, ip: req.ip ?? null }, () => next());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }
}

export function buildInviteLink(baseUrl: string, token: string): string {
  const clean = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return `/?invite=${encodeURIComponent(token)}`;
  const sep = clean.includes('?') ? '&' : '/?';
  return `${clean}${sep}invite=${encodeURIComponent(token)}`;
}

export function requireRole(...allowedRoles: RoleName[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      writeAuditLog({
        userId: req.user.id,
        userEmail: req.user.email,
        roleName: req.user.role,
        action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
        entityType: 'route',
        entityId: req.originalUrl,
        details: { required_roles: allowedRoles, method: req.method },
        ipAddress: req.ip,
      });
      return res.status(403).json({
        error: `Access denied: requires one of [${allowedRoles.join(', ')}]`,
      });
    }
    next();
  };
}

export function writeAuditLog(params: {
  userId?: number | null;
  userEmail?: string | null;
  roleName?: string | null;
  sessionId?: number | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}) {
  try {
    const ctx = auditContextStorage.getStore();
    const resolvedSessionId = params.sessionId !== undefined ? params.sessionId : ctx?.sessionId ?? null;
    const resolvedIp = params.ipAddress !== undefined ? params.ipAddress : ctx?.ip ?? null;
    db.prepare(
      `INSERT INTO audit_logs (user_id, user_email, role_name, session_id, action, entity_type, entity_id, details_json, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.userId ?? null,
      params.userEmail ?? null,
      params.roleName ?? null,
      resolvedSessionId,
      params.action,
      params.entityType,
      params.entityId !== undefined && params.entityId !== null ? String(params.entityId) : null,
      params.details ? JSON.stringify(params.details) : null,
      resolvedIp
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

export interface NotificationPrefs {
  enabled: boolean;
  popups_enabled: boolean;
}

export function getSuperAdminNotificationPrefs(): NotificationPrefs {
  const row = db
    .prepare("SELECT value_json FROM integration_settings WHERE key = 'super_admin_notifications'")
    .get() as { value_json: string } | undefined;
  if (!row) return { enabled: true, popups_enabled: true };
  try {
    const parsed = JSON.parse(row.value_json);
    return {
      enabled: parsed.enabled !== false,
      popups_enabled: parsed.popups_enabled !== false,
    };
  } catch {
    return { enabled: true, popups_enabled: true };
  }
}

export function setSuperAdminNotificationPrefs(prefs: NotificationPrefs, updatedByUserId: number): NotificationPrefs {
  const clean: NotificationPrefs = {
    enabled: Boolean(prefs.enabled),
    popups_enabled: Boolean(prefs.popups_enabled),
  };
  db.prepare(
    `INSERT INTO integration_settings (key, value_json, updated_by, updated_at)
     VALUES ('super_admin_notifications', ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(JSON.stringify(clean), updatedByUserId);
  return clean;
}

export function createNotification(params: {
  userId: number;
  ticketId?: number | null;
  title: string;
  message: string;
  type?: 'info' | 'warning' | 'critical' | 'success';
  eventKey?: string | null;
}) {
  try {
    if (params.eventKey) {
      const existing = db
        .prepare('SELECT id FROM notifications WHERE user_id = ? AND event_key = ?')
        .get(params.userId, params.eventKey);
      if (existing) return null;
    }

    const nowIso = new Date().toISOString();
    const res = db
      .prepare(
        `INSERT INTO notifications (user_id, ticket_id, title, message, type, event_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.userId,
        params.ticketId ?? null,
        params.title,
        params.message,
        params.type ?? 'info',
        params.eventKey ?? null,
        nowIso
      );

    const inserted = db.prepare('SELECT * FROM notifications WHERE id = ?').get(res.lastInsertRowid);
    if (inserted) {
      sendToUser(params.userId, 'notification:new', inserted);
    }
    return inserted;
  } catch (err) {
    console.error('Notification error:', err);
    return null;
  }
}

export function notifyAdmins(params: {
  ticketId?: number | null;
  title: string;
  message: string;
  type?: 'info' | 'warning' | 'critical' | 'success';
  eventKey?: string | null;
}) {
  const prefs = getSuperAdminNotificationPrefs();
  if (!prefs.enabled) {
    return;
  }

  const admins = db
    .prepare(
      `SELECT u.id FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'super_admin' AND u.status = 'Active'`
    )
    .all() as { id: number }[];
  for (const admin of admins) {
    createNotification({ ...params, userId: admin.id });
  }
}

