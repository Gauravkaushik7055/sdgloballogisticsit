import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { db, UPLOAD_ROOT } from '../db.ts';
import {
  type AuthRequest,
  type AuthUser,
  getSuperAdminNotificationPrefs,
  notifyAdmins,
  requireAuth,
  requireRole,
  setSuperAdminNotificationPrefs,
  writeAuditLog,
} from '../auth.ts';
import {
  buildAdminTicketScopeClause,
  classifyMediaCategory,
  getAdminPermissionPolicy,
  getScopedModeratorIdsForAdmin,
  logUnauthorizedAttempt,
  validateAndCleanDiskFiles,
} from '../security.ts';
import { broadcastAll, getOnlineUserIds, sendToSuperAdmins, sendToUser } from '../realtime.ts';

const router = Router();

const chatMediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '');
    cb(null, `chat-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const chatMediaUpload = multer({
  storage: chatMediaStorage,
  limits: { fileSize: 25 * 1024 * 1024, files: 6 },
});

function maybeChatMultipart(req: Request, res: Response, next: NextFunction) {
  if (req.is('multipart/form-data')) {
    return chatMediaUpload.array('files', 6)(req, res, next);
  }
  return next();
}

function attachChatMediaToMessages(messages: any[]) {
  if (!messages.length) return messages;
  const ids = messages.map((m) => Number(m.id)).filter(Boolean);
  if (!ids.length) return messages;
  const attRows = db
    .prepare(
      `SELECT id, message_id, original_name, mime_type, file_size, file_category, created_at
       FROM chat_attachments
       WHERE message_id IN (${ids.map(() => '?').join(',')})
       ORDER BY id ASC`
    )
    .all(...ids) as any[];
  const byMsg = new Map<number, any[]>();
  for (const a of attRows) {
    if (!byMsg.has(a.message_id)) byMsg.set(a.message_id, []);
    byMsg.get(a.message_id)!.push(a);
  }
  return messages.map((m) => ({
    ...m,
    attachments: byMsg.get(m.id) || [],
  }));
}

function isEmployeeLinkedToModerator(employeeUserId: number, moderatorId: number | null | undefined): boolean {
  if (!moderatorId) return false;
  const emp = db.prepare('SELECT id FROM employees WHERE user_id = ?').get(employeeUserId) as { id: number } | undefined;
  const row = db
    .prepare(
      `SELECT id FROM tickets
       WHERE assigned_moderator_id = ?
         AND (created_by_user_id = ? OR (? IS NOT NULL AND employee_id = ?))
       LIMIT 1`
    )
    .get(moderatorId, employeeUserId, emp?.id ?? null, emp?.id ?? null);
  return Boolean(row);
}

function canPairChat(sender: AuthUser, peer: { id: number; role_name: string; moderator_id?: number | null }): {
  allowed: boolean;
  reason?: string;
} {
  if (sender.id === peer.id) return { allowed: false, reason: 'Cannot send a message to yourself' };

  if (sender.role === 'super_admin') {
    return ['moderator', 'management', 'employee'].includes(peer.role_name)
      ? { allowed: true }
      : { allowed: false, reason: 'Invalid chat participant' };
  }

  if (sender.role === 'management') {
    const policy = getAdminPermissionPolicy(sender);
    if (!policy.can_view_chats) return { allowed: false, reason: 'Chat access disabled for your Admin account' };
    if (peer.role_name === 'super_admin') return { allowed: true };
    if (peer.role_name === 'moderator') {
      const scopedMods = getScopedModeratorIdsForAdmin(sender);
      if (scopedMods === null || (peer.moderator_id && scopedMods.includes(peer.moderator_id))) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Moderator is outside your assigned admin scope' };
    }
    if (peer.role_name === 'employee') {
      if (policy.allowed_location_ids.length === 0 && policy.allowed_department_ids.length === 0) {
        return { allowed: true };
      }
      const emp = db.prepare('SELECT location_id, department_id FROM employees WHERE user_id = ?').get(peer.id) as any;
      const locOk =
        policy.allowed_location_ids.length === 0 || (emp?.location_id && policy.allowed_location_ids.includes(emp.location_id));
      const deptOk =
        policy.allowed_department_ids.length === 0 ||
        (emp?.department_id && policy.allowed_department_ids.includes(emp.department_id));
      return locOk && deptOk
        ? { allowed: true }
        : { allowed: false, reason: 'Employee is outside your assigned department/location scope' };
    }
    return { allowed: false, reason: 'Admins cannot message other management users directly here' };
  }

  if (sender.role === 'moderator') {
    if (peer.role_name === 'super_admin' || peer.role_name === 'management') return { allowed: true };
    if (peer.role_name === 'employee' && isEmployeeLinkedToModerator(peer.id, sender.moderator_id)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'Moderators can only chat with Super Admin, Admins, or employees on tickets assigned to them.',
    };
  }

  if (sender.role === 'employee') {
    if (peer.role_name === 'super_admin' || peer.role_name === 'management') return { allowed: true };
    if (peer.role_name === 'moderator' && isEmployeeLinkedToModerator(sender.id, peer.moderator_id)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'Employees can only chat with IT Support, Admins, or moderators assigned to their tickets.',
    };
  }

  return { allowed: false, reason: 'Access denied' };
}

const DROPDOWN_GROUP_LABELS: Record<string, string> = {
  task_status: 'Task Statuses',
  work_category: 'Work / Issue Categories',
  priority: 'Priority Levels',
  department: 'Departments',
  device_type: 'Device Types',
  business_impact: 'Business Impact Levels',
  asset_category: 'IT Asset Categories',
  expense_category: 'Expense Categories',
};

function getUsageStats(groupKey: string, value: string, metaJson?: string | null): { total: number; details: string[] } {
  const details: string[] = [];
  let total = 0;

  if (groupKey === 'task_status') {
    const c = (db.prepare('SELECT COUNT(*) as c FROM tickets WHERE status = ?').get(value) as { c: number }).c;
    if (c > 0) {
      total += c;
      details.push(`${c} task(s)`);
    }
  } else if (groupKey === 'work_category') {
    const c = (db.prepare('SELECT COUNT(*) as c FROM tickets WHERE category = ?').get(value) as { c: number }).c;
    if (c > 0) {
      total += c;
      details.push(`${c} task(s)`);
    }
  } else if (groupKey === 'priority') {
    const tc = (db.prepare('SELECT COUNT(*) as c FROM tickets WHERE priority = ?').get(value) as { c: number }).c;
    const sc = (db.prepare('SELECT COUNT(*) as c FROM sla_configurations WHERE priority = ?').get(value) as { c: number }).c;
    if (tc > 0) {
      total += tc;
      details.push(`${tc} task(s)`);
    }
    if (sc > 0) {
      total += sc;
      details.push(`${sc} SLA policy`);
    }
  } else if (groupKey === 'department') {
    let deptId: number | null = null;
    if (metaJson) {
      try {
        deptId = JSON.parse(metaJson).department_id ?? null;
      } catch {
        deptId = null;
      }
    }
    const ec = deptId
      ? (db.prepare('SELECT COUNT(*) as c FROM employees WHERE department_id = ?').get(deptId) as { c: number }).c
      : 0;
    const tc = (
      db
        .prepare('SELECT COUNT(*) as c FROM tickets WHERE reporter_department = ? OR (? IS NOT NULL AND department_id = ?)')
        .get(value, deptId, deptId) as { c: number }
    ).c;
    if (ec > 0) {
      total += ec;
      details.push(`${ec} employee(s)`);
    }
    if (tc > 0) {
      total += tc;
      details.push(`${tc} task(s)`);
    }
  } else if (groupKey === 'device_type') {
    const c = (db.prepare('SELECT COUNT(*) as c FROM tickets WHERE device_type = ?').get(value) as { c: number }).c;
    if (c > 0) {
      total += c;
      details.push(`${c} task(s)`);
    }
  } else if (groupKey === 'business_impact') {
    const c = (db.prepare('SELECT COUNT(*) as c FROM tickets WHERE business_impact = ?').get(value) as { c: number }).c;
    if (c > 0) {
      total += c;
      details.push(`${c} task(s)`);
    }
  } else if (groupKey === 'asset_category') {
    const c = (db.prepare('SELECT COUNT(*) as c FROM it_assets WHERE category = ?').get(value) as { c: number }).c;
    if (c > 0) {
      total += c;
      details.push(`${c} asset(s)`);
    }
  } else if (groupKey === 'expense_category') {
    const c = (db.prepare('SELECT COUNT(*) as c FROM expenses WHERE category = ?').get(value) as { c: number }).c;
    if (c > 0) {
      total += c;
      details.push(`${c} expense(s)`);
    }
  }

  return { total, details };
}

// ==========================================
// 1. MULTI-ROLE DIRECT CHAT & MONITORING ARCHIVE
// ==========================================

router.get('/chat/conversations', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const onlineSet = new Set(getOnlineUserIds());
  if (user.role === 'management' && !getAdminPermissionPolicy(user).can_view_chats) {
    return res.status(403).json({ error: 'Chat viewing is disabled for your account' });
  }

  const allActiveUsers = db
    .prepare(
      `SELECT u.id as user_id, u.full_name, u.email, r.name as role,
              m.id as moderator_id, m.employee_code as mod_code, m.specialization,
              e.id as employee_id, e.employee_code as emp_code, e.designation,
              (SELECT COUNT(*) FROM direct_messages dm WHERE dm.sender_user_id = u.id AND dm.recipient_user_id = ? AND dm.is_read = 0) as unread_count,
              (SELECT dm.message FROM direct_messages dm
               WHERE (dm.sender_user_id = u.id AND dm.recipient_user_id = ?) OR (dm.sender_user_id = ? AND dm.recipient_user_id = u.id)
               ORDER BY dm.id DESC LIMIT 1) as last_message,
              (SELECT dm.created_at FROM direct_messages dm
               WHERE (dm.sender_user_id = u.id AND dm.recipient_user_id = ?) OR (dm.sender_user_id = ? AND dm.recipient_user_id = u.id)
               ORDER BY dm.id DESC LIMIT 1) as last_message_at
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN moderators m ON m.user_id = u.id AND m.status = 'Active'
       LEFT JOIN employees e ON e.user_id = u.id
       WHERE u.status = 'Active' AND u.id != ?
       ORDER BY COALESCE(last_message_at, u.created_at) DESC, u.full_name ASC`
    )
    .all(user.id, user.id, user.id, user.id, user.id, user.id) as any[];

  const conversations = allActiveUsers
    .filter((u) => canPairChat(user, { id: u.user_id, role_name: u.role, moderator_id: u.moderator_id }).allowed)
    .map((u) => ({
      user_id: u.user_id,
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      moderator_id: u.moderator_id ?? undefined,
      employee_id: u.employee_id ?? undefined,
      employee_code: u.mod_code || u.emp_code || undefined,
      specialization:
        u.role === 'super_admin'
          ? 'Super Admin / IT Head'
          : u.role === 'management'
          ? 'Operations Admin'
          : u.specialization || u.designation || 'Employee',
      unread_count: u.unread_count || 0,
      last_message: u.last_message || null,
      last_message_at: u.last_message_at || null,
      is_online: onlineSet.has(u.user_id),
    }));

  res.json({ conversations });
});

router.get('/chat/unread-summary', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const totalUnread = (
    db
      .prepare('SELECT COUNT(*) as c FROM direct_messages WHERE recipient_user_id = ? AND is_read = 0')
      .get(user.id) as { c: number }
  ).c;

  const recentMessages = db
    .prepare(
      `SELECT dm.*, su.full_name as sender_name, sr.name as sender_role, t.ticket_number
       FROM direct_messages dm
       JOIN users su ON dm.sender_user_id = su.id
       JOIN roles sr ON su.role_id = sr.id
       LEFT JOIN tickets t ON dm.ticket_id = t.id
       WHERE dm.recipient_user_id = ? OR dm.sender_user_id = ?
       ORDER BY dm.id DESC
       LIMIT 15`
    )
    .all(user.id, user.id);

  res.json({ totalUnread, recentMessages: attachChatMediaToMessages(recentMessages) });
});

router.get('/chat/messages', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const peerUserId = Number(req.query.peer_user_id);
  const ticketFilterId = req.query.ticket_id ? Number(req.query.ticket_id) : null;

  if (!peerUserId) {
    return res.status(400).json({ error: 'peer_user_id is required' });
  }

  const peer = db
    .prepare(
      `SELECT u.id, u.full_name, u.email, u.status, r.name as role_name, m.id as moderator_id
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN moderators m ON m.user_id = u.id
       WHERE u.id = ?`
    )
    .get(peerUserId) as
    | { id: number; full_name: string; email: string; status: string; role_name: string; moderator_id: number | null }
    | undefined;

  if (!peer) {
    return res.status(404).json({ error: 'Conversation participant not found' });
  }

  const check = canPairChat(user, peer);
  if (!check.allowed) {
    logUnauthorizedAttempt(req, 'chat_messages', peerUserId);
    return res.status(403).json({ error: check.reason || 'Access denied to this conversation' });
  }

  const params: any[] = [user.id, peerUserId, peerUserId, user.id];
  let ticketClause = '';
  if (ticketFilterId) {
    ticketClause = 'AND dm.ticket_id = ?';
    params.push(ticketFilterId);
  }

  const messages = db
    .prepare(
      `SELECT dm.*,
              su.full_name as sender_name,
              sr.name as sender_role,
              t.ticket_number,
              t.status as ticket_status
       FROM direct_messages dm
       JOIN users su ON dm.sender_user_id = su.id
       JOIN roles sr ON su.role_id = sr.id
       LEFT JOIN tickets t ON dm.ticket_id = t.id
       WHERE ((dm.sender_user_id = ? AND dm.recipient_user_id = ?) OR (dm.sender_user_id = ? AND dm.recipient_user_id = ?))
         ${ticketClause}
       ORDER BY dm.id ASC
       LIMIT 400`
    )
    .all(...params);

  const nowIso = new Date().toISOString();
  const markRes = db
    .prepare(
      `UPDATE direct_messages SET is_read = 1, read_at = ?
       WHERE sender_user_id = ? AND recipient_user_id = ? AND is_read = 0`
    )
    .run(nowIso, peerUserId, user.id);

  if (markRes.changes > 0) {
    sendToUser(peerUserId, 'chat:read', { by_user_id: user.id, read_at: nowIso });
  }

  res.json({ messages: attachChatMediaToMessages(messages), peer });
});

router.post('/chat/mark-read', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const peerUserId = Number(req.body?.peer_user_id);
  if (!peerUserId) {
    return res.status(400).json({ error: 'peer_user_id is required' });
  }
  const nowIso = new Date().toISOString();
  const markRes = db
    .prepare(
      `UPDATE direct_messages SET is_read = 1, read_at = ?
       WHERE sender_user_id = ? AND recipient_user_id = ? AND is_read = 0`
    )
    .run(nowIso, peerUserId, user.id);
  if (markRes.changes > 0) {
    sendToUser(peerUserId, 'chat:read', { by_user_id: user.id, read_at: nowIso });
  }
  res.json({ ok: true, marked: markRes.changes });
});

router.post('/chat/messages', requireAuth, maybeChatMultipart, (req: AuthRequest, res) => {
  const user = req.user!;
  const files = (req.files as Express.Multer.File[]) || [];

  const badFileErr = files.length > 0 ? validateAndCleanDiskFiles(files, 'media') : null;
  if (badFileErr) {
    return res.status(400).json({ error: badFileErr });
  }

  const recipient_user_id = req.body?.recipient_user_id ? Number(req.body.recipient_user_id) : 0;
  const rawMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const ticket_id = req.body?.ticket_id ? Number(req.body.ticket_id) : null;

  if (!recipient_user_id || (!rawMessage && files.length === 0)) {
    for (const f of files) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch {}
    }
    return res.status(400).json({ error: 'Recipient and message text or attachment are required' });
  }

  const recipient = db
    .prepare(
      `SELECT u.id, u.full_name, u.status, r.name as role_name, m.id as moderator_id
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN moderators m ON m.user_id = u.id
       WHERE u.id = ?`
    )
    .get(recipient_user_id) as
    | { id: number; full_name: string; status: string; role_name: string; moderator_id: number | null }
    | undefined;

  if (!recipient || recipient.status !== 'Active') {
    for (const f of files) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch {}
    }
    return res.status(404).json({ error: 'Active recipient not found' });
  }

  const pairCheck = canPairChat(user, recipient);
  if (!pairCheck.allowed) {
    for (const f of files) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch {}
    }
    logUnauthorizedAttempt(req, 'chat_send', recipient.id);
    return res.status(403).json({ error: pairCheck.reason || 'You are not authorized to message this recipient' });
  }

  let linkedTicket: { id: number; ticket_number: string; assigned_moderator_id: number | null; created_by_user_id: number } | undefined;
  if (ticket_id) {
    linkedTicket = db
      .prepare('SELECT id, ticket_number, assigned_moderator_id, created_by_user_id FROM tickets WHERE id = ?')
      .get(ticket_id) as any;
    if (!linkedTicket) {
      return res.status(404).json({ error: 'Linked task not found' });
    }
    if (user.role === 'moderator' && linkedTicket.assigned_moderator_id !== user.moderator_id) {
      return res.status(403).json({ error: 'You can only link tasks assigned to you' });
    }
    if (user.role === 'employee' && linkedTicket.created_by_user_id !== user.id) {
      return res.status(403).json({ error: 'You can only link your own support tickets' });
    }
  }

  const nowIso = new Date().toISOString();
  const cleanMsg = rawMessage || `Shared ${files.length} supporting media file(s)`;

  const msgId = db.transaction(() => {
    const ins = db
      .prepare(
        `INSERT INTO direct_messages (sender_user_id, recipient_user_id, ticket_id, message, conversation_scope, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        user.id,
        recipient.id,
        linkedTicket ? linkedTicket.id : null,
        cleanMsg,
        linkedTicket ? 'ticket_chat' : 'direct',
        nowIso
      );
    const id = Number(ins.lastInsertRowid);

    if (files.length > 0) {
      const insAtt = db.prepare(
        `INSERT INTO chat_attachments (message_id, uploaded_by_user_id, file_name, original_name, mime_type, file_size, file_category, storage_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const f of files) {
        insAtt.run(
          id,
          user.id,
          f.filename,
          f.originalname,
          f.mimetype,
          f.size,
          classifyMediaCategory(f.mimetype),
          f.filename
        );
      }
    }
    return id;
  })();

  const rawCreated = db
    .prepare(
      `SELECT dm.*, su.full_name as sender_name, sr.name as sender_role, t.ticket_number, t.status as ticket_status
       FROM direct_messages dm
       JOIN users su ON dm.sender_user_id = su.id
       JOIN roles sr ON su.role_id = sr.id
       LEFT JOIN tickets t ON dm.ticket_id = t.id
       WHERE dm.id = ?`
    )
    .get(msgId) as any;
  const created = attachChatMediaToMessages([rawCreated])[0];

  sendToUser(recipient.id, 'chat:message', created);
  sendToUser(user.id, 'chat:message', created);

  if (user.role === 'moderator' || user.role === 'employee') {
    notifyAdmins({
      ticketId: linkedTicket ? linkedTicket.id : null,
      title: `Direct Message from ${user.full_name}`,
      message: `${linkedTicket ? `[${linkedTicket.ticket_number}] ` : ''}${cleanMsg.slice(0, 140)}`,
      type: 'info',
      eventKey: `chat_msg:${created.id}`,
    });
  }

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'SEND_DIRECT_CHAT',
    entityType: 'direct_message',
    entityId: String(created.id),
    details: {
      recipient_id: recipient.id,
      ticket_id: linkedTicket?.id || null,
      attachment_count: files.length,
    },
    ipAddress: req.ip,
  });

  res.status(201).json({ message: created });
});

// GET /api/chat/attachments/:attachmentId/file (Authorized participants + Super Admin / scoped monitor Admins)
router.get('/chat/attachments/:attachmentId/file', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const attId = Number(req.params.attachmentId);
  const row = db
    .prepare(
      `SELECT ca.*, dm.sender_user_id, dm.recipient_user_id, dm.ticket_id
       FROM chat_attachments ca
       JOIN direct_messages dm ON ca.message_id = dm.id
       WHERE ca.id = ?`
    )
    .get(attId) as any;

  if (!row) return res.status(404).json({ error: 'Chat attachment not found' });

  let authorized = user.role === 'super_admin' || row.sender_user_id === user.id || row.recipient_user_id === user.id;
  if (!authorized && user.role === 'management') {
    const policy = getAdminPermissionPolicy(user);
    if (policy.can_monitor_chats) {
      const scopedMods = getScopedModeratorIdsForAdmin(user);
      if (scopedMods === null) {
        authorized = true;
      } else {
        const modMatch = db
          .prepare(
            `SELECT id FROM moderators WHERE user_id IN (?, ?) AND id IN (${scopedMods.length ? scopedMods.map(() => '?').join(',') : '-1'}) LIMIT 1`
          )
          .get(row.sender_user_id, row.recipient_user_id, ...scopedMods);
        authorized = Boolean(modMatch);
      }
    }
  }

  if (!authorized) {
    logUnauthorizedAttempt(req, 'chat_attachment', attId);
    return res.status(403).json({ error: 'Access denied to this chat attachment' });
  }

  const filePath = path.join(UPLOAD_ROOT, row.storage_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from storage' });

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'DOWNLOAD_CHAT_MEDIA',
    entityType: 'chat_attachment',
    entityId: String(attId),
    details: { file_name: row.original_name, message_id: row.message_id },
    ipAddress: req.ip,
  });

  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.original_name)}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ==========================================
// 1B. CHAT HISTORY & MONITORING (SUPER ADMIN & SCOPED ADMIN ONLY)
// ==========================================

router.get('/chat/monitor', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  const user = req.user!;
  const policy = getAdminPermissionPolicy(user);
  if (!policy.can_monitor_chats) {
    logUnauthorizedAttempt(req, 'chat_monitor', null);
    return res.status(403).json({ error: 'Chat monitoring is not permitted for your account' });
  }

  const { search, role_filter, moderator_id, ticket_id, date_from, date_to } = req.query as Record<
    string,
    string | undefined
  >;

  const where: string[] = [];
  const params: any[] = [];

  if (user.role === 'management') {
    const scopedMods = getScopedModeratorIdsForAdmin(user);
    if (scopedMods !== null) {
      if (scopedMods.length === 0) {
        return res.json({ threads: [], ticketChats: [] });
      }
      const modUsers = db
        .prepare(`SELECT user_id FROM moderators WHERE id IN (${scopedMods.map(() => '?').join(',')})`)
        .all(...scopedMods) as Array<{ user_id: number }>;
      const modUids = modUsers.map((m) => m.user_id);
      if (modUids.length === 0) return res.json({ threads: [], ticketChats: [] });
      const ph = modUids.map(() => '?').join(',');
      where.push(`(dm.sender_user_id IN (${ph}) OR dm.recipient_user_id IN (${ph}))`);
      params.push(...modUids, ...modUids);
    }
  }

  if (date_from) {
    where.push('date(dm.created_at) >= date(?)');
    params.push(date_from);
  }
  if (date_to) {
    where.push('date(dm.created_at) <= date(?)');
    params.push(date_to);
  }
  if (ticket_id && ticket_id !== 'All') {
    where.push('dm.ticket_id = ?');
    params.push(Number(ticket_id));
  }
  if (moderator_id && moderator_id !== 'All') {
    const modRow = db.prepare('SELECT user_id FROM moderators WHERE id = ?').get(Number(moderator_id)) as
      | { user_id: number }
      | undefined;
    if (modRow) {
      where.push('(dm.sender_user_id = ? OR dm.recipient_user_id = ?)');
      params.push(modRow.user_id, modRow.user_id);
    }
  }
  if (role_filter && role_filter !== 'All') {
    where.push('(sr.name = ? OR rr.name = ?)');
    params.push(role_filter, role_filter);
  }
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    where.push(
      '(dm.message LIKE ? OR su.full_name LIKE ? OR ru.full_name LIKE ? OR su.email LIKE ? OR ru.email LIKE ? OR COALESCE(t.ticket_number, \'\') LIKE ?)'
    );
    params.push(q, q, q, q, q, q);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const allMsgs = db
    .prepare(
      `SELECT dm.*,
              su.full_name as sender_name, su.email as sender_email, sr.name as sender_role,
              ru.full_name as recipient_name, ru.email as recipient_email, rr.name as recipient_role,
              t.ticket_number, t.category as ticket_category, t.status as ticket_status
       FROM direct_messages dm
       JOIN users su ON dm.sender_user_id = su.id
       JOIN roles sr ON su.role_id = sr.id
       JOIN users ru ON dm.recipient_user_id = ru.id
       JOIN roles rr ON ru.role_id = rr.id
       LEFT JOIN tickets t ON dm.ticket_id = t.id
       ${whereSql}
       ORDER BY dm.id DESC
       LIMIT 1000`
    )
    .all(...params) as any[];

  const threadMap = new Map<string, any>();
  for (const m of allMsgs) {
    const a = Math.min(m.sender_user_id, m.recipient_user_id);
    const b = Math.max(m.sender_user_id, m.recipient_user_id);
    const key = `${a}:${b}`;
    const existing = threadMap.get(key);
    const senderInfo = { id: m.sender_user_id, name: m.sender_name, email: m.sender_email, role: m.sender_role };
    const recipientInfo = { id: m.recipient_user_id, name: m.recipient_name, email: m.recipient_email, role: m.recipient_role };
    const userA = m.sender_user_id === a ? senderInfo : recipientInfo;
    const userB = m.sender_user_id === b ? senderInfo : recipientInfo;

    if (!existing) {
      threadMap.set(key, {
        thread_key: key,
        user_a: userA,
        user_b: userB,
        message_count: 1,
        last_message: m.message,
        last_message_at: m.created_at,
        ticket_numbers: m.ticket_number ? [m.ticket_number] : [],
      });
    } else {
      existing.message_count += 1;
      if (m.ticket_number && !existing.ticket_numbers.includes(m.ticket_number)) {
        existing.ticket_numbers.push(m.ticket_number);
      }
    }
  }

  // Also summarize Ticket Portal Conversations (Employee <-> Moderator/Admin comments)
  const tcWhere: string[] = [];
  const tcParams: any[] = [];
  if (user.role === 'management') {
    const scope = buildAdminTicketScopeClause(user, 't');
    if (scope.clause) {
      tcWhere.push(scope.clause);
      tcParams.push(...scope.params);
    }
  }
  if (date_from) {
    tcWhere.push('date(tc.created_at) >= date(?)');
    tcParams.push(date_from);
  }
  if (date_to) {
    tcWhere.push('date(tc.created_at) <= date(?)');
    tcParams.push(date_to);
  }
  if (moderator_id && moderator_id !== 'All') {
    tcWhere.push('t.assigned_moderator_id = ?');
    tcParams.push(Number(moderator_id));
  }
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    tcWhere.push('(tc.message LIKE ? OR tc.sender_name LIKE ? OR t.ticket_number LIKE ? OR t.reporter_name LIKE ?)');
    tcParams.push(q, q, q, q);
  }
  const tcWhereSql = tcWhere.length ? `WHERE ${tcWhere.join(' AND ')}` : '';
  const ticketChats = db
    .prepare(
      `SELECT t.id as ticket_id, t.ticket_number, t.category, t.status, t.reporter_name,
              COALESCE(m.full_name, 'Unassigned') as moderator_name,
              COUNT(tc.id) as comment_count,
              MAX(tc.created_at) as last_message_at,
              (SELECT tc2.message FROM ticket_comments tc2 WHERE tc2.ticket_id = t.id ORDER BY tc2.id DESC LIMIT 1) as last_message
       FROM ticket_comments tc
       JOIN tickets t ON tc.ticket_id = t.id
       LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
       ${tcWhereSql}
       GROUP BY t.id
       ORDER BY last_message_at DESC
       LIMIT 150`
    )
    .all(...tcParams);

  res.json({
    threads: Array.from(threadMap.values()),
    ticketChats,
  });
});

router.get('/chat/monitor/thread', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  const user = req.user!;
  const policy = getAdminPermissionPolicy(user);
  if (!policy.can_monitor_chats) {
    logUnauthorizedAttempt(req, 'chat_monitor_thread', null);
    return res.status(403).json({ error: 'Chat monitoring is not permitted for your account' });
  }

  const userA = Number(req.query.user_a);
  const userB = Number(req.query.user_b);
  if (!userA || !userB) {
    return res.status(400).json({ error: 'user_a and user_b are required' });
  }

  if (user.role === 'management') {
    const scopedMods = getScopedModeratorIdsForAdmin(user);
    if (scopedMods !== null) {
      const modMatch = db
        .prepare(
          `SELECT id FROM moderators WHERE user_id IN (?, ?) AND id IN (${scopedMods.length ? scopedMods.map(() => '?').join(',') : '-1'}) LIMIT 1`
        )
        .get(userA, userB, ...scopedMods);
      if (!modMatch) {
        logUnauthorizedAttempt(req, 'chat_monitor_thread', `${userA}-${userB}`);
        return res.status(403).json({ error: 'This conversation is outside your assigned moderator scope' });
      }
    }
  }

  const pA = db
    .prepare('SELECT u.id, u.full_name, u.email, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?')
    .get(userA) as any;
  const pB = db
    .prepare('SELECT u.id, u.full_name, u.email, r.name as role FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?')
    .get(userB) as any;

  if (!pA || !pB) {
    return res.status(404).json({ error: 'Participants not found' });
  }

  const messages = db
    .prepare(
      `SELECT dm.*, su.full_name as sender_name, sr.name as sender_role,
              ru.full_name as recipient_name, rr.name as recipient_role,
              t.ticket_number, t.status as ticket_status
       FROM direct_messages dm
       JOIN users su ON dm.sender_user_id = su.id
       JOIN roles sr ON su.role_id = sr.id
       JOIN users ru ON dm.recipient_user_id = ru.id
       JOIN roles rr ON ru.role_id = rr.id
       LEFT JOIN tickets t ON dm.ticket_id = t.id
       WHERE (dm.sender_user_id = ? AND dm.recipient_user_id = ?) OR (dm.sender_user_id = ? AND dm.recipient_user_id = ?)
       ORDER BY dm.id ASC`
    )
    .all(userA, userB, userB, userA);

  // Record mandatory immutable audit log whenever a privileged user inspects a third-party chat thread
  if (user.id !== userA && user.id !== userB) {
    writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      roleName: user.role,
      action: 'MONITOR_PRIVATE_CHAT',
      entityType: 'chat_thread',
      entityId: `${Math.min(userA, userB)}:${Math.max(userA, userB)}`,
      details: {
        participant_a: `${pA.full_name} (${pA.role})`,
        participant_b: `${pB.full_name} (${pB.role})`,
        message_count: messages.length,
      },
      ipAddress: req.ip,
    });
  }

  res.json({
    participants: [pA, pB],
    messages: attachChatMediaToMessages(messages),
  });
});

// ==========================================
// 2. SUPER ADMIN NOTIFICATION PREFERENCES
// ==========================================

router.get('/notifications/preferences', requireAuth, requireRole('super_admin'), (_req, res) => {
  res.json(getSuperAdminNotificationPrefs());
});

router.put('/notifications/preferences', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const current = getSuperAdminNotificationPrefs();
  const next = setSuperAdminNotificationPrefs(
    {
      enabled: req.body?.enabled !== undefined ? Boolean(req.body.enabled) : current.enabled,
      popups_enabled: req.body?.popups_enabled !== undefined ? Boolean(req.body.popups_enabled) : current.popups_enabled,
    },
    req.user!.id
  );

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_NOTIFICATION_PREFS',
    entityType: 'settings',
    entityId: 'super_admin_notifications',
    details: next as unknown as Record<string, unknown>,
    ipAddress: req.ip,
  });

  sendToSuperAdmins('notifications:prefs', next);
  res.json(next);
});

// ==========================================
// 3. COMPLETE DROPDOWN MANAGEMENT (SUPER ADMIN ONLY)
// ==========================================

router.get('/dropdowns', requireAuth, (req: AuthRequest, res) => {
  const includeInactive = req.query.include_inactive === '1' && req.user!.role === 'super_admin';
  const rows = db
    .prepare(
      `SELECT * FROM dropdown_options
       ${includeInactive ? '' : 'WHERE is_active = 1'}
       ORDER BY group_key ASC, sort_order ASC, id ASC`
    )
    .all() as any[];

  const optionsByGroup: Record<string, any[]> = {};
  for (const key of Object.keys(DROPDOWN_GROUP_LABELS)) {
    optionsByGroup[key] = [];
  }

  for (const row of rows) {
    let meta: any = {};
    if (row.meta_json) {
      try {
        meta = JSON.parse(row.meta_json);
      } catch {
        meta = {};
      }
    }
    const enriched: any = {
      id: row.id,
      group_key: row.group_key,
      label: row.label,
      value: row.value,
      sort_order: row.sort_order,
      is_active: Boolean(row.is_active),
      is_system: Boolean(row.is_system),
      meta,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (includeInactive) {
      enriched.usage = getUsageStats(row.group_key, row.value, row.meta_json);
    }
    if (!optionsByGroup[row.group_key]) {
      optionsByGroup[row.group_key] = [];
    }
    optionsByGroup[row.group_key].push(enriched);
  }

  res.json({
    groups: Object.entries(DROPDOWN_GROUP_LABELS).map(([key, label]) => ({ key, label })),
    optionsByGroup,
  });
});

router.post('/dropdowns', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { group_key, label, sort_order, is_active, meta } = req.body as {
    group_key?: string;
    label?: string;
    sort_order?: number;
    is_active?: boolean;
    meta?: Record<string, any>;
  };

  if (!group_key || !DROPDOWN_GROUP_LABELS[group_key]) {
    return res.status(400).json({ error: 'Valid dropdown group_key is required' });
  }
  const cleanLabel = (label || '').trim();
  if (!cleanLabel) {
    return res.status(400).json({ error: 'Option name / label is required' });
  }

  const dup = db
    .prepare('SELECT id FROM dropdown_options WHERE group_key = ? AND lower(value) = lower(?)')
    .get(group_key, cleanLabel);
  if (dup) {
    return res.status(400).json({ error: `Option "${cleanLabel}" already exists in ${DROPDOWN_GROUP_LABELS[group_key]}.` });
  }

  const maxOrderRow = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM dropdown_options WHERE group_key = ?')
    .get(group_key) as { m: number };
  const nextOrder = sort_order !== undefined ? Number(sort_order) : maxOrderRow.m + 1;

  const tx = db.transaction(() => {
    let nextMeta = meta ? { ...meta } : {};
    if (group_key === 'department') {
      const code = (meta?.code || cleanLabel.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'DEPT') +
        '-' +
        Math.floor(100 + Math.random() * 900);
      const existingDept = db.prepare('SELECT id, code FROM departments WHERE lower(name) = lower(?)').get(cleanLabel) as
        | { id: number; code: string }
        | undefined;
      if (existingDept) {
        nextMeta.department_id = existingDept.id;
        nextMeta.code = existingDept.code;
      } else {
        const dRes = db
          .prepare('INSERT INTO departments (name, code, cost_center) VALUES (?, ?, ?)')
          .run(cleanLabel, code, meta?.cost_center || '');
        nextMeta.department_id = Number(dRes.lastInsertRowid);
        nextMeta.code = code;
      }
    }

    const r = db
      .prepare(
        `INSERT INTO dropdown_options (group_key, label, value, sort_order, is_active, is_system, meta_json, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'))`
      )
      .run(group_key, cleanLabel, cleanLabel, nextOrder, is_active === false ? 0 : 1, Object.keys(nextMeta).length ? JSON.stringify(nextMeta) : null);

    return Number(r.lastInsertRowid);
  });

  const newId = tx();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'CREATE_DROPDOWN_OPTION',
    entityType: 'dropdown_option',
    entityId: String(newId),
    details: { group_key, label: cleanLabel },
    ipAddress: req.ip,
  });

  broadcastAll('dropdowns:updated', { group_key });
  res.status(201).json({ id: newId });
});

router.put('/dropdowns/:id', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM dropdown_options WHERE id = ?').get(id) as any;
  if (!existing) {
    return res.status(404).json({ error: 'Dropdown option not found' });
  }

  const { label, sort_order, is_active, meta } = req.body as {
    label?: string;
    sort_order?: number;
    is_active?: boolean;
    meta?: Record<string, any>;
  };

  const nextLabel = label !== undefined ? label.trim() : existing.label;
  if (!nextLabel) {
    return res.status(400).json({ error: 'Option name cannot be empty' });
  }

  if (nextLabel.toLowerCase() !== existing.value.toLowerCase()) {
    const dup = db
      .prepare('SELECT id FROM dropdown_options WHERE group_key = ? AND lower(value) = lower(?) AND id != ?')
      .get(existing.group_key, nextLabel, id);
    if (dup) {
      return res.status(400).json({ error: `Another option named "${nextLabel}" already exists in this dropdown.` });
    }
  }

  let parsedMeta: any = {};
  if (existing.meta_json) {
    try {
      parsedMeta = JSON.parse(existing.meta_json);
    } catch {
      parsedMeta = {};
    }
  }
  const mergedMeta = meta ? { ...parsedMeta, ...meta } : parsedMeta;

  db.transaction(() => {
    db.prepare(
      `UPDATE dropdown_options
       SET label = ?, value = ?, sort_order = ?, is_active = ?, meta_json = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      nextLabel,
      nextLabel,
      sort_order !== undefined ? Number(sort_order) : existing.sort_order,
      is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
      Object.keys(mergedMeta).length ? JSON.stringify(mergedMeta) : null,
      id
    );

    // Cascade rename cleanly to existing records so data integrity is preserved
    if (nextLabel !== existing.value) {
      if (existing.group_key === 'task_status') {
        db.prepare('UPDATE tickets SET status = ? WHERE status = ?').run(nextLabel, existing.value);
      } else if (existing.group_key === 'work_category') {
        db.prepare('UPDATE tickets SET category = ? WHERE category = ?').run(nextLabel, existing.value);
      } else if (existing.group_key === 'priority') {
        db.prepare('UPDATE tickets SET priority = ? WHERE priority = ?').run(nextLabel, existing.value);
        db.prepare('UPDATE sla_configurations SET priority = ? WHERE priority = ?').run(nextLabel, existing.value);
      } else if (existing.group_key === 'department') {
        db.prepare('UPDATE tickets SET reporter_department = ? WHERE reporter_department = ?').run(nextLabel, existing.value);
        if (mergedMeta.department_id) {
          db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(nextLabel, mergedMeta.department_id);
        } else {
          db.prepare('UPDATE departments SET name = ? WHERE name = ?').run(nextLabel, existing.value);
        }
      } else if (existing.group_key === 'device_type') {
        db.prepare('UPDATE tickets SET device_type = ? WHERE device_type = ?').run(nextLabel, existing.value);
      } else if (existing.group_key === 'business_impact') {
        db.prepare('UPDATE tickets SET business_impact = ? WHERE business_impact = ?').run(nextLabel, existing.value);
      } else if (existing.group_key === 'asset_category') {
        db.prepare('UPDATE it_assets SET category = ? WHERE category = ?').run(nextLabel, existing.value);
      } else if (existing.group_key === 'expense_category') {
        db.prepare('UPDATE expenses SET category = ? WHERE category = ?').run(nextLabel, existing.value);
      }
    }
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_DROPDOWN_OPTION',
    entityType: 'dropdown_option',
    entityId: String(id),
    details: { group_key: existing.group_key, old_label: existing.label, new_label: nextLabel, is_active },
    ipAddress: req.ip,
  });

  broadcastAll('dropdowns:updated', { group_key: existing.group_key });
  res.json({ ok: true });
});

router.patch('/dropdowns/reorder', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { group_key, ordered_ids } = req.body as { group_key?: string; ordered_ids?: number[] };
  if (!group_key || !Array.isArray(ordered_ids) || ordered_ids.length === 0) {
    return res.status(400).json({ error: 'group_key and ordered_ids are required' });
  }

  const stmt = db.prepare("UPDATE dropdown_options SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND group_key = ?");
  db.transaction(() => {
    ordered_ids.forEach((optId, index) => {
      stmt.run(index + 1, Number(optId), group_key);
    });
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'REORDER_DROPDOWN_OPTIONS',
    entityType: 'dropdown_option',
    entityId: group_key,
    details: { ordered_ids },
    ipAddress: req.ip,
  });

  broadcastAll('dropdowns:updated', { group_key });
  res.json({ ok: true });
});

router.delete('/dropdowns/:id', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM dropdown_options WHERE id = ?').get(id) as any;
  if (!existing) {
    return res.status(404).json({ error: 'Dropdown option not found' });
  }
  if (existing.is_system) {
    return res.status(400).json({ error: `"${existing.label}" is a core workflow option and cannot be deleted (you may rename or deactivate non-core options).` });
  }

  const migrateToId = req.query.migrate_to_id ? Number(req.query.migrate_to_id) : req.body?.migrate_to_id ? Number(req.body.migrate_to_id) : null;
  const usage = getUsageStats(existing.group_key, existing.value, existing.meta_json);

  if (usage.total > 0 && !migrateToId) {
    return res.status(409).json({
      error: `Cannot delete "${existing.label}" because it is currently used by ${usage.details.join(' and ')}. Select a replacement option to safely migrate existing records first, or deactivate it instead.`,
      usage,
    });
  }

  let targetOpt: any = null;
  if (migrateToId) {
    targetOpt = db
      .prepare('SELECT * FROM dropdown_options WHERE id = ? AND group_key = ? AND id != ?')
      .get(migrateToId, existing.group_key, id);
    if (!targetOpt) {
      return res.status(400).json({ error: 'Valid replacement dropdown option in the same group is required for migration.' });
    }
  }

  db.transaction(() => {
    if (targetOpt) {
      if (existing.group_key === 'task_status') {
        db.prepare('UPDATE tickets SET status = ? WHERE status = ?').run(targetOpt.value, existing.value);
      } else if (existing.group_key === 'work_category') {
        db.prepare('UPDATE tickets SET category = ? WHERE category = ?').run(targetOpt.value, existing.value);
      } else if (existing.group_key === 'priority') {
        db.prepare('UPDATE tickets SET priority = ? WHERE priority = ?').run(targetOpt.value, existing.value);
      } else if (existing.group_key === 'department') {
        let oldDeptId: number | null = null;
        let newDeptId: number | null = null;
        try {
          oldDeptId = existing.meta_json ? JSON.parse(existing.meta_json).department_id ?? null : null;
          newDeptId = targetOpt.meta_json ? JSON.parse(targetOpt.meta_json).department_id ?? null : null;
        } catch {}
        db.prepare('UPDATE tickets SET reporter_department = ?, department_id = COALESCE(?, department_id) WHERE reporter_department = ?').run(
          targetOpt.value,
          newDeptId,
          existing.value
        );
        if (oldDeptId && newDeptId) {
          db.prepare('UPDATE employees SET department_id = ? WHERE department_id = ?').run(newDeptId, oldDeptId);
          db.prepare('DELETE FROM departments WHERE id = ?').run(oldDeptId);
        }
      } else if (existing.group_key === 'device_type') {
        db.prepare('UPDATE tickets SET device_type = ? WHERE device_type = ?').run(targetOpt.value, existing.value);
      } else if (existing.group_key === 'business_impact') {
        db.prepare('UPDATE tickets SET business_impact = ? WHERE business_impact = ?').run(targetOpt.value, existing.value);
      } else if (existing.group_key === 'asset_category') {
        db.prepare('UPDATE it_assets SET category = ? WHERE category = ?').run(targetOpt.value, existing.value);
      } else if (existing.group_key === 'expense_category') {
        db.prepare('UPDATE expenses SET category = ? WHERE category = ?').run(targetOpt.value, existing.value);
      }
    } else if (existing.group_key === 'department') {
      try {
        const oldDeptId = existing.meta_json ? JSON.parse(existing.meta_json).department_id ?? null : null;
        if (oldDeptId) {
          db.prepare('DELETE FROM departments WHERE id = ?').run(oldDeptId);
        }
      } catch {}
    }

    db.prepare('DELETE FROM dropdown_options WHERE id = ?').run(id);
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'DELETE_DROPDOWN_OPTION',
    entityType: 'dropdown_option',
    entityId: String(id),
    details: { group_key: existing.group_key, label: existing.label, migrated_to: targetOpt?.value || null },
    ipAddress: req.ip,
  });

  broadcastAll('dropdowns:updated', { group_key: existing.group_key });
  res.json({ ok: true });
});

export default router;
