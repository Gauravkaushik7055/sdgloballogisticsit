import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BellRing,
  CheckCircle2,
  Edit3,
  Megaphone,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import {
  BroadcastCategory,
  BroadcastDisplayMode,
  BroadcastLifecycleStatus,
  BroadcastNotificationItem,
  BroadcastTargetAudience,
} from '../../types/index.ts';
import { apiFetch, formatDateTime } from '../../utils/api.ts';
import BroadcastAttachmentLink from './BroadcastAttachmentLink.tsx';

interface AudienceUserOption {
  id: number;
  full_name: string;
  email: string;
  role: string;
  role_label: string;
}

interface BroadcastNotificationsViewProps {
  onBackToDashboard?: () => void;
}

const CATEGORIES: BroadcastCategory[] = ['Important', 'Announcement', 'Warning', 'Urgent', 'General'];

const AUDIENCE_LABELS: Record<BroadcastTargetAudience, string> = {
  everyone: 'Everyone (All Active Users)',
  admins: 'Admins (Super Admin & Management)',
  moderators: 'Moderators Only',
  employees: 'Employees Only',
  selected: 'Selected Specific Users',
};

function toLocalDatetimeInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const offsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 16);
}

export default function BroadcastNotificationsView({ onBackToDashboard }: BroadcastNotificationsViewProps) {
  const { subscribeRealtime, refreshBroadcasts } = useAuth();
  const [broadcasts, setBroadcasts] = useState<BroadcastNotificationItem[]>([]);
  const [audienceUsers, setAudienceUsers] = useState<AudienceUserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | BroadcastLifecycleStatus>('all');
  const [categoryFilter, setCategoryFilter] = useState<'All' | BroadcastCategory>('All');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // Create / Edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<BroadcastNotificationItem | null>(null);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState<BroadcastCategory>('Announcement');
  const [displayMode, setDisplayMode] = useState<BroadcastDisplayMode>('tab_only');
  const [targetAudience, setTargetAudience] = useState<BroadcastTargetAudience>('everyone');
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [removeAttachment, setRemoveAttachment] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, usersRes] = await Promise.all([
        apiFetch<{ broadcasts: BroadcastNotificationItem[] }>('/api/broadcasts'),
        apiFetch<{ users: AudienceUserOption[] }>('/api/broadcasts/audience-users'),
      ]);
      setBroadcasts(listRes.broadcasts || []);
      setAudienceUsers(usersRes.users || []);
    } catch {
      // ignore transient error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'broadcast:new' || evt.event === 'broadcast:updated') {
        loadData();
      }
    });
  }, [subscribeRealtime, loadData]);

  const openCreateModal = () => {
    setEditingItem(null);
    setTitle('');
    setMessage('');
    setCategory('Announcement');
    setDisplayMode('tab_only');
    setTargetAudience('everyone');
    setSelectedUserIds([]);
    setUserSearch('');
    setStartsAt('');
    setExpiresAt('');
    setAttachmentFile(null);
    setRemoveAttachment(false);
    setFormError('');
    setModalOpen(true);
  };

  const openEditModal = (item: BroadcastNotificationItem) => {
    setEditingItem(item);
    setTitle(item.title);
    setMessage(item.message);
    setCategory(item.category);
    setDisplayMode(item.display_mode);
    setTargetAudience(item.target_audience);
    setSelectedUserIds(item.target_user_ids || []);
    setUserSearch('');
    setStartsAt(toLocalDatetimeInput(item.starts_at));
    setExpiresAt(toLocalDatetimeInput(item.expires_at));
    setAttachmentFile(null);
    setRemoveAttachment(false);
    setFormError('');
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!title.trim() || !message.trim()) {
      setFormError('Title and notification message are required.');
      return;
    }
    if (targetAudience === 'selected' && selectedUserIds.length === 0) {
      setFormError('Select at least one recipient when targeting specific users.');
      return;
    }

    const fd = new FormData();
    fd.append('title', title.trim());
    fd.append('message', message.trim());
    fd.append('category', category);
    fd.append('display_mode', displayMode);
    fd.append('target_audience', targetAudience);
    fd.append('target_user_ids', JSON.stringify(selectedUserIds));
    fd.append('starts_at', startsAt ? new Date(startsAt).toISOString() : '');
    fd.append('expires_at', expiresAt ? new Date(expiresAt).toISOString() : '');
    if (attachmentFile) {
      fd.append('attachment', attachmentFile);
    } else if (editingItem && removeAttachment) {
      fd.append('remove_attachment', 'true');
    }

    setSubmitting(true);
    try {
      if (editingItem) {
        await apiFetch(`/api/broadcasts/${editingItem.id}`, { method: 'PATCH', body: fd });
        setFeedback('Broadcast notification updated successfully.');
      } else {
        await apiFetch('/api/broadcasts', { method: 'POST', body: fd });
        setFeedback('Broadcast notification published cleanly.');
      }
      setModalOpen(false);
      await Promise.all([loadData(), refreshBroadcasts()]);
    } catch (err: any) {
      setFormError(err.message || 'Failed to save broadcast notification.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (item: BroadcastNotificationItem) => {
    try {
      await apiFetch(`/api/broadcasts/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: item.is_active ? 0 : 1 }),
      });
      setFeedback(item.is_active ? 'Broadcast withdrawn from user views.' : 'Broadcast reactivated.');
      await Promise.all([loadData(), refreshBroadcasts()]);
    } catch (err: any) {
      setFeedback(err.message || 'Failed to update broadcast state.');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiFetch(`/api/broadcasts/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setFeedback('Broadcast deleted permanently.');
      await Promise.all([loadData(), refreshBroadcasts()]);
    } catch (err: any) {
      setFeedback(err.message || 'Failed to delete broadcast.');
    }
  };

  const toggleSelectedUser = (uid: number) => {
    setSelectedUserIds((prev) => (prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]));
  };

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return audienceUsers;
    return audienceUsers.filter(
      (u) =>
        u.full_name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role_label.toLowerCase().includes(q)
    );
  }, [audienceUsers, userSearch]);

  const counts = useMemo(() => {
    const published = broadcasts.filter((b) => b.lifecycle_status === 'published').length;
    const scheduled = broadcasts.filter((b) => b.lifecycle_status === 'scheduled').length;
    const inactive = broadcasts.filter(
      (b) => b.lifecycle_status === 'expired' || b.lifecycle_status === 'withdrawn'
    ).length;
    const totalReads = broadcasts.reduce((sum, b) => sum + (b.read_count || 0), 0);
    return { published, scheduled, inactive, totalReads };
  }, [broadcasts]);

  const filteredBroadcasts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return broadcasts.filter((item) => {
      if (statusFilter !== 'all' && item.lifecycle_status !== statusFilter) return false;
      if (categoryFilter !== 'All' && item.category !== categoryFilter) return false;
      if (q && !item.title.toLowerCase().includes(q) && !item.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [broadcasts, statusFilter, categoryFilter, search]);

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filteredBroadcasts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedBroadcasts = filteredBroadcasts.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const getCategoryTextStyle = (cat: BroadcastCategory) => {
    switch (cat) {
      case 'Urgent':
        return 'text-red-700 dark:text-red-400';
      case 'Warning':
        return 'text-amber-700 dark:text-amber-400';
      case 'Important':
        return 'text-blue-700 dark:text-blue-400';
      case 'Announcement':
        return 'text-emerald-700 dark:text-emerald-400';
      default:
        return 'text-slate-600 dark:text-slate-400';
    }
  };

  const getLifecycleStyle = (status: BroadcastLifecycleStatus) => {
    switch (status) {
      case 'published':
        return 'text-emerald-700 dark:text-emerald-400 font-semibold';
      case 'scheduled':
        return 'text-blue-700 dark:text-blue-400 font-semibold';
      case 'expired':
        return 'text-amber-700 dark:text-amber-400 font-medium';
      case 'withdrawn':
        return 'text-slate-500 dark:text-slate-400 font-medium';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          {onBackToDashboard && (
            <button
              type="button"
              onClick={onBackToDashboard}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline mb-1.5 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Super Admin Dashboard
            </button>
          )}
          <h2 className="text-xl font-display font-bold text-slate-900 dark:text-white">
            Broadcast Notifications Center
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Create, target, schedule, and track company-wide alerts across Notification Tab and Live Popup modes.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New Broadcast
          </button>
        </div>
      </div>

      {feedback && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-300">
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback('')} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Published Active
          </div>
          <div className="text-2xl font-mono font-bold text-emerald-700 dark:text-emerald-400 tabular-nums mt-1">
            {counts.published}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Scheduled Upcoming
          </div>
          <div className="text-2xl font-mono font-bold text-blue-700 dark:text-blue-400 tabular-nums mt-1">
            {counts.scheduled}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Expired / Withdrawn
          </div>
          <div className="text-2xl font-mono font-bold text-slate-700 dark:text-slate-300 tabular-nums mt-1">
            {counts.inactive}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Total Confirmed Reads
          </div>
          <div className="text-2xl font-mono font-bold text-slate-900 dark:text-white tabular-nums mt-1">
            {counts.totalReads}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search broadcasts by title or message..."
            className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as any);
            setPage(1);
          }}
          aria-label="Filter by lifecycle status"
          className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
        >
          <option value="all">All Statuses</option>
          <option value="published">Published</option>
          <option value="scheduled">Scheduled</option>
          <option value="expired">Expired</option>
          <option value="withdrawn">Withdrawn</option>
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value as any);
            setPage(1);
          }}
          aria-label="Filter by category"
          className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
        >
          <option value="All">All Categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* Broadcasts Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="py-3 px-4">Broadcast Message</th>
                <th className="py-3 px-4 whitespace-nowrap">Display Mode</th>
                <th className="py-3 px-4 whitespace-nowrap">Audience</th>
                <th className="py-3 px-4 whitespace-nowrap">Schedule & Expiry</th>
                <th className="py-3 px-4 whitespace-nowrap">Reach / Read</th>
                <th className="py-3 px-4 whitespace-nowrap">Status</th>
                <th className="py-3 px-4 text-right whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    Loading broadcasts...
                  </td>
                </tr>
              ) : pagedBroadcasts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    No broadcast notifications match the current filters.
                  </td>
                </tr>
              ) : (
                pagedBroadcasts.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 align-top">
                    <td className="py-3.5 px-4 max-w-md">
                      <div className={`text-[11px] font-semibold uppercase tracking-wider ${getCategoryTextStyle(item.category)}`}>
                        {item.category}
                      </div>
                      <div className="font-semibold text-slate-900 dark:text-white mt-0.5">{item.title}</div>
                      <p className="text-slate-600 dark:text-slate-300 mt-1 whitespace-pre-line line-clamp-3">
                        {item.message}
                      </p>
                      <BroadcastAttachmentLink
                        path={item.attachment_path}
                        name={item.attachment_name}
                        mime={item.attachment_mime}
                      />
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      {item.display_mode === 'tab_and_popup' ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-blue-700 dark:text-blue-400">
                          <BellRing className="w-3.5 h-3.5" />
                          Tab + Live Popup
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                          <Megaphone className="w-3.5 h-3.5" />
                          Notification Tab Only
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap text-slate-700 dark:text-slate-300">
                      <div className="font-medium capitalize">{item.target_audience}</div>
                      {item.target_audience === 'selected' && (
                        <div className="text-[11px] font-mono text-slate-400 tabular-nums">
                          {item.target_user_ids.length} selected users
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-mono text-[11px] text-slate-600 dark:text-slate-300">
                      <div>Start: {item.starts_at ? formatDateTime(item.starts_at) : 'Immediate'}</div>
                      <div className="text-slate-400 mt-0.5">
                        Expires: {item.expires_at ? formatDateTime(item.expires_at) : 'No expiry'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-mono tabular-nums">
                      <div className="text-slate-900 dark:text-white font-semibold">
                        {item.read_count} / {item.delivered_count} read
                      </div>
                      {item.display_mode === 'tab_and_popup' && (
                        <div className="text-[11px] text-slate-400">{item.popup_seen_count} popup seen</div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span className={`capitalize ${getLifecycleStyle(item.lifecycle_status)}`}>
                        {item.lifecycle_status}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEditModal(item)}
                          title="Edit broadcast"
                          className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(item)}
                          title={item.is_active ? 'Withdraw broadcast' : 'Reactivate broadcast'}
                          className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"
                        >
                          {item.is_active ? (
                            <XCircle className="w-3.5 h-3.5 text-amber-600" />
                          ) : (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          )}
                        </button>
                        {confirmDeleteId === item.id ? (
                          <button
                            type="button"
                            onClick={() => handleDelete(item.id)}
                            className="px-2 py-1 text-[11px] font-semibold rounded bg-red-600 text-white cursor-pointer"
                          >
                            Confirm
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(item.id)}
                            title="Delete broadcast"
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-950/40 text-red-600 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
          <span className="font-mono tabular-nums">
            Showing {filteredBroadcasts.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, filteredBroadcasts.length)} of {filteredBroadcasts.length}
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

      {/* Create / Edit Broadcast Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 my-8 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-display font-bold">
                {editingItem ? 'Edit Broadcast Notification' : 'Publish New Broadcast Notification'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                {formError}
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold mb-1">Notification Title</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Scheduled ERP & Network Maintenance Window"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1">Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as BroadcastCategory)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1">Notification Message / Description</label>
                <textarea
                  required
                  rows={4}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Write the full announcement, action instructions, or alert guidance..."
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              {/* Delivery Display Mode */}
              <div>
                <label className="block text-xs font-semibold mb-1.5">Display Behavior</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setDisplayMode('tab_only')}
                    className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                      displayMode === 'tab_only'
                        ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/30'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                      <Megaphone className="w-4 h-4 text-blue-600" />
                      Notification Tab Only
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Appears inside the Notification Center with unread badge only. Never opens a popup dialog.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDisplayMode('tab_and_popup')}
                    className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                      displayMode === 'tab_and_popup'
                        ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/30'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                      <BellRing className="w-4 h-4 text-red-600" />
                      Notification Tab + Live Popup
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Appears in the Notification Center and triggers a one-time live popup alert for targeted users.
                    </p>
                  </button>
                </div>
              </div>

              {/* Target Audience */}
              <div>
                <label className="block text-xs font-semibold mb-1">Target Audience</label>
                <select
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value as BroadcastTargetAudience)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {(Object.keys(AUDIENCE_LABELS) as BroadcastTargetAudience[]).map((key) => (
                    <option key={key} value={key}>
                      {AUDIENCE_LABELS[key]}
                    </option>
                  ))}
                </select>

                {targetAudience === 'selected' && (
                  <div className="mt-2 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2 bg-slate-50/50 dark:bg-slate-950/40">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
                        <Users className="w-3.5 h-3.5" />
                        <span>Select Recipients ({selectedUserIds.length} chosen)</span>
                      </div>
                      <input
                        type="text"
                        value={userSearch}
                        onChange={(e) => setUserSearch(e.target.value)}
                        placeholder="Filter users..."
                        className="px-2.5 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                    <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                      {filteredUsers.map((u) => (
                        <label
                          key={u.id}
                          className="flex items-center justify-between py-1.5 px-1 text-xs cursor-pointer hover:bg-slate-100/70 dark:hover:bg-slate-800/40"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={selectedUserIds.includes(u.id)}
                              onChange={() => toggleSelectedUser(u.id)}
                            />
                            <span className="font-medium truncate">{u.full_name}</span>
                            <span className="text-slate-400 truncate">({u.email})</span>
                          </span>
                          <span className="text-[11px] text-slate-500 whitespace-nowrap shrink-0 ml-2">
                            {u.role_label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Start / Expiration Dates */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1">
                    Start Date & Time <span className="text-slate-400 font-normal">(optional = immediate)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1">
                    Expiration Date & Time <span className="text-slate-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                  />
                </div>
              </div>

              {/* Optional Attachment / Image */}
              <div>
                <label className="block text-xs font-semibold mb-1">
                  Optional Image or Document Attachment
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                    <Paperclip className="w-3.5 h-3.5" />
                    <span>{attachmentFile ? attachmentFile.name : 'Choose Image / PDF / Doc'}</span>
                    <input
                      type="file"
                      accept="image/*,.pdf,.doc,.docx,.txt"
                      className="hidden"
                      onChange={(e) => {
                        setAttachmentFile(e.target.files?.[0] || null);
                        setRemoveAttachment(false);
                      }}
                    />
                  </label>
                  {attachmentFile && (
                    <button
                      type="button"
                      onClick={() => setAttachmentFile(null)}
                      className="text-xs text-red-600 hover:underline cursor-pointer"
                    >
                      Clear selected file
                    </button>
                  )}
                  {editingItem?.attachment_name && !attachmentFile && !removeAttachment && (
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>Current: {editingItem.attachment_name}</span>
                      <button
                        type="button"
                        onClick={() => setRemoveAttachment(true)}
                        className="text-red-600 hover:underline cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer"
                >
                  {submitting
                    ? 'Saving...'
                    : editingItem
                    ? 'Update Broadcast'
                    : startsAt
                    ? 'Schedule Broadcast'
                    : 'Publish Broadcast Now'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
