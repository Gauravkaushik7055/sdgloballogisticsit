import { Router } from 'express';
import { db } from '../db.ts';
import { type AuthRequest, requireAuth, requireRole } from '../auth.ts';

const router = Router();

// GET /api/analytics/website-traffic — real public website traffic & visitor analytics (Super Admin only)
router.get('/analytics/website-traffic', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { granularity = 'daily', date_from, date_to, page_path } = req.query as Record<string, string | undefined>;

  const where: string[] = [];
  const params: any[] = [];

  if (date_from) {
    where.push('date(visited_at) >= date(?)');
    params.push(date_from);
  }
  if (date_to) {
    where.push('date(visited_at) <= date(?)');
    params.push(date_to);
  }
  if (page_path && page_path !== 'All') {
    where.push('page_path = ?');
    params.push(page_path);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as total_visits,
         COUNT(DISTINCT visitor_hash) as unique_visitors
       FROM website_visits
       ${whereSql}`
    )
    .get(...params) as { total_visits: number; unique_visitors: number };

  const periods = db
    .prepare(
      `SELECT
         SUM(CASE WHEN date(visited_at) = date('now') THEN 1 ELSE 0 END) as today_visits,
         SUM(CASE WHEN date(visited_at) = date('now', '-1 day') THEN 1 ELSE 0 END) as yesterday_visits,
         SUM(CASE WHEN datetime(visited_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as weekly_visits,
         SUM(CASE WHEN datetime(visited_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as monthly_visits,
         SUM(CASE WHEN datetime(visited_at) >= datetime('now', '-365 days') THEN 1 ELSE 0 END) as yearly_visits,
         SUM(CASE WHEN datetime(visited_at) >= datetime('now', '-14 days') AND datetime(visited_at) < datetime('now', '-7 days') THEN 1 ELSE 0 END) as prev_week_visits
       FROM website_visits`
    )
    .get() as {
    today_visits: number | null;
    yesterday_visits: number | null;
    weekly_visits: number | null;
    monthly_visits: number | null;
    yearly_visits: number | null;
    prev_week_visits: number | null;
  };

  const activeVisitorsNow = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT session_key) as c
         FROM website_visits
         WHERE datetime(last_heartbeat_at) >= datetime('now', '-5 minutes')`
      )
      .get() as { c: number }
  ).c;

  const thisWeek = periods.weekly_visits || 0;
  const prevWeek = periods.prev_week_visits || 0;
  let growthPct: number | null = null;
  if (prevWeek > 0) {
    growthPct = Math.round(((thisWeek - prevWeek) / prevWeek) * 1000) / 10;
  } else if (thisWeek > 0) {
    growthPct = 100;
  } else {
    growthPct = 0;
  }

  let groupExpr = "strftime('%Y-%m-%d', visited_at)";
  let defaultWindowClause = "datetime(visited_at) >= datetime('now', '-30 days')";
  if (granularity === 'weekly') {
    groupExpr = "strftime('%Y-W%W', visited_at)";
    defaultWindowClause = "datetime(visited_at) >= datetime('now', '-120 days')";
  } else if (granularity === 'monthly') {
    groupExpr = "strftime('%Y-%m', visited_at)";
    defaultWindowClause = "datetime(visited_at) >= datetime('now', '-365 days')";
  } else if (granularity === 'yearly') {
    groupExpr = "strftime('%Y', visited_at)";
    defaultWindowClause = '1=1';
  }

  const trendWhere =
    date_from || date_to
      ? whereSql
      : where.length > 0
      ? `${whereSql} AND ${defaultWindowClause}`
      : `WHERE ${defaultWindowClause}`;

  const trend = db
    .prepare(
      `SELECT ${groupExpr} as period,
              COUNT(*) as visits,
              COUNT(DISTINCT visitor_hash) as unique_visitors
       FROM website_visits
       ${trendWhere}
       GROUP BY period
       ORDER BY period ASC`
    )
    .all(...params);

  const topPages = db
    .prepare(
      `SELECT page_path,
              COUNT(*) as visits,
              COUNT(DISTINCT visitor_hash) as unique_visitors
       FROM website_visits
       ${whereSql}
       GROUP BY page_path
       ORDER BY visits DESC
       LIMIT 15`
    )
    .all(...params);

  const referrers = db
    .prepare(
      `SELECT COALESCE(NULLIF(referrer_host, ''), 'Direct / Bookmark') as source,
              COUNT(*) as visits,
              COUNT(DISTINCT visitor_hash) as unique_visitors
       FROM website_visits
       ${whereSql}
       GROUP BY source
       ORDER BY visits DESC
       LIMIT 12`
    )
    .all(...params);

  const devices = db
    .prepare(
      `SELECT device_type, COUNT(*) as visits
       FROM website_visits
       ${whereSql}
       GROUP BY device_type
       ORDER BY visits DESC`
    )
    .all(...params);

  const recentVisits = db
    .prepare(
      `SELECT visited_at,
              page_path,
              COALESCE(NULLIF(referrer_host, ''), 'Direct / Bookmark') as referrer,
              device_type,
              substr(visitor_hash, 1, 10) as visitor_token
       FROM website_visits
       ${whereSql}
       ORDER BY visited_at DESC, id DESC
       LIMIT 100`
    )
    .all(...params);

  res.json({
    summary: {
      total_visits: totals.total_visits || 0,
      unique_visitors: totals.unique_visitors || 0,
      today_visits: periods.today_visits || 0,
      yesterday_visits: periods.yesterday_visits || 0,
      weekly_visits: periods.weekly_visits || 0,
      monthly_visits: periods.monthly_visits || 0,
      yearly_visits: periods.yearly_visits || 0,
      active_visitors_now: activeVisitorsNow || 0,
      growth_pct: growthPct,
    },
    trend,
    top_pages: topPages,
    referrers,
    devices,
    recent_visits: recentVisits,
  });
});

export default router;
