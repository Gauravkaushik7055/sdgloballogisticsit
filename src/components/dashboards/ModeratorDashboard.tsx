import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, MessageSquare } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { ModeratorItem, TicketItem } from '../../types/index.ts';
import { apiFetch, formatDateTime, getPriorityColorClass, getStatusColorClass } from '../../utils/api.ts';

interface ModeratorDashboardProps {
  onSelectTicket: (ticketId: number) => void;
  onOpenDirectChat?: (ticketId?: number) => void;
  refreshTrigger: number;
}

export default function ModeratorDashboard({
  onSelectTicket,
  onOpenDirectChat,
  refreshTrigger,
}: ModeratorDashboardProps) {
  const { user, chatUnreadCount, subscribeRealtime } = useAuth();
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [myStats, setMyStats] = useState<ModeratorItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const loadData = useCallback(async () => {
    const [tRes, mRes] = await Promise.all([
      apiFetch<{ tickets: TicketItem[] }>('/api/tickets'),
      apiFetch<{ moderators: ModeratorItem[] }>('/api/moderators?period=monthly'),
    ]);
    setTickets(tRes.tickets);
    setMyStats(mRes.moderators[0] || null);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData, refreshTrigger]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'ticket:updated' || evt.event === 'chat:message') {
        loadData();
      }
    });
  }, [subscribeRealtime, loadData]);

  const countByStatus = (statusName: string) => tickets.filter((t) => t.status === statusName).length;
  const pendingAccept = tickets.filter((t) => t.status === 'Assigned');
  const completedCount = tickets.filter((t) => ['Completed', 'Resolved', 'Closed'].includes(t.status)).length;

  const statusTiles = [
    { label: 'My Assigned Tasks', value: 'All', count: tickets.length, tone: 'text-slate-900 dark:text-white' },
    { label: 'New Assignments', value: 'Assigned', count: countByStatus('Assigned'), tone: 'text-blue-700 dark:text-blue-400' },
    { label: 'Accepted', value: 'Accepted', count: countByStatus('Accepted'), tone: 'text-blue-700 dark:text-blue-400' },
    { label: 'In Progress', value: 'In Progress', count: countByStatus('In Progress'), tone: 'text-blue-700 dark:text-blue-400' },
    { label: 'On Hold', value: 'On Hold', count: countByStatus('On Hold'), tone: 'text-amber-700 dark:text-amber-400' },
    { label: 'Pending Info', value: 'Pending Information', count: countByStatus('Pending Information'), tone: 'text-amber-700 dark:text-amber-400' },
    { label: 'Ready for Review', value: 'Ready for Review', count: countByStatus('Ready for Review'), tone: 'text-cyan-700 dark:text-cyan-400' },
    { label: 'Revision Required', value: 'Revision Required', count: countByStatus('Revision Required'), tone: 'text-red-700 dark:text-red-400' },
    { label: 'Completed', value: 'Completed', count: completedCount, tone: 'text-emerald-700 dark:text-emerald-400' },
  ];

  const visibleTickets =
    statusFilter === 'All'
      ? tickets
      : statusFilter === 'Completed'
      ? tickets.filter((t) => ['Completed', 'Resolved', 'Closed'].includes(t.status))
      : tickets.filter((t) => t.status === statusFilter);

  const handleRespond = async (ticketId: number, decision: 'accept' | 'reject') => {
    await apiFetch(`/api/tickets/${ticketId}/respond-assignment`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason: rejectReason }),
    });
    setRejectingId(null);
    setRejectReason('');
    loadData();
  };

  return (
    <div className="space-y-6">
      {/* Header Summary + Direct Chat with Super Admin */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-display font-bold">Welcome, {user?.full_name}</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {myStats?.specialization || 'IT Support Moderator'} · Employee Code{' '}
            <span className="font-mono">{myStats?.employee_code || 'MOD'}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-6 text-xs">
          <div>
            <span className="text-slate-500 block">Logged Work (Month)</span>
            <span className="font-mono font-semibold text-base tabular-nums">
              {Math.round(((myStats?.total_working_minutes ?? 0) / 60) * 10) / 10} hrs
            </span>
          </div>
          <div>
            <span className="text-slate-500 block">Avg Resolution</span>
            <span className="font-mono font-semibold text-base tabular-nums">
              {myStats?.avg_resolution_hours ? `${myStats.avg_resolution_hours} hrs` : '—'}
            </span>
          </div>
          {onOpenDirectChat && (
            <button
              type="button"
              onClick={() => onOpenDirectChat()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>Direct Chat with Super Admin</span>
              {chatUnreadCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-red-600 text-white font-mono text-[10px] tabular-nums">
                  {chatUnreadCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Personal Task Status Filter Strip */}
      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2.5">
        {statusTiles.map((tile) => {
          const active = statusFilter === tile.value;
          return (
            <button
              key={tile.label}
              type="button"
              onClick={() => setStatusFilter(tile.value)}
              className={`text-left rounded-xl p-3 border transition-colors cursor-pointer ${
                active
                  ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/30'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/50'
              }`}
            >
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{tile.label}</div>
              <div className={`text-xl font-mono font-semibold tabular-nums mt-1 ${tile.tone}`}>
                {tile.count}
              </div>
            </button>
          );
        })}
      </div>

      {/* Pending Acceptance Cards */}
      {pendingAccept.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-display font-semibold">New Assignments Awaiting Acceptance</h3>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {pendingAccept.map((t) => (
              <div key={t.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => onSelectTicket(t.id)}
                      className="font-mono font-bold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                    >
                      {t.ticket_number}
                    </button>
                    <span>·</span>
                    <span className={getPriorityColorClass(t.priority)}>{t.priority}</span>
                    <span>·</span>
                    <span className="font-medium">{t.location_name || t.reporter_branch_name}</span>
                  </div>
                  <div className="text-xs text-slate-700 dark:text-slate-300 mt-1">
                    {t.category} — {t.device_name}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleRespond(t.id, 'accept')}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejectingId(rejectingId === t.id ? null : t.id)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 cursor-pointer"
                  >
                    Reject
                  </button>
                </div>
                {rejectingId === t.id && (
                  <div className="w-full flex gap-2 mt-2">
                    <input
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Enter reason for rejection..."
                      className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      onClick={() => handleRespond(t.id, 'reject')}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-600 text-white cursor-pointer"
                    >
                      Confirm Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Assigned Tasks Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-display font-semibold">
            {statusFilter === 'All' ? 'My Assigned Tasks' : `My Assigned Tasks · ${statusFilter}`} ({visibleTickets.length})
          </h3>
          <span className="text-xs text-slate-500">
            Click any task to update workflow status, add notes, or submit Ready for Review
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4">Task #</th>
                <th className="py-2.5 px-4">Title & Description</th>
                <th className="py-2.5 px-4">Priority</th>
                <th className="py-2.5 px-4">Current Status</th>
                <th className="py-2.5 px-4">Latest Notes / Activity</th>
                <th className="py-2.5 px-4">Work Logged</th>
                <th className="py-2.5 px-4">Deadline</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visibleTickets.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    No assigned tasks in this status.
                  </td>
                </tr>
              ) : (
                visibleTickets.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => onSelectTicket(t.id)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <td className="py-3 px-4 font-mono font-semibold text-blue-700 dark:text-blue-400 whitespace-nowrap">
                      {t.ticket_number}
                    </td>
                    <td className="py-3 px-4 max-w-[260px]">
                      <div className="font-semibold text-slate-900 dark:text-white truncate">
                        {t.category} · {t.device_name}
                      </div>
                      <div className="text-slate-500 truncate mt-0.5">{t.description}</div>
                    </td>
                    <td className={`py-3 px-4 whitespace-nowrap ${getPriorityColorClass(t.priority)}`}>{t.priority}</td>
                    <td className={`py-3 px-4 font-semibold whitespace-nowrap ${getStatusColorClass(t.status)}`}>
                      {t.status}
                    </td>
                    <td className="py-3 px-4 max-w-[240px] text-slate-600 dark:text-slate-300 truncate">
                      {t.latest_activity || t.latest_comment || t.resolution_description || '—'}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3 text-slate-400" />
                        {t.total_working_minutes}m
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-500 whitespace-nowrap">
                      {formatDateTime(t.deadline_at || t.sla_resolution_due)}
                    </td>
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
