import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Link2, MessageSquare, Phone, Plus } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { TicketItem } from '../../types/index.ts';
import { apiFetch, formatDateTime, getPriorityColorClass, getStatusColorClass } from '../../utils/api.ts';

interface EmployeeDashboardProps {
  onSelectTicket: (ticketId: number) => void;
  onOpenNewTicket: () => void;
  refreshTrigger: number;
}

export default function EmployeeDashboard({
  onSelectTicket,
  onOpenNewTicket,
  refreshTrigger,
}: EmployeeDashboardProps) {
  const { user } = useAuth();
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);

  const shareableLink = `${window.location.origin}/?panel=employee-login`;

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{ tickets: TicketItem[] }>('/api/tickets');
      setTickets(res.tickets);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets, refreshTrigger]);

  const totalCount = tickets.length;
  const openCount = tickets.filter((t) =>
    ['New', 'Assigned', 'Accepted', 'Accepted by Moderator'].includes(t.status)
  ).length;
  const inProgressCount = tickets.filter((t) =>
    ['Under Review', 'In Progress'].includes(t.status)
  ).length;
  const waitingCount = tickets.filter((t) =>
    [
      'On Hold',
      'Pending Information',
      'Ready for Review',
      'Pending Admin Review',
      'Waiting for Employee',
      'Waiting for Parts / Vendor',
      'Escalated',
    ].includes(t.status)
  ).length;
  const resolvedCount = tickets.filter((t) => ['Completed', 'Resolved', 'Closed'].includes(t.status)).length;
  const reopenedCount = tickets.filter((t) => ['Revision Required', 'Reopened'].includes(t.status)).length;

  const counters = [
    { label: 'Total Submitted', value: totalCount, cls: 'text-slate-900 dark:text-white' },
    { label: 'Open Tickets', value: openCount, cls: 'text-blue-700 dark:text-blue-400' },
    { label: 'In Progress', value: inProgressCount, cls: 'text-blue-700 dark:text-blue-400' },
    { label: 'Waiting for IT Support', value: waitingCount, cls: 'text-amber-700 dark:text-amber-400' },
    { label: 'Resolved Tickets', value: resolvedCount, cls: 'text-emerald-700 dark:text-emerald-400' },
    { label: 'Reopened Tickets', value: reopenedCount, cls: 'text-red-700 dark:text-red-400' },
  ];

  const handleCopy = () => {
    navigator.clipboard.writeText(shareableLink);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  return (
    <div className="space-y-6">
      {/* Shareable Employee Login Link at top of panel */}
      <div className="bg-white dark:bg-slate-900 border border-blue-200 dark:border-blue-900/60 rounded-xl px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1 text-xs">
          <Link2 className="w-4 h-4 text-blue-600 shrink-0" />
          <span className="font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap">
            Shareable Employee Login Link:
          </span>
          <code className="font-mono text-slate-600 dark:text-slate-300 truncate">{shareableLink}</code>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer shrink-0"
        >
          {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copiedLink ? 'Copied' : 'Copy Link'}</span>
        </button>
      </div>

      {/* Welcome, Captured Login Info & Direct Raise Ticket CTA */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <h2 className="text-xl font-display font-bold text-slate-900 dark:text-white">
            Employee & HR Support Panel · {user?.full_name}
          </h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            {user?.employee_profile?.mobile && (
              <span className="inline-flex items-center gap-1 font-mono text-slate-700 dark:text-slate-300">
                <Phone className="w-3.5 h-3.5 text-blue-600" />
                {user.employee_profile.mobile}
              </span>
            )}
            {user?.employee_profile?.employee_code && (
              <span className="font-mono">{user.employee_profile.employee_code}</span>
            )}
            <span>{user?.employee_profile?.location_name || 'Self-Service Staff'}</span>
            {user?.employee_profile?.department_name && <span>{user.employee_profile.department_name}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenNewTicket}
          className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Raise Support Ticket</span>
        </button>
      </div>

      {/* 6 Status Counters */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {counters.map((c) => (
          <div
            key={c.label}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4"
          >
            <div className="text-xs text-slate-500 dark:text-slate-400">{c.label}</div>
            <div className={`mt-1.5 text-2xl font-mono font-semibold tabular-nums ${c.cls}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* My Submitted Tickets */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-display font-semibold">My Ticket History & Live Status</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Click any ticket to view IT progress timeline, message your assigned engineer, confirm resolution, or reopen.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4">Ticket Number</th>
                <th className="py-2.5 px-4">Issue Category</th>
                <th className="py-2.5 px-4">Location</th>
                <th className="py-2.5 px-4">Assigned Moderator</th>
                <th className="py-2.5 px-4">Submission Date</th>
                <th className="py-2.5 px-4">Current Status</th>
                <th className="py-2.5 px-4">Priority</th>
                <th className="py-2.5 px-4">Latest Update</th>
                <th className="py-2.5 px-4 text-right">Contact IT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-500">
                    Loading your requests...
                  </td>
                </tr>
              ) : tickets.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-500">
                    You have not submitted any IT tickets yet. Click "Raise Support Ticket" above to start.
                  </td>
                </tr>
              ) : (
                tickets.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => onSelectTicket(t.id)}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                  >
                    <td className="py-3 px-4 font-mono font-semibold text-blue-700 dark:text-blue-400 whitespace-nowrap">
                      {t.ticket_number}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{t.category}</div>
                      <div className="text-slate-500 truncate max-w-[200px]">{t.device_name}</div>
                    </td>
                    <td className="py-3 px-4">{t.location_name || t.reporter_branch_name}</td>
                    <td className="py-3 px-4">{t.moderator_name || 'Pending Assignment'}</td>
                    <td className="py-3 px-4 font-mono text-slate-500 whitespace-nowrap">
                      {formatDateTime(t.created_at)}
                    </td>
                    <td className={`py-3 px-4 font-semibold whitespace-nowrap ${getStatusColorClass(t.status)}`}>
                      {t.status}
                    </td>
                    <td className={`py-3 px-4 whitespace-nowrap ${getPriorityColorClass(t.priority)}`}>{t.priority}</td>
                    <td className="py-3 px-4 max-w-[240px] truncate text-slate-600 dark:text-slate-300">
                      {t.latest_comment || t.latest_activity || 'Submitted'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectTicket(t.id);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <MessageSquare className="w-3 h-3" />
                        <span>Open</span>
                      </button>
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
