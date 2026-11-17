import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db.ts';
import { sendToSuperAdmins } from '../realtime.ts';

const router = Router();

const BOT_UA_REGEX = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|headlesschrome|puppeteer|playwright|lighthouse|pagespeed|curl\/|wget\/|python-requests|go-http-client|axios\/|postman|insomnia|uptime|pingdom|datadog/i;

function isBotUserAgent(ua: string): boolean {
  if (!ua || !ua.trim()) return true;
  return BOT_UA_REGEX.test(ua);
}

function classifyDeviceType(ua: string): 'Desktop' | 'Mobile' | 'Tablet' {
  const lower = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobi))/i.test(lower)) return 'Tablet';
  if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/i.test(lower)) return 'Mobile';
  return 'Desktop';
}

function parseReferrerHost(referrer: string): string {
  const raw = (referrer || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.hostname.replace(/^www\./i, '').slice(0, 120);
  } catch {
    return raw.slice(0, 120);
  }
}

function computeVisitorHash(visitorId: string, ip: string, ua: string): string {
  const salt = process.env.JWT_SECRET || 'sdglobal-visit-salt-2026';
  const seed = visitorId ? `vid:${visitorId}` : `ipua:${ip}|${ua.slice(0, 80)}`;
  return crypto.createHash('sha256').update(`${salt}:${seed}`).digest('hex');
}

// POST /api/public/track-visit — tracks real public website visits with bot filtering & 30-min deduplication
router.post('/track-visit', (req, res) => {
  try {
    const ua = String(req.headers['user-agent'] || '');
    if (isBotUserAgent(ua)) {
      return res.json({ ok: true, tracked: false, reason: 'bot_filtered' });
    }

    const { page_path, referrer, session_key, visitor_id } = (req.body || {}) as {
      page_path?: string;
      referrer?: string;
      session_key?: string;
      visitor_id?: string;
    };

    const rawPath = String(page_path || '/').trim() || '/';
    const cleanPath = rawPath.startsWith('/') ? rawPath.slice(0, 200) : `/${rawPath.slice(0, 199)}`;
    if (cleanPath.startsWith('/api') || cleanPath.startsWith('/ws')) {
      return res.json({ ok: true, tracked: false, reason: 'non_page' });
    }

    const cleanSession = String(session_key || '').trim().slice(0, 100) || crypto.randomBytes(12).toString('hex');
    const cleanVisitorId = String(visitor_id || '').trim().slice(0, 100);
    const visitorHash = computeVisitorHash(cleanVisitorId, req.ip || '', ua);
    const cleanReferrer = String(referrer || '').trim().slice(0, 400);
    const refHost = parseReferrerHost(cleanReferrer);
    const deviceType = classifyDeviceType(ua);
    const nowIso = new Date().toISOString();

    // Deduplicate same session + page within a 30-minute window
    const recentDup = db
      .prepare(
        `SELECT id FROM website_visits
         WHERE session_key = ?
           AND page_path = ?
           AND datetime(visited_at) >= datetime('now', '-30 minutes')
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(cleanSession, cleanPath) as { id: number } | undefined;

    if (recentDup) {
      db.prepare('UPDATE website_visits SET last_heartbeat_at = ? WHERE id = ?').run(nowIso, recentDup.id);
      return res.json({ ok: true, tracked: false, deduplicated: true, session_key: cleanSession });
    }

    db.prepare(
      `INSERT INTO website_visits (
         visitor_hash, session_key, page_path, referrer, referrer_host, user_agent, device_type, visited_at, last_heartbeat_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(visitorHash, cleanSession, cleanPath, cleanReferrer, refHost, ua.slice(0, 300), deviceType, nowIso, nowIso);

    sendToSuperAdmins('traffic:updated', { page_path: cleanPath, visited_at: nowIso });
    return res.status(201).json({ ok: true, tracked: true, session_key: cleanSession });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to track visit' });
  }
});

// POST /api/public/visit-heartbeat — keeps currently active public visitor count accurate
router.post('/visit-heartbeat', (req, res) => {
  try {
    const ua = String(req.headers['user-agent'] || '');
    if (isBotUserAgent(ua)) {
      return res.json({ ok: true });
    }
    const { session_key, page_path } = (req.body || {}) as { session_key?: string; page_path?: string };
    const cleanSession = String(session_key || '').trim().slice(0, 100);
    if (!cleanSession) return res.json({ ok: true });

    const nowIso = new Date().toISOString();
    const row = page_path
      ? (db
          .prepare('SELECT id FROM website_visits WHERE session_key = ? AND page_path = ? ORDER BY id DESC LIMIT 1')
          .get(cleanSession, String(page_path).slice(0, 200)) as { id: number } | undefined)
      : (db
          .prepare('SELECT id FROM website_visits WHERE session_key = ? ORDER BY id DESC LIMIT 1')
          .get(cleanSession) as { id: number } | undefined);

    if (row) {
      db.prepare('UPDATE website_visits SET last_heartbeat_at = ? WHERE id = ?').run(nowIso, row.id);
    }
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: true });
  }
});

// GET /api/public/live-overview — safe, non-PII live operational metrics for the public webpage
router.get('/live-overview', (_req, res) => {
  try {
    const locations = db
      .prepare('SELECT id, code, name, type, city, state FROM locations ORDER BY id ASC')
      .all() as Array<{ id: number; code: string; name: string; type: string; city: string; state: string }>;

    const slaTiers = db
      .prepare(
        `SELECT priority, first_response_minutes, resolution_hours, working_hours_start, working_hours_end
         FROM sla_configurations
         ORDER BY CASE priority
           WHEN 'Critical' THEN 1
           WHEN 'High' THEN 2
           WHEN 'Medium' THEN 3
           ELSE 4
         END`
      )
      .all() as Array<{
      priority: string;
      first_response_minutes: number;
      resolution_hours: number;
      working_hours_start: string;
      working_hours_end: string;
    }>;

    const counts = db
      .prepare(
        `SELECT
           COUNT(*) as total_tickets,
           SUM(CASE WHEN status IN ('Completed', 'Resolved', 'Closed') THEN 1 ELSE 0 END) as completed_tickets,
           SUM(CASE WHEN status NOT IN ('Completed', 'Resolved', 'Closed') THEN 1 ELSE 0 END) as active_tickets
         FROM tickets`
      )
      .get() as { total_tickets: number; completed_tickets: number; active_tickets: number } | undefined;

    const activeModerators = (
      db
        .prepare(
          `SELECT COUNT(*) as c
           FROM moderators m
           JOIN users u ON m.user_id = u.id
           WHERE u.status = 'Active'`
        )
        .get() as { c: number }
    ).c;

    res.json({
      company: {
        name: 'SD Global',
        portal_title: 'SD Global IT Operations & Support Desk',
        support_email: 'techsupport@sdgloballogistics.com',
      },
      metrics: {
        active_locations: locations.length,
        active_moderators: activeModerators,
        total_tickets: counts?.total_tickets || 0,
        active_tickets: counts?.active_tickets || 0,
        completed_tickets: counts?.completed_tickets || 0,
      },
      locations,
      sla_tiers: slaTiers,
      server_time: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load live operational overview' });
  }
});

// POST /api/public/track-ticket — safe ticket roadmap lookup verified by last 4 digits of reporter mobile
router.post('/track-ticket', (req, res) => {
  const { ticket_number, mobile_last4 } = req.body as {
    ticket_number?: string;
    mobile_last4?: string;
  };

  const cleanNumber = (ticket_number || '').trim().toUpperCase();
  const cleanDigits = (mobile_last4 || '').replace(/\D/g, '');

  if (!cleanNumber || cleanDigits.length !== 4) {
    return res.status(400).json({
      error: 'Enter a valid ticket number and the last 4 digits of your registered mobile number.',
    });
  }

  const ticket = db
    .prepare(
      `SELECT
         t.id,
         t.ticket_number,
         t.status,
         t.priority,
         t.category,
         t.device_name,
         t.reporter_mobile,
         t.created_at,
         t.updated_at,
         t.sla_resolution_due,
         t.assigned_moderator_id,
         l.name as location_name,
         e.mobile as employee_mobile
       FROM tickets t
       LEFT JOIN locations l ON t.location_id = l.id
       LEFT JOIN employees e ON t.employee_id = e.id
       WHERE upper(t.ticket_number) = ?`
    )
    .get(cleanNumber) as
    | {
        id: number;
        ticket_number: string;
        status: string;
        priority: string;
        category: string;
        device_name: string;
        reporter_mobile: string | null;
        created_at: string;
        updated_at: string;
        sla_resolution_due: string | null;
        assigned_moderator_id: number | null;
        location_name: string | null;
        employee_mobile: string | null;
      }
    | undefined;

  if (!ticket) {
    return res.status(404).json({
      error: 'No matching ticket found for that ticket number and mobile verification digits.',
    });
  }

  const candidatePhones = [ticket.reporter_mobile || '', ticket.employee_mobile || '']
    .map((p) => p.replace(/\D/g, ''))
    .filter((p) => p.length >= 4);

  const matched = candidatePhones.some((digits) => digits.slice(-4) === cleanDigits);
  if (!matched) {
    return res.status(404).json({
      error: 'No matching ticket found for that ticket number and mobile verification digits.',
    });
  }

  const timeline = db
    .prepare(
      `SELECT action_type as action, previous_status, new_status, created_at
       FROM ticket_activities
       WHERE ticket_id = ?
         AND (
           new_status IS NOT NULL
           OR action_type IN ('CREATED', 'ASSIGNED', 'STATUS_CHANGED', 'WORK_APPROVED_COMPLETED', 'REVISION_REQUESTED', 'REOPENED', 'EMPLOYEE_CONFIRMED')
         )
       ORDER BY created_at ASC, id ASC`
    )
    .all(ticket.id) as Array<{
    action: string;
    previous_status: string | null;
    new_status: string | null;
    created_at: string;
  }>;

  res.json({
    ticket: {
      ticket_number: ticket.ticket_number,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      device_name: ticket.device_name,
      location_name: ticket.location_name || 'SD Global Hub',
      assignment_state: ticket.assigned_moderator_id ? 'Assigned to IT Engineer' : 'Pending Assignment',
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      sla_resolution_due_at: ticket.sla_resolution_due,
    },
    timeline,
  });
});

export default router;
