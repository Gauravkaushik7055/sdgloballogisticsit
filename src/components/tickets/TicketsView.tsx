import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpDown,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  Plus,
  Search,
  UserPlus,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useDropdowns } from '../../context/DropdownContext.tsx';
import { LocationItem, ModeratorItem, TicketItem } from '../../types/index.ts';
import { apiFetch, formatDateTime, getPriorityColorClass, getStatusColorClass } from '../../utils/api.ts';
import { exportToCsv, exportToExcel, exportToPdf } from '../../utils/exportUtils.ts';

export type TicketQueuePreset = 'all' | 'pending_assigns' | 'pending_work' | 'new_unassigned' | 'overdue';

interface TicketsViewProps {
  onSelectTicket: (ticketId: number) => void;
  onOpenNewTicket: () => void;
  refreshTrigger: number;
  initialPreset?: { key: number; queueFilter?: TicketQueuePreset } | null;
  onBackToDashboard?: () => void;
}

const QUEUE_LABELS: Record<TicketQueuePreset, string> = {
  all: 'All Tickets',
  pending_assigns: 'Pending Assigns (Unassigned Open Tasks)',
  pending_work: 'Pending Work (Assigned & Awaiting Completion)',
  new_unassigned: 'New / Unassigned Tickets',
  overdue: 'Overdue Tickets (SLA Breached)',
};

const PRIORITY_RANK: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export default function TicketsView({
  onSelectTicket,
  onOpenNewTicket,
  refreshTrigger,
  initialPreset,
  onBackToDashboard,
}: TicketsViewProps) {
  const { user, subscribeRealtime } = useAuth();
  const { getOptions } = useDropdowns();
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [moderators, setModerators] = useState<ModeratorItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [queueFilter, setQueueFilter] = useState<TicketQueuePreset>(initialPreset?.queueFilter || 'all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [priority, setPriority] = useState('All');
  const [category, setCategory] = useState('All');
  const [locationId, setLocationId] = useState('All');
  const [moderatorId, setModeratorId] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [sortField, setSortField] = useState<'ticket_number' | 'priority' | 'status' | 'created_at'>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  // Quick Assign modal state for Super Admin
  const [assigningTicket, setAssigningTicket] = useState<TicketItem | null>(null);
  const [assignModId, setAssignModId] = useState('');
  const [assignDeadline, setAssignDeadline] = useState('');
  const [assignReason, setAssignReason] = useState('');

  useEffect(() => {
    if (initialPreset) {
      setQueueFilter(initialPreset.queueFilter || 'all');
      setStatus('All');
      setModeratorId('All');
      setPage(1);
    }
  }, [initialPreset?.key]);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (queueFilter !== 'all') qs.set('queue_filter', queueFilter);
      if (search.trim()) qs.set('search', search.trim());
      if (status !== 'All') qs.set('status', status);
      if (priority !== 'All') qs.set('priority', priority);
      if (category !== 'All') qs.set('category', category);
      if (locationId !== 'All') qs.set('location_id', locationId);
      if (moderatorId !== 'All') qs.set('moderator_id', moderatorId);
      if (dateFrom) qs.set('date_from', dateFrom);
      if (dateTo) qs.set('date_to', dateTo);

      const res = await apiFetch<{ tickets: TicketItem[] }>(`/api/tickets?${qs.toString()}`);
      setTickets(res.tickets);
    } finally {
      setLoading(false);
    }
  }, [queueFilter, search, status, priority, category, locationId, moderatorId, dateFrom, dateTo]);

  useEffect(() => {
    loadTickets();
  }, [loadTickets, refreshTrigger]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'ticket:updated') {
        loadTickets();
      }
    });
  }, [subscribeRealtime, loadTickets]);

  useEffect(() => {
    apiFetch<{ locations: LocationItem[] }>('/api/locations')
      .then((r) => setLocations(r.locations))
      .catch(() => {});
    if (user?.role === 'super_admin' || user?.role === 'management') {
      apiFetch<{ moderators: ModeratorItem[] }>('/api/moderators?include_super_admin=1')
        .then((r) => setModerators(r.moderators))
        .catch(() => {});
    }
  }, [user]);

  const sortedTickets = useMemo(() => {
    const copy = [...tickets];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'priority') {
        cmp = (PRIORITY_RANK[a.priority] || 0) - (PRIORITY_RANK[b.priority] || 0);
      } else if (sortField === 'ticket_number') {
        cmp = a.ticket_number.localeCompare(b.ticket_number);
      } else if (sortField === 'status') {
        cmp = a.status.localeCompare(b.status);
      } else {
        cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [tickets, sortField, sortDir]);

  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(sortedTickets.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedTickets = sortedTickets.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
    setPage(1);
  };

  const exportRows = useMemo(
    () =>
      sortedTickets.map((t) => ({
        TicketNumber: t.ticket_number,
        Category: t.category,
        Device: t.device_name,
        Location: t.location_name || t.reporter_branch_name || '',
        Reporter: t.reporter_name || '',
        Priority: t.priority,
        Status: t.status,
        Assignee: t.moderator_name || 'Unassigned',
        SLA_Breached: t.sla_breached ? 'Yes' : 'No',
        Submitted: formatDateTime(t.created_at),
      })),
    [sortedTickets]
  );

  const handleQuickAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assigningTicket || !assignModId) return;
    await apiFetch(`/api/tickets/${assigningTicket.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({
        moderator_id: Number(assignModId),
        deadline_at: assignDeadline ? new Date(assignDeadline).toISOString() : undefined,
        reason: assignReason || 'Assigned from Ticket Operations table',
      }),
    });
    setAssigningTicket(null);
    setAssignModId('');
    setAssignDeadline('');
    setAssignReason('');
    loadTickets();
  };

  return (
    <div className="space-y-5">
      {/* Drilldown Header & Exports */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {onBackToDashboard && (
            <button
              type="button"
              onClick={onBackToDashboard}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline mb-1 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Super Admin Dashboard
            </button>
          )}
          <h2 className="text-lg font-display font-bold text-slate-900 dark:text-white">
            {QUEUE_LABELS[queueFilter]}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={exportRows.length === 0}
            onClick={() => exportToCsv(`SD_Global_${queueFilter}_tickets`, exportRows)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
          <button
            type="button"
            disabled={exportRows.length === 0}
            onClick={() => exportToExcel(`SD_Global_${queueFilter}_tickets`, 'Tickets', exportRows)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Excel
          </button>
          <button
            type="button"
            disabled={exportRows.length === 0}
            onClick={() =>
              exportToPdf(`SD_Global_${queueFilter}_tickets`, QUEUE_LABELS[queueFilter], exportRows)
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            PDF
          </button>
          {user?.role !== 'management' && user?.role !== 'moderator' && (
            <button
              type="button"
              onClick={onOpenNewTicket}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Submit New Ticket</span>
            </button>
          )}
        </div>
      </div>

      {/* Toolbar & Filters */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search ticket #, employee, device, branch, or description..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>

          <select
            value={queueFilter}
            onChange={(e) => {
              setQueueFilter(e.target.value as TicketQueuePreset);
              setPage(1);
            }}
            aria-label="Queue view filter"
            className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="all">Queue: All Tickets</option>
            <option value="pending_assigns">Queue: Pending Assigns</option>
            <option value="pending_work">Queue: Pending Work</option>
            <option value="new_unassigned">Queue: New / Unassigned</option>
            <option value="overdue">Queue: Overdue (SLA)</option>
          </select>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 pt-1">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Statuses</option>
            {getOptions('task_status').map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <select
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value);
              setPage(1);
            }}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Priorities</option>
            {getOptions('priority').map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Categories</option>
            {getOptions('work_category').map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setPage(1);
            }}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Locations</option>
            {locations.map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name}
              </option>
            ))}
          </select>

          {(user?.role === 'super_admin' || user?.role === 'management') && (
            <select
              value={moderatorId}
              onChange={(e) => {
                setModeratorId(e.target.value);
                setPage(1);
              }}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="All">All Assignees</option>
              <option value="unassigned">Unassigned Only</option>
              {moderators.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.full_name}
                  {m.assignee_role === 'super_admin' ? ' (Super Admin)' : ''}
                </option>
              ))}
            </select>
          )}

          <input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
            aria-label="Date from"
            className="px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />

          <input
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
            aria-label="Date to"
            className="px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />
        </div>
      </div>

      {/* High-Density Ticket Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Filter className="w-3.5 h-3.5" />
            <span className="font-mono tabular-nums">{sortedTickets.length} ticket(s)</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setQueueFilter('all');
              setSearch('');
              setStatus('All');
              setPriority('All');
              setCategory('All');
              setLocationId('All');
              setModeratorId('All');
              setDateFrom('');
              setDateTo('');
              setPage(1);
            }}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          >
            Reset Filters
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-4 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => toggleSort('ticket_number')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Ticket # <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4">Issue & Device</th>
                <th className="py-2.5 px-4">Location</th>
                <th className="py-2.5 px-4">Reporter</th>
                <th className="py-2.5 px-4">
                  <button
                    type="button"
                    onClick={() => toggleSort('priority')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Priority <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4">
                  <button
                    type="button"
                    onClick={() => toggleSort('status')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Status <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4">Moderator</th>
                <th className="py-2.5 px-4 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => toggleSort('created_at')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Submitted <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                {user?.role === 'super_admin' && <th className="py-2.5 px-4 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-500">
                    Loading tickets...
                  </td>
                </tr>
              ) : pagedTickets.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    No tickets match the current filters.
                  </td>
                </tr>
              ) : (
                pagedTickets.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => onSelectTicket(t.id)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
                  >
                    <td className="py-3 px-4 font-mono font-semibold text-blue-700 dark:text-blue-400 whitespace-nowrap">
                      {t.ticket_number}
                      {t.sla_breached === 1 && !['Completed', 'Resolved', 'Closed'].includes(t.status) && (
                        <div className="text-[10px] font-sans font-semibold text-red-600 dark:text-red-400 mt-0.5">
                          SLA Breached
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 max-w-[260px]">
                      <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">{t.category}</div>
                      <div className="text-slate-500 dark:text-slate-400 truncate mt-0.5">
                        {t.device_name} · {t.description}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-800 dark:text-slate-200">{t.location_name || t.reporter_branch_name}</div>
                      <div className="text-slate-500 dark:text-slate-400">{t.reporter_city}</div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-800 dark:text-slate-200">{t.reporter_name}</div>
                      <div className="font-mono text-slate-500 dark:text-slate-400">{t.reporter_employee_code}</div>
                    </td>
                    <td className={`py-3 px-4 whitespace-nowrap ${getPriorityColorClass(t.priority)}`}>{t.priority}</td>
                    <td className={`py-3 px-4 font-semibold whitespace-nowrap ${getStatusColorClass(t.status)}`}>
                      {t.status}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap text-slate-700 dark:text-slate-300">
                      {t.moderator_name ? (
                        <span>
                          {t.moderator_name}
                          {t.moderator_role === 'super_admin' && (
                            <span className="ml-1 text-[10px] font-semibold text-blue-700 dark:text-blue-400">
                              (Super Admin)
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">Unassigned</span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {formatDateTime(t.created_at)}
                    </td>
                    {user?.role === 'super_admin' && (
                      <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => {
                            setAssigningTicket(t);
                            setAssignModId(t.assigned_moderator_id ? String(t.assigned_moderator_id) : '');
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                        >
                          <UserPlus className="w-3 h-3" />
                          <span>{t.assigned_moderator_id ? 'Reassign' : 'Assign'}</span>
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
          <span className="font-mono tabular-nums">
            Showing {sortedTickets.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, sortedTickets.length)} of {sortedTickets.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
            >
              Previous
            </button>
            <span className="font-mono tabular-nums">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Quick Assign Modal */}
      {assigningTicket && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleQuickAssign}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-display font-bold">
                Assign Work · {assigningTicket.ticket_number}
              </h3>
              {moderators.find((m) => m.assignee_role === 'super_admin') && (
                <button
                  type="button"
                  onClick={() => {
                    const selfMod = moderators.find((m) => m.assignee_role === 'super_admin');
                    if (selfMod) setAssignModId(String(selfMod.id));
                  }}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 cursor-pointer"
                >
                  Select Myself
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500">
              {assigningTicket.category} at {assigningTicket.reporter_branch_name}
            </p>
            <div>
              <label className="block text-xs font-medium mb-1">Select Assignee (Super Admin or Moderator) *</label>
              <select
                required
                value={assignModId}
                onChange={(e) => setAssignModId(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="">Choose assignee...</option>
                {moderators
                  .filter((m) => m.status === 'Active')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name}
                      {m.assignee_role === 'super_admin' ? ' (Super Admin · Self)' : ''} (Workload: {m.current_workload}/
                      {m.max_capacity}) · {m.specialization}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Target Deadline (Optional)</label>
              <input
                type="datetime-local"
                value={assignDeadline}
                onChange={(e) => setAssignDeadline(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Assignment Note</label>
              <input
                value={assignReason}
                onChange={(e) => setAssignReason(e.target.value)}
                placeholder="Location match / specialization"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAssigningTicket(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800"
              >
                Confirm Assignment
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
