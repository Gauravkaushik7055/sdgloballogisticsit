import { Router } from 'express';
import { db } from '../db.ts';
import { type AuthRequest, requireAuth, requireRole, writeAuditLog } from '../auth.ts';
import { evaluateOverdueTickets } from '../sla.ts';
import {
  buildAdminTicketScopeClause,
  getAdminPermissionPolicy,
  getScopedModeratorIdsForAdmin,
  logUnauthorizedAttempt,
  maskSecret,
  requireCapability,
} from '../security.ts';
import {
  dispatchOutlookEmail,
  dispatchWhatsAppMessage,
  getEffectiveOutlookConfig,
  getEffectiveWhatsAppConfig,
  saveIntegrationSetting,
} from '../integrations.ts';

const router = Router();

// --- ANALYTICS & ADMIN DASHBOARD ---
router.get('/analytics/dashboard', requireAuth, (req: AuthRequest, res) => {
  evaluateOverdueTickets();

  const user = req.user!;
  const policy = getAdminPermissionPolicy(user);
  const { date_from, date_to, location_id, department_id, moderator_id, category, priority, status } = req.query as Record<
    string,
    string | undefined
  >;

  const where: string[] = [];
  const params: any[] = [];

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

  if (date_from) {
    where.push('date(t.created_at) >= date(?)');
    params.push(date_from);
  }
  if (date_to) {
    where.push('date(t.created_at) <= date(?)');
    params.push(date_to);
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
    where.push('t.assigned_moderator_id = ?');
    params.push(Number(moderator_id));
  }
  if (category && category !== 'All') {
    where.push('t.category = ?');
    params.push(category);
  }
  if (priority && priority !== 'All') {
    where.push('t.priority = ?');
    params.push(priority);
  }
  if (status && status !== 'All') {
    where.push('t.status = ?');
    params.push(status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const kpis = db
    .prepare(
      `SELECT
        COUNT(*) as total_tickets,
        COALESCE(SUM(CASE WHEN t.status = 'New' THEN 1 ELSE 0 END), 0) as new_tickets,
        COALESCE(SUM(CASE WHEN t.assigned_moderator_id IS NOT NULL THEN 1 ELSE 0 END), 0) as total_assigned_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'Assigned' THEN 1 ELSE 0 END), 0) as assigned_tasks,
        COALESCE(SUM(CASE WHEN t.status IN ('Accepted','Accepted by Moderator') THEN 1 ELSE 0 END), 0) as accepted_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'Under Review' THEN 1 ELSE 0 END), 0) as under_review_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END), 0) as in_progress_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'On Hold' THEN 1 ELSE 0 END), 0) as on_hold_tasks,
        COALESCE(SUM(CASE WHEN t.status IN ('Pending Information','Waiting for Employee','Waiting for Parts / Vendor') THEN 1 ELSE 0 END), 0) as pending_info_tasks,
        COALESCE(SUM(CASE WHEN t.status IN ('Ready for Review','Pending Admin Review') THEN 1 ELSE 0 END), 0) as ready_for_review_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'Revision Required' THEN 1 ELSE 0 END), 0) as revision_required_tasks,
        COALESCE(SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END), 0) as completed_tasks,
        COALESCE(SUM(CASE WHEN t.assigned_moderator_id IS NOT NULL AND t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END), 0) as pending_work_tasks,
        COALESCE(SUM(CASE WHEN t.assigned_moderator_id IS NULL AND t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END), 0) as unassigned_tickets,
        COALESCE(SUM(CASE WHEN t.status IN ('In Progress','Accepted','Accepted by Moderator','Assigned','Under Review') THEN 1 ELSE 0 END), 0) as in_progress_tickets,
        COALESCE(SUM(CASE WHEN t.status IN ('Pending Information','On Hold','Ready for Review','Revision Required','Waiting for Employee','Waiting for Parts / Vendor','Pending Admin Review','Escalated') THEN 1 ELSE 0 END), 0) as waiting_tickets,
        COALESCE(SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END), 0) as resolved_tickets,
        COALESCE(SUM(CASE WHEN t.status = 'Reopened' THEN 1 ELSE 0 END), 0) as reopened_tickets,
        COALESCE(SUM(CASE WHEN t.sla_breached = 1 AND t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END), 0) as overdue_tickets,
        ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END), 1) as avg_resolution_hours,
        ROUND(AVG(CASE WHEN t.first_response_at IS NOT NULL THEN (julianday(t.first_response_at) - julianday(t.created_at)) * 1440 END), 0) as avg_first_response_mins
       FROM tickets t
       ${whereSql}`
    )
    .get(...params) as any;

  let totalEmployees = 0;
  if (user.role === 'super_admin') {
    totalEmployees = (db.prepare('SELECT COUNT(*) as c FROM employees').get() as { c: number }).c;
  } else if (user.role === 'management') {
    const empWhere: string[] = [];
    const empParams: any[] = [];
    if (policy.allowed_location_ids.length > 0) {
      empWhere.push(`location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')})`);
      empParams.push(...policy.allowed_location_ids);
    }
    if (policy.allowed_department_ids.length > 0) {
      empWhere.push(`department_id IN (${policy.allowed_department_ids.map(() => '?').join(',')})`);
      empParams.push(...policy.allowed_department_ids);
    }
    const empWhereSql = empWhere.length ? `WHERE ${empWhere.join(' AND ')}` : '';
    totalEmployees = (db.prepare(`SELECT COUNT(*) as c FROM employees ${empWhereSql}`).get(...empParams) as { c: number }).c;
  } else {
    totalEmployees = (db.prepare('SELECT COUNT(*) as c FROM employees').get() as { c: number }).c;
  }

  const scopedModIds = user.role === 'management' ? getScopedModeratorIdsForAdmin(user) : null;
  let totalModerators = 0;
  if (scopedModIds !== null && scopedModIds.length === 0) {
    totalModerators = 0;
  } else if (scopedModIds !== null) {
    totalModerators = (
      db
        .prepare(
          `SELECT COUNT(*) as c
           FROM moderators m
           JOIN users u ON m.user_id = u.id
           JOIN roles r ON u.role_id = r.id
           WHERE m.status = 'Active' AND r.name = 'moderator' AND m.id IN (${scopedModIds.map(() => '?').join(',')})`
        )
        .get(...scopedModIds) as { c: number }
    ).c;
  } else {
    totalModerators = (
      db
        .prepare(
          `SELECT COUNT(*) as c
           FROM moderators m
           JOIN users u ON m.user_id = u.id
           JOIN roles r ON u.role_id = r.id
           WHERE m.status = 'Active' AND r.name = 'moderator'`
        )
        .get() as { c: number }
    ).c;
  }

  const ticketsByMonth = db
    .prepare(
      `SELECT strftime('%Y-%m', t.created_at) as month,
              COUNT(*) as total,
              SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as resolved,
              SUM(CASE WHEN t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as pending,
              ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END), 1) as avg_hours
       FROM tickets t
       ${whereSql}
       GROUP BY strftime('%Y-%m', t.created_at)
       ORDER BY month ASC`
    )
    .all(...params);

  const ticketsByLocation = db
    .prepare(
      `SELECT COALESCE(l.name, t.reporter_branch_name) as location,
              COUNT(*) as total,
              SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as resolved,
              SUM(CASE WHEN t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as open
       FROM tickets t
       LEFT JOIN locations l ON t.location_id = l.id
       ${whereSql}
       GROUP BY COALESCE(l.name, t.reporter_branch_name)
       ORDER BY total DESC`
    )
    .all(...params);

  const ticketsByCategory = db
    .prepare(
      `SELECT t.category, COUNT(*) as total
       FROM tickets t
       ${whereSql}
       GROUP BY t.category
       ORDER BY total DESC`
    )
    .all(...params);

  const modJoinFilters: string[] = [];
  const modJoinParams: any[] = [];
  if (date_from) {
    modJoinFilters.push('date(t.created_at) >= date(?)');
    modJoinParams.push(date_from);
  }
  if (date_to) {
    modJoinFilters.push('date(t.created_at) <= date(?)');
    modJoinParams.push(date_to);
  }
  if (location_id && location_id !== 'All') {
    modJoinFilters.push('t.location_id = ?');
    modJoinParams.push(Number(location_id));
  }
  if (category && category !== 'All') {
    modJoinFilters.push('t.category = ?');
    modJoinParams.push(category);
  }
  if (user.role === 'management') {
    const scope = buildAdminTicketScopeClause(user, 't');
    if (scope.clause) {
      modJoinFilters.push(scope.clause);
      modJoinParams.push(...scope.params);
    }
  }
  const modJoinSql = modJoinFilters.length ? `AND ${modJoinFilters.join(' AND ')}` : '';

  const modOuterFilters: string[] = [];
  const modOuterParams: any[] = [];
  if (user.role === 'moderator') {
    modOuterFilters.push('m.id = ?');
    modOuterParams.push(user.moderator_id ?? -1);
  } else if (moderator_id && moderator_id !== 'All') {
    modOuterFilters.push('m.id = ?');
    modOuterParams.push(Number(moderator_id));
  }
  if (user.role === 'management' && scopedModIds !== null) {
    if (scopedModIds.length === 0) {
      modOuterFilters.push('1 = 0');
    } else {
      modOuterFilters.push(`m.id IN (${scopedModIds.map(() => '?').join(',')})`);
      modOuterParams.push(...scopedModIds);
    }
  }
  const modOuterWhere = modOuterFilters.length ? `WHERE ${modOuterFilters.join(' AND ')}` : '';

  const moderatorPerformance =
    user.role === 'employee'
      ? []
      : db
          .prepare(
            `SELECT m.id as moderator_id,
                    m.user_id,
                    CASE WHEN r.name = 'super_admin' THEN m.full_name || ' (Super Admin)' ELSE m.full_name END as name,
                    m.specialization,
                    m.status as account_status,
                    COUNT(t.id) as assigned,
                    SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as resolved,
                    SUM(CASE WHEN t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) as in_progress,
                    SUM(CASE WHEN t.status IN ('On Hold','Pending Information') THEN 1 ELSE 0 END) as held_or_info,
                    SUM(CASE WHEN t.status = 'Ready for Review' THEN 1 ELSE 0 END) as ready_for_review,
                    ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END), 1) as avg_hours
             FROM moderators m
             JOIN users u ON m.user_id = u.id
             JOIN roles r ON u.role_id = r.id
             LEFT JOIN tickets t ON t.assigned_moderator_id = m.id ${modJoinSql}
             ${modOuterWhere}
             GROUP BY m.id
             ORDER BY resolved DESC, assigned DESC`
          )
          .all(...modJoinParams, ...modOuterParams);

  const canSeeFinancials =
    user.role === 'super_admin' || (user.role === 'management' && policy.can_view_budgets);
  let expenditureByMonth: any[] = [];
  if (canSeeFinancials) {
    const expWhere: string[] = ["approval_status = 'Approved'"];
    const expParams: any[] = [];
    if (user.role === 'management' && policy.allowed_location_ids.length > 0) {
      expWhere.push(`(location_id IS NULL OR location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')}))`);
      expParams.push(...policy.allowed_location_ids);
    }
    expenditureByMonth = db
      .prepare(
        `SELECT strftime('%Y-%m', payment_date) as month,
                SUM(amount) as total_spent,
                SUM(CASE WHEN category IN ('Repair & Maintenance','Spare Parts') THEN amount ELSE 0 END) as maintenance_cost,
                SUM(CASE WHEN category = 'Hardware Purchase' THEN amount ELSE 0 END) as hardware_cost
         FROM expenses
         WHERE ${expWhere.join(' AND ')}
         GROUP BY strftime('%Y-%m', payment_date)
         ORDER BY month ASC`
      )
      .all(...expParams);
  }

  let recentStatusUpdates: any[] = [];
  if (user.role !== 'employee') {
    const statusWhere: string[] = [];
    const statusParams: any[] = [];
    if (user.role === 'moderator') {
      statusWhere.push('t.assigned_moderator_id = ?');
      statusParams.push(user.moderator_id ?? -1);
    } else if (user.role === 'management') {
      const scope = buildAdminTicketScopeClause(user, 't');
      if (scope.clause) {
        statusWhere.push(scope.clause);
        statusParams.push(...scope.params);
      }
    }
    recentStatusUpdates = db
      .prepare(
        `SELECT ta.id, ta.ticket_id, t.ticket_number, t.category, ta.actor_name, ta.actor_role,
                ta.action_type, ta.previous_status, ta.new_status, ta.details, ta.created_at
         FROM ticket_activities ta
         JOIN tickets t ON ta.ticket_id = t.id
         ${statusWhere.length ? `WHERE ${statusWhere.join(' AND ')}` : ''}
         ORDER BY ta.created_at DESC, ta.id DESC
         LIMIT 12`
      )
      .all(...statusParams);
  }

  const canViewChats = user.role !== 'management' || policy.can_view_chats;
  const recentChatMessages = canViewChats
    ? db
        .prepare(
          `SELECT dm.*, su.full_name as sender_name, sr.name as sender_role,
                  ru.full_name as recipient_name, t.ticket_number
           FROM direct_messages dm
           JOIN users su ON dm.sender_user_id = su.id
           JOIN roles sr ON su.role_id = sr.id
           JOIN users ru ON dm.recipient_user_id = ru.id
           LEFT JOIN tickets t ON dm.ticket_id = t.id
           WHERE dm.sender_user_id = ? OR dm.recipient_user_id = ?
           ORDER BY dm.created_at DESC, dm.id DESC
           LIMIT 10`
        )
        .all(user.id, user.id)
    : [];

  const unreadNotificationsCount = (
    db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id) as { c: number }
  ).c;

  const unreadChatCount = canViewChats
    ? (
        db.prepare('SELECT COUNT(*) as c FROM direct_messages WHERE recipient_user_id = ? AND is_read = 0').get(user.id) as {
          c: number;
        }
      ).c
    : 0;

  res.json({
    kpis: {
      ...kpis,
      total_employees: totalEmployees,
      total_moderators: totalModerators,
      unread_notifications: unreadNotificationsCount,
      unread_chat_messages: unreadChatCount,
    },
    charts: {
      ticketsByMonth,
      ticketsByLocation,
      ticketsByCategory,
      moderatorPerformance,
      expenditureByMonth,
    },
    recentStatusUpdates,
    recentChatMessages,
  });
});

// --- SAVED REPORT SNAPSHOTS HISTORY (MUST BE DEFINED BEFORE /reports/:type) ---
router.get(
  '/reports/saved',
  requireAuth,
  requireRole('super_admin', 'management'),
  requireCapability('can_view_reports'),
  (req: AuthRequest, res) => {
    const user = req.user!;
    const policy = getAdminPermissionPolicy(user);
    const { report_type } = req.query as { report_type?: string };

    const where: string[] = ['COALESCE(sr.is_archived, 0) = 0'];
    const params: any[] = [];

    if (report_type && report_type !== 'All') {
      where.push('sr.report_type = ?');
      params.push(report_type);
    }
    if (user.role === 'management' && !policy.can_view_budgets) {
      where.push("sr.report_type NOT IN ('budget','expense')");
    }

    const items = db
      .prepare(
        `SELECT sr.id, sr.report_type, sr.title, sr.filters_json, sr.row_count,
                sr.created_by_user_id, sr.created_by_name, sr.created_by_role, sr.created_at
         FROM saved_reports sr
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY sr.created_at DESC, sr.id DESC
         LIMIT 150`
      )
      .all(...params)
      .map((r: any) => ({
        ...r,
        filters: (() => {
          try {
            return r.filters_json ? JSON.parse(r.filters_json) : {};
          } catch {
            return {};
          }
        })(),
      }));

    res.json({ savedReports: items });
  }
);

router.post(
  '/reports/save',
  requireAuth,
  requireRole('super_admin', 'management'),
  requireCapability('can_view_reports'),
  (req: AuthRequest, res) => {
    const user = req.user!;
    const policy = getAdminPermissionPolicy(user);
    const { report_type, title, filters, rows } = req.body as {
      report_type?: string;
      title?: string;
      filters?: Record<string, any>;
      rows?: any[];
    };

    if (!report_type || !title || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'report_type, title, and rows array are required' });
    }
    if ((report_type === 'budget' || report_type === 'expense') && user.role === 'management' && !policy.can_view_budgets) {
      logUnauthorizedAttempt(req, 'saved_report', report_type);
      return res.status(403).json({ error: 'Access denied: financial report snapshots require Budget view permission' });
    }

    const nowIso = new Date().toISOString();
    const resInsert = db
      .prepare(
        `INSERT INTO saved_reports
         (report_type, title, filters_json, row_count, rows_json, created_by_user_id, created_by_name, created_by_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        report_type,
        title.trim(),
        JSON.stringify(filters || {}),
        rows.length,
        JSON.stringify(rows.slice(0, 5000)),
        user.id,
        user.full_name,
        user.role,
        nowIso
      );

    writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      roleName: user.role,
      action: 'SAVE_REPORT_SNAPSHOT',
      entityType: 'report',
      entityId: String(resInsert.lastInsertRowid),
      details: { report_type, title: title.trim(), row_count: rows.length },
      ipAddress: req.ip,
    });

    res.status(201).json({
      id: Number(resInsert.lastInsertRowid),
      created_at: nowIso,
      row_count: rows.length,
    });
  }
);

router.get(
  '/reports/saved/:id',
  requireAuth,
  requireRole('super_admin', 'management'),
  requireCapability('can_view_reports'),
  (req: AuthRequest, res) => {
    const user = req.user!;
    const policy = getAdminPermissionPolicy(user);
    const row = db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(Number(req.params.id)) as any;
    if (!row) return res.status(404).json({ error: 'Saved report snapshot not found' });

    if ((row.report_type === 'budget' || row.report_type === 'expense') && user.role === 'management' && !policy.can_view_budgets) {
      logUnauthorizedAttempt(req, 'saved_report', row.id);
      return res.status(403).json({ error: 'Access denied: financial report snapshots require Budget view permission' });
    }

    let filters = {};
    let rows: any[] = [];
    try {
      filters = row.filters_json ? JSON.parse(row.filters_json) : {};
    } catch {
      filters = {};
    }
    try {
      rows = row.rows_json ? JSON.parse(row.rows_json) : [];
    } catch {
      rows = [];
    }

    res.json({
      snapshot: {
        id: row.id,
        report_type: row.report_type,
        title: row.title,
        filters,
        row_count: row.row_count,
        rows,
        created_by_name: row.created_by_name,
        created_by_role: row.created_by_role,
        created_at: row.created_at,
      },
    });
  }
);

router.delete('/reports/saved/:id', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const row = db.prepare('SELECT id, title, report_type FROM saved_reports WHERE id = ?').get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: 'Saved report snapshot not found' });

  db.prepare("UPDATE saved_reports SET is_archived = 1, archived_at = datetime('now') WHERE id = ?").run(row.id);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'ARCHIVE_REPORT_SNAPSHOT',
    entityType: 'report',
    entityId: String(row.id),
    details: { title: row.title, report_type: row.report_type, preserved: true },
    ipAddress: req.ip,
  });
  res.json({ ok: true, archived: true });
});

// --- 12 ENTERPRISE REPORTS ---
router.get(
  '/reports/:type',
  requireAuth,
  requireRole('super_admin', 'management'),
  requireCapability('can_view_reports'),
  (req: AuthRequest, res) => {
    const reportType = req.params.type;
    const user = req.user!;
    const policy = getAdminPermissionPolicy(user);

    if ((reportType === 'budget' || reportType === 'expense') && user.role === 'management' && !policy.can_view_budgets) {
      logUnauthorizedAttempt(req, 'report', reportType);
      return res.status(403).json({ error: 'Access denied: Budget & Expense reports require Budget view permission' });
    }

    const { date_from, date_to, location_id, category, moderator_id } = req.query as Record<string, string | undefined>;

    const where: string[] = [];
    const params: any[] = [];
    if (user.role === 'management') {
      const scope = buildAdminTicketScopeClause(user, 't');
      if (scope.clause) {
        where.push(scope.clause);
        params.push(...scope.params);
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
    if (location_id && location_id !== 'All') {
      where.push('t.location_id = ?');
      params.push(Number(location_id));
    }
    if (category && category !== 'All') {
      where.push('t.category = ?');
      params.push(category);
    }
    if (moderator_id && moderator_id !== 'All') {
      where.push('t.assigned_moderator_id = ?');
      params.push(Number(moderator_id));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let rows: any[] = [];
    let title = '';

    switch (reportType) {
      case 'daily':
        title = 'Daily Ticket Report';
        rows = db
          .prepare(
            `SELECT t.ticket_number, date(t.created_at) as date, t.reporter_name, l.name as location, t.category, t.priority, t.status, COALESCE(m.full_name, 'Unassigned') as moderator
             FROM tickets t LEFT JOIN locations l ON t.location_id = l.id LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
             ${whereSql ? whereSql + ' AND' : 'WHERE'} date(t.created_at) >= date('now', '-7 days')
             ORDER BY t.created_at DESC`
          )
          .all(...params);
        break;
      case 'weekly':
        title = 'Weekly Ticket Report';
        rows = db
          .prepare(
            `SELECT strftime('%Y-W%W', t.created_at) as week, COUNT(*) as total_tickets,
                    SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as resolved,
                    SUM(CASE WHEN t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN t.sla_breached = 1 THEN 1 ELSE 0 END) as sla_breaches
             FROM tickets t ${whereSql} GROUP BY week ORDER BY week DESC`
          )
          .all(...params);
        break;
      case 'monthly':
        title = 'Monthly Ticket Report';
        rows = db
          .prepare(
            `SELECT strftime('%Y-%m', t.created_at) as month, COUNT(*) as total_tickets,
                    SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as resolved,
                    SUM(CASE WHEN t.priority = 'Critical' THEN 1 ELSE 0 END) as critical_tickets,
                    COALESCE(SUM(t.expenses_incurred), 0) as ticket_expenses_inr
             FROM tickets t ${whereSql} GROUP BY month ORDER BY month DESC`
          )
          .all(...params);
        break;
      case 'location':
        title = 'Location-Wise Issue Report';
        rows = db
          .prepare(
            `SELECT COALESCE(l.name, t.reporter_branch_name) as location, l.city, COUNT(*) as total_tickets,
                    SUM(CASE WHEN t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as open_tickets,
                    SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as resolved_tickets,
                    SUM(CASE WHEN t.sla_breached = 1 THEN 1 ELSE 0 END) as sla_breaches
             FROM tickets t LEFT JOIN locations l ON t.location_id = l.id
             ${whereSql} GROUP BY location ORDER BY total_tickets DESC`
          )
          .all(...params);
        break;
      case 'moderator': {
        title = 'Moderator Performance Report';
        const modJoinWhere = where.length ? `AND ${where.join(' AND ')}` : '';
        const scopedMods = user.role === 'management' ? getScopedModeratorIdsForAdmin(user) : null;
        const modFilters: string[] = [];
        const modWhereParams: any[] = [];
        if (moderator_id && moderator_id !== 'All') {
          modFilters.push('m.id = ?');
          modWhereParams.push(Number(moderator_id));
        }
        if (user.role === 'management' && scopedMods !== null) {
          if (scopedMods.length === 0) {
            modFilters.push('1 = 0');
          } else {
            modFilters.push(`m.id IN (${scopedMods.map(() => '?').join(',')})`);
            modWhereParams.push(...scopedMods);
          }
        }
        const modWhere = modFilters.length ? `WHERE ${modFilters.join(' AND ')}` : '';
        rows = db
          .prepare(
            `SELECT m.employee_code,
                    CASE WHEN r.name = 'super_admin' THEN m.full_name || ' (Super Admin)' ELSE m.full_name END as moderator,
                    m.specialization,
                    m.status as account_status,
                    COUNT(t.id) as total_assigned,
                    SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as resolved,
                    SUM(CASE WHEN t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN t.status = 'Reopened' THEN 1 ELSE 0 END) as reopened,
                    ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END), 1) as avg_resolution_hrs,
                    ROUND(AVG(CASE WHEN t.first_response_at IS NOT NULL THEN (julianday(t.first_response_at) - julianday(t.created_at)) * 1440 END), 0) as avg_first_response_mins,
                    COALESCE(SUM(t.total_working_minutes), 0) as logged_work_mins
             FROM moderators m
             JOIN users u ON m.user_id = u.id
             JOIN roles r ON u.role_id = r.id
             LEFT JOIN tickets t ON t.assigned_moderator_id = m.id ${modJoinWhere}
             ${modWhere}
             GROUP BY m.id
             ORDER BY resolved DESC, total_assigned DESC`
          )
          .all(...params, ...modWhereParams);
        break;
      }
      case 'pending':
        title = 'Pending Ticket Report';
        rows = db
          .prepare(
            `SELECT t.ticket_number, t.created_at, t.reporter_name, COALESCE(l.name, t.reporter_branch_name) as location,
                    t.category, t.priority, t.status, COALESCE(m.full_name, 'Unassigned') as moderator, t.sla_resolution_due
             FROM tickets t LEFT JOIN locations l ON t.location_id = l.id LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
             ${whereSql ? whereSql + ' AND' : 'WHERE'} t.status NOT IN ('Completed','Resolved','Closed')
             ORDER BY t.created_at ASC`
          )
          .all(...params);
        break;
      case 'resolution-time':
        title = 'Resolution Time Report';
        rows = db
          .prepare(
            `SELECT t.ticket_number, t.category, t.priority, t.status, COALESCE(m.full_name, 'Unassigned') as moderator,
                    t.created_at, t.first_response_at, t.resolved_at,
                    ROUND((julianday(t.resolved_at) - julianday(t.created_at)) * 24, 2) as elapsed_hours,
                    ROUND((julianday(t.resolved_at) - julianday(t.created_at)) * 1440, 0) as resolution_minutes,
                    t.total_working_minutes as active_work_mins
             FROM tickets t LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
             ${whereSql ? whereSql + ' AND' : 'WHERE'} t.resolved_at IS NOT NULL
             ORDER BY elapsed_hours DESC`
          )
          .all(...params);
        break;
      case 'first-response-time':
        title = 'First Response Time Report';
        rows = db
          .prepare(
            `SELECT t.ticket_number, t.category, t.priority, t.status, COALESCE(m.full_name, 'Unassigned') as moderator,
                    t.created_at, t.first_response_at, t.sla_first_response_due,
                    ROUND((julianday(t.first_response_at) - julianday(t.created_at)) * 1440, 1) as first_response_mins
             FROM tickets t LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
             ${whereSql ? whereSql + ' AND' : 'WHERE'} t.first_response_at IS NOT NULL
             ORDER BY first_response_mins DESC`
          )
          .all(...params);
        break;
      case 'asset-maintenance': {
        title = 'Asset Maintenance Report';
        const amWhere: string[] = [];
        const amParams: any[] = [];
        if (location_id && location_id !== 'All') {
          amWhere.push('a.location_id = ?');
          amParams.push(Number(location_id));
        }
        if (user.role === 'management' && policy.allowed_location_ids.length > 0) {
          amWhere.push(`a.location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')})`);
          amParams.push(...policy.allowed_location_ids);
        }
        if (date_from) {
          amWhere.push('date(am.performed_at) >= date(?)');
          amParams.push(date_from);
        }
        if (date_to) {
          amWhere.push('date(am.performed_at) <= date(?)');
          amParams.push(date_to);
        }
        rows = db
          .prepare(
            `SELECT a.asset_tag, COALESCE(a.device_name, a.brand || ' ' || a.model) as device_name,
                    a.serial_number, a.category, a.brand, a.model, l.name as location,
                    am.maintenance_type, am.description, am.cost as cost_inr, am.performed_at, am.performed_by
             FROM asset_maintenance am
             JOIN it_assets a ON am.asset_id = a.id
             LEFT JOIN locations l ON a.location_id = l.id
             ${amWhere.length ? `WHERE ${amWhere.join(' AND ')}` : ''}
             ORDER BY am.performed_at DESC`
          )
          .all(...amParams);
        break;
      }
      case 'budget': {
        title = 'IT Budget Report (INR)';
        const bWhere: string[] = [];
        const bParams: any[] = [];
        if (location_id && location_id !== 'All') {
          bWhere.push('b.location_id = ?');
          bParams.push(Number(location_id));
        }
        if (user.role === 'management' && policy.allowed_location_ids.length > 0) {
          bWhere.push(`(b.location_id IS NULL OR b.location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')}))`);
          bParams.push(...policy.allowed_location_ids);
        }
        rows = db
          .prepare(
            `SELECT b.fiscal_year, CASE WHEN b.month = 0 THEN 'Annual' ELSE printf('Month %02d', b.month) END as period,
                    COALESCE(l.name, 'Company-Wide') as location, COALESCE(b.category, 'All Categories') as category,
                    b.allocated_amount as allocated_amount_inr, b.notes
             FROM it_budgets b LEFT JOIN locations l ON b.location_id = l.id
             ${bWhere.length ? `WHERE ${bWhere.join(' AND ')}` : ''}
             ORDER BY b.fiscal_year DESC, b.month ASC`
          )
          .all(...bParams);
        break;
      }
      case 'expense': {
        title = 'Expense Report (INR)';
        const eWhere: string[] = [];
        const eParams: any[] = [];
        if (location_id && location_id !== 'All') {
          eWhere.push('e.location_id = ?');
          eParams.push(Number(location_id));
        }
        if (user.role === 'management' && policy.allowed_location_ids.length > 0) {
          eWhere.push(`(e.location_id IS NULL OR e.location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')}))`);
          eParams.push(...policy.allowed_location_ids);
        }
        if (date_from) {
          eWhere.push('date(e.payment_date) >= date(?)');
          eParams.push(date_from);
        }
        if (date_to) {
          eWhere.push('date(e.payment_date) <= date(?)');
          eParams.push(date_to);
        }
        rows = db
          .prepare(
            `SELECT e.payment_date, e.invoice_number, e.category, e.vendor_name, COALESCE(l.name, 'Global') as location,
                    COALESCE(t.ticket_number, '-') as ticket_ref, e.amount as amount_inr, e.approval_status, e.description
             FROM expenses e LEFT JOIN locations l ON e.location_id = l.id LEFT JOIN tickets t ON e.ticket_id = t.id
             ${eWhere.length ? `WHERE ${eWhere.join(' AND ')}` : ''}
             ORDER BY e.payment_date DESC`
          )
          .all(...eParams);
        break;
      }
      case 'employee': {
        title = 'Employee-Wise Issue Report';
        const empJoinWhere = where.length ? `AND ${where.join(' AND ')}` : '';
        const empOuter: string[] = [];
        const empOuterParams: any[] = [];
        if (user.role === 'management') {
          if (policy.allowed_location_ids.length > 0) {
            empOuter.push(`e.location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')})`);
            empOuterParams.push(...policy.allowed_location_ids);
          }
          if (policy.allowed_department_ids.length > 0) {
            empOuter.push(`e.department_id IN (${policy.allowed_department_ids.map(() => '?').join(',')})`);
            empOuterParams.push(...policy.allowed_department_ids);
          }
        }
        rows = db
          .prepare(
            `SELECT e.employee_code, e.full_name, e.mobile, d.name as department, l.name as location,
                    COUNT(t.id) as total_tickets,
                    SUM(CASE WHEN t.status NOT IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as open_tickets,
                    SUM(CASE WHEN t.status IN ('Completed','Resolved','Closed') THEN 1 ELSE 0 END) as resolved_tickets
             FROM employees e
             LEFT JOIN departments d ON e.department_id = d.id
             LEFT JOIN locations l ON e.location_id = l.id
             LEFT JOIN tickets t ON (t.employee_id = e.id OR (e.user_id IS NOT NULL AND t.created_by_user_id = e.user_id)) ${empJoinWhere}
             ${empOuter.length ? `WHERE ${empOuter.join(' AND ')}` : ''}
             GROUP BY e.id ORDER BY total_tickets DESC`
          )
          .all(...params, ...empOuterParams);
        break;
      }
      case 'sla-breach':
        title = 'SLA Breach Report';
        rows = db
          .prepare(
            `SELECT t.ticket_number, t.priority, t.status, t.reporter_name, COALESCE(l.name, t.reporter_branch_name) as location,
                    COALESCE(m.full_name, 'Unassigned') as moderator, t.created_at, t.sla_first_response_due, t.sla_resolution_due
             FROM tickets t LEFT JOIN locations l ON t.location_id = l.id LEFT JOIN moderators m ON t.assigned_moderator_id = m.id
             ${whereSql ? whereSql + ' AND' : 'WHERE'} t.sla_breached = 1
             ORDER BY t.created_at DESC`
          )
          .all(...params);
        break;
      default:
        return res.status(400).json({ error: 'Unknown report type' });
    }

    writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      roleName: user.role,
      action: 'VIEW_REPORT',
      entityType: 'report',
      entityId: reportType,
      details: { row_count: rows.length },
      ipAddress: req.ip,
    });

    res.json({ title, type: reportType, rows, generatedAt: new Date().toISOString() });
  }
);

// --- MICROSOFT OUTLOOK INTEGRATION ---
router.get('/integrations/outlook/status', requireAuth, requireRole('super_admin'), (_req, res) => {
  const cfg = getEffectiveOutlookConfig();
  const appUrl = process.env.APP_URL || '';
  const history = db.prepare('SELECT * FROM email_communications ORDER BY created_at DESC LIMIT 50').all();
  res.json({
    configured: Boolean(cfg.clientId && cfg.clientSecret),
    connected: Boolean(cfg.accessToken),
    connectedEmail: cfg.connectedEmail || null,
    tenantId: cfg.tenantId || 'common',
    clientIdSet: Boolean(cfg.clientId),
    clientIdMasked: maskSecret(cfg.clientId),
    hasClientSecret: Boolean(cfg.clientSecret),
    clientSecretMasked: maskSecret(cfg.clientSecret),
    callbackUrl: appUrl ? `${appUrl.replace(/\/$/, '')}/auth/outlook/callback` : '/auth/outlook/callback',
    autoNotifyOnCreate: cfg.autoNotifyOnCreate,
    autoNotifyOnAssign: cfg.autoNotifyOnAssign,
    autoNotifyOnResolve: cfg.autoNotifyOnResolve,
    history,
  });
});

router.post('/integrations/outlook/config', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const existing = getEffectiveOutlookConfig();
  const { clientId, clientSecret, tenantId, autoNotifyOnCreate, autoNotifyOnAssign, autoNotifyOnResolve, disconnect } = req.body;
  if (disconnect) {
    saveIntegrationSetting(
      'outlook',
      {
        ...existing,
        accessToken: '',
        refreshToken: '',
        connectedEmail: '',
        expiresAt: '',
      },
      req.user!.id
    );
    return res.json({ ok: true });
  }
  saveIntegrationSetting(
    'outlook',
    {
      ...existing,
      clientId: clientId !== undefined ? clientId.trim() : existing.clientId,
      clientSecret: clientSecret ? clientSecret.trim() : existing.clientSecret,
      tenantId: tenantId ? tenantId.trim() : existing.tenantId || 'common',
      autoNotifyOnCreate: autoNotifyOnCreate ?? existing.autoNotifyOnCreate,
      autoNotifyOnAssign: autoNotifyOnAssign ?? existing.autoNotifyOnAssign,
      autoNotifyOnResolve: autoNotifyOnResolve ?? existing.autoNotifyOnResolve,
    },
    req.user!.id
  );
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_OUTLOOK_CONFIG',
    entityType: 'integration',
    entityId: 'outlook',
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

router.get('/integrations/outlook/auth-url', requireAuth, requireRole('super_admin'), (req, res) => {
  const cfg = getEffectiveOutlookConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    return res.status(400).json({ error: 'Enter Microsoft Azure Client ID and Client Secret first.' });
  }
  const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const redirectUri = `${baseUrl}/auth/outlook/callback`;

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: 'openid profile email offline_access User.Read Mail.Read Mail.Send',
    prompt: 'consent',
  });

  const url = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId || 'common')}/oauth2/v2.0/authorize?${params.toString()}`;
  res.json({ url, redirectUri });
});

router.post('/integrations/outlook/send', requireAuth, requireRole('super_admin', 'moderator'), async (req: AuthRequest, res) => {
  const { ticket_id, to, subject, body } = req.body;
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Recipient, subject, and body are required' });
  }
  const result = await dispatchOutlookEmail({
    ticketId: ticket_id ? Number(ticket_id) : null,
    to: to.trim(),
    subject: subject.trim(),
    body: body.trim(),
  });
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'SEND_OUTLOOK_EMAIL',
    entityType: 'ticket',
    entityId: ticket_id ? String(ticket_id) : 'general',
    details: { to: to.trim(), subject: subject.trim() },
    ipAddress: req.ip,
  });
  res.json(result);
});

router.post('/integrations/outlook/sync-inbox', requireAuth, requireRole('super_admin'), async (_req, res) => {
  const cfg = getEffectiveOutlookConfig();
  if (!cfg.accessToken) {
    return res.status(400).json({ error: 'Outlook OAuth account is not connected yet.' });
  }
  try {
    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=15&$select=id,subject,from,bodyPreview,receivedDateTime', {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    });
    if (!graphRes.ok) {
      const txt = await graphRes.text();
      return res.status(502).json({ error: `Microsoft Graph error: ${txt}` });
    }
    const data = (await graphRes.json()) as { value: any[] };
    const insert = db.prepare(
      `INSERT INTO email_communications (ticket_id, direction, sender_email, recipient_email, subject, body, message_id, status)
       SELECT ?, 'Inbound', ?, ?, ?, ?, ?, 'Received'
       WHERE NOT EXISTS (SELECT 1 FROM email_communications WHERE message_id = ?)`
    );

    let added = 0;
    for (const msg of data.value || []) {
      const subj = msg.subject || '(No Subject)';
      const match = subj.match(/IT-\d{4}-\d{5}/);
      let ticketId: number | null = null;
      if (match) {
        const t = db.prepare('SELECT id FROM tickets WHERE ticket_number = ?').get(match[0]) as { id: number } | undefined;
        if (t) ticketId = t.id;
      }
      const r = insert.run(
        ticketId,
        msg.from?.emailAddress?.address || 'unknown@sender',
        cfg.connectedEmail || 'support@outlook',
        subj,
        msg.bodyPreview || '',
        msg.id,
        msg.id
      );
      if (r.changes > 0) added++;
    }
    res.json({ synced: added });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/integrations/outlook/link-ticket', requireAuth, requireRole('super_admin'), (req, res) => {
  const { email_id, ticket_id } = req.body;
  db.prepare('UPDATE email_communications SET ticket_id = ? WHERE id = ?').run(Number(ticket_id), Number(email_id));
  res.json({ ok: true });
});

// --- META WHATSAPP CLOUD API ---
router.get('/integrations/whatsapp/status', requireAuth, requireRole('super_admin'), (_req, res) => {
  const cfg = getEffectiveWhatsAppConfig();
  const appUrl = process.env.APP_URL || '';
  const history = db.prepare('SELECT * FROM whatsapp_communications ORDER BY created_at DESC LIMIT 50').all();
  res.json({
    configured: Boolean(cfg.accessToken && cfg.phoneNumberId),
    enabled: cfg.enabled,
    wabaId: cfg.wabaId,
    phoneNumberId: cfg.phoneNumberId,
    hasAccessToken: Boolean(cfg.accessToken),
    accessTokenMasked: maskSecret(cfg.accessToken),
    hasVerifyToken: Boolean(cfg.webhookVerifyToken),
    webhookVerifyTokenMasked: maskSecret(cfg.webhookVerifyToken),
    webhookUrl: appUrl ? `${appUrl.replace(/\/$/, '')}/api/webhooks/whatsapp` : '/api/webhooks/whatsapp',
    templates: cfg.templates,
    history,
  });
});

router.post('/integrations/whatsapp/config', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const existing = getEffectiveWhatsAppConfig();
  const { wabaId, phoneNumberId, accessToken, webhookVerifyToken, enabled, templates } = req.body;
  saveIntegrationSetting(
    'whatsapp',
    {
      wabaId: wabaId !== undefined ? wabaId.trim() : existing.wabaId,
      phoneNumberId: phoneNumberId !== undefined ? phoneNumberId.trim() : existing.phoneNumberId,
      accessToken: accessToken ? accessToken.trim() : existing.accessToken,
      webhookVerifyToken: webhookVerifyToken ? webhookVerifyToken.trim() : existing.webhookVerifyToken,
      enabled: enabled !== undefined ? Boolean(enabled) : existing.enabled,
      templates: templates || existing.templates,
    },
    req.user!.id
  );
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_WHATSAPP_CONFIG',
    entityType: 'integration',
    entityId: 'whatsapp',
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

router.post('/integrations/whatsapp/send', requireAuth, requireRole('super_admin', 'moderator'), async (req: AuthRequest, res) => {
  const { ticket_id, to_phone, message, template_name } = req.body;
  if (!to_phone || !message) {
    return res.status(400).json({ error: 'Phone number and message body are required' });
  }
  const result = await dispatchWhatsAppMessage({
    ticketId: ticket_id ? Number(ticket_id) : null,
    toPhone: to_phone.trim(),
    messageBody: message.trim(),
    templateName: template_name || null,
  });
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'SEND_WHATSAPP_MESSAGE',
    entityType: 'ticket',
    entityId: ticket_id ? String(ticket_id) : 'general',
    details: { to_phone: to_phone.trim(), template_name: template_name || null },
    ipAddress: req.ip,
  });
  res.json(result);
});

// Meta Webhook Verification (GET) & Incoming Message Webhook (POST)
router.get('/webhooks/whatsapp', (req, res) => {
  const cfg = getEffectiveWhatsAppConfig();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === cfg.webhookVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/webhooks/whatsapp', (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (msg) {
      const fromPhone = msg.from || '';
      const textBody = msg.text?.body || '[Media/Template Reply]';
      const ticketMatch = textBody.match(/IT-\d{4}-\d{5}/);
      let ticket: any = null;
      if (ticketMatch) {
        ticket = db.prepare('SELECT * FROM tickets WHERE ticket_number = ?').get(ticketMatch[0]);
      } else {
        ticket = db
          .prepare("SELECT * FROM tickets WHERE replace(replace(reporter_mobile, '+', ''), '-', '') LIKE ? ORDER BY updated_at DESC LIMIT 1")
          .get(`%${fromPhone.slice(-10)}`);
      }
      db.prepare(
        `INSERT INTO whatsapp_communications (ticket_id, direction, phone_number, message_body, wa_message_id, status)
         VALUES (?, 'Inbound', ?, ?, ?, 'Received')`
      ).run(ticket?.id ?? null, fromPhone, textBody, msg.id || null);

      if (ticket) {
        db.prepare(
          `INSERT INTO ticket_comments (ticket_id, sender_name, sender_role, channel, is_internal, message)
           VALUES (?, ?, 'employee', 'WhatsApp', 0, ?)`
        ).run(ticket.id, ticket.reporter_name, textBody);
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
  res.sendStatus(200);
});

export default router;
