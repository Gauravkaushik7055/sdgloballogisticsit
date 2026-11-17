import { db } from './db.ts';
import { notifyAdmins } from './auth.ts';

export function computeSlaDeadlines(priority: string, createdAtIso?: string) {
  const sla = db
    .prepare('SELECT * FROM sla_configurations WHERE priority = ?')
    .get(priority) as
    | {
        first_response_minutes: number;
        resolution_hours: number;
      }
    | undefined;

  const firstMins = sla?.first_response_minutes ?? (priority === 'Critical' ? 15 : priority === 'High' ? 30 : priority === 'Medium' ? 240 : 480);
  const resHours = sla?.resolution_hours ?? (priority === 'Critical' ? 4 : priority === 'High' ? 8 : priority === 'Medium' ? 24 : 48);

  const base = createdAtIso ? new Date(createdAtIso) : new Date();
  const firstDue = new Date(base.getTime() + firstMins * 60 * 1000).toISOString();
  const resDue = new Date(base.getTime() + resHours * 60 * 60 * 1000).toISOString();

  return {
    sla_first_response_due: firstDue,
    sla_resolution_due: resDue,
  };
}

export function evaluateOverdueTickets() {
  const nowIso = new Date().toISOString();
  const candidates = db
    .prepare(
      `SELECT id, ticket_number, priority, status, sla_resolution_due, sla_breached
       FROM tickets
       WHERE status NOT IN ('Completed', 'Resolved', 'Closed')
         AND sla_resolution_due IS NOT NULL
         AND sla_resolution_due < ?
         AND sla_breached = 0`
    )
    .all(nowIso) as {
      id: number;
      ticket_number: string;
      priority: string;
      status: string;
      sla_resolution_due: string;
    }[];

  if (candidates.length === 0) return;

  const updateStmt = db.prepare('UPDATE tickets SET sla_breached = 1, updated_at = ? WHERE id = ?');
  const actStmt = db.prepare(
    `INSERT INTO ticket_activities (ticket_id, actor_user_id, actor_name, actor_role, action_type, previous_status, new_status, details)
     VALUES (?, NULL, 'SLA Monitor', 'system', 'SLA Breach Alert', ?, ?, ?)`
  );

  for (const t of candidates) {
    updateStmt.run(nowIso, t.id);
    actStmt.run(
      t.id,
      t.status,
      t.status,
      `Resolution SLA deadline (${t.sla_resolution_due}) missed for ${t.priority} ticket.`
    );
    if (t.priority === 'Critical' || t.priority === 'High') {
      notifyAdmins({
        ticketId: t.id,
        title: `SLA Breached: ${t.ticket_number}`,
        message: `${t.priority} priority ticket ${t.ticket_number} missed its SLA target and requires immediate IT Head review.`,
        type: 'critical',
        eventKey: `sla_breach:${t.id}`,
      });
    }
  }
}
