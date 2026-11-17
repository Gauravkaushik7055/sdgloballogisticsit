import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { db, UPLOAD_ROOT } from '../db.ts';
import { type AuthRequest, createNotification, notifyAdmins, requireAuth, requireRole, writeAuditLog } from '../auth.ts';
import {
  buildAdminTicketScopeClause,
  canUserAccessTicket,
  logUnauthorizedAttempt,
  validateAndCleanDiskFiles,
} from '../security.ts';
import { sendToRoles, sendToUser } from '../realtime.ts';
import { computeSlaDeadlines, evaluateOverdueTickets } from '../sla.ts';
import { dispatchOutlookEmail, dispatchWhatsAppMessage, getEffectiveOutlookConfig, getEffectiveWhatsAppConfig } from '../integrations.ts';

const router = Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_ROOT);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

function classifyFile(mimeType: string): 'Photo' | 'Video' | 'Document' {
  if (mimeType.startsWith('image/')) return 'Photo';
  if (mimeType.startsWith('video/')) return 'Video';
  return 'Document';
}

function generateTicketNumber(): string {
  const year = new Date().getFullYear();
  const prefix = `IT-${year}-`;
  const row = db
    .prepare("SELECT ticket_number FROM tickets WHERE ticket_number LIKE ? ORDER BY id DESC LIMIT 1")
    .get(`${prefix}%`) as { ticket_number: string } | undefined;

  let nextSeq = 1;
  if (row) {
    const parts = row.ticket_number.split('-');
    const lastNum = parseInt(parts[2] || '0', 10);
    if (!isNaN(lastNum)) nextSeq = lastNum + 1;
  }
  return `${prefix}${String(nextSeq).padStart(5, '0')}`;
}

function logTicketActivity(params: {
  ticketId: number;
  actorUserId: number;
  actorName: string;
  actorRole: string;
  actionType: string;
  previousStatus?: string | null;
  newStatus?: string | null;
  details: string;
}) {
  db.prepare(
    `INSERT INTO ticket_activities (ticket_id, actor_user_id, actor_name, actor_role, action_type, previous_status, new_status, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.ticketId,
    params.actorUserId,
    params.actorName,
    params.actorRole,
    params.actionType,
    params.previousStatus ?? null,
    params.newStatus ?? null,
    params.details
  );
}

// GET /api/tickets
router.get('/', requireAuth, (req: AuthRequest, res) => {
  evaluateOverdueTickets();

  const user = req.user!;
  const {
    status,
    priority,
    category,
    location_id,
    department_id,
    moderator_id,
    date_from,
    date_to,
    search,
    queue_filter,
  } = req.query as Record<string, string | undefined>;

  const includeArchived = req.query.include_archived === '1' && user.role === 'super_admin';
  const onlyArchived = req.query.only_archived === '1' && user.role === 'super_admin';

  const where: string[] = [];
  const params: any[] = [];

  if (onlyArchived) {
    where.push('COALESCE(t.is_archived, 0) = 1');
  } else if (!includeArchived) {
    where.push('COALESCE(t.is_archived, 0) = 0');
  }

  if (user.role === 'employee') {
    where.push('(t.created_by_user_id = ? OR t.employee_id = ?)');
    params.push(user.id, user.employee_id ?? -1);
  } else if (user.role === 'moderator') {
    where.push('t.assigned_moderator_id = ?');
    params.push(user.moderator_id ?? -1);
  } else if (user.role === 'management') {
    const scope = buildAdminTicketScopeClause(user, 't');
    if (scope.clause) {
      where.push(scope.clause);
      params.push(...scope.params);
    }
  }

  if (status && status !== 'All') {
    where.push('t.status = ?');
    params.push(status);
  }
  if (priority && priority !== 'All') {
    where.push('t.priority = ?');
    params.push(priority);
  }
  if (category && category !== 'All') {
    where.push('t.category = ?');
    params.push(category);
  }
  if (location_id && location_id !== 'All') {
    where.push('t.location_id = ?');
    params.push(Number(location_id));
  }
  if (department_id && department_id !== 'All') {
    where.push('t.department_id = ?');
    params.push(Number(department_id));
  }
  if (moderator_id && moderator_id !== 'All') {
    if (moderator_id === 'unassigned') {
      where.push('t.assigned_moderator_id IS NULL');
    } else {
      where.push('t.assigned_moderator_id = ?');
      params.push(Number(moderator_id));
    }
  }
  if (date_from) {
    where.push('date(t.created_at) >= date(?)');
    params.push(date_from);
  }
  if (date_to) {
    where.push('date(t.created_at) <= date(?)');
    params.push(date_to);
  }
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    where.push(
      '(t.ticket_number LIKE ? OR t.reporter_name LIKE ? OR t.reporter_employee_code LIKE ? OR t.description LIKE ? OR t.device_name LIKE ? OR t.reporter_branch_name LIKE ?)'
    );
    params.push(q, q, q, q, q, q);
  }
  if (queue_filter === 'pending_assigns' || queue_filter === 'new_unassigned') {
    where.push("t.assigned_moderator_id IS NULL AND t.status NOT IN ('Completed','Resolved','Closed')");
  } else if (queue_filter === 'pending_work') {
    where.push("t.assigned_moderator_id IS NOT NULL AND t.status NOT IN ('Completed','Resolved','Closed')");
  } else if (queue_filter === 'overdue') {
    where.push("t.sla_breached = 1 AND t.status NOT IN ('Completed','Resolved','Closed')");
  } else if (queue_filter === 'completed') {
    where.push("t.status IN ('Completed','Resolved','Closed')");
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const tickets = db
    .prepare(
      `SELECT t.*,
              l.name as location_name, l.code as location_code, l.type as location_type,
              d.name as department_name,
              m.full_name as moderator_name, m.email as moderator_email, m.phone as moderator_phone,
              mr.name as moderator_role,
              a.asset_tag, a.brand as asset_brand, a.model as asset_model,
              (SELECT message FROM ticket_comments tc WHERE tc.ticket_id = t.id AND tc.is_internal = 0 ORDER BY tc.created_at DESC LIMIT 1) as latest_comment,
              (SELECT details FROM ticket_activities ta WHERE ta.ticket_id = t.id ORDER BY ta.created_at DESC, ta.id DESC LIMIT 1) as latest_activity
       FROM tickets t
       LEFT JOIN locations l ON t.location_id = l.id
       LEFT JOIN departments d ON t.department_id = d.id
       LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
       LEFT JOIN users mu ON m.user_id = mu.id
       LEFT JOIN roles mr ON mu.role_id = mr.id
       LEFT JOIN it_assets a ON t.asset_id = a.id
       ${whereSql}
       ORDER BY
         CASE t.status WHEN 'Escalated' THEN 1 WHEN 'Ready for Review' THEN 2 WHEN 'Revision Required' THEN 3 WHEN 'New' THEN 4 WHEN 'Reopened' THEN 5 ELSE 6 END,
         t.created_at DESC`
    )
    .all(...params);

  res.json({ tickets });
});

// POST /api/tickets (Create new ticket with optional files)
router.post('/', requireAuth, upload.array('files', 12), async (req: AuthRequest, res) => {
  const user = req.user!;
  const uploadedFiles = (req.files as Express.Multer.File[]) || [];
  if (user.role === 'management' || user.role === 'moderator') {
    for (const f of uploadedFiles) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch {}
    }
    return res.status(403).json({
      error:
        user.role === 'management'
          ? 'Read-only management accounts cannot submit tickets'
          : 'Moderators cannot create or submit tasks. Only Super Admin or Employees can create tasks.',
    });
  }
  const fileThreatErr = uploadedFiles.length > 0 ? validateAndCleanDiskFiles(uploadedFiles, 'media') : null;
  if (fileThreatErr) {
    return res.status(400).json({ error: fileThreatErr });
  }

  const body = req.body;
  const required = [
    'reporter_name',
    'reporter_employee_code',
    'reporter_department',
    'reporter_designation',
    'reporter_mobile',
    'reporter_email',
    'reporter_branch_name',
    'reporter_city',
    'reporter_full_location',
    'reporter_manager',
    'category',
    'device_type',
    'device_name',
    'description',
    'issue_occurred_at',
    'business_impact',
    'priority',
  ];

  for (const field of required) {
    if (!body[field] || !String(body[field]).trim()) {
      return res.status(400).json({ error: `Missing required field: ${field}` });
    }
  }

  const nowIso = new Date().toISOString();
  const ticketNumber = generateTicketNumber();
  const sla = computeSlaDeadlines(body.priority, nowIso);

  const locationId = body.location_id ? Number(body.location_id) : null;
  const departmentId = body.department_id ? Number(body.department_id) : null;
  const assetId = body.asset_id ? Number(body.asset_id) : null;

  const result = db
    .prepare(
      `INSERT INTO tickets (
        ticket_number, employee_id, created_by_user_id,
        reporter_name, reporter_employee_code, reporter_department, reporter_designation, reporter_mobile, reporter_email,
        reporter_branch_name, reporter_city, reporter_full_location, reporter_manager,
        location_id, department_id, category, device_type, device_name, asset_id, asset_serial_input,
        description, issue_occurred_at, business_impact, priority, status,
        sla_first_response_due, sla_resolution_due, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?)`
    )
    .run(
      ticketNumber,
      user.employee_id ?? null,
      user.id,
      body.reporter_name.trim(),
      body.reporter_employee_code.trim(),
      body.reporter_department.trim(),
      body.reporter_designation.trim(),
      body.reporter_mobile.trim(),
      body.reporter_email.trim(),
      body.reporter_branch_name.trim(),
      body.reporter_city.trim(),
      body.reporter_full_location.trim(),
      body.reporter_manager.trim(),
      locationId,
      departmentId,
      body.category.trim(),
      body.device_type.trim(),
      body.device_name.trim(),
      assetId,
      body.asset_serial_input?.trim() || null,
      body.description.trim(),
      body.issue_occurred_at,
      body.business_impact,
      body.priority,
      sla.sla_first_response_due,
      sla.sla_resolution_due,
      nowIso,
      nowIso
    );

  const ticketId = Number(result.lastInsertRowid);

  // Auto-capture / enrich employee HR details from ticket submission
  if (user.role === 'employee' && user.employee_id) {
    const empRow = db.prepare('SELECT * FROM employees WHERE id = ?').get(user.employee_id) as any;
    if (empRow) {
      const nextName = body.reporter_name.trim();
      const nextEmail = body.reporter_email.trim().toLowerCase();
      const nextCode = body.reporter_employee_code.trim();
      const emailCollision = db
        .prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?')
        .get(nextEmail, user.id);
      const codeCollision = db
        .prepare('SELECT id FROM employees WHERE lower(employee_code) = lower(?) AND id != ?')
        .get(nextCode, empRow.id);

      const safeEmail =
        !emailCollision && (empRow.email.endsWith('@mobile.logicore.local') || !empRow.email)
          ? nextEmail
          : empRow.email;
      const safeCode =
        !codeCollision && empRow.employee_code.startsWith('EMP-M-') ? nextCode : empRow.employee_code;

      db.prepare('UPDATE users SET full_name = ?, email = ?, mobile = COALESCE(mobile, ?) WHERE id = ?').run(
        nextName,
        safeEmail,
        body.reporter_mobile.trim(),
        user.id
      );
      db.prepare(
        `UPDATE employees
         SET full_name = ?,
             employee_code = ?,
             email = ?,
             department_id = COALESCE(?, department_id),
             designation = ?,
             location_id = COALESCE(?, location_id),
             reporting_manager = COALESCE(NULLIF(?, ''), reporting_manager)
         WHERE id = ?`
      ).run(
        nextName,
        safeCode,
        safeEmail,
        departmentId,
        body.reporter_designation.trim(),
        locationId,
        body.reporter_manager.trim(),
        empRow.id
      );
    }
  }

  // Save uploaded attachments
  const files = (req.files as Express.Multer.File[]) || [];
  const insertAtt = db.prepare(
    `INSERT INTO ticket_attachments (ticket_id, uploaded_by_user_id, file_name, original_name, mime_type, file_size, file_category, storage_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of files) {
    insertAtt.run(
      ticketId,
      user.id,
      f.filename,
      f.originalname,
      f.mimetype,
      f.size,
      classifyFile(f.mimetype),
      f.filename
    );
  }

  logTicketActivity({
    ticketId,
    actorUserId: user.id,
    actorName: user.full_name,
    actorRole: user.role,
    actionType: 'Ticket Created',
    previousStatus: null,
    newStatus: 'New',
    details: `Submitted ${body.priority} priority ticket for ${body.category} at ${body.reporter_branch_name}.`,
  });

  notifyAdmins({
    ticketId,
    title: `New Ticket ${ticketNumber}`,
    message: `${body.reporter_name} (${body.reporter_branch_name}) submitted a ${body.priority} ${body.category} request.`,
    type: body.priority === 'Critical' ? 'critical' : 'info',
  });

  createNotification({
    userId: user.id,
    ticketId,
    title: `Ticket Confirmed: ${ticketNumber}`,
    message: `Your support request has been logged under ${body.category}.`,
    type: 'success',
  });

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'CREATE_TICKET',
    entityType: 'ticket',
    entityId: ticketNumber,
    details: { category: body.category, priority: body.priority, attachments: files.length },
    ipAddress: req.ip,
  });

  // Trigger Outlook / WhatsApp notifications if configured
  const outlookCfg = getEffectiveOutlookConfig();
  if (outlookCfg.accessToken && outlookCfg.autoNotifyOnCreate) {
    dispatchOutlookEmail({
      ticketId,
      to: body.reporter_email.trim(),
      subject: `[${ticketNumber}] IT Support Request Received - ${body.category}`,
      body: `Hello ${body.reporter_name},\n\nYour IT support ticket ${ticketNumber} (${body.priority}) for ${body.device_name} at ${body.reporter_branch_name} has been logged.\n\nSLA First Response Target: ${sla.sla_first_response_due}\n\nRegards,\nSD Global IT Desk`,
    }).catch(() => {});
  }
  const waCfg = getEffectiveWhatsAppConfig();
  if (waCfg.enabled && waCfg.accessToken && waCfg.phoneNumberId) {
    dispatchWhatsAppMessage({
      ticketId,
      toPhone: body.reporter_mobile.trim(),
      templateName: waCfg.templates.ticket_created,
      messageBody: `SD Global IT Desk: Ticket ${ticketNumber} received for ${body.category} (${body.priority}). We will assign an engineer shortly.`,
    }).catch(() => {});
  }

  const created = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  sendToRoles(['super_admin', 'management'], 'ticket:updated', { ticketId, status: 'New', action: 'created' });
  sendToUser(user.id, 'ticket:updated', { ticketId, status: 'New', action: 'created' });
  res.status(201).json({ ticket: created });
});

// DELETE /api/tickets/:id (Non-destructive Archival — Strictly Super Admin ONLY; tickets are never deleted)
router.delete('/:id', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const ticketId = Number(req.params.id);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  let modUserId: number | null = null;
  if (ticket.assigned_moderator_id) {
    const m = db.prepare('SELECT user_id FROM moderators WHERE id = ?').get(ticket.assigned_moderator_id) as { user_id: number } | undefined;
    modUserId = m?.user_id ?? null;
  }

  const nowIso = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE tickets SET is_archived = 1, archived_at = ?, archived_by_user_id = ?, updated_at = ? WHERE id = ?').run(
      nowIso,
      req.user!.id,
      nowIso,
      ticketId
    );
    logTicketActivity({
      ticketId,
      actorUserId: req.user!.id,
      actorName: req.user!.full_name,
      actorRole: req.user!.role,
      actionType: 'Ticket Archived',
      previousStatus: ticket.status,
      newStatus: ticket.status,
      details: `Ticket archived by Super Admin ${req.user!.full_name}. Complete ticket & chat history preserved permanently.`,
    });
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'ARCHIVE_TICKET',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    details: { category: ticket.category, status: ticket.status, archived: true },
    ipAddress: req.ip,
  });

  sendToRoles(['super_admin', 'management'], 'ticket:updated', { ticketId, action: 'archived' });
  if (modUserId) sendToUser(modUserId, 'ticket:updated', { ticketId, action: 'archived' });
  if (ticket.created_by_user_id) sendToUser(ticket.created_by_user_id, 'ticket:updated', { ticketId, action: 'archived' });

  res.json({ ok: true, archived: true });
});

// POST /api/tickets/:id/restore (Restore archived ticket — Strictly Super Admin ONLY)
router.post('/:id/restore', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const ticketId = Number(req.params.id);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const nowIso = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE tickets SET is_archived = 0, archived_at = NULL, archived_by_user_id = NULL, updated_at = ? WHERE id = ?').run(
      nowIso,
      ticketId
    );
    logTicketActivity({
      ticketId,
      actorUserId: req.user!.id,
      actorName: req.user!.full_name,
      actorRole: req.user!.role,
      actionType: 'Ticket Restored',
      previousStatus: ticket.status,
      newStatus: ticket.status,
      details: `Ticket restored from archive by Super Admin ${req.user!.full_name}.`,
    });
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'RESTORE_TICKET',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    ipAddress: req.ip,
  });

  sendToRoles(['super_admin', 'management'], 'ticket:updated', { ticketId, action: 'restored' });
  res.json({ ok: true });
});

// GET /api/tickets/:id
router.get('/:id', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const ticketId = Number(req.params.id);
  const ticket = db
    .prepare(
      `SELECT t.*,
              l.name as location_name, l.code as location_code, l.city as location_city,
              d.name as department_name,
              m.full_name as moderator_name, m.email as moderator_email, m.phone as moderator_phone, m.specialization as moderator_specialization,
              mr.name as moderator_role,
              a.asset_tag, a.serial_number as asset_serial_number, a.brand as asset_brand, a.model as asset_model, a.condition_status as asset_condition
       FROM tickets t
       LEFT JOIN locations l ON t.location_id = l.id
       LEFT JOIN departments d ON t.department_id = d.id
       LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
       LEFT JOIN users mu ON m.user_id = mu.id
       LEFT JOIN roles mr ON mu.role_id = mr.id
       LEFT JOIN it_assets a ON t.asset_id = a.id
       WHERE t.id = ?`
    )
    .get(ticketId) as any;

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  // Enforce backend RBAC
  if (!canUserAccessTicket(user, ticket)) {
    logUnauthorizedAttempt(req, 'ticket', ticketId);
    return res.status(403).json({ error: 'Access denied to this ticket' });
  }

  const activities = db
    .prepare('SELECT * FROM ticket_activities WHERE ticket_id = ? ORDER BY created_at ASC, id ASC')
    .all(ticketId);

  const attachments = db
    .prepare('SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at DESC')
    .all(ticketId);

  // Hide internal IT notes from employees
  const comments =
    user.role === 'employee'
      ? db
          .prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? AND is_internal = 0 ORDER BY created_at ASC')
          .all(ticketId)
      : db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC').all(ticketId);

  const timeLogs = db
    .prepare(
      `SELECT ttl.*, m.full_name as moderator_name
       FROM ticket_time_logs ttl
       JOIN moderators m ON ttl.moderator_id = m.id
       WHERE ttl.ticket_id = ?
       ORDER BY ttl.started_at DESC`
    )
    .all(ticketId);

  const assignments = db
    .prepare(
      `SELECT ta.*, m.full_name as moderator_name, u.full_name as assigned_by_name
       FROM ticket_assignments ta
       JOIN moderators m ON ta.moderator_id = m.id
       LEFT JOIN users u ON ta.assigned_by_user_id = u.id
       WHERE ta.ticket_id = ?
       ORDER BY ta.created_at DESC`
    )
    .all(ticketId);

  const emails =
    user.role === 'employee'
      ? []
      : db.prepare('SELECT * FROM email_communications WHERE ticket_id = ? ORDER BY created_at DESC').all(ticketId);

  const whatsapp =
    user.role === 'employee'
      ? []
      : db.prepare('SELECT * FROM whatsapp_communications WHERE ticket_id = ? ORDER BY created_at DESC').all(ticketId);

  const expenses = db
    .prepare('SELECT * FROM expenses WHERE ticket_id = ? ORDER BY created_at DESC')
    .all(ticketId);

  if (user.role === 'moderator') {
    writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      roleName: user.role,
      action: 'VIEW_TICKET',
      entityType: 'ticket',
      entityId: ticket.ticket_number,
      details: { category: ticket.category, priority: ticket.priority, status: ticket.status },
      ipAddress: req.ip,
    });
  }

  res.json({
    ticket,
    activities,
    attachments,
    comments,
    timeLogs,
    assignments,
    emails,
    whatsapp,
    expenses,
  });
});

// POST /api/tickets/:id/assign (Admin assigns or reassigns ticket to a moderator or to themselves)
router.post('/:id/assign', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const ticketId = Number(req.params.id);
  const { moderator_id, assignee_type, deadline_at, priority, reason } = req.body as {
    moderator_id?: number;
    assignee_type?: 'self' | 'moderator';
    deadline_at?: string;
    priority?: string;
    reason?: string;
  };

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  let resolvedModId = moderator_id ? Number(moderator_id) : 0;
  if (assignee_type === 'self') {
    const existingSelf = db.prepare('SELECT id FROM moderators WHERE user_id = ?').get(req.user!.id) as { id: number } | undefined;
    if (existingSelf) {
      resolvedModId = existingSelf.id;
    } else {
      const adminRow = db.prepare('SELECT id, full_name, email, mobile, created_at FROM users WHERE id = ?').get(req.user!.id) as any;
      const empCode = `IT-HEAD-${String(adminRow.id).padStart(3, '0')}`;
      const inserted = db
        .prepare(
          `INSERT INTO moderators (
            user_id, employee_code, full_name, email, phone, specialization, assigned_location_ids, date_of_joining, status, max_capacity
          ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'Active', 50)`
        )
        .run(
          adminRow.id,
          empCode,
          adminRow.full_name,
          adminRow.email,
          adminRow.mobile || 'IT Head Desk',
          'Super Admin / IT Head Escalations',
          (adminRow.created_at || new Date().toISOString()).slice(0, 10)
        );
      resolvedModId = Number(inserted.lastInsertRowid);
    }
  }

  const mod = db
    .prepare(
      `SELECT m.*, r.name as role_name
       FROM moderators m
       JOIN users u ON m.user_id = u.id
       JOIN roles r ON u.role_id = r.id
       WHERE m.id = ? AND m.status = 'Active'`
    )
    .get(resolvedModId) as any;
  if (!mod) return res.status(404).json({ error: 'Active assignee not found' });

  const isSelfAssign = mod.user_id === req.user!.id;
  const nowIso = new Date().toISOString();
  const isReassign = Boolean(ticket.assigned_moderator_id);
  const nextStatus = 'Assigned';
  const nextPriority = priority || ticket.priority;

  db.prepare(
    `UPDATE tickets
     SET assigned_moderator_id = ?, deadline_at = ?, priority = ?, status = ?, assigned_at = COALESCE(assigned_at, ?), updated_at = ?
     WHERE id = ?`
  ).run(mod.id, deadline_at || ticket.deadline_at || ticket.sla_resolution_due, nextPriority, nextStatus, nowIso, nowIso, ticketId);

  const assignmentReason = reason || (isSelfAssign ? 'Self-assigned by Super Admin' : 'Assigned by IT Head');
  db.prepare(
    `INSERT INTO ticket_assignments (ticket_id, moderator_id, assigned_by_user_id, action, reason, deadline_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(ticketId, mod.id, req.user!.id, isReassign ? 'Reassigned' : 'Assigned', assignmentReason, deadline_at || null);

  logTicketActivity({
    ticketId,
    actorUserId: req.user!.id,
    actorName: req.user!.full_name,
    actorRole: req.user!.role,
    actionType: isSelfAssign ? 'Self-Assigned (Super Admin)' : isReassign ? 'Ticket Reassigned' : 'Moderator Assigned',
    previousStatus: ticket.status,
    newStatus: nextStatus,
    details: `${isSelfAssign ? 'Self-assigned to Super Admin' : isReassign ? 'Reassigned to' : 'Assigned to'} ${mod.full_name}${reason ? ` (${reason})` : ''}.`,
  });

  if (!isSelfAssign) {
    createNotification({
      userId: mod.user_id,
      ticketId,
      title: `Assigned Ticket ${ticket.ticket_number}`,
      message: `You were assigned ${nextPriority} ticket ${ticket.ticket_number} (${ticket.category}).`,
      type: nextPriority === 'Critical' ? 'critical' : 'info',
    });
  }

  createNotification({
    userId: ticket.created_by_user_id,
    ticketId,
    title: `Engineer Assigned: ${ticket.ticket_number}`,
    message: `${mod.full_name}${mod.role_name === 'super_admin' ? ' (IT Head)' : ''} has been assigned to resolve your IT ticket.`,
    type: 'info',
  });

  const outlookCfg = getEffectiveOutlookConfig();
  if (outlookCfg.accessToken && outlookCfg.autoNotifyOnAssign) {
    dispatchOutlookEmail({
      ticketId,
      to: ticket.reporter_email,
      subject: `[${ticket.ticket_number}] IT Engineer Assigned - ${mod.full_name}`,
      body: `Hello ${ticket.reporter_name},\n\n${mod.role_name === 'super_admin' ? 'IT Head' : 'IT Moderator'} ${mod.full_name} (${mod.phone}) has been assigned to your ticket ${ticket.ticket_number}.\n\nRegards,\nSD Global IT Desk`,
    }).catch(() => {});
  }

  const waCfg = getEffectiveWhatsAppConfig();
  if (waCfg.enabled && waCfg.accessToken && waCfg.phoneNumberId) {
    dispatchWhatsAppMessage({
      ticketId,
      toPhone: ticket.reporter_mobile,
      templateName: waCfg.templates.moderator_assigned,
      messageBody: `SD Global IT: ${mod.full_name} has been assigned to ticket ${ticket.ticket_number}.`,
    }).catch(() => {});
  }

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: isReassign ? 'REASSIGN_TICKET' : 'ASSIGN_TICKET',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    details: { moderator_id: mod.id, moderator_name: mod.full_name },
    ipAddress: req.ip,
  });

  sendToRoles(['super_admin', 'management'], 'ticket:updated', { ticketId, status: nextStatus, action: 'assigned' });
  if (mod.user_id) sendToUser(mod.user_id, 'ticket:updated', { ticketId, status: nextStatus, action: 'assigned' });
  if (ticket.created_by_user_id) sendToUser(ticket.created_by_user_id, 'ticket:updated', { ticketId, status: nextStatus, action: 'assigned' });

  res.json({ ok: true });
});

// POST /api/tickets/:id/respond-assignment (Moderator Accepts or Rejects with reason)
router.post('/:id/respond-assignment', requireAuth, requireRole('moderator'), (req: AuthRequest, res) => {
  const ticketId = Number(req.params.id);
  const { decision, reason } = req.body as { decision: 'accept' | 'reject'; reason?: string };
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;

  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.assigned_moderator_id !== req.user!.moderator_id) {
    return res.status(403).json({ error: 'This ticket is not assigned to you' });
  }
  if (decision === 'reject' && (!reason || !reason.trim())) {
    return res.status(400).json({ error: 'A rejection reason is required' });
  }

  const nowIso = new Date().toISOString();
  if (decision === 'accept') {
    db.prepare(
      `UPDATE tickets
       SET status = 'Accepted', accepted_at = COALESCE(accepted_at, ?), first_response_at = COALESCE(first_response_at, ?), updated_at = ?
       WHERE id = ?`
    ).run(nowIso, nowIso, nowIso, ticketId);

    db.prepare(
      `INSERT INTO ticket_assignments (ticket_id, moderator_id, assigned_by_user_id, action, reason)
       VALUES (?, ?, ?, 'Accepted', ?)`
    ).run(ticketId, req.user!.moderator_id, req.user!.id, reason?.trim() || 'Accepted assignment');

    logTicketActivity({
      ticketId,
      actorUserId: req.user!.id,
      actorName: req.user!.full_name,
      actorRole: req.user!.role,
      actionType: 'Assignment Accepted',
      previousStatus: ticket.status,
      newStatus: 'Accepted',
      details: `${req.user!.full_name} accepted the assigned work.${reason?.trim() ? ` Note: ${reason.trim()}` : ''}`,
    });

    notifyAdmins({
      ticketId,
      title: `Work Accepted: ${ticket.ticket_number}`,
      message: `${req.user!.full_name} accepted assigned work ${ticket.ticket_number}.`,
      type: 'success',
      eventKey: `accept:${ticketId}:${ticket.assigned_at || '0'}`,
    });
  } else {
    db.prepare(
      `UPDATE tickets
       SET status = 'New', assigned_moderator_id = NULL, rejection_reason = ?, updated_at = ?
       WHERE id = ?`
    ).run(reason!.trim(), nowIso, ticketId);

    db.prepare(
      `INSERT INTO ticket_assignments (ticket_id, moderator_id, assigned_by_user_id, action, reason)
       VALUES (?, ?, ?, 'Rejected', ?)`
    ).run(ticketId, req.user!.moderator_id, req.user!.id, reason!.trim());

    logTicketActivity({
      ticketId,
      actorUserId: req.user!.id,
      actorName: req.user!.full_name,
      actorRole: req.user!.role,
      actionType: 'Assignment Rejected',
      previousStatus: ticket.status,
      newStatus: 'New',
      details: `${req.user!.full_name} rejected assignment and returned task to queue. Reason: ${reason!.trim()}`,
    });

    notifyAdmins({
      ticketId,
      title: `Assignment Rejected: ${ticket.ticket_number}`,
      message: `${req.user!.full_name} rejected ${ticket.ticket_number}: ${reason!.trim()}`,
      type: 'warning',
    });
  }

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: decision === 'accept' ? 'ACCEPT_ASSIGNMENT' : 'REJECT_ASSIGNMENT',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    details: { reason: reason?.trim() || null },
    ipAddress: req.ip,
  });

  const nextSt = decision === 'accept' ? 'Accepted' : 'New';
  sendToRoles(['super_admin', 'management'], 'ticket:updated', { ticketId, status: nextSt, action: decision });
  sendToUser(req.user!.id, 'ticket:updated', { ticketId, status: nextSt, action: decision });
  if (ticket.created_by_user_id) sendToUser(ticket.created_by_user_id, 'ticket:updated', { ticketId, status: nextSt, action: decision });

  res.json({ ok: true });
});

// PATCH /api/tickets/:id/status (Admin or assigned Moderator updates status, notes, parts, visits, resolution)
router.patch('/:id/status', requireAuth, requireRole('super_admin', 'moderator'), (req: AuthRequest, res) => {
  const user = req.user!;
  const ticketId = Number(req.params.id);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;

  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (user.role === 'moderator' && ticket.assigned_moderator_id !== user.moderator_id) {
    return res.status(403).json({ error: 'Access denied: task is not assigned to you' });
  }

  const {
    status,
    note,
    parts_replaced,
    expenses_incurred,
    visit_count,
    resolution_description,
    asset_id,
    priority,
  } = req.body as Record<string, any>;

  const nextStatus: string = (typeof status === 'string' && status.trim()) ? status.trim() : ticket.status;
  const statusChanged = nextStatus !== ticket.status;
  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  const trimmedResolution = typeof resolution_description === 'string' ? resolution_description.trim() : '';

  // Strict Moderator RBAC enforcement
  if (user.role === 'moderator') {
    const moderatorForbidden = new Set(['Completed', 'Closed', 'Resolved', 'Revision Required', 'New', 'Assigned']);
    if (statusChanged && moderatorForbidden.has(nextStatus)) {
      return res.status(403).json({
        error: `Moderators cannot set status to "${nextStatus}". Submit completed work as "Ready for Review" for Super Admin approval.`,
      });
    }
    if (priority && priority !== ticket.priority) {
      return res.status(403).json({ error: 'Moderators cannot change task priority' });
    }
  }

  // Mandatory note / reason for key transitions
  const mandatoryNoteStatuses = new Set(['On Hold', 'Pending Information', 'Revision Required']);
  if (statusChanged && mandatoryNoteStatuses.has(nextStatus) && !trimmedNote && !trimmedResolution) {
    return res.status(400).json({
      error: `A reason or note is mandatory when moving a task to "${nextStatus}".`,
    });
  }

  const nowIso = new Date().toISOString();
  let acceptedAt = ticket.accepted_at;
  let workStartedAt = ticket.work_started_at;
  let workCompletedAt = ticket.work_completed_at;
  let resolvedAt = ticket.resolved_at;
  let closedAt = ticket.closed_at;
  const firstResponseAt = ticket.first_response_at || nowIso;

  if (nextStatus === 'Accepted' && !acceptedAt) acceptedAt = nowIso;
  if (nextStatus === 'In Progress' && !workStartedAt) workStartedAt = nowIso;
  if (nextStatus === 'Ready for Review') {
    workCompletedAt = workCompletedAt || nowIso;
  }
  if (nextStatus === 'Completed' || nextStatus === 'Resolved' || nextStatus === 'Closed') {
    workCompletedAt = workCompletedAt || nowIso;
    resolvedAt = resolvedAt || nowIso;
    closedAt = nowIso;
  }

  db.prepare(
    `UPDATE tickets SET
      status = ?,
      priority = COALESCE(?, priority),
      asset_id = COALESCE(?, asset_id),
      parts_replaced = COALESCE(?, parts_replaced),
      expenses_incurred = COALESCE(?, expenses_incurred),
      visit_count = COALESCE(?, visit_count),
      resolution_description = COALESCE(?, resolution_description),
      first_response_at = ?,
      accepted_at = ?,
      work_started_at = ?,
      work_completed_at = ?,
      resolved_at = ?,
      closed_at = ?,
      admin_verified = CASE WHEN ? IN ('Completed', 'Closed') THEN 1 WHEN ? = 'Revision Required' THEN 0 ELSE admin_verified END,
      admin_verified_by = CASE WHEN ? IN ('Completed', 'Closed') THEN ? ELSE admin_verified_by END,
      updated_at = ?
     WHERE id = ?`
  ).run(
    nextStatus,
    user.role === 'super_admin' ? (priority ?? null) : null,
    asset_id !== undefined ? asset_id : null,
    parts_replaced ?? null,
    expenses_incurred !== undefined ? Number(expenses_incurred) : null,
    visit_count !== undefined ? Number(visit_count) : null,
    trimmedResolution ? trimmedResolution : null,
    firstResponseAt,
    acceptedAt,
    workStartedAt,
    workCompletedAt,
    resolvedAt,
    closedAt,
    nextStatus,
    nextStatus,
    nextStatus,
    user.id,
    nowIso,
    ticketId
  );

  const detailParts: string[] = [];
  if (statusChanged) detailParts.push(`Status changed from "${ticket.status}" to "${nextStatus}".`);
  if (trimmedNote) detailParts.push(`Note: ${trimmedNote}`);
  if (trimmedResolution) detailParts.push(`Resolution: ${trimmedResolution}`);
  if (parts_replaced) detailParts.push(`Parts replaced: ${parts_replaced}`);

  logTicketActivity({
    ticketId,
    actorUserId: user.id,
    actorName: user.full_name,
    actorRole: user.role,
    actionType: statusChanged ? 'Status Updated' : 'Note Added',
    previousStatus: ticket.status,
    newStatus: nextStatus,
    details: detailParts.join(' ') || 'Updated task progress records.',
  });

  // Notify reporter for key lifecycle events
  if (nextStatus === 'Completed' || nextStatus === 'Pending Information' || nextStatus === 'Escalated') {
    createNotification({
      userId: ticket.created_by_user_id,
      ticketId,
      title: `${ticket.ticket_number}: ${nextStatus}`,
      message:
        nextStatus === 'Completed'
          ? 'Your IT support request has been completed and approved by Super Admin.'
          : nextStatus === 'Pending Information'
          ? 'IT Support requested additional details regarding your ticket.'
          : 'Your ticket was escalated to senior IT management.',
      type: nextStatus === 'Completed' ? 'success' : nextStatus === 'Escalated' ? 'critical' : 'warning',
    });
  }

  // Single consolidated deduplicated notification to Super Admin
  const modUser = ticket.assigned_moderator_id
    ? (db.prepare('SELECT user_id FROM moderators WHERE id = ?').get(ticket.assigned_moderator_id) as { user_id: number } | undefined)
    : undefined;

  if (user.role === 'moderator') {
    let notifTitle = '';
    let notifMsg = '';
    let notifType: 'info' | 'warning' | 'critical' | 'success' = 'info';

    if (statusChanged && nextStatus === 'On Hold') {
      notifTitle = `Task On Hold: ${ticket.ticket_number}`;
      notifMsg = `${user.full_name} placed ${ticket.ticket_number} On Hold. Reason: ${trimmedNote || trimmedResolution}`;
      notifType = 'warning';
    } else if (statusChanged && nextStatus === 'Pending Information') {
      notifTitle = `Info Requested: ${ticket.ticket_number}`;
      notifMsg = `${user.full_name} requested additional information for ${ticket.ticket_number}: ${trimmedNote || trimmedResolution}`;
      notifType = 'warning';
    } else if (statusChanged && nextStatus === 'Ready for Review') {
      notifTitle = `Ready for Review: ${ticket.ticket_number}`;
      notifMsg = `${user.full_name} completed work on ${ticket.ticket_number} and submitted it for your approval.`;
      notifType = 'success';
    } else if (statusChanged) {
      notifTitle = `Status Updated: ${ticket.ticket_number} (${nextStatus})`;
      notifMsg = `${user.full_name} moved ${ticket.ticket_number} to ${nextStatus}${trimmedNote ? ` — "${trimmedNote}"` : ''}.`;
      notifType = nextStatus === 'Escalated' ? 'critical' : 'info';
    } else if (trimmedNote || trimmedResolution) {
      notifTitle = `Task Note Added: ${ticket.ticket_number}`;
      notifMsg = `${user.full_name} added a note on ${ticket.ticket_number}: "${(trimmedNote || trimmedResolution).slice(0, 140)}"`;
      notifType = 'info';
    }

    if (notifTitle) {
      notifyAdmins({
        ticketId,
        title: notifTitle,
        message: notifMsg,
        type: notifType,
        eventKey: `mod_update:${ticketId}:${user.id}:${nextStatus}:${trimmedNote.slice(0, 40)}:${nowIso.slice(0, 19)}`,
      });
    }
  } else if (statusChanged && nextStatus === 'Completed') {
    notifyAdmins({
      ticketId,
      title: `Task Completed: ${ticket.ticket_number}`,
      message: `${ticket.ticket_number} was marked Completed and approved by ${user.full_name}.`,
      type: 'success',
      eventKey: `completed:${ticketId}:${nowIso.slice(0, 19)}`,
    });
    if (modUser && modUser.user_id !== user.id) {
      createNotification({
        userId: modUser.user_id,
        ticketId,
        title: `Task Approved & Completed: ${ticket.ticket_number}`,
        message: `Super Admin ${user.full_name} approved ${ticket.ticket_number} as Completed.`,
        type: 'success',
      });
    }
  } else if (statusChanged && nextStatus === 'Revision Required' && modUser && modUser.user_id !== user.id) {
    createNotification({
      userId: modUser.user_id,
      ticketId,
      title: `Revision Required: ${ticket.ticket_number}`,
      message: `${user.full_name} requested revisions on ${ticket.ticket_number}: ${trimmedNote || trimmedResolution}`,
      type: 'warning',
    });
  }

  if (nextStatus === 'Completed') {
    const outlookCfg = getEffectiveOutlookConfig();
    if (outlookCfg.accessToken && outlookCfg.autoNotifyOnResolve) {
      dispatchOutlookEmail({
        ticketId,
        to: ticket.reporter_email,
        subject: `[${ticket.ticket_number}] Completed - Support Request Resolved`,
        body: `Hello ${ticket.reporter_name},\n\nYour ticket ${ticket.ticket_number} has been completed.\nResolution summary: ${trimmedResolution || ticket.resolution_description || 'Completed by IT support.'}\n\nRegards,\nSD Global IT Desk`,
      }).catch(() => {});
    }
    const waCfg = getEffectiveWhatsAppConfig();
    if (waCfg.enabled && waCfg.accessToken && waCfg.phoneNumberId) {
      dispatchWhatsAppMessage({
        ticketId,
        toPhone: ticket.reporter_mobile,
        templateName: waCfg.templates.ticket_resolved,
        messageBody: `SD Global IT: Ticket ${ticket.ticket_number} has been completed.`,
      }).catch(() => {});
    }
  }

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'UPDATE_TICKET_STATUS',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    details: {
      previous_status: ticket.status,
      new_status: nextStatus,
      note: trimmedNote || null,
      parts_replaced: parts_replaced || null,
      resolution_description: trimmedResolution || null,
    },
    ipAddress: req.ip,
  });

  sendToRoles(['super_admin', 'management'], 'ticket:updated', { ticketId, status: nextStatus, action: 'status_updated' });
  if (modUser) sendToUser(modUser.user_id, 'ticket:updated', { ticketId, status: nextStatus, action: 'status_updated' });
  if (ticket.created_by_user_id) sendToUser(ticket.created_by_user_id, 'ticket:updated', { ticketId, status: nextStatus, action: 'status_updated' });

  res.json({ ok: true, status: nextStatus });
});

// POST /api/tickets/:id/review (Super Admin reviews Ready for Review task: Approve -> Completed OR Revision Required)
router.post('/:id/review', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const user = req.user!;
  const ticketId = Number(req.params.id);
  const { decision, note } = req.body as { decision?: 'approve' | 'revision'; note?: string };
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;

  if (!ticket) return res.status(404).json({ error: 'Task not found' });
  if (!decision || !['approve', 'revision'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approve or revision' });
  }

  const trimmedNote = (note || '').trim();
  if (decision === 'revision' && !trimmedNote) {
    return res.status(400).json({ error: 'A revision reason / note is mandatory when requesting changes.' });
  }

  const nowIso = new Date().toISOString();
  const nextStatus = decision === 'approve' ? 'Completed' : 'Revision Required';

  if (decision === 'approve') {
    db.prepare(
      `UPDATE tickets
       SET status = 'Completed',
           work_completed_at = COALESCE(work_completed_at, ?),
           resolved_at = COALESCE(resolved_at, ?),
           closed_at = ?,
           admin_verified = 1,
           admin_verified_by = ?,
           resolution_description = COALESCE(NULLIF(?, ''), resolution_description),
           updated_at = ?
       WHERE id = ?`
    ).run(nowIso, nowIso, nowIso, user.id, trimmedNote, nowIso, ticketId);
  } else {
    db.prepare(
      `UPDATE tickets
       SET status = 'Revision Required',
           admin_verified = 0,
           updated_at = ?
       WHERE id = ?`
    ).run(nowIso, ticketId);
  }

  logTicketActivity({
    ticketId,
    actorUserId: user.id,
    actorName: user.full_name,
    actorRole: user.role,
    actionType: decision === 'approve' ? 'Approved & Completed' : 'Revision Required',
    previousStatus: ticket.status,
    newStatus: nextStatus,
    details:
      decision === 'approve'
        ? `Super Admin ${user.full_name} approved and marked task Completed.${trimmedNote ? ` Note: ${trimmedNote}` : ''}`
        : `Super Admin ${user.full_name} requested revisions. Reason: ${trimmedNote}`,
  });

  const modUser = ticket.assigned_moderator_id
    ? (db.prepare('SELECT user_id FROM moderators WHERE id = ?').get(ticket.assigned_moderator_id) as { user_id: number } | undefined)
    : undefined;

  if (modUser && modUser.user_id !== user.id) {
    createNotification({
      userId: modUser.user_id,
      ticketId,
      title: decision === 'approve' ? `Approved & Completed: ${ticket.ticket_number}` : `Revision Required: ${ticket.ticket_number}`,
      message:
        decision === 'approve'
          ? `Super Admin ${user.full_name} approved ${ticket.ticket_number} as Completed.`
          : `Super Admin ${user.full_name} requested revisions on ${ticket.ticket_number}: ${trimmedNote}`,
      type: decision === 'approve' ? 'success' : 'warning',
    });
  }

  if (decision === 'approve') {
    createNotification({
      userId: ticket.created_by_user_id,
      ticketId,
      title: `Completed: ${ticket.ticket_number}`,
      message: 'Your IT support request has been completed and verified by Super Admin.',
      type: 'success',
    });
    notifyAdmins({
      ticketId,
      title: `Task Completed: ${ticket.ticket_number}`,
      message: `${ticket.ticket_number} approved and marked Completed by ${user.full_name}.`,
      type: 'success',
      eventKey: `review_complete:${ticketId}:${nowIso.slice(0, 19)}`,
    });
  }

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: decision === 'approve' ? 'APPROVE_TASK_COMPLETION' : 'REQUEST_TASK_REVISION',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    details: { previous_status: ticket.status, new_status: nextStatus, note: trimmedNote || null },
    ipAddress: req.ip,
  });

  sendToRoles(['super_admin', 'management'], 'ticket:updated', { ticketId, status: nextStatus, action: decision });
  if (modUser) sendToUser(modUser.user_id, 'ticket:updated', { ticketId, status: nextStatus, action: decision });
  if (ticket.created_by_user_id) sendToUser(ticket.created_by_user_id, 'ticket:updated', { ticketId, status: nextStatus, action: decision });

  res.json({ ok: true, status: nextStatus });
});

// POST /api/tickets/:id/employee-confirm (Employee confirms resolution or reopens ticket)
router.post('/:id/employee-confirm', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const ticketId = Number(req.params.id);
  const { action, feedback } = req.body as { action: 'confirm' | 'reopen'; feedback?: string };
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;

  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (user.role === 'employee' && ticket.created_by_user_id !== user.id && ticket.employee_id !== user.employee_id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (user.role === 'management') {
    return res.status(403).json({ error: 'Read-only users cannot modify tickets' });
  }

  const nowIso = new Date().toISOString();
  if (action === 'confirm') {
    db.prepare(
      `UPDATE tickets SET employee_confirmed = 1, employee_feedback = ?, updated_at = ? WHERE id = ?`
    ).run(feedback || 'Confirmed resolved by employee', nowIso, ticketId);

    logTicketActivity({
      ticketId,
      actorUserId: user.id,
      actorName: user.full_name,
      actorRole: user.role,
      actionType: 'Employee Confirmed Resolution',
      previousStatus: ticket.status,
      newStatus: ticket.status,
      details: `Employee confirmed issue is resolved.${feedback ? ` Feedback: ${feedback}` : ''}`,
    });

    notifyAdmins({
      ticketId,
      title: `Confirmed Resolved: ${ticket.ticket_number}`,
      message: `${user.full_name} confirmed resolution of ${ticket.ticket_number}. Ready for Admin verification & closure.`,
      type: 'success',
    });
  } else {
    if (!feedback || !feedback.trim()) {
      return res.status(400).json({ error: 'Please explain why the ticket is being reopened' });
    }
    db.prepare(
      `UPDATE tickets SET status = 'Reopened', employee_confirmed = 0, employee_feedback = ?, updated_at = ? WHERE id = ?`
    ).run(feedback.trim(), nowIso, ticketId);

    logTicketActivity({
      ticketId,
      actorUserId: user.id,
      actorName: user.full_name,
      actorRole: user.role,
      actionType: 'Ticket Reopened',
      previousStatus: ticket.status,
      newStatus: 'Reopened',
      details: `Employee reopened ticket. Reason: ${feedback.trim()}`,
    });

    notifyAdmins({
      ticketId,
      title: `Ticket Reopened: ${ticket.ticket_number}`,
      message: `${user.full_name} reopened ${ticket.ticket_number}: ${feedback.trim()}`,
      type: 'warning',
    });
    if (ticket.assigned_moderator_id) {
      const mod = db.prepare('SELECT user_id FROM moderators WHERE id = ?').get(ticket.assigned_moderator_id) as
        | { user_id: number }
        | undefined;
      if (mod) {
        createNotification({
          userId: mod.user_id,
          ticketId,
          title: `Ticket Reopened: ${ticket.ticket_number}`,
          message: `${user.full_name} reopened ${ticket.ticket_number}: ${feedback.trim()}`,
          type: 'warning',
        });
      }
    }
  }

  sendToRoles(['super_admin', 'management'], 'ticket:updated', {
    ticketId,
    status: action === 'confirm' ? ticket.status : 'Reopened',
    action: `employee_${action}`,
  });
  if (ticket.assigned_moderator_id) {
    const modRow = db.prepare('SELECT user_id FROM moderators WHERE id = ?').get(ticket.assigned_moderator_id) as { user_id: number } | undefined;
    if (modRow) {
      sendToUser(modRow.user_id, 'ticket:updated', {
        ticketId,
        status: action === 'confirm' ? ticket.status : 'Reopened',
        action: `employee_${action}`,
      });
    }
  }
  if (ticket.created_by_user_id) {
    sendToUser(ticket.created_by_user_id, 'ticket:updated', {
      ticketId,
      status: action === 'confirm' ? ticket.status : 'Reopened',
      action: `employee_${action}`,
    });
  }

  res.json({ ok: true });
});

// POST /api/tickets/:id/comments
router.post('/:id/comments', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  if (user.role === 'management') {
    return res.status(403).json({ error: 'Read-only management accounts cannot post comments' });
  }
  const ticketId = Number(req.params.id);
  const { message, is_internal } = req.body as { message: string; is_internal?: boolean };
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  if (user.role === 'employee' && ticket.created_by_user_id !== user.id && ticket.employee_id !== user.employee_id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (user.role === 'moderator' && ticket.assigned_moderator_id !== user.moderator_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const internalFlag = user.role === 'employee' ? 0 : is_internal ? 1 : 0;
  const nowIso = new Date().toISOString();

  db.prepare(
    `INSERT INTO ticket_comments (ticket_id, sender_user_id, sender_name, sender_role, channel, is_internal, message, created_at)
     VALUES (?, ?, ?, ?, 'Portal', ?, ?, ?)`
  ).run(ticketId, user.id, user.full_name, user.role, internalFlag, message.trim(), nowIso);

  if (user.role !== 'employee' && !ticket.first_response_at && !internalFlag) {
    db.prepare('UPDATE tickets SET first_response_at = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, ticketId);
  } else {
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso, ticketId);
  }

  logTicketActivity({
    ticketId,
    actorUserId: user.id,
    actorName: user.full_name,
    actorRole: user.role,
    actionType: internalFlag ? 'Internal Note Added' : 'Message Sent',
    previousStatus: ticket.status,
    newStatus: ticket.status,
    details: `${internalFlag ? '[Internal] ' : ''}${message.trim().slice(0, 140)}`,
  });

  if (!internalFlag) {
    if (user.role === 'employee' && ticket.assigned_moderator_id) {
      const mod = db.prepare('SELECT user_id FROM moderators WHERE id = ?').get(ticket.assigned_moderator_id) as
        | { user_id: number }
        | undefined;
      if (mod) {
        createNotification({
          userId: mod.user_id,
          ticketId,
          title: `New Reply on ${ticket.ticket_number}`,
          message: `${user.full_name}: ${message.trim().slice(0, 100)}`,
          type: 'info',
        });
      }
    } else if (user.role !== 'employee') {
      createNotification({
        userId: ticket.created_by_user_id,
        ticketId,
        title: `IT Update on ${ticket.ticket_number}`,
        message: `${user.full_name}: ${message.trim().slice(0, 100)}`,
        type: 'info',
      });
    }
  }

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: internalFlag ? 'ADD_INTERNAL_NOTE' : 'POST_COMMENT',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    details: { preview: message.trim().slice(0, 120), is_internal: Boolean(internalFlag) },
    ipAddress: req.ip,
  });

  res.status(201).json({ ok: true });
});

// POST /api/tickets/:id/time-logs (Moderator or Admin logs work time)
router.post('/:id/time-logs', requireAuth, requireRole('super_admin', 'moderator'), (req: AuthRequest, res) => {
  const user = req.user!;
  const ticketId = Number(req.params.id);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const modId = user.moderator_id || ticket.assigned_moderator_id;
  if (!modId) {
    return res.status(400).json({ error: 'No moderator associated with this ticket time log' });
  }
  if (user.role === 'moderator' && ticket.assigned_moderator_id !== user.moderator_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { duration_minutes, work_type, notes, started_at, ended_at } = req.body as {
    duration_minutes: number;
    work_type?: string;
    notes?: string;
    started_at?: string;
    ended_at?: string;
  };

  const mins = Number(duration_minutes);
  if (!mins || mins <= 0) {
    return res.status(400).json({ error: 'Duration in minutes must be greater than 0' });
  }

  const endIso = ended_at || new Date().toISOString();
  const startIso = started_at || new Date(Date.now() - mins * 60000).toISOString();

  db.prepare(
    `INSERT INTO ticket_time_logs (ticket_id, moderator_id, started_at, ended_at, duration_minutes, work_type, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(ticketId, modId, startIso, endIso, mins, work_type || 'Troubleshooting', notes || '');

  db.prepare('UPDATE tickets SET total_working_minutes = total_working_minutes + ?, updated_at = ? WHERE id = ?').run(
    mins,
    new Date().toISOString(),
    ticketId
  );

  logTicketActivity({
    ticketId,
    actorUserId: user.id,
    actorName: user.full_name,
    actorRole: user.role,
    actionType: 'Time Logged',
    previousStatus: ticket.status,
    newStatus: ticket.status,
    details: `Logged ${mins} mins (${work_type || 'Troubleshooting'})${notes ? `: ${notes}` : ''}.`,
  });

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'LOG_WORK_TIME',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    details: { duration_minutes: mins, work_type: work_type || 'Troubleshooting', notes: notes || null },
    ipAddress: req.ip,
  });

  res.status(201).json({ ok: true });
});

// POST /api/tickets/:id/attachments (Add additional attachments with strict RBAC & threat check)
router.post('/:id/attachments', requireAuth, upload.array('files', 10), (req: AuthRequest, res) => {
  const user = req.user!;
  const files = (req.files as Express.Multer.File[]) || [];
  const cleanupFiles = () => {
    for (const f of files) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch {}
    }
  };

  if (user.role === 'management') {
    cleanupFiles();
    return res.status(403).json({ error: 'Read-only users cannot upload files' });
  }
  const ticketId = Number(req.params.id);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId) as any;
  if (!ticket) {
    cleanupFiles();
    return res.status(404).json({ error: 'Ticket not found' });
  }

  if (!canUserAccessTicket(user, ticket)) {
    cleanupFiles();
    logUnauthorizedAttempt(req, 'ticket_attachment_upload', ticketId);
    return res.status(403).json({ error: 'Access denied: you are not authorized to upload files to this ticket' });
  }

  if (files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const threatErr = validateAndCleanDiskFiles(files, 'media');
  if (threatErr) {
    return res.status(400).json({ error: threatErr });
  }

  const insertAtt = db.prepare(
    `INSERT INTO ticket_attachments (ticket_id, uploaded_by_user_id, file_name, original_name, mime_type, file_size, file_category, storage_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of files) {
    insertAtt.run(ticketId, user.id, f.filename, f.originalname, f.mimetype, f.size, classifyFile(f.mimetype), f.filename);
  }

  logTicketActivity({
    ticketId,
    actorUserId: user.id,
    actorName: user.full_name,
    actorRole: user.role,
    actionType: 'Attachments Uploaded',
    previousStatus: ticket.status,
    newStatus: ticket.status,
    details: `Uploaded ${files.length} supporting file(s): ${files.map((f) => f.originalname).join(', ')}.`,
  });

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'UPLOAD_TICKET_ATTACHMENT',
    entityType: 'ticket',
    entityId: ticket.ticket_number,
    details: { count: files.length, files: files.map((f) => f.originalname) },
    ipAddress: req.ip,
  });

  res.status(201).json({ ok: true, count: files.length });
});

// GET /api/tickets/attachments/:attachmentId/file (Enforces parent ticket RBAC + audit log)
router.get('/attachments/:attachmentId/file', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const attId = Number(req.params.attachmentId);
  const att = db.prepare('SELECT * FROM ticket_attachments WHERE id = ?').get(attId) as any;
  if (!att) return res.status(404).json({ error: 'Attachment not found' });

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(att.ticket_id) as any;
  if (!ticket || !canUserAccessTicket(user, ticket)) {
    logUnauthorizedAttempt(req, 'ticket_attachment_download', attId);
    return res.status(403).json({ error: 'Access denied to this attachment' });
  }

  const filePath = path.join(UPLOAD_ROOT, att.storage_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File missing from storage' });
  }

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'DOWNLOAD_TICKET_ATTACHMENT',
    entityType: 'ticket_attachment',
    entityId: String(attId),
    details: { ticket_number: ticket.ticket_number, original_name: att.original_name },
    ipAddress: req.ip,
  });

  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.original_name)}"`);
  fs.createReadStream(filePath).pipe(res);
});

export default router;
