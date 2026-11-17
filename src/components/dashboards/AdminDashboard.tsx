import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Bell, Globe, Megaphone, MessageSquare } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAuth } from '../../context/AuthContext.tsx';
import { useDropdowns } from '../../context/DropdownContext.tsx';
import {
  BroadcastNotificationItem,
  DepartmentItem,
  LocationItem,
  ModeratorItem,
  TicketItem,
  WebsiteTrafficResponse,
} from '../../types/index.ts';
import {
  apiFetch,
  formatCurrency,
  formatDateTime,
  getPriorityColorClass,
  getStatusColorClass,
} from '../../utils/api.ts';
import type { TicketQueuePreset } from '../tickets/TicketsView.tsx';

export type DashboardDrilldownTarget =
  | { section: 'tickets'; queueFilter: TicketQueuePreset }
  | { section: 'employees' }
  | { section: 'moderators'; moderatorStatus: 'All' | 'Active' }
  | { section: 'reports'; reportType: string }
  | { section: 'broadcasts' }
  | { section: 'traffic' };

interface AdminDashboardProps {
  onSelectTicket: (ticketId: number) => void;
  onOpenDirectChat?: (ticketId?: number, peerUserId?: number) => void;
  onOpenIntegrations?: () => void;
  onNavigateDrilldown?: (target: DashboardDrilldownTarget) => void;
  refreshTrigger: number;
  readOnlyExecutive?: boolean;
}

export default function AdminDashboard({
  onSelectTicket,
  onOpenDirectChat,
  onOpenIntegrations,
  onNavigateDrilldown,
  refreshTrigger,
  readOnlyExecutive = false,
}: AdminDashboardProps) {
  const { user, unreadCount, chatUnreadCount, subscribeRealtime } = useAuth();
  const { getOptions } = useDropdowns();
  const [data, setData] = useState<any>(null);
  const [recentTickets, setRecentTickets] = useState<TicketItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [moderators, setModerators] = useState<ModeratorItem[]>([]);
  const [trafficSummary, setTrafficSummary] = useState<WebsiteTrafficResponse['summary'] | null>(null);
  const [broadcastSummary, setBroadcastSummary] = useState<{
    published: number;
    scheduled: number;
    totalReads: number;
  } | null>(null);

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [locationId, setLocationId] = useState('All');
  const [departmentId, setDepartmentId] = useState('All');
  const [moderatorId, setModeratorId] = useState('All');
  const [category, setCategory] = useState('All');
  const [priority, setPriority] = useState('All');
  const [status, setStatus] = useState('All');
  const [queueFocus, setQueueFocus] = useState<'all' | 'pending_assigns' | 'pending_work'>('all');

  const loadAnalytics = useCallback(async () => {
    const qs = new URLSearchParams();
    if (dateFrom) qs.set('date_from', dateFrom);
    if (dateTo) qs.set('date_to', dateTo);
    if (locationId !== 'All') qs.set('location_id', locationId);
    if (departmentId !== 'All') qs.set('department_id', departmentId);
    if (moderatorId !== 'All') qs.set('moderator_id', moderatorId);
    if (category !== 'All') qs.set('category', category);
    if (priority !== 'All') qs.set('priority', priority);
    if (status !== 'All') qs.set('status', status);

    const [analyticsRes, ticketsRes] = await Promise.all([
      apiFetch<any>(`/api/analytics/dashboard?${qs.toString()}`),
      apiFetch<{ tickets: TicketItem[] }>(`/api/tickets?${qs.toString()}`),
    ]);
    setData(analyticsRes);
    const filteredList =
      queueFocus === 'pending_assigns'
        ? ticketsRes.tickets.filter(
            (t) => !t.assigned_moderator_id && !['Completed', 'Resolved', 'Closed'].includes(t.status)
          )
        : queueFocus === 'pending_work'
        ? ticketsRes.tickets.filter(
            (t) => Boolean(t.assigned_moderator_id) && !['Completed', 'Resolved', 'Closed'].includes(t.status)
          )
        : ticketsRes.tickets;
    setRecentTickets(filteredList.slice(0, 10));
  }, [dateFrom, dateTo, locationId, departmentId, moderatorId, category, priority, status, queueFocus]);

  const loadSuperAdminWidgets = useCallback(async () => {
    if (user?.role !== 'super_admin' || readOnlyExecutive) return;
    try {
      const [trRes, bcRes] = await Promise.all([
        apiFetch<WebsiteTrafficResponse>('/api/analytics/website-traffic?granularity=daily'),
        apiFetch<{ broadcasts: BroadcastNotificationItem[] }>('/api/broadcasts'),
      ]);
      setTrafficSummary(trRes.summary);
      const list = bcRes.broadcasts || [];
      setBroadcastSummary({
        published: list.filter((b) => b.lifecycle_status === 'published').length,
        scheduled: list.filter((b) => b.lifecycle_status === 'scheduled').length,
        totalReads: list.reduce((sum, b) => sum + (b.read_count || 0), 0),
      });
    } catch {
      // keep silent on transient fetch error
    }
  }, [user?.role, readOnlyExecutive]);

  useEffect(() => {
    loadAnalytics();
    loadSuperAdminWidgets();
  }, [loadAnalytics, loadSuperAdminWidgets, refreshTrigger]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (
        evt.event === 'ticket:updated' ||
        evt.event === 'directory:updated' ||
        evt.event === 'chat:message' ||
        evt.event === 'notification:new'
      ) {
        loadAnalytics();
      }
      if (evt.event === 'traffic:updated' || evt.event === 'broadcast:new' || evt.event === 'broadcast:updated') {
        loadSuperAdminWidgets();
      }
    });
  }, [subscribeRealtime, loadAnalytics, loadSuperAdminWidgets]);

  useEffect(() => {
    Promise.all([
      apiFetch<{ locations: LocationItem[] }>('/api/locations'),
      apiFetch<{ departments: DepartmentItem[] }>('/api/departments'),
      apiFetch<{ moderators: ModeratorItem[] }>('/api/moderators?include_super_admin=1'),
    ])
      .then(([l, d, m]) => {
        setLocations(l.locations);
        setDepartments(d.departments);
        setModerators(m.moderators);
      })
      .catch(() => {});
  }, []);

  const kpis = data?.kpis || {};
  const charts = data?.charts || {};
  const recentStatusUpdates = data?.recentStatusUpdates || [];
  const recentChatMessages = data?.recentChatMessages || [];

  const pendingAssignsCount = kpis.unassigned_tickets ?? 0;
  const pendingWorkCount =
    kpis.pending_work_tasks ??
    (kpis.in_progress_tickets ?? 0) + (kpis.waiting_tickets ?? 0) + (kpis.reopened_tickets ?? 0);

  const pendingCards = [
    {
      key: 'pending_assigns' as const,
      label: 'Pending Assigns',
      subtitle: 'Unassigned tickets awaiting moderator assignment',
      count: pendingAssignsCount,
      tone: 'text-amber-700 dark:text-amber-400',
      target: { section: 'tickets' as const, queueFilter: 'pending_assigns' as const },
    },
    {
      key: 'pending_work' as const,
      label: 'Pending Work',
      subtitle: 'Assigned tasks currently open and awaiting completion',
      count: pendingWorkCount,
      tone: 'text-blue-700 dark:text-blue-400',
      target: { section: 'tickets' as const, queueFilter: 'pending_work' as const },
    },
  ];

  const kpiCards: Array<{
    label: string;
    value: string | number;
    tone: string;
    target: DashboardDrilldownTarget;
  }> = [
    {
      label: 'Total Employees',
      value: kpis.total_employees ?? 0,
      tone: 'text-slate-900 dark:text-white',
      target: { section: 'employees' },
    },
    {
      label: 'Active Moderators',
      value: kpis.total_moderators ?? 0,
      tone: 'text-slate-900 dark:text-white',
      target: { section: 'moderators', moderatorStatus: 'Active' },
    },
    {
      label: 'Total Tickets',
      value: kpis.total_tickets ?? 0,
      tone: 'text-blue-700 dark:text-blue-400',
      target: { section: 'tickets', queueFilter: 'all' },
    },
    {
      label: 'New / Unassigned',
      value: kpis.unassigned_tickets ?? 0,
      tone: 'text-amber-700 dark:text-amber-400',
      target: { section: 'tickets', queueFilter: 'new_unassigned' },
    },
    {
      label: 'Overdue (SLA)',
      value: kpis.overdue_tickets ?? 0,
      tone: 'text-red-700 dark:text-red-400',
      target: { section: 'tickets', queueFilter: 'overdue' },
    },
    {
      label: 'Avg Resolution Time',
      value:
        kpis.avg_resolution_hours !== null && kpis.avg_resolution_hours !== undefined
          ? `${kpis.avg_resolution_hours}h`
          : '—',
      tone: 'text-slate-900 dark:text-white',
      target: { section: 'reports', reportType: 'resolution-time' },
    },
    {
      label: 'Avg 1st Response',
      value:
        kpis.avg_first_response_mins !== null && kpis.avg_first_response_mins !== undefined
          ? `${kpis.avg_first_response_mins}m`
          : '—',
      tone: 'text-slate-900 dark:text-white',
      target: { section: 'reports', reportType: 'first-response-time' },
    },
  ];

  return (
    <div className="space-y-6">
      {readOnlyExecutive && (
        <div className="px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-600 dark:text-slate-300 flex items-center justify-between">
          <span>
            Executive Read-Only View · Signed in as <strong className="text-slate-900 dark:text-white">{user?.full_name}</strong>
          </span>
          <span className="font-mono text-slate-500">View-Only Access</span>
        </div>
      )}

      {/* Multi-Axis Filters */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-display font-semibold">Operational Filters</h2>
          <button
            type="button"
            onClick={() => {
              setDateFrom('');
              setDateTo('');
              setLocationId('All');
              setDepartmentId('All');
              setModeratorId('All');
              setCategory('All');
              setPriority('All');
              setStatus('All');
              setQueueFocus('all');
            }}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          >
            Clear All
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="Date from"
            className="px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="Date to"
            className="px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Hubs / Branches</option>
            {locations.map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name}
              </option>
            ))}
          </select>
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Departments</option>
            {departments.map((d) => (
              <option key={d.id} value={String(d.id)}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            value={moderatorId}
            onChange={(e) => setModeratorId(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Assignees</option>
            {moderators.map((m) => (
              <option key={m.id} value={String(m.id)}>
                {m.full_name}
                {m.assignee_role === 'super_admin' ? ' (Super Admin)' : ''}
              </option>
            ))}
          </select>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Categories</option>
            {getOptions('work_category').map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Priorities</option>
            {getOptions('priority').map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Statuses</option>
            {getOptions('task_status').map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Clickable Pending Assigns & Pending Work Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {pendingCards.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onNavigateDrilldown?.(item.target)}
            className="group text-left rounded-xl p-4 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-blue-500/60 dark:hover:border-blue-500/50 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors cursor-pointer flex items-center justify-between gap-4"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-display font-semibold text-slate-900 dark:text-white">
                <span>{item.label}</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-600 transition-colors" />
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{item.subtitle}</div>
            </div>
            <div className={`text-3xl font-mono font-semibold tabular-nums shrink-0 ${item.tone}`}>
              {item.count}
            </div>
          </button>
        ))}
      </div>

      {/* Clickable Operations KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {kpiCards.map((k) => (
          <button
            key={k.label}
            type="button"
            onClick={() => onNavigateDrilldown?.(k.target)}
            className="group text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-500/60 dark:hover:border-blue-500/50 hover:bg-slate-50/80 dark:hover:bg-slate-800/40 rounded-xl p-4 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{k.label}</span>
              <ArrowUpRight className="w-3 h-3 text-slate-400 group-hover:text-blue-600 shrink-0 transition-colors" />
            </div>
            <div className={`mt-1.5 text-2xl font-mono font-semibold tabular-nums ${k.tone}`}>{k.value}</div>
          </button>
        ))}
      </div>

      {/* Super Admin Traffic & Broadcast Summary Widgets */}
      {user?.role === 'super_admin' && !readOnlyExecutive && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => onNavigateDrilldown?.({ section: 'traffic' })}
            className="group text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-500/60 dark:hover:border-blue-500/50 rounded-xl p-4 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                <Globe className="w-4 h-4 text-blue-600" />
                <span>Public Website Visit Counter & Traffic Analytics</span>
              </div>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 dark:text-blue-400">
                Open Analytics <ArrowUpRight className="w-3.5 h-3.5" />
              </span>
            </div>
            <div className="grid grid-cols-4 gap-3 mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <div>
                <div className="text-[11px] text-slate-500">Total Visits</div>
                <div className="text-lg font-mono font-bold tabular-nums">{trafficSummary?.total_visits ?? 0}</div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Unique Visitors</div>
                <div className="text-lg font-mono font-bold text-blue-700 dark:text-blue-400 tabular-nums">
                  {trafficSummary?.unique_visitors ?? 0}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Today</div>
                <div className="text-lg font-mono font-bold tabular-nums">{trafficSummary?.today_visits ?? 0}</div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Active Now</div>
                <div className="text-lg font-mono font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                  {trafficSummary?.active_visitors_now ?? 0}
                </div>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => onNavigateDrilldown?.({ section: 'broadcasts' })}
            className="group text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-500/60 dark:hover:border-blue-500/50 rounded-xl p-4 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
                <Megaphone className="w-4 h-4 text-amber-600" />
                <span>Broadcast Notifications Center</span>
              </div>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 dark:text-blue-400">
                Manage Broadcasts <ArrowUpRight className="w-3.5 h-3.5" />
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <div>
                <div className="text-[11px] text-slate-500">Published Active</div>
                <div className="text-lg font-mono font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
                  {broadcastSummary?.published ?? 0}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Scheduled</div>
                <div className="text-lg font-mono font-bold text-blue-700 dark:text-blue-400 tabular-nums">
                  {broadcastSummary?.scheduled ?? 0}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">Confirmed Reads</div>
                <div className="text-lg font-mono font-bold tabular-nums">{broadcastSummary?.totalReads ?? 0}</div>
              </div>
            </div>
          </button>
        </div>
      )}

      {/* Live Feeds: Status Updates, Moderator Chat Messages, Unread Alerts */}
      {!readOnlyExecutive && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Recent Status Updates */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-display font-semibold">Recent Status Updates</h3>
              <span className="text-[11px] font-mono text-slate-400">Live</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
              {recentStatusUpdates.length === 0 ? (
                <div className="p-6 text-xs text-slate-500 text-center">No status activity logged yet.</div>
              ) : (
                recentStatusUpdates.slice(0, 6).map((act: any) => (
                  <button
                    key={act.id}
                    type="button"
                    onClick={() => onSelectTicket(act.ticket_id)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                        {act.ticket_number}
                      </span>
                      <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                        {formatDateTime(act.created_at)}
                      </span>
                    </div>
                    <div className="text-xs text-slate-800 dark:text-slate-200 mt-0.5">
                      {act.actor_name} ·{' '}
                      <span className={getStatusColorClass(act.new_status || '')}>
                        {act.new_status || act.action_type}
                      </span>
                    </div>
                    {act.details && <div className="text-[11px] text-slate-500 truncate mt-0.5">{act.details}</div>}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Recent Moderator Chat Messages */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-display font-semibold">Recent Moderator Chat Messages</h3>
              {onOpenDirectChat && (
                <button
                  type="button"
                  onClick={() => onOpenDirectChat()}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  Open Chat
                </button>
              )}
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
              {recentChatMessages.length === 0 ? (
                <div className="p-6 text-xs text-slate-500 text-center">No direct moderator messages yet.</div>
              ) : (
                recentChatMessages.slice(0, 6).map((cm: any) => (
                  <button
                    key={cm.id}
                    type="button"
                    onClick={() =>
                      onOpenDirectChat &&
                      onOpenDirectChat(
                        cm.ticket_id || undefined,
                        cm.sender_user_id === user?.id ? cm.recipient_user_id : cm.sender_user_id
                      )
                    }
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-semibold text-slate-900 dark:text-white truncate">
                        {cm.sender_name} → {cm.recipient_name}
                      </span>
                      <span className="font-mono text-[10px] text-slate-400 tabular-nums shrink-0">
                        {formatDateTime(cm.created_at)}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600 dark:text-slate-300 truncate mt-0.5">
                      {cm.ticket_number ? `[${cm.ticket_number}] ` : ''}
                      {cm.message}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Unread Alerts & Chat Counter */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-4">
            <div>
              <h3 className="text-sm font-display font-semibold">Alerts & Communication Inbox</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Unread workflow notifications and direct moderator conversations
              </p>
              <div className="grid grid-cols-2 gap-3 mt-4">
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50">
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Bell className="w-3.5 h-3.5 text-red-600" />
                    <span>Unread Alerts</span>
                  </div>
                  <div className="mt-1 text-2xl font-mono font-semibold tabular-nums text-red-700 dark:text-red-400">
                    {unreadCount}
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50">
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <MessageSquare className="w-3.5 h-3.5 text-blue-600" />
                    <span>Unread Chat</span>
                  </div>
                  <div className="mt-1 text-2xl font-mono font-semibold tabular-nums text-blue-700 dark:text-blue-400">
                    {chatUnreadCount}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {onOpenDirectChat && (
                <button
                  type="button"
                  onClick={() => onOpenDirectChat()}
                  className="flex-1 py-2 px-3 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                >
                  Open Direct Chat
                </button>
              )}
              {onOpenIntegrations && (
                <button
                  type="button"
                  onClick={onOpenIntegrations}
                  className="py-2 px-3 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Alert Settings
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Moderator-Wise Work Performance Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-display font-semibold">Moderator-Wise Work Performance</h3>
          <span className="text-xs text-slate-500">Assigned, Active, On Hold, Ready for Review & Completed</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4">Assignee</th>
                <th className="py-2.5 px-4 text-right">Assigned</th>
                <th className="py-2.5 px-4 text-right">In Progress</th>
                <th className="py-2.5 px-4 text-right">On Hold / Info</th>
                <th className="py-2.5 px-4 text-right">Ready for Review</th>
                <th className="py-2.5 px-4 text-right">Completed</th>
                <th className="py-2.5 px-4 text-right">Avg Hrs</th>
                {onOpenDirectChat && <th className="py-2.5 px-4 text-right">Direct Chat</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(charts.moderatorPerformance || []).map((m: any) => (
                <tr key={m.moderator_id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="py-2.5 px-4">
                    <div className="font-semibold text-slate-900 dark:text-white">{m.name}</div>
                    <div className="text-[11px] text-slate-500">{m.specialization}</div>
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums">{m.assigned ?? 0}</td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">
                    {m.in_progress ?? 0}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                    {m.held_or_info ?? 0}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-cyan-700 dark:text-cyan-400 font-semibold">
                    {m.ready_for_review ?? 0}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-semibold">
                    {m.resolved ?? 0}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-500">
                    {m.avg_hours !== null && m.avg_hours !== undefined ? `${m.avg_hours}h` : '—'}
                  </td>
                  {onOpenDirectChat && (
                    <td className="py-2.5 px-4 text-right">
                      {m.user_id !== user?.id ? (
                        <button
                          type="button"
                          onClick={() => onOpenDirectChat(undefined, m.user_id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <MessageSquare className="w-3 h-3" />
                          Chat
                        </button>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h3 className="text-sm font-display font-semibold mb-1">Tickets by Month · Pending vs Completed</h3>
          <p className="text-xs text-slate-500 mb-4">Monthly ticket intake and closure throughput</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={charts.ticketsByMonth || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.4} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="resolved" name="Completed" stackId="a" fill="#16a34a" radius={[0, 0, 0, 0]} />
                <Bar dataKey="pending" name="Pending" stackId="a" fill="#d97706" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h3 className="text-sm font-display font-semibold mb-1">Tickets by Branch & Warehouse</h3>
          <p className="text-xs text-slate-500 mb-4">Open vs completed volume across logistics facilities</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={charts.ticketsByLocation || []} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.4} />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="location" width={150} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="open" name="Open" fill="#2563eb" />
                <Bar dataKey="resolved" name="Completed" fill="#16a34a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h3 className="text-sm font-display font-semibold mb-1">Tickets by Issue Category</h3>
          <p className="text-xs text-slate-500 mb-4">Top technical fault areas across operations</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={(charts.ticketsByCategory || []).slice(0, 8)} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.4} />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="category" width={170} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="total" name="Tickets" fill="#1d4ed8" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h3 className="text-sm font-display font-semibold mb-1">Moderator Workload & Resolution</h3>
          <p className="text-xs text-slate-500 mb-4">Assigned, completed, and pending tasks per engineer</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={charts.moderatorPerformance || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.4} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="resolved" name="Completed" fill="#16a34a" />
                <Bar dataKey="pending" name="Pending" fill="#d97706" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h3 className="text-sm font-display font-semibold mb-1">Average Resolution Time (Hours)</h3>
          <p className="text-xs text-slate-500 mb-4">Monthly elapsed resolution duration trend</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={charts.ticketsByMonth || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.4} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="avg_hours" name="Avg Resolution (hrs)" stroke="#1d4ed8" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h3 className="text-sm font-display font-semibold mb-1">IT Expenditure & Maintenance Costs (₹)</h3>
          <p className="text-xs text-slate-500 mb-4">Approved monthly IT spend vs hardware maintenance</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={charts.expenditureByMonth || []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.4} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v)} />
                <Tooltip formatter={(val: any) => formatCurrency(Number(val))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="total_spent" name="Total IT Spend" fill="#0f172a" />
                <Bar dataKey="maintenance_cost" name="Repair & Parts" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Priority Attention Queue Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-display font-semibold">
              {queueFocus === 'pending_assigns'
                ? 'Pending Assigns Queue'
                : queueFocus === 'pending_work'
                ? 'Pending Work Queue'
                : status === 'All'
                ? 'Priority Attention Queue'
                : `Filtered Queue · ${status}`}
            </h3>
            <div className="flex items-center gap-1 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-md text-[11px]">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'pending_assigns', label: 'Pending Assigns' },
                  { id: 'pending_work', label: 'Pending Work' },
                ] as const
              ).map((qTab) => (
                <button
                  key={qTab.id}
                  type="button"
                  onClick={() => setQueueFocus(qTab.id)}
                  className={`px-2 py-1 rounded font-medium cursor-pointer ${
                    queueFocus === qTab.id
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-500'
                  }`}
                >
                  {qTab.label}
                </button>
              ))}
            </div>
          </div>
          <span className="text-xs text-slate-500">Click any task to inspect roadmap, approve completion, or assign</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4">Ticket #</th>
                <th className="py-2.5 px-4">Category & Device</th>
                <th className="py-2.5 px-4">Hub / Branch</th>
                <th className="py-2.5 px-4">Priority</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Assigned To</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {recentTickets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    No tasks match the current operational filters.
                  </td>
                </tr>
              ) : (
                recentTickets.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => onSelectTicket(t.id)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <td className="py-2.5 px-4 font-mono font-semibold text-blue-700 dark:text-blue-400">
                      {t.ticket_number}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className="font-medium">{t.category}</span> · <span className="text-slate-500">{t.device_name}</span>
                    </td>
                    <td className="py-2.5 px-4">{t.location_name || t.reporter_branch_name}</td>
                    <td className={`py-2.5 px-4 ${getPriorityColorClass(t.priority)}`}>{t.priority}</td>
                    <td className={`py-2.5 px-4 font-semibold ${getStatusColorClass(t.status)}`}>{t.status}</td>
                    <td className="py-2.5 px-4">{t.moderator_name || 'Unassigned'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
