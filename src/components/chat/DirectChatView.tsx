import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCheck,
  Download,
  Eye,
  FileSpreadsheet,
  Link2,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Ticket,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { ChatAttachmentItem, ChatConversationItem, DirectMessageItem, ModeratorItem, TicketItem } from '../../types/index.ts';
import {
  apiFetch,
  fetchProtectedBlobUrl,
  formatDateTime,
  getStatusColorClass,
  uploadWithProgress,
} from '../../utils/api.ts';
import { exportToCsv } from '../../utils/exportUtils.ts';
import MediaPreviewModal, { PreviewMediaDescriptor, formatBytesCompact } from '../common/MediaPreviewModal.tsx';
import UploadProgressList, { checkClientFileSafety } from '../common/UploadProgressList.tsx';

interface DirectChatViewProps {
  initialPeerUserId?: number | null;
  initialTaskId?: number | null;
  onOpenTask?: (ticketId: number) => void;
}

interface MonitoredThreadSummary {
  thread_key: string;
  user_a: { id: number; name: string; email: string; role: string };
  user_b: { id: number; name: string; email: string; role: string };
  message_count: number;
  last_message: string;
  last_message_at: string;
  ticket_numbers: string[];
}

interface MonitoredTicketChat {
  ticket_id: number;
  ticket_number: string;
  category: string;
  status: string;
  reporter_name: string;
  moderator_name: string;
  comment_count: number;
  last_message_at: string;
  last_message: string;
}

function formatRoleLabel(role?: string) {
  if (role === 'super_admin') return 'Super Admin';
  if (role === 'management') return 'Admin';
  if (role === 'moderator') return 'Moderator';
  if (role === 'employee') return 'Employee';
  return role || 'User';
}

export default function DirectChatView({ initialPeerUserId, initialTaskId, onOpenTask }: DirectChatViewProps) {
  const { user, onlineUserIds, refreshChatUnread, subscribeRealtime } = useAuth();

  const canViewChats = user?.role !== 'management' || user.permissions?.can_view_chats !== false;
  const canMonitorChats =
    user?.role === 'super_admin' || (user?.role === 'management' && Boolean(user.permissions?.can_monitor_chats));

  const [activeMode, setActiveMode] = useState<'direct' | 'monitor'>('direct');

  // Direct chat state
  const [conversations, setConversations] = useState<ChatConversationItem[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedPeerId, setSelectedPeerId] = useState<number | null>(initialPeerUserId ?? null);
  const [messages, setMessages] = useState<DirectMessageItem[]>([]);
  const [tasks, setTasks] = useState<TicketItem[]>([]);
  const [linkedTaskId, setLinkedTaskId] = useState<string>(initialTaskId ? String(initialTaskId) : '');
  const [filterByTaskOnly, setFilterByTaskOnly] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [loadingConvos, setLoadingConvos] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState('');
  const [error, setError] = useState('');

  // Monitoring archive state
  const [monitorSearch, setMonitorSearch] = useState('');
  const [monitorRole, setMonitorRole] = useState('All');
  const [monitorModId, setMonitorModId] = useState('All');
  const [monitorDateFrom, setMonitorDateFrom] = useState('');
  const [monitorDateTo, setMonitorDateTo] = useState('');
  const [moderatorsList, setModeratorsList] = useState<ModeratorItem[]>([]);
  const [monitoredThreads, setMonitoredThreads] = useState<MonitoredThreadSummary[]>([]);
  const [monitoredTicketChats, setMonitoredTicketChats] = useState<MonitoredTicketChat[]>([]);
  const [loadingMonitor, setLoadingMonitor] = useState(false);
  const [monitorError, setMonitorError] = useState('');
  const [activeMonitorThread, setActiveMonitorThread] = useState<MonitoredThreadSummary | null>(null);
  const [monitorMessages, setMonitorMessages] = useState<DirectMessageItem[]>([]);
  const [loadingMonitorThread, setLoadingMonitorThread] = useState(false);

  const [previewMedia, setPreviewMedia] = useState<PreviewMediaDescriptor | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadConversations = useCallback(async () => {
    if (!canViewChats) {
      setLoadingConvos(false);
      return;
    }
    try {
      const res = await apiFetch<{ conversations: ChatConversationItem[] }>('/api/chat/conversations');
      setConversations(res.conversations || []);
      setSelectedPeerId((prev) => {
        if (prev && res.conversations.some((c) => c.user_id === prev)) return prev;
        if (initialPeerUserId && res.conversations.some((c) => c.user_id === initialPeerUserId)) {
          return initialPeerUserId;
        }
        return res.conversations[0]?.user_id ?? null;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load chat contacts');
    } finally {
      setLoadingConvos(false);
    }
  }, [initialPeerUserId, canViewChats]);

  const loadTasks = useCallback(async () => {
    try {
      const res = await apiFetch<{ tickets: TicketItem[] }>('/api/tickets');
      setTasks(res.tickets || []);
    } catch {
      // non-fatal
    }
  }, []);

  const loadMessages = useCallback(
    async (peerId: number, ticketFilter?: number | null) => {
      setLoadingMsgs(true);
      setError('');
      try {
        const qs = new URLSearchParams({ peer_user_id: String(peerId) });
        if (ticketFilter) qs.set('ticket_id', String(ticketFilter));
        const res = await apiFetch<{ messages: DirectMessageItem[] }>(`/api/chat/messages?${qs.toString()}`);
        setMessages(res.messages || []);
        setConversations((prev) =>
          prev.map((c) => (c.user_id === peerId ? { ...c, unread_count: 0 } : c))
        );
        refreshChatUnread();
      } catch (err: any) {
        setError(err.message || 'Failed to load messages');
      } finally {
        setLoadingMsgs(false);
      }
    },
    [refreshChatUnread]
  );

  const loadMonitorArchive = useCallback(async () => {
    if (!canMonitorChats) return;
    setLoadingMonitor(true);
    setMonitorError('');
    try {
      const qs = new URLSearchParams();
      if (monitorSearch.trim()) qs.set('search', monitorSearch.trim());
      if (monitorRole !== 'All') qs.set('role_filter', monitorRole);
      if (monitorModId !== 'All') qs.set('moderator_id', monitorModId);
      if (monitorDateFrom) qs.set('date_from', monitorDateFrom);
      if (monitorDateTo) qs.set('date_to', monitorDateTo);

      const res = await apiFetch<{ threads: MonitoredThreadSummary[]; ticketChats: MonitoredTicketChat[] }>(
        `/api/chat/monitor?${qs.toString()}`
      );
      setMonitoredThreads(res.threads || []);
      setMonitoredTicketChats(res.ticketChats || []);
    } catch (err: any) {
      setMonitorError(err.message || 'Failed to load chat monitoring archive');
    } finally {
      setLoadingMonitor(false);
    }
  }, [canMonitorChats, monitorSearch, monitorRole, monitorModId, monitorDateFrom, monitorDateTo]);

  const inspectMonitorThread = async (thread: MonitoredThreadSummary) => {
    setActiveMonitorThread(thread);
    setLoadingMonitorThread(true);
    setMonitorError('');
    try {
      const qs = new URLSearchParams({
        user_a: String(thread.user_a.id),
        user_b: String(thread.user_b.id),
      });
      const res = await apiFetch<{ messages: DirectMessageItem[] }>(`/api/chat/monitor/thread?${qs.toString()}`);
      setMonitorMessages(res.messages || []);
    } catch (err: any) {
      setMonitorError(err.message || 'Unable to inspect selected thread');
    } finally {
      setLoadingMonitorThread(false);
    }
  };

  useEffect(() => {
    loadConversations();
    loadTasks();
    if (canMonitorChats) {
      apiFetch<{ moderators: ModeratorItem[] }>('/api/moderators?include_super_admin=1')
        .then((r) => setModeratorsList(r.moderators || []))
        .catch(() => {});
    }
  }, [loadConversations, loadTasks, canMonitorChats]);

  useEffect(() => {
    if (activeMode === 'monitor' && canMonitorChats) {
      loadMonitorArchive();
    }
  }, [activeMode, canMonitorChats, loadMonitorArchive]);

  useEffect(() => {
    if (initialPeerUserId) {
      setActiveMode('direct');
      setSelectedPeerId(initialPeerUserId);
    }
  }, [initialPeerUserId]);

  useEffect(() => {
    if (initialTaskId) setLinkedTaskId(String(initialTaskId));
  }, [initialTaskId]);

  useEffect(() => {
    if (!selectedPeerId || !canViewChats) return;
    loadMessages(selectedPeerId, filterByTaskOnly && linkedTaskId ? Number(linkedTaskId) : null);
  }, [selectedPeerId, filterByTaskOnly, linkedTaskId, loadMessages, canViewChats]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (!user) return;
    return subscribeRealtime((evt) => {
      if (evt.event === 'chat:message' && evt.data) {
        const incoming = evt.data as DirectMessageItem;
        const involvesSelected =
          selectedPeerId &&
          ((incoming.sender_user_id === selectedPeerId && incoming.recipient_user_id === user.id) ||
            (incoming.sender_user_id === user.id && incoming.recipient_user_id === selectedPeerId));

        if (involvesSelected) {
          if (!filterByTaskOnly || !linkedTaskId || incoming.ticket_id === Number(linkedTaskId)) {
            setMessages((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
          }
          if (incoming.sender_user_id === selectedPeerId) {
            apiFetch('/api/chat/mark-read', {
              method: 'POST',
              body: JSON.stringify({ peer_user_id: selectedPeerId }),
            })
              .then(() => refreshChatUnread())
              .catch(() => {});
          }
        }
        loadConversations();
        if (activeMode === 'monitor' && canMonitorChats) {
          loadMonitorArchive();
        }
      } else if (evt.event === 'chat:read' && evt.data) {
        if (evt.data.by_user_id === selectedPeerId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.sender_user_id === user.id ? { ...m, is_read: 1, read_at: evt.data.read_at } : m
            )
          );
        }
      }
    });
  }, [
    user,
    selectedPeerId,
    filterByTaskOnly,
    linkedTaskId,
    activeMode,
    canMonitorChats,
    subscribeRealtime,
    loadConversations,
    loadMonitorArchive,
    refreshChatUnread,
  ]);

  const filteredConversations = useMemo(() => {
    const q = contactSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.full_name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.specialization || '').toLowerCase().includes(q) ||
        formatRoleLabel(c.role).toLowerCase().includes(q)
    );
  }, [conversations, contactSearch]);

  const selectedPeer = useMemo(
    () => conversations.find((c) => c.user_id === selectedPeerId) || null,
    [conversations, selectedPeerId]
  );

  const linkableTasks = useMemo(() => {
    if (!selectedPeer) return tasks;
    if ((user?.role === 'super_admin' || user?.role === 'management') && selectedPeer.moderator_id) {
      return tasks.filter((t) => t.assigned_moderator_id === selectedPeer.moderator_id);
    }
    if (selectedPeer.role === 'employee' && selectedPeer.employee_id) {
      return tasks.filter((t) => t.employee_id === selectedPeer.employee_id || t.created_by_user_id === selectedPeer.user_id);
    }
    return tasks;
  }, [tasks, selectedPeer, user?.role]);

  const handleSelectFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    for (const f of incoming) {
      const safetyErr = checkClientFileSafety(f, 25);
      if (safetyErr) {
        setUploadError(safetyErr);
        return;
      }
    }
    const merged = [...pendingFiles, ...incoming].slice(0, 6);
    setUploadError('');
    setPendingFiles(merged);
  };

  const executeSend = async () => {
    if (!selectedPeerId || (!messageText.trim() && pendingFiles.length === 0)) return;
    setError('');
    setUploadError('');
    setSending(true);
    setUploadProgress(0);

    try {
      let res: { message: DirectMessageItem };
      if (pendingFiles.length > 0) {
        const fd = new FormData();
        fd.append('recipient_user_id', String(selectedPeerId));
        if (messageText.trim()) fd.append('message', messageText.trim());
        if (linkedTaskId) fd.append('ticket_id', linkedTaskId);
        pendingFiles.forEach((f) => fd.append('files', f));

        res = await uploadWithProgress<{ message: DirectMessageItem }>('/api/chat/messages', fd, {
          onProgress: (pct) => setUploadProgress(pct),
        });
      } else {
        res = await apiFetch<{ message: DirectMessageItem }>('/api/chat/messages', {
          method: 'POST',
          body: JSON.stringify({
            recipient_user_id: selectedPeerId,
            message: messageText.trim(),
            ticket_id: linkedTaskId ? Number(linkedTaskId) : null,
          }),
        });
      }

      setMessageText('');
      setPendingFiles([]);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      loadConversations();
    } catch (err: any) {
      const msg = err.message || 'Failed to send message';
      if (pendingFiles.length > 0) {
        setUploadError(msg);
      } else {
        setError(msg);
      }
    } finally {
      setSending(false);
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeSend();
  };

  const handleDownloadAttachment = async (att: ChatAttachmentItem) => {
    const fileName = att.original_name || att.file_name || `attachment-${att.id}`;
    try {
      const blobUrl = await fetchProtectedBlobUrl(`/api/chat/attachments/${att.id}/file`);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    } catch (err: any) {
      setError(err.message || 'Unable to download attachment');
    }
  };

  const renderAttachments = (attachments?: ChatAttachmentItem[], mine?: boolean) => {
    if (!attachments || attachments.length === 0) return null;
    return (
      <div className="mt-2 space-y-1.5">
        {attachments.map((att) => {
          const displayName = att.original_name || att.file_name || `file-${att.id}`;
          const previewDesc: PreviewMediaDescriptor = {
            file_name: displayName,
            mime_type: att.mime_type,
            file_size: att.file_size,
            url: `/api/chat/attachments/${att.id}/file`,
          };
          return (
            <div
              key={att.id}
              className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-xs ${
                mine
                  ? 'bg-blue-800/70 border-blue-500/70 text-white'
                  : 'bg-slate-50 dark:bg-slate-800/70 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100'
              }`}
            >
              <button
                type="button"
                onClick={() => setPreviewMedia(previewDesc)}
                className="flex items-center gap-1.5 min-w-0 text-left hover:underline cursor-pointer"
              >
                <Eye className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate font-medium">{displayName}</span>
                <span className={`font-mono text-[10px] shrink-0 ${mine ? 'text-blue-200' : 'text-slate-400'}`}>
                  ({formatBytesCompact(att.file_size)})
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleDownloadAttachment(att)}
                aria-label={`Download ${displayName}`}
                className={`p-1 rounded hover:opacity-80 cursor-pointer shrink-0 ${
                  mine ? 'text-blue-100' : 'text-slate-500 hover:text-blue-700'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  if (!user) return null;

  if (!canViewChats && !canMonitorChats) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center space-y-2">
        <ShieldAlert className="w-8 h-8 text-amber-500 mx-auto" />
        <h3 className="text-sm font-display font-bold">Chat Access Restricted</h3>
        <p className="text-xs text-slate-500">
          Direct chat & monitoring permissions are currently disabled for your Admin account. Contact the Super Admin to adjust your permission matrix.
        </p>
      </div>
    );
  }

  const sidebarTitle =
    user.role === 'super_admin'
      ? 'All Active Channels'
      : user.role === 'management'
      ? 'Support & Moderator Channels'
      : user.role === 'moderator'
      ? 'Super Admin, Admins & Ticket Staff'
      : 'IT Support & Assigned Engineers';

  const sidebarDesc =
    user.role === 'super_admin'
      ? 'Direct 1-on-1 channels with moderators, admins, and employees.'
      : user.role === 'management'
      ? 'Chat with Super Admin, assigned moderators, and scoped employees.'
      : user.role === 'moderator'
      ? 'Chat with Super Admin, Operations Admins, and employees on your assigned tickets.'
      : 'Reach IT Support Admins or moderators assigned to your active tickets.';

  return (
    <div className="space-y-4">
      {canMonitorChats && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {canViewChats && (
              <button
                type="button"
                onClick={() => setActiveMode('direct')}
                className={`px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  activeMode === 'direct'
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                Direct & Task Chat
              </button>
            )}
            <button
              type="button"
              onClick={() => setActiveMode('monitor')}
              className={`px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                activeMode === 'monitor'
                  ? 'bg-blue-700 text-white'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              Chat History & Monitoring Archive
            </button>
          </div>
          <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
            {user.role === 'super_admin' ? 'Unrestricted Super Admin Archive' : 'Scoped Admin Audit View'}
          </span>
        </div>
      )}

      {activeMode === 'direct' && canViewChats ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden grid lg:grid-cols-12 min-h-[640px]">
          {/* Conversation List */}
          <div className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 flex flex-col">
            <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
              <div>
                <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-white">{sidebarTitle}</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{sidebarDesc}</p>
              </div>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  placeholder="Search contacts or roles..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 max-h-[560px]">
              {loadingConvos ? (
                <div className="p-6 text-xs text-slate-500">Loading conversations...</div>
              ) : filteredConversations.length === 0 ? (
                <div className="p-6 text-xs text-slate-500">
                  No authorized contacts matched. Contacts appear automatically when accounts are active or tickets are assigned.
                </div>
              ) : (
                filteredConversations.map((c) => {
                  const isOnline = onlineUserIds.includes(c.user_id) || Boolean(c.is_online);
                  const isSelected = c.user_id === selectedPeerId;
                  return (
                    <button
                      key={c.user_id}
                      type="button"
                      onClick={() => setSelectedPeerId(c.user_id)}
                      className={`w-full text-left px-4 py-3.5 transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-blue-50/70 dark:bg-blue-950/30'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            title={isOnline ? 'Live WebSocket Online' : 'Offline'}
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              isOnline ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'
                            }`}
                          />
                          <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                            {c.full_name}
                          </span>
                        </div>
                        {c.unread_count > 0 && (
                          <span className="min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded bg-blue-700 text-white text-[11px] font-mono font-bold tabular-nums">
                            {c.unread_count}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">{formatRoleLabel(c.role)}</span>
                        {c.specialization ? ` · ${c.specialization}` : ''}
                        {' · '}
                        {isOnline ? 'Online' : 'Offline'}
                      </div>
                      {c.last_message && (
                        <div className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 truncate">
                          {c.last_message}
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Message Thread */}
          <div className="lg:col-span-8 flex flex-col bg-slate-50/50 dark:bg-slate-950/40">
            {selectedPeer ? (
              <>
                <div className="px-5 py-3.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                        {selectedPeer.full_name}
                      </h3>
                      <span className="text-[11px] font-semibold text-blue-700 dark:text-blue-400">
                        {formatRoleLabel(selectedPeer.role)}
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        · {onlineUserIds.includes(selectedPeer.user_id) || selectedPeer.is_online ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                      {selectedPeer.email} {selectedPeer.employee_code ? `· ${selectedPeer.employee_code}` : ''}
                    </div>
                  </div>

                  {linkedTaskId && (
                    <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={filterByTaskOnly}
                        onChange={(e) => setFilterByTaskOnly(e.target.checked)}
                        className="rounded border-slate-300"
                      />
                      <span>Show selected task messages only</span>
                    </label>
                  )}
                </div>

                {error && (
                  <div className="m-3 p-3 text-xs rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900/60">
                    {error}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto p-5 space-y-3 max-h-[430px]">
                  {loadingMsgs ? (
                    <div className="text-xs text-slate-500 text-center py-10">Loading conversation history...</div>
                  ) : messages.length === 0 ? (
                    <div className="text-center py-12 space-y-2">
                      <MessageSquare className="w-8 h-8 text-slate-300 dark:text-slate-700 mx-auto" />
                      <p className="text-xs text-slate-500">
                        No messages yet with {selectedPeer.full_name}. Start a conversation below.
                      </p>
                    </div>
                  ) : (
                    messages.map((m) => {
                      const mine = m.sender_user_id === user.id;
                      return (
                        <div key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                          <div
                            className={`max-w-[82%] rounded-xl px-4 py-2.5 text-sm border ${
                              mine
                                ? 'bg-blue-700 text-white border-blue-700'
                                : 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border-slate-200 dark:border-slate-800'
                            }`}
                          >
                            <div
                              className={`text-[11px] font-medium mb-1 flex items-center gap-2 ${
                                mine ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              <span>{m.sender_name}</span>
                              <span>·</span>
                              <span>{formatRoleLabel(m.sender_role)}</span>
                            </div>

                            {m.ticket_id && m.ticket_number && (
                              <button
                                type="button"
                                onClick={() => onOpenTask && onOpenTask(m.ticket_id!)}
                                className={`mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded border cursor-pointer ${
                                  mine
                                    ? 'bg-blue-800/80 border-blue-500 text-white hover:bg-blue-800'
                                    : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-blue-700 dark:text-blue-300 hover:underline'
                                }`}
                              >
                                <Link2 className="w-3 h-3" />
                                <span>{m.ticket_number}</span>
                                {m.ticket_status && (
                                  <span className={mine ? 'text-blue-100' : getStatusColorClass(m.ticket_status)}>
                                    · {m.ticket_status}
                                  </span>
                                )}
                              </button>
                            )}

                            <div className="whitespace-pre-wrap break-words leading-relaxed">{m.message}</div>
                            {renderAttachments(m.attachments, mine)}
                          </div>

                          <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-slate-400 tabular-nums px-1">
                            <span>{formatDateTime(m.created_at)}</span>
                            {mine && (
                              <span className="inline-flex items-center gap-0.5 text-slate-500">
                                <CheckCheck className={`w-3 h-3 ${m.is_read ? 'text-blue-600' : 'text-slate-400'}`} />
                                {m.is_read ? 'Read' : 'Sent'}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={bottomRef} />
                </div>

                {/* Composer */}
                <form
                  onSubmit={handleSend}
                  className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Link2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <select
                        value={linkedTaskId}
                        onChange={(e) => setLinkedTaskId(e.target.value)}
                        className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 max-w-xs"
                      >
                        <option value="">General message (no task linked)</option>
                        {linkableTasks.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.ticket_number} — {t.category} ({t.status})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"
                        onChange={(e) => handleSelectFiles(e.target.files)}
                        className="hidden"
                      />
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() => fileInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Paperclip className="w-3.5 h-3.5" />
                        <span>Attach Media ({pendingFiles.length}/6)</span>
                      </button>
                    </div>
                  </div>

                  {(pendingFiles.length > 0 || uploadError) && (
                    <UploadProgressList
                      files={pendingFiles}
                      uploading={sending && pendingFiles.length > 0}
                      progress={uploadProgress}
                      error={uploadError}
                      onRemoveFile={(idx) => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}
                      onRetry={() => executeSend()}
                    />
                  )}

                  <div className="flex items-end gap-2">
                    <textarea
                      rows={2}
                      value={messageText}
                      onChange={(e) => setMessageText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSend(e);
                        }
                      }}
                      placeholder={`Message ${selectedPeer.full_name}... (Enter to send, Shift+Enter for newline)`}
                      className="flex-1 px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                    <button
                      type="submit"
                      disabled={sending || (!messageText.trim() && pendingFiles.length === 0)}
                      className="px-4 py-2.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer shrink-0 whitespace-nowrap"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>{sending ? (pendingFiles.length ? `Uploading ${uploadProgress}%` : 'Sending...') : 'Send'}</span>
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center p-10 text-xs text-slate-500">
                Select a conversation to start messaging.
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Chat History & Monitoring Archive */
        <div className="space-y-4">
          <div className="p-3.5 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 flex items-center justify-between gap-3 text-xs text-amber-900 dark:text-amber-200">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>
                Every chat history inspection is permanently logged in the immutable Security Audit Trail (
                <span className="font-mono font-semibold">MONITOR_PRIVATE_CHAT</span>).
              </span>
            </div>
            {(user.role === 'super_admin' || user.permissions?.can_export_data) && (
              <button
                type="button"
                disabled={monitoredThreads.length === 0}
                onClick={() =>
                  exportToCsv(
                    'SD_Global_Chat_Monitoring_Archive',
                    monitoredThreads.map((t) => ({
                      Thread: t.thread_key,
                      Participant_A: `${t.user_a.name} (${formatRoleLabel(t.user_a.role)})`,
                      Participant_B: `${t.user_b.name} (${formatRoleLabel(t.user_b.role)})`,
                      Messages: t.message_count,
                      Tickets: t.ticket_numbers.join(', ') || '-',
                      Last_Message: t.last_message,
                      Last_Activity: t.last_message_at,
                    }))
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-800 text-slate-900 dark:text-white font-semibold cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Export Index CSV
              </button>
            )}
          </div>

          {/* Monitor Filters */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
            <div className="relative lg:col-span-2">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={monitorSearch}
                onChange={(e) => setMonitorSearch(e.target.value)}
                placeholder="Search message, user, email, ticket #..."
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <select
              value={monitorRole}
              onChange={(e) => setMonitorRole(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="All">All Roles</option>
              <option value="super_admin">Super Admin</option>
              <option value="management">Admins</option>
              <option value="moderator">Moderators</option>
              <option value="employee">Employees</option>
            </select>
            <select
              value={monitorModId}
              onChange={(e) => setMonitorModId(e.target.value)}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="All">All Moderators</option>
              {moderatorsList.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.full_name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={monitorDateFrom}
              onChange={(e) => setMonitorDateFrom(e.target.value)}
              aria-label="Date from"
              className="px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={monitorDateTo}
                onChange={(e) => setMonitorDateTo(e.target.value)}
                aria-label="Date to"
                className="flex-1 px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 min-w-0"
              />
              <button
                type="button"
                onClick={loadMonitorArchive}
                className="p-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer shrink-0"
                title="Refresh Archive"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingMonitor ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {monitorError && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
              {monitorError}
            </div>
          )}

          {/* Two-column Monitor Split */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden grid lg:grid-cols-12 min-h-[500px]">
            <div className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 max-h-[540px] overflow-y-auto">
              <div className="px-4 py-3 bg-slate-50/70 dark:bg-slate-950/50 text-xs font-semibold text-slate-600 dark:text-slate-300">
                Direct & Task Conversation Threads ({monitoredThreads.length})
              </div>
              {loadingMonitor ? (
                <div className="p-6 text-xs text-slate-500">Loading monitored threads...</div>
              ) : monitoredThreads.length === 0 ? (
                <div className="p-6 text-xs text-slate-500">No direct chat threads matched the filter criteria.</div>
              ) : (
                monitoredThreads.map((t) => {
                  const selected = activeMonitorThread?.thread_key === t.thread_key;
                  return (
                    <button
                      key={t.thread_key}
                      type="button"
                      onClick={() => inspectMonitorThread(t)}
                      className={`w-full text-left px-4 py-3 transition-colors cursor-pointer ${
                        selected ? 'bg-blue-50/70 dark:bg-blue-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                        <span className="truncate">
                          {t.user_a.name} ({formatRoleLabel(t.user_a.role)}) ↔ {t.user_b.name} ({formatRoleLabel(t.user_b.role)})
                        </span>
                        <span className="font-mono text-[11px] text-blue-700 dark:text-blue-400 shrink-0 tabular-nums">
                          {t.message_count} msg
                        </span>
                      </div>
                      {t.ticket_numbers.length > 0 && (
                        <div className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">
                          Tasks: {t.ticket_numbers.join(', ')}
                        </div>
                      )}
                      <div className="text-xs text-slate-600 dark:text-slate-300 mt-1 truncate">{t.last_message}</div>
                      <div className="text-[10px] font-mono text-slate-400 mt-0.5">{formatDateTime(t.last_message_at)}</div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="lg:col-span-7 flex flex-col bg-slate-50/50 dark:bg-slate-950/40 max-h-[540px]">
              {activeMonitorThread ? (
                <>
                  <div className="px-5 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
                    <div className="text-sm font-display font-semibold">
                      {activeMonitorThread.user_a.name} ({formatRoleLabel(activeMonitorThread.user_a.role)}) ↔{' '}
                      {activeMonitorThread.user_b.name} ({formatRoleLabel(activeMonitorThread.user_b.role)})
                    </div>
                    <div className="text-[11px] font-mono text-slate-500">
                      {activeMonitorThread.user_a.email} · {activeMonitorThread.user_b.email}
                    </div>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {loadingMonitorThread ? (
                      <div className="text-xs text-slate-500 text-center py-10">Loading full thread history...</div>
                    ) : monitorMessages.length === 0 ? (
                      <div className="text-xs text-slate-500 text-center py-10">No messages recorded in this thread.</div>
                    ) : (
                      monitorMessages.map((m) => (
                        <div
                          key={m.id}
                          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 text-xs space-y-1.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                            <span className="font-semibold text-slate-900 dark:text-white">
                              {m.sender_name} ({formatRoleLabel(m.sender_role)}) → {m.recipient_name || 'Recipient'}
                            </span>
                            <span className="font-mono text-slate-400">{formatDateTime(m.created_at)}</span>
                          </div>
                          {m.ticket_id && m.ticket_number && (
                            <button
                              type="button"
                              onClick={() => onOpenTask && onOpenTask(m.ticket_id!)}
                              className="inline-flex items-center gap-1 font-mono text-[11px] text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                            >
                              <Link2 className="w-3 h-3" />
                              {m.ticket_number}
                            </button>
                          )}
                          <div className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap">{m.message}</div>
                          {renderAttachments(m.attachments, false)}
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center p-10 text-xs text-slate-500">
                  Select any direct conversation thread on the left to inspect full transcript & attachments.
                </div>
              )}
            </div>
          </div>

          {/* Ticket Portal Conversations Summary */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <Ticket className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-display font-semibold">
                Ticket Portal Conversations ({monitoredTicketChats.length})
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                    <th className="py-2.5 px-4">Ticket</th>
                    <th className="py-2.5 px-4">Reporter & Moderator</th>
                    <th className="py-2.5 px-4">Latest Comment</th>
                    <th className="py-2.5 px-4 text-right">Messages</th>
                    <th className="py-2.5 px-4">Last Activity</th>
                    <th className="py-2.5 px-4 text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {monitoredTicketChats.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-500">
                        No ticket portal comment threads matched.
                      </td>
                    </tr>
                  ) : (
                    monitoredTicketChats.map((tc) => (
                      <tr key={tc.ticket_id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-2.5 px-4">
                          <div className="font-mono font-semibold text-blue-700 dark:text-blue-400">{tc.ticket_number}</div>
                          <div className="text-slate-500">
                            {tc.category} · {tc.status}
                          </div>
                        </td>
                        <td className="py-2.5 px-4">
                          <div>{tc.reporter_name}</div>
                          <div className="text-slate-500">Assigned: {tc.moderator_name}</div>
                        </td>
                        <td className="py-2.5 px-4 max-w-xs truncate text-slate-600 dark:text-slate-300">
                          {tc.last_message}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">{tc.comment_count}</td>
                        <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                          {formatDateTime(tc.last_message_at)}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          {onOpenTask && (
                            <button
                              type="button"
                              onClick={() => onOpenTask(tc.ticket_id)}
                              className="px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                            >
                              Open Ticket Thread
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <MediaPreviewModal media={previewMedia} onClose={() => setPreviewMedia(null)} />
    </div>
  );
}
