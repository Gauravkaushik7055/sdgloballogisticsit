import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { db, UPLOAD_ROOT } from '../db.ts';
import { type AuthRequest, buildInviteLink, requireAuth, requireRole, writeAuditLog } from '../auth.ts';
import {
  getAdminPermissionPolicy,
  getScopedModeratorIdsForAdmin,
  logUnauthorizedAttempt,
  validateAndCleanDiskFiles,
  validateFileBufferOrDisk,
} from '../security.ts';
import { broadcastAll, sendToRoles } from '../realtime.ts';

const router = Router();

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function buildModeratorCommonLink(baseUrl: string, accessKey: string): string {
  const clean = (baseUrl || '').trim().replace(/\/+$/, '');
  const sep = clean.includes('?') ? '&' : '/?';
  return `${clean}${sep}panel=moderator-login&mod_access=${encodeURIComponent(accessKey)}`;
}

function ensureSuperAdminAssigneeRow(userId: number): number | null {
  const existing = db.prepare('SELECT id FROM moderators WHERE user_id = ?').get(userId) as { id: number } | undefined;
  if (existing) return existing.id;

  const adminUser = db
    .prepare(
      `SELECT u.id, u.full_name, u.email, u.mobile, u.created_at, r.name as role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ? AND r.name = 'super_admin' AND u.status = 'Active'`
    )
    .get(userId) as any;

  if (!adminUser) return null;

  const empCode = `IT-HEAD-${String(adminUser.id).padStart(3, '0')}`;
  const res = db
    .prepare(
      `INSERT INTO moderators (
        user_id, employee_code, full_name, email, phone, specialization, assigned_location_ids, date_of_joining, status, max_capacity
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'Active', 50)`
    )
    .run(
      adminUser.id,
      empCode,
      adminUser.full_name,
      adminUser.email,
      adminUser.mobile || 'IT Head Desk',
      'Super Admin / IT Head Escalations',
      (adminUser.created_at || new Date().toISOString()).slice(0, 10)
    );
  return Number(res.lastInsertRowid);
}

const invoiceUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, `inv-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// --- REFERENCE DATA: Locations, Departments, Vendors ---
router.get('/locations', requireAuth, (_req, res) => {
  const locations = db.prepare('SELECT * FROM locations ORDER BY name ASC').all();
  res.json({ locations });
});

router.post('/locations', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { code, name, type, city, state, address, manager_name } = req.body;
  if (!code || !name || !city || !state || !address) {
    return res.status(400).json({ error: 'Code, name, city, state, and address are required' });
  }
  try {
    const r = db
      .prepare('INSERT INTO locations (code, name, type, city, state, address, manager_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(code.trim(), name.trim(), type || 'Warehouse', city.trim(), state.trim(), address.trim(), manager_name || '');
    writeAuditLog({
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      action: 'CREATE_LOCATION',
      entityType: 'location',
      entityId: String(r.lastInsertRowid),
      details: { code, name },
      ipAddress: req.ip,
    });
    sendToRoles(['super_admin', 'management'], 'directory:updated', { entity: 'location', action: 'created' });
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/departments', requireAuth, (_req, res) => {
  const departments = db.prepare('SELECT * FROM departments ORDER BY name ASC').all();
  res.json({ departments });
});

router.get('/vendors', requireAuth, (_req, res) => {
  const vendors = db.prepare('SELECT * FROM vendors ORDER BY name ASC').all();
  res.json({ vendors });
});

router.post('/vendors', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { name, category, contact_person, phone, email, tax_id, address } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'Vendor name and category required' });
  const r = db
    .prepare('INSERT INTO vendors (name, category, contact_person, phone, email, tax_id, address) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, category, contact_person || '', phone || '', email || '', tax_id || '', address || '');
  res.status(201).json({ id: r.lastInsertRowid });
});

// --- EMPLOYEES & USER ACCOUNTS ---
router.get('/employees', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  const user = req.user!;
  const isAdmin = user.role === 'super_admin';
  const whereParts: string[] = [];
  const params: any[] = [];
  if (user.role === 'management') {
    const policy = getAdminPermissionPolicy(user);
    if (policy.allowed_location_ids.length > 0) {
      whereParts.push(`e.location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')})`);
      params.push(...policy.allowed_location_ids);
    }
    if (policy.allowed_department_ids.length > 0) {
      whereParts.push(`e.department_id IN (${policy.allowed_department_ids.map(() => '?').join(',')})`);
      params.push(...policy.allowed_department_ids);
    }
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const employees = db
    .prepare(
      `SELECT e.*,
              d.name as department_name,
              l.name as location_name,
              l.city as location_city,
              u.status as account_status,
              COALESCE(e.last_login_at, u.last_login_at) as last_login_at,
              COALESCE(e.last_login_ip, u.last_login_ip) as last_login_ip,
              MAX(COALESCE(e.login_count, 0), (SELECT COUNT(*) FROM login_sessions ls WHERE ls.user_id = e.user_id)) as login_count,
              (SELECT ls.user_agent FROM login_sessions ls WHERE ls.user_id = e.user_id ORDER BY ls.id DESC LIMIT 1) as last_user_agent,
              (SELECT COUNT(*) FROM login_sessions ls WHERE ls.user_id = e.user_id AND ls.is_active = 1) as active_sessions,
              u.must_reset_password,
              r.name as role_name,
              ${isAdmin ? 'u.invite_token, u.invited_link_base, u.invite_expires_at,' : ''}
              (SELECT COUNT(*) FROM tickets t WHERE t.employee_id = e.id OR (e.user_id IS NOT NULL AND t.created_by_user_id = e.user_id)) as ticket_count,
              (SELECT COUNT(*) FROM tickets t WHERE (t.employee_id = e.id OR (e.user_id IS NOT NULL AND t.created_by_user_id = e.user_id)) AND t.status NOT IN ('Completed','Resolved','Closed')) as open_ticket_count,
              (SELECT COUNT(*) FROM tickets t WHERE (t.employee_id = e.id OR (e.user_id IS NOT NULL AND t.created_by_user_id = e.user_id)) AND t.status IN ('Completed','Resolved','Closed')) as resolved_ticket_count,
              (SELECT t.ticket_number FROM tickets t WHERE t.employee_id = e.id OR (e.user_id IS NOT NULL AND t.created_by_user_id = e.user_id) ORDER BY t.id DESC LIMIT 1) as latest_ticket_number,
              (SELECT t.created_at FROM tickets t WHERE t.employee_id = e.id OR (e.user_id IS NOT NULL AND t.created_by_user_id = e.user_id) ORDER BY t.id DESC LIMIT 1) as latest_ticket_at
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN locations l ON e.location_id = l.id
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN roles r ON u.role_id = r.id
       ${whereSql}
       ORDER BY COALESCE(e.last_login_at, u.last_login_at, e.created_at) DESC, e.full_name ASC`
    )
    .all(...params);
  res.json({ employees });
});

router.get('/employees/:id/details', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  const empId = Number(req.params.id);
  const employee = db
    .prepare(
      `SELECT e.*, d.name as department_name, l.name as location_name, l.city as location_city,
              u.status as account_status, COALESCE(e.last_login_at, u.last_login_at) as last_login_at,
              COALESCE(e.last_login_ip, u.last_login_ip) as last_login_ip, r.name as role_name
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN locations l ON e.location_id = l.id
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE e.id = ?`
    )
    .get(empId) as any;

  if (!employee) {
    return res.status(404).json({ error: 'Employee not found' });
  }

  if (req.user!.role === 'management') {
    const policy = getAdminPermissionPolicy(req.user!);
    if (policy.allowed_location_ids.length > 0 && !policy.allowed_location_ids.includes(Number(employee.location_id))) {
      logUnauthorizedAttempt(req, 'employee_details', empId);
      return res.status(403).json({ error: 'Employee is outside your assigned location scope' });
    }
    if (policy.allowed_department_ids.length > 0 && !policy.allowed_department_ids.includes(Number(employee.department_id))) {
      logUnauthorizedAttempt(req, 'employee_details', empId);
      return res.status(403).json({ error: 'Employee is outside your assigned department scope' });
    }
  }

  const sessions = employee.user_id
    ? db
        .prepare(
          `SELECT * FROM login_sessions
           WHERE user_id = ?
           ORDER BY login_at DESC, id DESC
           LIMIT 100`
        )
        .all(employee.user_id)
    : [];

  const tickets = db
    .prepare(
      `SELECT t.*, l.name as location_name, m.full_name as moderator_name
       FROM tickets t
       LEFT JOIN locations l ON t.location_id = l.id
       LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
       WHERE t.employee_id = ? OR (? IS NOT NULL AND t.created_by_user_id = ?)
       ORDER BY t.created_at DESC, t.id DESC`
    )
    .all(empId, employee.user_id ?? null, employee.user_id ?? null);

  res.json({ employee, sessions, tickets });
});

router.post('/employees', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const {
    employee_code,
    full_name,
    department_id,
    designation,
    mobile,
    email,
    location_id,
    reporting_manager,
    password,
    role_name,
    portal_url,
  } = req.body;

  if (!employee_code || !full_name || !email || !designation || !mobile) {
    return res.status(400).json({ error: 'Employee code, name, email, designation, and mobile are required' });
  }

  const targetRole = role_name === 'management' ? 'management' : 'employee';
  const roleRow = db.prepare('SELECT id FROM roles WHERE name = ?').get(targetRole) as { id: number };
  const rawPassword = typeof password === 'string' && password.trim() ? password.trim() : crypto.randomBytes(16).toString('hex');
  const hash = bcrypt.hashSync(rawPassword, 10);
  const mustReset = typeof password === 'string' && password.trim() ? 0 : 1;
  const inviteToken = crypto.randomBytes(24).toString('hex');
  const inviteExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const baseUrl = (portal_url || process.env.APP_URL || `${req.protocol}://${req.get('host')}`).trim().replace(/\/+$/, '');

  try {
    const tx = db.transaction(() => {
      const uRes = db
        .prepare(
          `INSERT INTO users (role_id, email, password_hash, full_name, status, must_reset_password, invite_token, invite_expires_at, invited_link_base)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          roleRow.id,
          email.trim().toLowerCase(),
          hash,
          full_name.trim(),
          'Active',
          mustReset,
          inviteToken,
          inviteExpires,
          baseUrl
        );

      const eRes = db
        .prepare(
          `INSERT INTO employees (user_id, employee_code, full_name, department_id, designation, mobile, email, location_id, reporting_manager)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          uRes.lastInsertRowid,
          employee_code.trim(),
          full_name.trim(),
          department_id ? Number(department_id) : null,
          designation.trim(),
          mobile.trim(),
          email.trim().toLowerCase(),
          location_id ? Number(location_id) : null,
          reporting_manager || ''
        );
      return { employeeId: Number(eRes.lastInsertRowid), userId: Number(uRes.lastInsertRowid) };
    });
    const { employeeId, userId } = tx();
    const loginLink = buildInviteLink(baseUrl, inviteToken);
    writeAuditLog({
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      action: 'CREATE_EMPLOYEE',
      entityType: 'employee',
      entityId: String(employeeId),
      details: { employee_code, email, role: targetRole, invited_link_base: baseUrl },
      ipAddress: req.ip,
    });
    sendToRoles(['super_admin', 'management'], 'directory:updated', { entity: 'employee', action: 'created', employeeId });
    res.status(201).json({ id: employeeId, user_id: userId, invite_token: inviteToken, login_link: loginLink });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Bulk CSV/JSON Import of Employees
router.post('/employees/import', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { rows } = req.body as {
    rows: Array<{
      employee_code: string;
      full_name: string;
      email: string;
      mobile: string;
      designation: string;
      department?: string;
      location_code?: string;
      reporting_manager?: string;
    }>;
  };
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No employee rows provided for import' });
  }
  const roleRow = db.prepare("SELECT id FROM roles WHERE name = 'employee'").get() as { id: number };
  const defaultHash = bcrypt.hashSync('LogiCore@2026', 10);

  let imported = 0;
  const skipped: string[] = [];

  for (const r of rows) {
    if (!r.employee_code || !r.email || !r.full_name) {
      skipped.push(r.email || r.employee_code || 'Missing fields');
      continue;
    }
    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(r.email.trim());
    if (existing) {
      skipped.push(`${r.email} (already exists)`);
      continue;
    }
    const dept = r.department
      ? (db.prepare('SELECT id FROM departments WHERE lower(name) = lower(?)').get(r.department.trim()) as { id: number } | undefined)
      : undefined;
    const loc = r.location_code
      ? (db.prepare('SELECT id FROM locations WHERE lower(code) = lower(?) OR lower(name) = lower(?)').get(r.location_code.trim(), r.location_code.trim()) as { id: number } | undefined)
      : undefined;

    const uRes = db
      .prepare('INSERT INTO users (role_id, email, password_hash, full_name, status, must_reset_password) VALUES (?, ?, ?, ?, ?, 1)')
      .run(roleRow.id, r.email.trim().toLowerCase(), defaultHash, r.full_name.trim(), 'Active');

    db.prepare(
      `INSERT INTO employees (user_id, employee_code, full_name, department_id, designation, mobile, email, location_id, reporting_manager)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uRes.lastInsertRowid,
      r.employee_code.trim(),
      r.full_name.trim(),
      dept?.id ?? null,
      r.designation || 'Logistics Staff',
      r.mobile || 'N/A',
      r.email.trim().toLowerCase(),
      loc?.id ?? null,
      r.reporting_manager || ''
    );
    imported++;
  }

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'BULK_IMPORT_EMPLOYEES',
    entityType: 'employee',
    details: { imported, skipped_count: skipped.length },
    ipAddress: req.ip,
  });

  sendToRoles(['super_admin', 'management'], 'directory:updated', { entity: 'employee', action: 'imported', imported });
  res.json({ imported, skipped });
});

router.patch('/users/:userId/status', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const userId = Number(req.params.userId);
  const { status } = req.body as { status: 'Active' | 'Inactive' };
  if (!['Active', 'Inactive'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  db.prepare('UPDATE moderators SET status = ? WHERE user_id = ?').run(status, userId);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'TOGGLE_USER_STATUS',
    entityType: 'user',
    entityId: String(userId),
    details: { status },
    ipAddress: req.ip,
  });
  sendToRoles(['super_admin', 'management'], 'directory:updated', { entity: 'user', action: 'status_toggled', userId });
  res.json({ ok: true });
});

router.delete('/users/:userId', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const userId = Number(req.params.userId);
  if (userId === req.user!.id) {
    return res.status(400).json({ error: 'Cannot delete currently signed-in Super Admin account' });
  }
  const hasTickets = (
    db.prepare('SELECT COUNT(*) as c FROM tickets WHERE created_by_user_id = ?').get(userId) as { c: number }
  ).c;
  const hasChats = (
    db
      .prepare('SELECT COUNT(*) as c FROM direct_messages WHERE sender_user_id = ? OR recipient_user_id = ?')
      .get(userId, userId) as { c: number }
  ).c;
  const hasActivities = (
    db.prepare('SELECT COUNT(*) as c FROM ticket_activities WHERE actor_user_id = ?').get(userId) as { c: number }
  ).c;
  const hasAssetEvents = (
    db.prepare('SELECT COUNT(*) as c FROM asset_history WHERE actor_user_id = ?').get(userId) as { c: number }
  ).c;
  const hasSessions = (
    db.prepare('SELECT COUNT(*) as c FROM login_sessions WHERE user_id = ?').get(userId) as { c: number }
  ).c;

  if (hasTickets > 0 || hasChats > 0 || hasActivities > 0 || hasAssetEvents > 0 || hasSessions > 0) {
    return res.status(400).json({
      error:
        'User has permanent CRM records (tickets, chats, sessions, or asset logs) in immutable audit history. Deactivate the account instead of deleting.',
    });
  }
  try {
    db.transaction(() => {
      db.prepare('UPDATE tickets SET assigned_moderator_id = NULL WHERE assigned_moderator_id IN (SELECT id FROM moderators WHERE user_id = ?)').run(userId);
      db.prepare('UPDATE tickets SET admin_verified_by = NULL WHERE admin_verified_by = ?').run(userId);
      db.prepare('DELETE FROM moderators WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM employees WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    })();
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Cannot delete user due to existing historical records' });
  }
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'DELETE_USER',
    entityType: 'user',
    entityId: String(userId),
    ipAddress: req.ip,
  });
  sendToRoles(['super_admin', 'management'], 'directory:updated', { entity: 'user', action: 'deleted', userId });
  res.json({ ok: true });
});

router.post('/users/:userId/invite-link', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const userId = Number(req.params.userId);
  const { portal_url } = req.body as { portal_url?: string };
  const targetUser = db.prepare('SELECT id, email, full_name, invited_link_base FROM users WHERE id = ?').get(userId) as any;
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const inviteToken = crypto.randomBytes(24).toString('hex');
  const inviteExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const baseUrl = (portal_url || targetUser.invited_link_base || process.env.APP_URL || `${req.protocol}://${req.get('host')}`)
    .trim()
    .replace(/\/+$/, '');

  db.prepare('UPDATE users SET invite_token = ?, invite_expires_at = ?, invited_link_base = ? WHERE id = ?').run(
    inviteToken,
    inviteExpires,
    baseUrl,
    userId
  );

  const loginLink = buildInviteLink(baseUrl, inviteToken);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'GENERATE_USER_INVITE_LINK',
    entityType: 'user',
    entityId: String(userId),
    details: { target_email: targetUser.email, base_url: baseUrl },
    ipAddress: req.ip,
  });

  res.json({ invite_token: inviteToken, login_link: loginLink, expires_at: inviteExpires });
});

// --- MODERATORS & PERFORMANCE ---
// Common Moderator Portal Access Link (Super Admin ONLY)
router.get('/moderators/common-access-link', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const row = db.prepare("SELECT value_json, updated_at FROM integration_settings WHERE key = 'moderator_common_portal'").get() as
    | { value_json: string; updated_at: string }
    | undefined;

  let cfg: { access_key: string; base_url?: string } | null = null;
  if (row) {
    try {
      cfg = JSON.parse(row.value_json);
    } catch {
      cfg = null;
    }
  }

  const defaultBase = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).trim().replace(/\/+$/, '');
  if (!cfg || !cfg.access_key) {
    const accessKey = crypto.randomBytes(16).toString('hex');
    cfg = { access_key: accessKey, base_url: defaultBase };
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO integration_settings (key, value_json, updated_by, updated_at)
       VALUES ('moderator_common_portal', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).run(JSON.stringify(cfg), req.user!.id, nowIso);
    return res.json({
      access_key: accessKey,
      base_url: defaultBase,
      login_link: buildModeratorCommonLink(defaultBase, accessKey),
      updated_at: nowIso,
    });
  }

  const baseUrl = (cfg.base_url || defaultBase).trim().replace(/\/+$/, '');
  res.json({
    access_key: cfg.access_key,
    base_url: baseUrl,
    login_link: buildModeratorCommonLink(baseUrl, cfg.access_key),
    updated_at: row?.updated_at || null,
  });
});

router.post('/moderators/common-access-link', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { portal_url } = req.body as { portal_url?: string };
  const baseUrl = (portal_url || process.env.APP_URL || `${req.protocol}://${req.get('host')}`).trim().replace(/\/+$/, '');
  const accessKey = crypto.randomBytes(16).toString('hex');
  const nowIso = new Date().toISOString();
  const payload = { access_key: accessKey, base_url: baseUrl };

  db.prepare(
    `INSERT INTO integration_settings (key, value_json, updated_by, updated_at)
     VALUES ('moderator_common_portal', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(JSON.stringify(payload), req.user!.id, nowIso);

  const loginLink = buildModeratorCommonLink(baseUrl, accessKey);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'GENERATE_COMMON_MODERATOR_LINK',
    entityType: 'auth',
    entityId: 'moderator_common_portal',
    details: { base_url: baseUrl },
    ipAddress: req.ip,
  });

  res.json({
    access_key: accessKey,
    base_url: baseUrl,
    login_link: loginLink,
    updated_at: nowIso,
  });
});

router.get('/moderators', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const isAdmin = user.role === 'super_admin';
  const includeSuperAdmin = req.query.include_super_admin === '1' && user.role !== 'moderator';
  const period = (req.query.period as string) || 'monthly'; // daily, weekly, monthly, all
  let dateFilter = '';
  if (period === 'daily') dateFilter = "AND date(t.created_at) = date('now')";
  else if (period === 'weekly') dateFilter = "AND datetime(t.created_at) >= datetime('now', '-7 days')";
  else if (period === 'monthly') dateFilter = "AND datetime(t.created_at) >= datetime('now', '-30 days')";

  if (includeSuperAdmin && isAdmin) {
    ensureSuperAdminAssigneeRow(user.id);
  }

  // Moderators must NOT view other moderators' private performance metrics; Admins are scoped
  const whereClauses: string[] = [];
  const modParams: any[] = [];
  if (user.role === 'moderator') {
    whereClauses.push('m.id = ?');
    modParams.push(user.moderator_id ?? -1);
  } else if (user.role === 'management') {
    whereClauses.push("r.name = 'moderator'");
    const scopedMods = getScopedModeratorIdsForAdmin(user);
    if (scopedMods !== null) {
      if (scopedMods.length === 0) {
        return res.json({ moderators: [] });
      }
      whereClauses.push(`m.id IN (${scopedMods.map(() => '?').join(',')})`);
      modParams.push(...scopedMods);
    }
  } else if (includeSuperAdmin) {
    whereClauses.push("r.name IN ('moderator', 'super_admin')");
  } else {
    whereClauses.push("r.name = 'moderator'");
  }
  const modWhere = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const mods = db
    .prepare(
      `SELECT m.*,
              r.name as assignee_role,
              u.last_login_at,
              u.must_reset_password,
              ${isAdmin ? 'u.invite_token, u.invite_expires_at, u.invited_link_base,' : ''}
              (SELECT COUNT(*) FROM tickets t WHERE t.assigned_moderator_id = m.id AND t.status NOT IN ('Completed','Resolved','Closed')) as current_workload,
              (SELECT COUNT(*) FROM tickets t WHERE t.assigned_moderator_id = m.id ${dateFilter}) as total_assigned,
              (SELECT COUNT(*) FROM tickets t WHERE t.assigned_moderator_id = m.id AND t.status IN ('Completed','Resolved','Closed') ${dateFilter}) as resolved_tickets,
              (SELECT COUNT(*) FROM tickets t WHERE t.assigned_moderator_id = m.id AND t.status NOT IN ('Completed','Resolved','Closed') ${dateFilter}) as pending_tickets,
              (SELECT COUNT(*) FROM tickets t WHERE t.assigned_moderator_id = m.id AND t.status IN ('Reopened','Revision Required') ${dateFilter}) as reopened_tickets,
              (SELECT COUNT(*) FROM tickets t WHERE t.assigned_moderator_id = m.id AND t.sla_breached = 1 AND t.status NOT IN ('Completed','Resolved','Closed') ${dateFilter}) as overdue_tickets,
              (SELECT ROUND(AVG((julianday(t.resolved_at) - julianday(t.created_at)) * 24), 1) FROM tickets t WHERE t.assigned_moderator_id = m.id AND t.resolved_at IS NOT NULL ${dateFilter}) as avg_resolution_hours,
              (SELECT ROUND(AVG((julianday(t.first_response_at) - julianday(t.created_at)) * 1440), 0) FROM tickets t WHERE t.assigned_moderator_id = m.id AND t.first_response_at IS NOT NULL ${dateFilter}) as avg_first_response_mins,
              (SELECT COALESCE(SUM(ttl.duration_minutes), 0) FROM ticket_time_logs ttl WHERE ttl.moderator_id = m.id) as total_working_minutes,
              ${isAdmin ? '(SELECT COUNT(*) FROM audit_logs al WHERE al.user_id = m.user_id) as tracked_action_count,' : '0 as tracked_action_count,'}
              ${isAdmin ? '(SELECT MAX(al.created_at) FROM audit_logs al WHERE al.user_id = m.user_id) as last_activity_at' : 'NULL as last_activity_at'}
       FROM moderators m
       JOIN users u ON m.user_id = u.id
       JOIN roles r ON u.role_id = r.id
       ${modWhere}
       ORDER BY CASE WHEN r.name = 'super_admin' THEN 0 ELSE 1 END, m.full_name ASC`
    )
    .all(...modParams) as any[];

  const locations = db.prepare('SELECT id, name, code FROM locations').all() as { id: number; name: string; code: string }[];
  const locMap = new Map(locations.map((l) => [l.id, `${l.name} (${l.code})`]));

  const enriched = mods.map((m) => {
    let locIds: number[] = [];
    try {
      locIds = JSON.parse(m.assigned_location_ids || '[]');
    } catch {
      locIds = [];
    }
    return {
      ...m,
      assigned_location_ids: locIds,
      assigned_location_names: locIds.map((id) => locMap.get(id)).filter(Boolean),
    };
  });

  res.json({ moderators: enriched });
});

router.post('/moderators', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const {
    employee_code,
    full_name,
    email,
    phone,
    specialization,
    assigned_location_ids,
    date_of_joining,
    max_capacity,
    password,
    portal_url,
  } = req.body;

  if (!employee_code || !full_name || !email || !phone || !specialization) {
    return res.status(400).json({ error: 'All moderator profile fields are required' });
  }

  const assignedPassword = typeof password === 'string' ? password.trim() : '';
  if (assignedPassword.length < 8) {
    return res.status(400).json({
      error: 'Super Admin must assign a password of at least 8 characters for each moderator.',
    });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingEmail = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(normalizedEmail);
  if (existingEmail) {
    return res.status(400).json({ error: 'A user account with this email ID already exists. Assign a unique email ID.' });
  }

  const existingCode = db
    .prepare('SELECT id FROM moderators WHERE lower(employee_code) = lower(?)')
    .get(employee_code.trim());
  if (existingCode) {
    return res.status(400).json({ error: 'A moderator with this Employee ID already exists.' });
  }

  const roleRow = db.prepare("SELECT id FROM roles WHERE name = 'moderator'").get() as { id: number };
  const hash = bcrypt.hashSync(assignedPassword, 10);
  const inviteToken = crypto.randomBytes(24).toString('hex');
  const inviteExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const baseUrl = (portal_url || process.env.APP_URL || `${req.protocol}://${req.get('host')}`).trim().replace(/\/+$/, '');

  try {
    const tx = db.transaction(() => {
      const uRes = db
        .prepare(
          `INSERT INTO users (role_id, email, password_hash, full_name, status, must_reset_password, invite_token, invite_expires_at, invited_link_base)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          roleRow.id,
          normalizedEmail,
          hash,
          full_name.trim(),
          'Active',
          inviteToken,
          inviteExpires,
          baseUrl
        );

      const mRes = db
        .prepare(
          `INSERT INTO moderators (user_id, employee_code, full_name, email, phone, specialization, assigned_location_ids, date_of_joining, max_capacity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          uRes.lastInsertRowid,
          employee_code.trim(),
          full_name.trim(),
          normalizedEmail,
          phone.trim(),
          specialization.trim(),
          JSON.stringify(assigned_location_ids || []),
          date_of_joining || new Date().toISOString().slice(0, 10),
          Number(max_capacity) || 10
        );
      return { moderatorId: Number(mRes.lastInsertRowid), userId: Number(uRes.lastInsertRowid) };
    });
    const { moderatorId, userId } = tx();
    const loginLink = buildInviteLink(baseUrl, inviteToken);
    writeAuditLog({
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      action: 'CREATE_MODERATOR',
      entityType: 'moderator',
      entityId: String(moderatorId),
      details: { email: normalizedEmail, specialization, invited_link_base: baseUrl },
      ipAddress: req.ip,
    });
    sendToRoles(['super_admin', 'management'], 'directory:updated', { entity: 'moderator', action: 'created', moderatorId });
    res.status(201).json({
      id: moderatorId,
      user_id: userId,
      email: normalizedEmail,
      invite_token: inviteToken,
      login_link: loginLink,
      expires_at: inviteExpires,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Regenerate / update invite link for a moderator (Super Admin ONLY)
router.post('/moderators/:id/invite-link', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const modId = Number(req.params.id);
  const { portal_url } = req.body as { portal_url?: string };
  const mod = db
    .prepare(
      `SELECT m.*, u.invited_link_base FROM moderators m JOIN users u ON m.user_id = u.id WHERE m.id = ?`
    )
    .get(modId) as any;
  if (!mod) return res.status(404).json({ error: 'Moderator not found' });

  const inviteToken = crypto.randomBytes(24).toString('hex');
  const inviteExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const baseUrl = (portal_url || mod.invited_link_base || process.env.APP_URL || `${req.protocol}://${req.get('host')}`)
    .trim()
    .replace(/\/+$/, '');

  db.prepare('UPDATE users SET invite_token = ?, invite_expires_at = ?, invited_link_base = ? WHERE id = ?').run(
    inviteToken,
    inviteExpires,
    baseUrl,
    mod.user_id
  );

  const loginLink = buildInviteLink(baseUrl, inviteToken);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'GENERATE_MODERATOR_LOGIN_LINK',
    entityType: 'moderator',
    entityId: String(modId),
    details: { moderator_email: mod.email, base_url: baseUrl },
    ipAddress: req.ip,
  });

  res.json({ invite_token: inviteToken, login_link: loginLink, expires_at: inviteExpires });
});

// View full activity & session history of a specific moderator (STRICTLY Super Admin ONLY)
router.get('/moderators/:id/activities', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const modId = Number(req.params.id);
  const mod = db
    .prepare(
      `SELECT m.*, u.last_login_at, u.invite_token, u.invited_link_base, u.invite_expires_at, u.must_reset_password
       FROM moderators m
       JOIN users u ON m.user_id = u.id
       WHERE m.id = ?`
    )
    .get(modId) as any;
  if (!mod) return res.status(404).json({ error: 'Moderator not found' });

  const sessions = db
    .prepare(
      `SELECT ls.*, u.full_name, u.email
       FROM login_sessions ls
       JOIN users u ON ls.user_id = u.id
       WHERE ls.user_id = ?
       ORDER BY ls.login_at DESC
       LIMIT 100`
    )
    .all(mod.user_id) as any[];

  const activities = db
    .prepare(
      `SELECT * FROM audit_logs
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 300`
    )
    .all(mod.user_id) as any[];

  const ticketActivities = db
    .prepare(
      `SELECT ta.*, t.ticket_number, t.category, t.priority
       FROM ticket_activities ta
       JOIN tickets t ON ta.ticket_id = t.id
       WHERE ta.actor_user_id = ?
       ORDER BY ta.created_at DESC, ta.id DESC
       LIMIT 200`
    )
    .all(mod.user_id) as any[];

  const timeLogs = db
    .prepare(
      `SELECT ttl.*, t.ticket_number, t.category
       FROM ticket_time_logs ttl
       JOIN tickets t ON ttl.ticket_id = t.id
       WHERE ttl.moderator_id = ?
       ORDER BY ttl.started_at DESC
       LIMIT 150`
    )
    .all(mod.id) as any[];

  const totalTimeLogged = timeLogs.reduce((acc, item) => acc + (Number(item.duration_minutes) || 0), 0);

  res.json({
    moderator: mod,
    sessions,
    activities,
    ticketActivities,
    timeLogs,
    summary: {
      total_actions: activities.length,
      total_sessions: sessions.length,
      active_sessions: sessions.filter((s) => s.is_active === 1).length,
      total_time_logged_mins: totalTimeLogged,
      last_activity_at: activities[0]?.created_at || sessions[0]?.last_activity_at || mod.last_login_at || null,
    },
  });
});

router.put('/moderators/:id', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const modId = Number(req.params.id);
  const {
    full_name,
    email,
    new_password,
    phone,
    specialization,
    assigned_location_ids,
    status,
    max_capacity,
    performance_rating,
  } = req.body;
  const mod = db.prepare('SELECT * FROM moderators WHERE id = ?').get(modId) as any;
  if (!mod) return res.status(404).json({ error: 'Moderator not found' });

  let nextEmail: string | null = null;
  if (typeof email === 'string' && email.trim() && email.trim().toLowerCase() !== mod.email.toLowerCase()) {
    nextEmail = email.trim().toLowerCase();
    const dup = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?').get(nextEmail, mod.user_id);
    if (dup) {
      return res.status(400).json({ error: 'Another user account already uses this email ID.' });
    }
  }

  let nextPasswordHash: string | null = null;
  if (typeof new_password === 'string' && new_password.trim().length > 0) {
    if (new_password.trim().length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    nextPasswordHash = bcrypt.hashSync(new_password.trim(), 10);
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE moderators
       SET full_name = COALESCE(?, full_name),
           email = COALESCE(?, email),
           phone = COALESCE(?, phone),
           specialization = COALESCE(?, specialization),
           assigned_location_ids = COALESCE(?, assigned_location_ids),
           status = COALESCE(?, status),
           max_capacity = COALESCE(?, max_capacity),
           performance_rating = COALESCE(?, performance_rating)
       WHERE id = ?`
    ).run(
      full_name ?? null,
      nextEmail,
      phone ?? null,
      specialization ?? null,
      assigned_location_ids ? JSON.stringify(assigned_location_ids) : null,
      status ?? null,
      max_capacity ? Number(max_capacity) : null,
      performance_rating ? Number(performance_rating) : null,
      modId
    );

    if (status) {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, mod.user_id);
    }
    if (full_name) {
      db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(full_name, mod.user_id);
    }
    if (nextEmail) {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(nextEmail, mod.user_id);
    }
    if (nextPasswordHash) {
      db.prepare('UPDATE users SET password_hash = ?, must_reset_password = 0 WHERE id = ?').run(
        nextPasswordHash,
        mod.user_id
      );
    }
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_MODERATOR',
    entityType: 'moderator',
    entityId: String(modId),
    details: {
      email_updated: Boolean(nextEmail),
      password_updated: Boolean(nextPasswordHash),
      status: status || undefined,
    },
    ipAddress: req.ip,
  });

  sendToRoles(['super_admin', 'management'], 'directory:updated', { entity: 'moderator', action: 'updated', moderatorId: modId });
  res.json({ ok: true });
});

// --- IT ASSETS, LIFECYCLE & EXCEL IMPORT ---
function recordAssetHistory(params: {
  assetId: number;
  eventType: string;
  previousValue?: string | null;
  newValue?: string | null;
  assignedEmployeeId?: number | null;
  locationId?: number | null;
  actorUserId: number;
  actorName: string;
  actorRole?: string | null;
  notes?: string;
}) {
  let resolvedRole = params.actorRole || null;
  if (!resolvedRole && params.actorUserId) {
    const row = db
      .prepare('SELECT r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?')
      .get(params.actorUserId) as { role_name?: string } | undefined;
    resolvedRole = row?.role_name || null;
  }
  db.prepare(
    `INSERT INTO asset_history (asset_id, event_type, previous_value, new_value, assigned_employee_id, location_id, actor_user_id, actor_name, actor_role, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.assetId,
    params.eventType,
    params.previousValue ?? null,
    params.newValue ?? null,
    params.assignedEmployeeId ?? null,
    params.locationId ?? null,
    params.actorUserId,
    params.actorName,
    resolvedRole,
    params.notes ?? null
  );
}

router.get('/assets', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const whereParts: string[] = [];
  const params: any[] = [];

  if (user.role === 'employee') {
    whereParts.push('a.assigned_employee_id = ?');
    params.push(user.employee_id ?? -1);
  } else if (user.role === 'management') {
    const policy = getAdminPermissionPolicy(user);
    if (policy.allowed_location_ids.length > 0) {
      whereParts.push(`a.location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')})`);
      params.push(...policy.allowed_location_ids);
    }
  }
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const assets = db
    .prepare(
      `SELECT a.*,
              COALESCE(a.device_name, TRIM(COALESCE(a.brand, '') || ' ' || COALESCE(a.model, ''))) as device_name,
              l.name as location_name, l.code as location_code,
              e.full_name as assigned_employee_name, e.employee_code as assigned_employee_code, e.email as assigned_employee_email,
              (SELECT COUNT(*) FROM tickets t WHERE t.asset_id = a.id) as linked_tickets,
              (SELECT COUNT(*) FROM asset_maintenance am WHERE am.asset_id = a.id) as repair_count,
              (SELECT COALESCE(SUM(am.cost), 0) FROM asset_maintenance am WHERE am.asset_id = a.id) as total_maintenance_cost
       FROM it_assets a
       LEFT JOIN locations l ON a.location_id = l.id
       LEFT JOIN employees e ON a.assigned_employee_id = e.id
       ${whereSql}
       ORDER BY a.asset_tag ASC`
    )
    .all(...params);
  res.json({ assets });
});

router.get('/assets/import-template', requireAuth, requireRole('super_admin', 'management'), (_req, res) => {
  const sampleRows = [
    {
      'Device Name': 'Dell Latitude 5430 Laptop',
      'Asset ID': 'SDGL-LAP-101',
      'Serial Number': 'SN-DL5430-9901',
      Category: 'Laptop',
      Brand: 'Dell',
      Model: 'Latitude 5430',
      'Purchase Date': '2025-04-15',
      'Purchase Cost (INR)': 68500,
      'Warranty Expiry': '2028-04-14',
      'Warranty Provider': 'Dell ProSupport India',
      'Service Contract': 'AMC-3YR-ONSITE',
      'Location Code': 'BOM-HUB-01',
      'Assigned Employee Email': '',
      Status: 'Operational',
      Notes: 'Issued to Operations lead',
    },
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sampleRows);
  XLSX.utils.book_append_sheet(wb, ws, 'IT_Assets');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sdglobal-it-assets-template.xlsx"');
  res.send(buf);
});

router.get('/assets/import-batches', requireAuth, requireRole('super_admin', 'management'), (_req, res) => {
  const batches = db
    .prepare(
      `SELECT b.*, u.full_name as imported_by_name
       FROM asset_import_batches b
       LEFT JOIN users u ON b.imported_by_user_id = u.id
       ORDER BY b.id DESC LIMIT 25`
    )
    .all();
  res.json({ batches });
});

function formatExcelDateValue(val: any): string {
  if (!val) return '';
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return '';
}

function normalizeHeaderKey(key: string): string {
  return String(key || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

router.post('/assets/import-excel', requireAuth, requireRole('super_admin', 'management'), excelUpload.single('file'), (req: AuthRequest, res) => {
  const user = req.user!;
  if (user.role === 'management' && !getAdminPermissionPolicy(user).can_manage_assets) {
    logUnauthorizedAttempt(req, 'assets_import_excel', null);
    return res.status(403).json({ error: 'You do not have permission to import IT assets' });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Please upload an Excel file (.xlsx or .xls)' });
  }

  const fileCheck = validateFileBufferOrDisk(file, 'excel');
  if (!fileCheck.ok) {
    return res.status(400).json({ error: fileCheck.error });
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
  } catch (err: any) {
    return res.status(400).json({ error: `Unable to parse Excel workbook: ${err.message}` });
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return res.status(400).json({ error: 'Excel workbook does not contain any worksheet' });
  }

  const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[firstSheetName], { defval: '' });
  if (rawRows.length === 0) {
    return res.status(400).json({ error: 'Uploaded Excel worksheet is empty' });
  }

  const locations = db.prepare('SELECT id, code, name FROM locations').all() as Array<{ id: number; code: string; name: string }>;
  const employees = db.prepare('SELECT id, email, employee_code, full_name FROM employees').all() as Array<{
    id: number;
    email: string;
    employee_code: string;
    full_name: string;
  }>;
  const existingTags = new Set(
    (db.prepare('SELECT lower(asset_tag) as t FROM it_assets').all() as Array<{ t: string }>).map((r) => r.t)
  );
  const existingSerials = new Set(
    (db.prepare('SELECT lower(serial_number) as s FROM it_assets').all() as Array<{ s: string }>).map((r) => r.s)
  );

  const locByCodeOrName = new Map<string, number>();
  for (const l of locations) {
    locByCodeOrName.set(l.code.trim().toLowerCase(), l.id);
    locByCodeOrName.set(l.name.trim().toLowerCase(), l.id);
  }
  const empByKey = new Map<string, number>();
  for (const e of employees) {
    if (e.email) empByKey.set(e.email.trim().toLowerCase(), e.id);
    if (e.employee_code) empByKey.set(e.employee_code.trim().toLowerCase(), e.id);
  }

  const VALID_STATUSES = new Set(['Operational', 'Under Repair', 'Decommissioned', 'Spare']);
  const seenTagsInSheet = new Set<string>();
  const seenSerialsInSheet = new Set<string>();

  const validRecords: any[] = [];
  const errors: Array<{ row: number; asset_tag?: string; serial_number?: string; error: string }> = [];

  rawRows.forEach((rawRow, idx) => {
    const rowNumber = idx + 2; // Excel 1-indexed + header
    const norm: Record<string, any> = {};
    for (const [k, v] of Object.entries(rawRow)) {
      norm[normalizeHeaderKey(k)] = v;
    }

    const assetTag = String(norm.assetid || norm.assettag || norm.uniqueassetid || '').trim();
    const serialNumber = String(norm.serialnumber || norm.serial || norm.serialno || '').trim();
    const category = String(norm.category || norm.type || norm.devicetype || '').trim();
    const brand = String(norm.brand || norm.manufacturer || '').trim();
    const model = String(norm.model || '').trim();
    const deviceName = String(norm.devicename || norm.name || `${brand} ${model}`.trim()).trim();
    const purchaseDate = formatExcelDateValue(norm.purchasedate || norm.dateofpurchase);
    const rawCost = norm.purchasecostinr ?? norm.purchasecost ?? norm.costinr ?? norm.cost ?? 0;
    const costNum = rawCost === '' ? 0 : Number(String(rawCost).replace(/[₹,\s]/g, ''));
    const warrantyExpiry = formatExcelDateValue(norm.warrantyexpiry || norm.warrantyenddate);
    const warrantyProvider = String(norm.warrantyprovider || norm.serviceprovider || '').trim();
    const serviceContract = String(norm.servicecontract || norm.servicedetails || norm.amc || '').trim();
    const locKey = String(norm.locationcode || norm.location || norm.branch || norm.hub || '').trim().toLowerCase();
    const empKey = String(norm.assignedemployeeemail || norm.assignedemployee || norm.employeecode || norm.employeeemail || '')
      .trim()
      .toLowerCase();
    const statusRaw = String(norm.status || norm.conditionstatus || 'Operational').trim() || 'Operational';
    const notes = String(norm.notes || '').trim();

    if (!assetTag) {
      errors.push({ row: rowNumber, serial_number: serialNumber, error: 'Missing required Asset ID / Asset Tag' });
      return;
    }
    if (!serialNumber) {
      errors.push({ row: rowNumber, asset_tag: assetTag, error: 'Missing required Serial Number' });
      return;
    }
    if (!category || !brand || !model) {
      errors.push({
        row: rowNumber,
        asset_tag: assetTag,
        serial_number: serialNumber,
        error: 'Category, Brand, and Model are required',
      });
      return;
    }
    if (!purchaseDate) {
      errors.push({
        row: rowNumber,
        asset_tag: assetTag,
        serial_number: serialNumber,
        error: 'Valid Purchase Date (YYYY-MM-DD) is required',
      });
      return;
    }
    if (isNaN(costNum) || costNum < 0) {
      errors.push({
        row: rowNumber,
        asset_tag: assetTag,
        serial_number: serialNumber,
        error: `Invalid Purchase Cost (INR): "${rawCost}"`,
      });
      return;
    }
    if (!VALID_STATUSES.has(statusRaw)) {
      errors.push({
        row: rowNumber,
        asset_tag: assetTag,
        serial_number: serialNumber,
        error: `Invalid Status "${statusRaw}". Allowed: Operational, Under Repair, Decommissioned, Spare`,
      });
      return;
    }

    const tagKey = assetTag.toLowerCase();
    const serialKey = serialNumber.toLowerCase();
    if (seenTagsInSheet.has(tagKey) || existingTags.has(tagKey)) {
      errors.push({
        row: rowNumber,
        asset_tag: assetTag,
        serial_number: serialNumber,
        error: `Duplicate Asset ID "${assetTag}" (already exists in database or worksheet)`,
      });
      return;
    }
    if (seenSerialsInSheet.has(serialKey) || existingSerials.has(serialKey)) {
      errors.push({
        row: rowNumber,
        asset_tag: assetTag,
        serial_number: serialNumber,
        error: `Duplicate Serial Number "${serialNumber}" (already exists in database or worksheet)`,
      });
      return;
    }

    let resolvedLocId: number | null = null;
    if (locKey) {
      resolvedLocId = locByCodeOrName.get(locKey) ?? null;
      if (!resolvedLocId) {
        errors.push({
          row: rowNumber,
          asset_tag: assetTag,
          serial_number: serialNumber,
          error: `Unknown Location Code/Name "${locKey}"`,
        });
        return;
      }
    }

    let resolvedEmpId: number | null = null;
    if (empKey) {
      resolvedEmpId = empByKey.get(empKey) ?? null;
      if (!resolvedEmpId) {
        errors.push({
          row: rowNumber,
          asset_tag: assetTag,
          serial_number: serialNumber,
          error: `No matching employee found for "${empKey}"`,
        });
        return;
      }
    }

    seenTagsInSheet.add(tagKey);
    seenSerialsInSheet.add(serialKey);

    validRecords.push({
      rowNumber,
      asset_tag: assetTag,
      serial_number: serialNumber,
      device_name: deviceName,
      category,
      brand,
      model,
      purchase_date: purchaseDate,
      purchase_cost: costNum,
      warranty_expiry: warrantyExpiry || null,
      warranty_provider: warrantyProvider || null,
      service_contract: serviceContract || null,
      location_id: resolvedLocId,
      assigned_employee_id: resolvedEmpId,
      condition_status: statusRaw,
      notes,
    });
  });

  const imported: Array<{ id: number; asset_tag: string; serial_number: string; device_name: string }> = [];
  const batchId = db.transaction(() => {
    const insAsset = db.prepare(
      `INSERT INTO it_assets (
        asset_tag, serial_number, device_name, category, brand, model,
        purchase_date, purchase_cost, warranty_expiry, warranty_provider, service_contract,
        assigned_employee_id, location_id, condition_status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const item of validRecords) {
      const r = insAsset.run(
        item.asset_tag,
        item.serial_number,
        item.device_name,
        item.category,
        item.brand,
        item.model,
        item.purchase_date,
        item.purchase_cost,
        item.warranty_expiry,
        item.warranty_provider,
        item.service_contract,
        item.assigned_employee_id,
        item.location_id,
        item.condition_status,
        item.notes
      );
      const newAssetId = Number(r.lastInsertRowid);
      recordAssetHistory({
        assetId: newAssetId,
        eventType: 'Imported',
        newValue: `${item.asset_tag} (${item.condition_status})`,
        assignedEmployeeId: item.assigned_employee_id,
        locationId: item.location_id,
        actorUserId: user.id,
        actorName: user.full_name,
        notes: `Imported from Excel file "${file.originalname}" (row ${item.rowNumber})`,
      });
      imported.push({
        id: newAssetId,
        asset_tag: item.asset_tag,
        serial_number: item.serial_number,
        device_name: item.device_name,
      });
    }

    const bRes = db
      .prepare(
        `INSERT INTO asset_import_batches (filename, total_rows, imported_count, failed_count, errors_json, imported_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(file.originalname, rawRows.length, imported.length, errors.length, JSON.stringify(errors), user.id);

    return Number(bRes.lastInsertRowid);
  })();

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'IMPORT_ASSETS_EXCEL',
    entityType: 'asset_import_batch',
    entityId: String(batchId),
    details: {
      filename: file.originalname,
      total_rows: rawRows.length,
      imported_count: imported.length,
      failed_count: errors.length,
    },
    ipAddress: req.ip,
  });

  if (imported.length > 0) {
    broadcastAll('asset:updated', { action: 'excel_import', importedCount: imported.length });
  }

  res.status(imported.length > 0 ? 201 : 200).json({
    batchId,
    filename: file.originalname,
    totalRows: rawRows.length,
    importedCount: imported.length,
    failedCount: errors.length,
    imported,
    errors,
  });
});

router.post('/assets', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  if (req.user!.role === 'management' && !getAdminPermissionPolicy(req.user!).can_manage_assets) {
    logUnauthorizedAttempt(req, 'create_asset', null);
    return res.status(403).json({ error: 'You do not have permission to register IT assets' });
  }

  const {
    asset_tag,
    serial_number,
    device_name,
    category,
    brand,
    model,
    purchase_date,
    purchase_cost,
    warranty_expiry,
    warranty_provider,
    service_contract,
    assigned_employee_id,
    location_id,
    condition_status,
    notes,
  } = req.body;
  if (!asset_tag || !serial_number || !category || !brand || !model || !purchase_date) {
    return res.status(400).json({ error: 'Asset tag, serial number, category, brand, model, and purchase date are required' });
  }
  const cleanDeviceName = (device_name || `${brand} ${model}`).trim();

  try {
    const newId = db.transaction(() => {
      const r = db
        .prepare(
          `INSERT INTO it_assets (
            asset_tag, serial_number, device_name, category, brand, model,
            purchase_date, purchase_cost, warranty_expiry, warranty_provider, service_contract,
            assigned_employee_id, location_id, condition_status, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          asset_tag.trim(),
          serial_number.trim(),
          cleanDeviceName,
          category,
          brand.trim(),
          model.trim(),
          purchase_date,
          Number(purchase_cost) || 0,
          warranty_expiry || null,
          warranty_provider?.trim() || null,
          service_contract?.trim() || null,
          assigned_employee_id ? Number(assigned_employee_id) : null,
          location_id ? Number(location_id) : null,
          condition_status || 'Operational',
          notes || ''
        );
      const id = Number(r.lastInsertRowid);
      recordAssetHistory({
        assetId: id,
        eventType: 'Created',
        newValue: `${asset_tag.trim()} · ${condition_status || 'Operational'}`,
        assignedEmployeeId: assigned_employee_id ? Number(assigned_employee_id) : null,
        locationId: location_id ? Number(location_id) : null,
        actorUserId: req.user!.id,
        actorName: req.user!.full_name,
        notes: 'Asset registered in IT Inventory',
      });
      return id;
    })();

    writeAuditLog({
      userId: req.user!.id,
      userEmail: req.user!.email,
      roleName: req.user!.role,
      action: 'CREATE_ASSET',
      entityType: 'asset',
      entityId: asset_tag,
      ipAddress: req.ip,
    });
    broadcastAll('asset:updated', { action: 'created', assetId: newId });
    res.status(201).json({ id: newId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/assets/:id', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  if (req.user!.role === 'management' && !getAdminPermissionPolicy(req.user!).can_manage_assets) {
    logUnauthorizedAttempt(req, 'update_asset', req.params.id);
    return res.status(403).json({ error: 'You do not have permission to update IT assets' });
  }

  const assetId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM it_assets WHERE id = ?').get(assetId) as any;
  if (!existing) return res.status(404).json({ error: 'Asset not found' });

  const {
    device_name,
    category,
    brand,
    model,
    purchase_date,
    purchase_cost,
    warranty_expiry,
    warranty_provider,
    service_contract,
    condition_status,
    location_id,
    assigned_employee_id,
    notes,
  } = req.body;

  const hasAssignedEmployee = assigned_employee_id !== undefined ? 1 : 0;
  const nextEmployeeId = assigned_employee_id ? Number(assigned_employee_id) : null;
  const hasLocation = location_id !== undefined ? 1 : 0;
  const nextLocationId = location_id ? Number(location_id) : null;

  db.transaction(() => {
    db.prepare(
      `UPDATE it_assets
       SET device_name = COALESCE(?, device_name),
           category = COALESCE(?, category),
           brand = COALESCE(?, brand),
           model = COALESCE(?, model),
           purchase_date = COALESCE(?, purchase_date),
           purchase_cost = COALESCE(?, purchase_cost),
           warranty_expiry = COALESCE(?, warranty_expiry),
           warranty_provider = COALESCE(?, warranty_provider),
           service_contract = COALESCE(?, service_contract),
           condition_status = COALESCE(?, condition_status),
           location_id = CASE WHEN ? = 1 THEN ? ELSE location_id END,
           assigned_employee_id = CASE WHEN ? = 1 THEN ? ELSE assigned_employee_id END,
           notes = COALESCE(?, notes)
       WHERE id = ?`
    ).run(
      device_name ?? null,
      category ?? null,
      brand ?? null,
      model ?? null,
      purchase_date ?? null,
      purchase_cost !== undefined ? Number(purchase_cost) : null,
      warranty_expiry !== undefined ? warranty_expiry || null : null,
      warranty_provider !== undefined ? warranty_provider || null : null,
      service_contract !== undefined ? service_contract || null : null,
      condition_status ?? null,
      hasLocation,
      nextLocationId,
      hasAssignedEmployee,
      nextEmployeeId,
      notes ?? null,
      assetId
    );

    if (condition_status && condition_status !== existing.condition_status) {
      recordAssetHistory({
        assetId,
        eventType: 'Status Changed',
        previousValue: existing.condition_status,
        newValue: condition_status,
        assignedEmployeeId: hasAssignedEmployee ? nextEmployeeId : existing.assigned_employee_id,
        locationId: hasLocation ? nextLocationId : existing.location_id,
        actorUserId: req.user!.id,
        actorName: req.user!.full_name,
        notes: notes || `Status updated from ${existing.condition_status} to ${condition_status}`,
      });
    }

    if (hasAssignedEmployee && nextEmployeeId !== existing.assigned_employee_id) {
      const prevEmp = existing.assigned_employee_id
        ? (db.prepare('SELECT full_name FROM employees WHERE id = ?').get(existing.assigned_employee_id) as any)?.full_name
        : 'Unassigned';
      const newEmp = nextEmployeeId
        ? (db.prepare('SELECT full_name FROM employees WHERE id = ?').get(nextEmployeeId) as any)?.full_name
        : 'Unassigned';
      recordAssetHistory({
        assetId,
        eventType: nextEmployeeId ? 'Assigned' : 'Unassigned',
        previousValue: prevEmp || 'Unassigned',
        newValue: newEmp || 'Unassigned',
        assignedEmployeeId: nextEmployeeId,
        locationId: hasLocation ? nextLocationId : existing.location_id,
        actorUserId: req.user!.id,
        actorName: req.user!.full_name,
        notes: `Device assignment changed from ${prevEmp || 'Unassigned'} to ${newEmp || 'Unassigned'}`,
      });
    }

    if (hasLocation && nextLocationId !== existing.location_id) {
      const prevLoc = existing.location_id
        ? (db.prepare('SELECT name FROM locations WHERE id = ?').get(existing.location_id) as any)?.name
        : 'Unassigned';
      const newLoc = nextLocationId
        ? (db.prepare('SELECT name FROM locations WHERE id = ?').get(nextLocationId) as any)?.name
        : 'Unassigned';
      recordAssetHistory({
        assetId,
        eventType: 'Transferred',
        previousValue: prevLoc || 'Unassigned',
        newValue: newLoc || 'Unassigned',
        assignedEmployeeId: hasAssignedEmployee ? nextEmployeeId : existing.assigned_employee_id,
        locationId: nextLocationId,
        actorUserId: req.user!.id,
        actorName: req.user!.full_name,
        actorRole: req.user!.role,
        notes: `Location changed from ${prevLoc || 'Unassigned'} to ${newLoc || 'Unassigned'}`,
      });
    }

    const changedMetaFields: string[] = [];
    if (device_name !== undefined && device_name !== existing.device_name) changedMetaFields.push('device_name');
    if (category !== undefined && category !== existing.category) changedMetaFields.push('category');
    if (brand !== undefined && brand !== existing.brand) changedMetaFields.push('brand');
    if (model !== undefined && model !== existing.model) changedMetaFields.push('model');
    if (purchase_date !== undefined && purchase_date !== existing.purchase_date) changedMetaFields.push('purchase_date');
    if (purchase_cost !== undefined && Number(purchase_cost) !== Number(existing.purchase_cost)) changedMetaFields.push('purchase_cost');
    if (warranty_expiry !== undefined && (warranty_expiry || null) !== (existing.warranty_expiry || null)) changedMetaFields.push('warranty_expiry');
    if (warranty_provider !== undefined && (warranty_provider || null) !== (existing.warranty_provider || null)) changedMetaFields.push('warranty_provider');
    if (service_contract !== undefined && (service_contract || null) !== (existing.service_contract || null)) changedMetaFields.push('service_contract');
    if (notes !== undefined && (notes || '') !== (existing.notes || '')) changedMetaFields.push('notes');

    if (changedMetaFields.length > 0) {
      recordAssetHistory({
        assetId,
        eventType: 'Details Updated',
        previousValue: existing.device_name || `${existing.brand} ${existing.model}`,
        newValue: changedMetaFields.join(', '),
        assignedEmployeeId: hasAssignedEmployee ? nextEmployeeId : existing.assigned_employee_id,
        locationId: hasLocation ? nextLocationId : existing.location_id,
        actorUserId: req.user!.id,
        actorName: req.user!.full_name,
        actorRole: req.user!.role,
        notes: `Updated fields: ${changedMetaFields.join(', ')}`,
      });
    }
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_ASSET',
    entityType: 'asset',
    entityId: String(assetId),
    details: { condition_status, location_id, assigned_employee_id, notes },
    ipAddress: req.ip,
  });
  broadcastAll('asset:updated', { action: 'updated', assetId });
  res.json({ ok: true });
});

router.get('/assets/:id/maintenance', requireAuth, (req: AuthRequest, res) => {
  const assetId = Number(req.params.id);
  const asset = db
    .prepare(
      `SELECT a.*, COALESCE(a.device_name, TRIM(COALESCE(a.brand, '') || ' ' || COALESCE(a.model, ''))) as device_name,
              l.name as location_name, l.code as location_code,
              e.full_name as assigned_employee_name, e.employee_code as assigned_employee_code
       FROM it_assets a
       LEFT JOIN locations l ON a.location_id = l.id
       LEFT JOIN employees e ON a.assigned_employee_id = e.id
       WHERE a.id = ?`
    )
    .get(assetId) as any;

  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (req.user!.role === 'employee' && asset.assigned_employee_id !== req.user!.employee_id) {
    logUnauthorizedAttempt(req, 'asset_maintenance', assetId);
    return res.status(403).json({ error: 'Access denied to this asset' });
  }

  const maintenance = db
    .prepare(
      `SELECT am.*, v.name as vendor_name, t.ticket_number
       FROM asset_maintenance am
       LEFT JOIN vendors v ON am.vendor_id = v.id
       LEFT JOIN tickets t ON am.ticket_id = t.id
       WHERE am.asset_id = ?
       ORDER BY am.performed_at DESC, am.id DESC`
    )
    .all(assetId) as any[];

  const linkedTickets = db
    .prepare('SELECT id, ticket_number, category, priority, status, created_at FROM tickets WHERE asset_id = ? ORDER BY created_at DESC')
    .all(assetId);

  const history = db
    .prepare(
      `SELECT ah.*, l.name as location_name, e.full_name as employee_name
       FROM asset_history ah
       LEFT JOIN locations l ON ah.location_id = l.id
       LEFT JOIN employees e ON ah.assigned_employee_id = e.id
       WHERE ah.asset_id = ?
       ORDER BY ah.created_at DESC, ah.id DESC`
    )
    .all(assetId);

  const totalRepairCost = maintenance.reduce((sum, m) => sum + (Number(m.cost) || 0), 0);

  res.json({
    asset,
    maintenance,
    linkedTickets,
    history,
    summary: {
      repairCount: maintenance.length,
      totalRepairCost,
      purchaseCost: Number(asset.purchase_cost) || 0,
      totalLifecycleCost: (Number(asset.purchase_cost) || 0) + totalRepairCost,
    },
  });
});

router.post('/assets/:id/maintenance', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  if (req.user!.role === 'management' && !getAdminPermissionPolicy(req.user!).can_manage_assets) {
    logUnauthorizedAttempt(req, 'log_asset_maintenance', req.params.id);
    return res.status(403).json({ error: 'You do not have permission to log asset maintenance' });
  }

  const assetId = Number(req.params.id);
  const asset = db.prepare('SELECT * FROM it_assets WHERE id = ?').get(assetId) as any;
  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const { ticket_id, maintenance_type, description, vendor_id, cost, performed_at, performed_by, next_status } = req.body;
  if (!description || !maintenance_type) {
    return res.status(400).json({ error: 'Maintenance type and description are required' });
  }
  const numericCost = Number(cost) || 0;
  const dateStr = performed_at || new Date().toISOString().slice(0, 10);

  const newMaintId = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO asset_maintenance (asset_id, ticket_id, maintenance_type, description, vendor_id, cost, performed_at, performed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        assetId,
        ticket_id ? Number(ticket_id) : null,
        maintenance_type,
        description,
        vendor_id ? Number(vendor_id) : null,
        numericCost,
        dateStr,
        performed_by || req.user!.full_name
      );

    if (next_status && ['Operational', 'Under Repair', 'Decommissioned', 'Spare'].includes(next_status) && next_status !== asset.condition_status) {
      db.prepare('UPDATE it_assets SET condition_status = ? WHERE id = ?').run(next_status, assetId);
    }

    recordAssetHistory({
      assetId,
      eventType: 'Maintenance',
      previousValue: asset.condition_status,
      newValue: `${maintenance_type} (₹${numericCost.toLocaleString('en-IN')})`,
      assignedEmployeeId: asset.assigned_employee_id,
      locationId: asset.location_id,
      actorUserId: req.user!.id,
      actorName: performed_by || req.user!.full_name,
      notes: description,
    });

    return Number(r.lastInsertRowid);
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'LOG_ASSET_MAINTENANCE',
    entityType: 'asset',
    entityId: String(assetId),
    details: { maintenance_type, cost: numericCost, description },
    ipAddress: req.ip,
  });
  broadcastAll('asset:updated', { action: 'maintenance', assetId });
  res.status(201).json({ id: newMaintId });
});

// --- IT BUDGETS & EXPENSES (INR ₹) ---
router.get('/budgets', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  const user = req.user!;
  const policy = getAdminPermissionPolicy(user);
  if (!policy.can_view_budgets) {
    logUnauthorizedAttempt(req, 'budgets', null);
    return res.status(403).json({ error: 'Access denied: IT Budget access is restricted for your account' });
  }

  const year = Number(req.query.year) || new Date().getFullYear();
  const yearStr = String(year);

  const budgetWhere: string[] = ['b.fiscal_year = ?'];
  const budgetParams: any[] = [year];
  const expenseWhere: string[] = ["strftime('%Y', e.payment_date) = ?"];
  const expenseParams: any[] = [yearStr];

  if (user.role === 'management' && policy.allowed_location_ids.length > 0) {
    const ph = policy.allowed_location_ids.map(() => '?').join(',');
    budgetWhere.push(`(b.location_id IS NULL OR b.location_id IN (${ph}))`);
    budgetParams.push(...policy.allowed_location_ids);
    expenseWhere.push(`e.location_id IN (${ph})`);
    expenseParams.push(...policy.allowed_location_ids);
  }

  const budgets = db
    .prepare(
      `SELECT b.*, l.name as location_name, l.code as location_code
       FROM it_budgets b
       LEFT JOIN locations l ON b.location_id = l.id
       WHERE ${budgetWhere.join(' AND ')}
       ORDER BY b.month ASC, b.location_id ASC, b.id DESC`
    )
    .all(...budgetParams) as any[];

  const expenses = db
    .prepare(
      `SELECT e.*, l.name as location_name, l.code as location_code, t.ticket_number,
              u.full_name as approved_by_name, cu.full_name as created_by_name
       FROM expenses e
       LEFT JOIN locations l ON e.location_id = l.id
       LEFT JOIN tickets t ON e.ticket_id = t.id
       LEFT JOIN users u ON e.approved_by_user_id = u.id
       LEFT JOIN users cu ON e.created_by_user_id = cu.id
       WHERE ${expenseWhere.join(' AND ')}
       ORDER BY e.payment_date DESC, e.id DESC`
    )
    .all(...expenseParams) as any[];

  // Compute global company-wide annual budget OR sum of scoped/location/category allocations cleanly
  const globalAnnualTotal = budgets
    .filter((b) => Number(b.month) === 0 && !b.location_id && !b.category)
    .reduce((sum, b) => sum + (Number(b.allocated_amount) || 0), 0);
  const specificAllocatedTotal = budgets
    .filter((b) => !(Number(b.month) === 0 && !b.location_id && !b.category))
    .reduce((sum, b) => sum + (Number(b.allocated_amount) || 0), 0);
  const totalAnnualBudget = globalAnnualTotal > 0 ? globalAnnualTotal : specificAllocatedTotal;

  const totalApprovedSpent = expenses
    .filter((e) => e.approval_status === 'Approved')
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const totalPendingSpent = expenses
    .filter((e) => e.approval_status === 'Pending')
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const totalRejectedSpent = expenses
    .filter((e) => e.approval_status === 'Rejected')
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

  const rawRemaining = totalAnnualBudget - totalApprovedSpent;

  const locScopeClause =
    user.role === 'management' && policy.allowed_location_ids.length > 0
      ? `WHERE l.id IN (${policy.allowed_location_ids.map(() => '?').join(',')})`
      : '';
  const locScopeParams = user.role === 'management' && policy.allowed_location_ids.length > 0 ? policy.allowed_location_ids : [];

  const locationSummary = db
    .prepare(
      `SELECT l.id as location_id, l.name as location_name, l.code as location_code,
              COALESCE((SELECT SUM(allocated_amount) FROM it_budgets b WHERE b.location_id = l.id AND b.fiscal_year = ?), 0) as allocated,
              COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.location_id = l.id AND strftime('%Y', e.payment_date) = ? AND e.approval_status = 'Approved'), 0) as spent,
              COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.location_id = l.id AND strftime('%Y', e.payment_date) = ? AND e.approval_status = 'Pending'), 0) as pending
       FROM locations l
       ${locScopeClause}
       ORDER BY l.name ASC`
    )
    .all(year, yearStr, yearStr, ...locScopeParams)
    .map((row: any) => ({
      ...row,
      remaining: Math.max(0, (Number(row.allocated) || 0) - (Number(row.spent) || 0)),
    }));

  // Build Category-Wise summary across all expense categories & budget category allocations
  const expCatRows = db
    .prepare("SELECT label FROM dropdown_options WHERE group_key = 'expense_category' AND is_active = 1 ORDER BY sort_order ASC")
    .all() as Array<{ label: string }>;
  const categorySet = new Set<string>(expCatRows.map((c) => c.label));
  budgets.forEach((b) => {
    if (b.category) categorySet.add(b.category);
  });
  expenses.forEach((e) => {
    if (e.category) categorySet.add(e.category);
  });

  const categorySummary = Array.from(categorySet).map((cat) => {
    const allocated = budgets
      .filter((b) => b.category === cat)
      .reduce((sum, b) => sum + (Number(b.allocated_amount) || 0), 0);
    const spent = expenses
      .filter((e) => e.category === cat && e.approval_status === 'Approved')
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const pending = expenses
      .filter((e) => e.category === cat && e.approval_status === 'Pending')
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    const count = expenses.filter((e) => e.category === cat).length;
    return {
      category: cat,
      allocated,
      spent,
      pending,
      remaining: allocated > 0 ? allocated - spent : null,
      count,
    };
  });

  const approvalHistory = db
    .prepare(
      `SELECT ea.*, e.invoice_number, e.vendor_name, e.amount, e.category
       FROM expense_approvals ea
       JOIN expenses e ON ea.expense_id = e.id
       WHERE strftime('%Y', e.payment_date) = ?
       ORDER BY ea.created_at DESC, ea.id DESC
       LIMIT 60`
    )
    .all(yearStr);

  res.json({
    year,
    currency: 'INR',
    budgets,
    expenses,
    summary: {
      totalAnnualBudget,
      globalAnnualTotal,
      specificAllocatedTotal,
      totalApprovedSpent,
      totalPendingSpent,
      totalRejectedSpent,
      remainingBudget: Math.max(0, rawRemaining),
      netBalance: rawRemaining,
      utilizationPct: totalAnnualBudget > 0 ? Math.round((totalApprovedSpent / totalAnnualBudget) * 1000) / 10 : 0,
    },
    locationSummary,
    categorySummary,
    approvalHistory,
  });
});

router.post('/budgets', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  if (req.user!.role === 'management' && !getAdminPermissionPolicy(req.user!).can_manage_budgets) {
    logUnauthorizedAttempt(req, 'create_budget', null);
    return res.status(403).json({ error: 'You do not have permission to create or modify budgets' });
  }
  const { fiscal_year, month, location_id, category, allocated_amount, notes } = req.body;
  if (!fiscal_year || allocated_amount === undefined || isNaN(Number(allocated_amount)) || Number(allocated_amount) < 0) {
    return res.status(400).json({ error: 'Valid fiscal year and non-negative allocated amount (INR) are required' });
  }
  const r = db
    .prepare(
      `INSERT INTO it_budgets (fiscal_year, month, location_id, category, allocated_amount, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(fiscal_year),
      Number(month) || 0,
      location_id ? Number(location_id) : null,
      category && category !== 'All' ? String(category).trim() : null,
      Number(allocated_amount),
      notes || '',
      req.user!.id
    );
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'CREATE_BUDGET',
    entityType: 'budget',
    entityId: String(r.lastInsertRowid),
    details: { fiscal_year, month, location_id: location_id || null, category: category || null, allocated_amount_inr: allocated_amount },
    ipAddress: req.ip,
  });
  broadcastAll('budget:updated', { action: 'budget_created', fiscal_year: Number(fiscal_year) });
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/budgets/:id', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  if (req.user!.role === 'management' && !getAdminPermissionPolicy(req.user!).can_manage_budgets) {
    logUnauthorizedAttempt(req, 'update_budget', req.params.id);
    return res.status(403).json({ error: 'You do not have permission to update budgets' });
  }
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM it_budgets WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'Budget allocation not found' });

  const { fiscal_year, month, location_id, category, allocated_amount, notes } = req.body;
  if (allocated_amount !== undefined && (isNaN(Number(allocated_amount)) || Number(allocated_amount) < 0)) {
    return res.status(400).json({ error: 'Allocated amount (INR) must be a non-negative number' });
  }

  db.prepare(
    `UPDATE it_budgets
     SET fiscal_year = COALESCE(?, fiscal_year),
         month = COALESCE(?, month),
         location_id = ?,
         category = ?,
         allocated_amount = COALESCE(?, allocated_amount),
         notes = COALESCE(?, notes)
     WHERE id = ?`
  ).run(
    fiscal_year !== undefined ? Number(fiscal_year) : null,
    month !== undefined ? Number(month) : null,
    location_id !== undefined ? (location_id ? Number(location_id) : null) : existing.location_id,
    category !== undefined ? (category && category !== 'All' ? String(category).trim() : null) : existing.category,
    allocated_amount !== undefined ? Number(allocated_amount) : null,
    notes !== undefined ? notes : null,
    id
  );

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_BUDGET',
    entityType: 'budget',
    entityId: String(id),
    details: { previous_amount: existing.allocated_amount, new_amount: allocated_amount, notes },
    ipAddress: req.ip,
  });
  broadcastAll('budget:updated', { action: 'budget_updated', id });
  res.json({ ok: true });
});

router.delete('/budgets/:id', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM it_budgets WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'Budget allocation not found' });
  db.prepare('DELETE FROM it_budgets WHERE id = ?').run(id);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'DELETE_BUDGET',
    entityType: 'budget',
    entityId: String(id),
    details: { fiscal_year: existing.fiscal_year, allocated_amount_inr: existing.allocated_amount },
    ipAddress: req.ip,
  });
  broadcastAll('budget:updated', { action: 'budget_deleted', id });
  res.json({ ok: true });
});

router.post('/expenses', requireAuth, requireRole('super_admin', 'management'), invoiceUpload.single('invoice'), (req: AuthRequest, res) => {
  const user = req.user!;
  if (user.role === 'management' && !getAdminPermissionPolicy(user).can_manage_budgets) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    logUnauthorizedAttempt(req, 'log_expense', null);
    return res.status(403).json({ error: 'You do not have permission to log expenses' });
  }
  if (req.file) {
    const fileErr = validateAndCleanDiskFiles([req.file], 'invoice');
    if (fileErr) return res.status(400).json({ error: fileErr });
  }

  const { category, ticket_id, vendor_id, vendor_name, location_id, amount, invoice_number, payment_date, description } = req.body;
  if (!category || !vendor_name || !amount || !invoice_number || !payment_date) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    return res.status(400).json({ error: 'Category, vendor name, amount (INR), invoice number, and payment date are required' });
  }
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'Expense amount (INR) must be greater than 0' });
  }

  const filePath = req.file ? req.file.filename : null;
  const approvalStatus = user.role === 'super_admin' ? 'Approved' : 'Pending';
  const approvedBy = user.role === 'super_admin' ? user.id : null;

  const r = db
    .prepare(
      `INSERT INTO expenses (category, ticket_id, vendor_id, vendor_name, location_id, amount, invoice_number, invoice_attachment_path, payment_date, approval_status, approved_by_user_id, description, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      category,
      ticket_id ? Number(ticket_id) : null,
      vendor_id ? Number(vendor_id) : null,
      vendor_name.trim(),
      location_id ? Number(location_id) : null,
      numericAmount,
      invoice_number.trim(),
      filePath,
      payment_date,
      approvalStatus,
      approvedBy,
      description || '',
      user.id
    );

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'LOG_EXPENSE',
    entityType: 'expense',
    entityId: String(r.lastInsertRowid),
    details: { amount_inr: numericAmount, invoice_number, category, approvalStatus },
    ipAddress: req.ip,
  });

  broadcastAll('budget:updated', { action: 'expense_created', expenseId: Number(r.lastInsertRowid) });
  res.status(201).json({ id: r.lastInsertRowid });
});

router.post('/expenses/:id/approve', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  if (req.user!.role === 'management' && !getAdminPermissionPolicy(req.user!).can_approve_expenses) {
    logUnauthorizedAttempt(req, 'approve_expense', req.params.id);
    return res.status(403).json({ error: 'You do not have permission to approve or reject expenses' });
  }
  const expenseId = Number(req.params.id);
  const { decision, remarks } = req.body as { decision: 'Approved' | 'Rejected'; remarks?: string };
  if (!['Approved', 'Rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision' });
  }
  const existing = db.prepare('SELECT id, amount, invoice_number FROM expenses WHERE id = ?').get(expenseId) as any;
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  db.prepare('UPDATE expenses SET approval_status = ?, approved_by_user_id = ? WHERE id = ?').run(
    decision,
    req.user!.id,
    expenseId
  );
  db.prepare(
    'INSERT INTO expense_approvals (expense_id, approver_user_id, approver_name, decision, remarks) VALUES (?, ?, ?, ?, ?)'
  ).run(expenseId, req.user!.id, req.user!.full_name, decision, remarks || '');

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'EXPENSE_APPROVAL',
    entityType: 'expense',
    entityId: String(expenseId),
    details: { decision, remarks, amount_inr: existing.amount, invoice_number: existing.invoice_number },
    ipAddress: req.ip,
  });

  broadcastAll('budget:updated', { action: 'expense_decision', expenseId, decision });
  res.json({ ok: true });
});

router.get('/expenses/:id/invoice', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  if (req.user!.role === 'management' && !getAdminPermissionPolicy(req.user!).can_view_budgets) {
    logUnauthorizedAttempt(req, 'expense_invoice', req.params.id);
    return res.status(403).json({ error: 'Access denied to financial invoices' });
  }
  const expense = db.prepare('SELECT invoice_attachment_path, invoice_number FROM expenses WHERE id = ?').get(Number(req.params.id)) as any;
  if (!expense?.invoice_attachment_path) return res.status(404).json({ error: 'Invoice attachment not found' });
  const filePath = path.join(UPLOAD_ROOT, expense.invoice_attachment_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Invoice file missing' });
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'DOWNLOAD_EXPENSE_INVOICE',
    entityType: 'expense',
    entityId: String(req.params.id),
    details: { invoice_number: expense.invoice_number },
    ipAddress: req.ip,
  });
  res.sendFile(filePath);
});

// --- SLA CONFIGURATIONS ---
router.get('/sla-configs', requireAuth, (_req, res) => {
  const configs = db.prepare('SELECT * FROM sla_configurations ORDER BY first_response_minutes ASC').all();
  res.json({ configs });
});

router.put('/sla-configs/:id', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const { first_response_minutes, resolution_hours, working_hours_start, working_hours_end, holidays_json, auto_escalate, escalate_to_email } = req.body;
  db.prepare(
    `UPDATE sla_configurations
     SET first_response_minutes = COALESCE(?, first_response_minutes),
         resolution_hours = COALESCE(?, resolution_hours),
         working_hours_start = COALESCE(?, working_hours_start),
         working_hours_end = COALESCE(?, working_hours_end),
         holidays_json = COALESCE(?, holidays_json),
         auto_escalate = COALESCE(?, auto_escalate),
         escalate_to_email = COALESCE(?, escalate_to_email),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    first_response_minutes ? Number(first_response_minutes) : null,
    resolution_hours ? Number(resolution_hours) : null,
    working_hours_start ?? null,
    working_hours_end ?? null,
    holidays_json ?? null,
    auto_escalate !== undefined ? (auto_escalate ? 1 : 0) : null,
    escalate_to_email ?? null,
    id
  );
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_SLA_CONFIG',
    entityType: 'sla_configuration',
    entityId: String(id),
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

// --- NOTIFICATIONS ---
router.get('/notifications', requireAuth, (req: AuthRequest, res) => {
  const notifications = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50')
    .all(req.user!.id);
  const unreadCount = (
    db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user!.id) as { c: number }
  ).c;
  res.json({ notifications, unreadCount });
});

router.post('/notifications/:id/read', requireAuth, (req: AuthRequest, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user!.id);
  res.json({ ok: true });
});

router.post('/notifications/read-all', requireAuth, (req: AuthRequest, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user!.id);
  res.json({ ok: true });
});

export default router;
