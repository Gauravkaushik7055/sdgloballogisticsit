import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Download,
  Eye,
  Mail,
  MessageSquare,
  Paperclip,
  RotateCcw,
  Send,
  ShieldAlert,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useDropdowns } from '../../context/DropdownContext.tsx';
import { ModeratorItem, TicketItem } from '../../types/index.ts';
import {
  apiFetch,
  fetchProtectedBlobUrl,
  formatCurrency,
  formatDateTime,
  getAuthToken,
  getPriorityColorClass,
  getStatusColorClass,
  uploadWithProgress,
} from '../../utils/api.ts';
import StatusRoadmapTracker from './StatusRoadmapTracker.tsx';
import MediaPreviewModal, { PreviewMediaDescriptor } from '../common/MediaPreviewModal.tsx';
import UploadProgressList, { checkClientFileSafety } from '../common/UploadProgressList.tsx';

interface TicketDetailDrawerProps {
  ticketId: number | null;
  onClose: () => void;
  onUpdated: () => void;
  onOpenDirectChat?: (ticketId: number, peerUserId?: number) => void;
}

export default function TicketDetailDrawer({
  ticketId,
  onClose,
  onUpdated,
  onOpenDirectChat,
}: TicketDetailDrawerProps) {
  const { user, subscribeRealtime } = useAuth();
  const { getOptions } = useDropdowns();
  const [loading, setLoading] = useState(false);
  const [ticket, setTicket] = useState<TicketItem | null>(null);
  const [activities, setActivities] = useState<any[]>([]);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [comments, setComments] = useState<any[]>([]);
  const [timeLogs, setTimeLogs] = useState<any[]>([]);
  const [emails, setEmails] = useState<any[]>([]);
  const [whatsapp, setWhatsapp] = useState<any[]>([]);
  const [moderators, setModerators] = useState<ModeratorItem[]>([]);
  const [assets, setAssets] = useState<any[]>([]);

  const [activeTab, setActiveTab] = useState<'timeline' | 'comms' | 'time' | 'attachments'>('timeline');
  const [commChannel, setCommChannel] = useState<'portal' | 'outlook' | 'whatsapp'>('portal');

  // Form states
  const [commentText, setCommentText] = useState('');
  const [isInternal, setIsInternal] = useState(false);

  const [nextStatus, setNextStatus] = useState('');
  const [nextPriority, setNextPriority] = useState('');
  const [troubleshootNote, setTroubleshootNote] = useState('');
  const [partsReplaced, setPartsReplaced] = useState('');
  const [expensesIncurred, setExpensesIncurred] = useState('');
  const [visitCount, setVisitCount] = useState('');
  const [resolutionDesc, setResolutionDesc] = useState('');
  const [linkedAssetId, setLinkedAssetId] = useState('');

  // Assign / Reject / Reopen
  const [assignModId, setAssignModId] = useState('');
  const [assignDeadline, setAssignDeadline] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectBox, setShowRejectBox] = useState(false);

  const [empFeedback, setEmpFeedback] = useState('');
  const [showReopenBox, setShowReopenBox] = useState(false);

  // Time log
  const [logMinutes, setLogMinutes] = useState('30');
  const [logWorkType, setLogWorkType] = useState('Troubleshooting');
  const [logNotes, setLogNotes] = useState('');

  // Outlook / WhatsApp compose
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [waPhone, setWaPhone] = useState('');
  const [waBody, setWaBody] = useState('');
  const [actionMsg, setActionMsg] = useState('');
  const [actionErr, setActionErr] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Media upload & preview state
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [uploadCompleted, setUploadCompleted] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<PreviewMediaDescriptor | null>(null);

  const loadDetail = useCallback(async () => {
    if (!ticketId) return;
    setLoading(true);
    try {
      const data = await apiFetch<any>(`/api/tickets/${ticketId}`);
      setTicket(data.ticket);
      setActivities(data.activities || []);
      setAttachments(data.attachments || []);
      setComments(data.comments || []);
      setTimeLogs(data.timeLogs || []);
      setEmails(data.emails || []);
      setWhatsapp(data.whatsapp || []);

      setNextStatus(data.ticket.status);
      setNextPriority(data.ticket.priority);
      setPartsReplaced(data.ticket.parts_replaced || '');
      setExpensesIncurred(String(data.ticket.expenses_incurred ?? 0));
      setVisitCount(String(data.ticket.visit_count ?? 0));
      setResolutionDesc(data.ticket.resolution_description || '');
      setLinkedAssetId(data.ticket.asset_id ? String(data.ticket.asset_id) : '');
      setAssignModId(data.ticket.assigned_moderator_id ? String(data.ticket.assigned_moderator_id) : '');

      setEmailTo(data.ticket.reporter_email || '');
      setEmailSubject(`[${data.ticket.ticket_number}] Update on ${data.ticket.category}`);
      setWaPhone(data.ticket.reporter_mobile || '');
    } catch (err: any) {
      setActionErr(err.message);
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId) return;
    setActionMsg('');
    setActionErr('');
    setShowRejectBox(false);
    setShowReopenBox(false);
    setConfirmDelete(false);
    setReviewNote('');
    loadDetail();

    if (user?.role === 'super_admin') {
      apiFetch<{ moderators: ModeratorItem[] }>('/api/moderators?include_super_admin=1')
        .then((r) => setModerators(r.moderators))
        .catch(() => {});
    }
    if (user?.role === 'super_admin' || user?.role === 'moderator') {
      apiFetch<{ assets: any[] }>('/api/assets')
        .then((r) => setAssets(r.assets))
        .catch(() => {});
    }
  }, [ticketId, user, loadDetail]);

  useEffect(() => {
    if (!ticketId) return;
    return subscribeRealtime((evt) => {
      if (evt.event === 'ticket:updated' && Number(evt.data?.ticketId) === ticketId) {
        loadDetail();
      }
    });
  }, [ticketId, subscribeRealtime, loadDetail]);

  if (!ticketId) return null;

  const notifyAction = (msg: string) => {
    setActionErr('');
    setActionMsg(msg);
    loadDetail();
    onUpdated();
  };

  const handleAssign = async (overrideSelf = false) => {
    if (!overrideSelf && !assignModId) return;
    try {
      await apiFetch(`/api/tickets/${ticketId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          ...(overrideSelf ? { assignee_type: 'self' } : { moderator_id: Number(assignModId) }),
          deadline_at: assignDeadline ? new Date(assignDeadline).toISOString() : undefined,
        }),
      });
      notifyAction(overrideSelf ? 'Task assigned to you (Super Admin).' : 'Work assigned successfully.');
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const handleRespondAssignment = async (decision: 'accept' | 'reject') => {
    try {
      await apiFetch(`/api/tickets/${ticketId}/respond-assignment`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: rejectReason }),
      });
      setShowRejectBox(false);
      setRejectReason('');
      notifyAction(decision === 'accept' ? 'Assignment accepted.' : 'Assignment rejected and returned to IT Head.');
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const handleStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      ['On Hold', 'Pending Information', 'Revision Required'].includes(nextStatus) &&
      !troubleshootNote.trim() &&
      !resolutionDesc.trim()
    ) {
      setActionErr(`A detailed reason/note is required when changing status to "${nextStatus}".`);
      return;
    }
    try {
      await apiFetch(`/api/tickets/${ticketId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: nextStatus,
          ...(user?.role === 'super_admin' ? { priority: nextPriority } : {}),
          note: troubleshootNote,
          parts_replaced: partsReplaced,
          expenses_incurred: Number(expensesIncurred) || 0,
          visit_count: Number(visitCount) || 0,
          resolution_description: resolutionDesc,
          asset_id: linkedAssetId ? Number(linkedAssetId) : null,
        }),
      });
      setTroubleshootNote('');
      notifyAction('Task status and troubleshooting notes updated.');
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const handleSuperAdminReview = async (decision: 'approve' | 'revision') => {
    if (decision === 'revision' && !reviewNote.trim()) {
      setActionErr('Please enter specific revision instructions before requesting revision.');
      return;
    }
    try {
      await apiFetch(`/api/tickets/${ticketId}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, note: reviewNote.trim() }),
      });
      setReviewNote('');
      notifyAction(
        decision === 'approve'
          ? 'Work approved and marked as Completed.'
          : 'Revision requested. Moderator has been notified.'
      );
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const handleDeleteTask = async () => {
    try {
      await apiFetch(`/api/tickets/${ticketId}`, { method: 'DELETE' });
      onUpdated();
      onClose();
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const handleEmployeeConfirm = async (action: 'confirm' | 'reopen') => {
    try {
      await apiFetch(`/api/tickets/${ticketId}/employee-confirm`, {
        method: 'POST',
        body: JSON.stringify({ action, feedback: empFeedback }),
      });
      setEmpFeedback('');
      setShowReopenBox(false);
      notifyAction(action === 'confirm' ? 'Resolution confirmed.' : 'Ticket reopened and IT team notified.');
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const handleSendComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    try {
      await apiFetch(`/api/tickets/${ticketId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ message: commentText.trim(), is_internal: isInternal }),
      });
      setCommentText('');
      notifyAction('Message posted.');
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const handleAddTimeLog = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch(`/api/tickets/${ticketId}/time-logs`, {
        method: 'POST',
        body: JSON.stringify({
          duration_minutes: Number(logMinutes),
          work_type: logWorkType,
          notes: logNotes,
        }),
      });
      setLogNotes('');
      notifyAction('Working time logged.');
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const performMediaUpload = async (filesToUpload: File[]) => {
    if (!ticketId || filesToUpload.length === 0) return;
    setUploadingMedia(true);
    setUploadProgress(0);
    setUploadError('');
    setUploadCompleted(false);
    const fd = new FormData();
    filesToUpload.forEach((f) => fd.append('files', f));
    try {
      await uploadWithProgress(`/api/tickets/${ticketId}/attachments`, fd, {
        method: 'POST',
        onProgress: (pct) => setUploadProgress(pct),
      });
      setPendingUploadFiles([]);
      setUploadCompleted(true);
      notifyAction('Attachment(s) uploaded and verified cleanly.');
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploadingMedia(false);
    }
  };

  const handleUploadMore = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadError('');
    setUploadCompleted(false);
    const valid: File[] = [];
    for (const file of Array.from(files)) {
      const safetyErr = checkClientFileSafety(file, 25);
      if (safetyErr) {
        setUploadError(safetyErr);
        continue;
      }
      valid.push(file);
    }
    if (valid.length === 0) return;
    setPendingUploadFiles(valid);
    await performMediaUpload(valid);
  };

  const handleDownloadAttachment = async (att: any) => {
    const fileUrl = `/api/tickets/attachments/${att.id}/file`;
    try {
      const blobUrl = await fetchProtectedBlobUrl(fileUrl);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = att.original_name || 'attachment';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    } catch (err: any) {
      setActionErr(err.message || 'Failed to download file');
    }
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ delivered: boolean; status: string; error?: string }>('/api/integrations/outlook/send', {
        method: 'POST',
        body: JSON.stringify({ ticket_id: ticketId, to: emailTo, subject: emailSubject, body: emailBody }),
      });
      setEmailBody('');
      if (res.delivered) {
        notifyAction('Outlook email sent.');
      } else {
        setActionErr(res.error || res.status);
        loadDetail();
      }
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const handleSendWhatsApp = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ delivered: boolean; status: string; error?: string }>('/api/integrations/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({ ticket_id: ticketId, to_phone: waPhone, message: waBody }),
      });
      setWaBody('');
      if (res.delivered) {
        notifyAction('WhatsApp message sent.');
      } else {
        setActionErr(res.error || res.status);
        loadDetail();
      }
    } catch (err: any) {
      setActionErr(err.message);
    }
  };

  const tokenQuery = getAuthToken() ? `?token=${encodeURIComponent(getAuthToken()!)}` : '';

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 flex justify-end">
      <div className="w-full max-w-5xl bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 h-full flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-base font-bold text-blue-700 dark:text-blue-400">
                {ticket?.ticket_number || 'Loading...'}
              </span>
              {ticket && (
                <>
                  <span className="text-slate-300 dark:text-slate-700">·</span>
                  <span className={`text-xs font-semibold ${getStatusColorClass(ticket.status)}`}>{ticket.status}</span>
                  <span className="text-slate-300 dark:text-slate-700">·</span>
                  <span className={`text-xs ${getPriorityColorClass(ticket.priority)}`}>{ticket.priority} Priority</span>
                  {ticket.sla_breached === 1 && !['Completed', 'Resolved', 'Closed'].includes(ticket.status) && (
                    <>
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
                        <ShieldAlert className="w-3.5 h-3.5" />
                        SLA Breached
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
            {ticket && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">
                {ticket.category} · {ticket.device_name} · {ticket.reporter_branch_name} ({ticket.reporter_city})
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {ticket && onOpenDirectChat && (user?.role !== 'management' || user?.permissions?.can_view_chats !== false) && (
              <button
                type="button"
                onClick={() => {
                  const assignedMod = moderators.find((m) => m.id === ticket.assigned_moderator_id);
                  onOpenDirectChat(ticket.id, user?.role === 'super_admin' ? assignedMod?.user_id : undefined);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 cursor-pointer"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Direct Chat</span>
              </button>
            )}
            {ticket && user?.role === 'super_admin' && (
              confirmDelete ? (
                <div className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleDeleteTask}
                    className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 cursor-pointer"
                  >
                    Confirm Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="p-2 rounded-lg border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                  title="Delete Task (Super Admin)"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading && !ticket ? (
            <div className="py-12 text-center text-sm text-slate-500">Loading ticket workspace...</div>
          ) : ticket ? (
            <>
              {actionErr && (
                <div className="p-3 text-xs rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
                  {actionErr}
                </div>
              )}
              {actionMsg && (
                <div className="p-3 text-xs rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
                  {actionMsg}
                </div>
              )}

              {/* Summary Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pb-6 border-b border-slate-200 dark:border-slate-800">
                <div className="lg:col-span-2 space-y-4">
                  <div>
                    <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                      Issue Description
                    </div>
                    <p className="text-sm text-slate-900 dark:text-slate-100 leading-relaxed whitespace-pre-wrap">
                      {ticket.description}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2 text-xs">
                    <div>
                      <span className="text-slate-500 block">Reporter</span>
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {ticket.reporter_name} ({ticket.reporter_employee_code})
                      </span>
                      <span className="text-slate-500 block mt-0.5">
                        {ticket.reporter_designation} · {ticket.reporter_department}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Contact & Manager</span>
                      <span className="font-mono text-slate-800 dark:text-slate-200">{ticket.reporter_mobile}</span>
                      <span className="block text-slate-500 truncate">{ticket.reporter_email}</span>
                      <span className="block text-slate-500">Mgr: {ticket.reporter_manager}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Exact Location</span>
                      <span className="font-semibold text-slate-900 dark:text-white">{ticket.reporter_branch_name}</span>
                      <span className="block text-slate-500">{ticket.reporter_full_location}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Device & Serial</span>
                      <span className="font-semibold">{ticket.device_type} · {ticket.device_name}</span>
                      <span className="font-mono block text-slate-500">
                        {ticket.asset_tag ? `${ticket.asset_tag} / ` : ''}
                        {ticket.asset_serial_input || 'N/A'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Business Impact</span>
                      <span className="font-semibold">{ticket.business_impact}</span>
                      <span className="font-mono block text-slate-500 mt-0.5">
                        Occurred: {formatDateTime(ticket.issue_occurred_at)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Work & Cost Metrics</span>
                      <span className="font-mono font-semibold tabular-nums">
                        {ticket.total_working_minutes} mins · {ticket.visit_count} visit(s)
                      </span>
                      <span className="font-mono block text-slate-500">
                        Expense: {formatCurrency(ticket.expenses_incurred)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* SLA & Assignment Metadata Column */}
                <div className="bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3 text-xs">
                  <div className="font-display font-semibold text-sm text-slate-900 dark:text-white">
                    SLA & Lifecycle Timestamps
                  </div>
                  <div className="space-y-1.5 font-mono text-[11px]">
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Created:</span>
                      <span>{formatDateTime(ticket.created_at)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">1st Resp Due:</span>
                      <span>{formatDateTime(ticket.sla_first_response_due)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">1st Response:</span>
                      <span>{formatDateTime(ticket.first_response_at)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Assigned:</span>
                      <span>{formatDateTime(ticket.assigned_at)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Accepted:</span>
                      <span>{formatDateTime(ticket.accepted_at)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Resolution Due:</span>
                      <span>{formatDateTime(ticket.sla_resolution_due)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Resolved:</span>
                      <span>{formatDateTime(ticket.resolved_at)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">Closed / Verified:</span>
                      <span>{formatDateTime(ticket.closed_at)}</span>
                    </div>
                  </div>
                  {ticket.resolution_description && (
                    <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                      <span className="text-slate-500 block font-semibold">Resolution Summary</span>
                      <p className="text-slate-800 dark:text-slate-200 mt-0.5">{ticket.resolution_description}</p>
                    </div>
                  )}
                  {ticket.parts_replaced && (
                    <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                      <span className="text-slate-500 block font-semibold">Parts Replaced</span>
                      <p className="text-slate-800 dark:text-slate-200 mt-0.5">{ticket.parts_replaced}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Work Status Roadmap Visual Tracker & History */}
              <StatusRoadmapTracker status={ticket.status} activities={activities} />

              {/* ROLE-SPECIFIC ACTION PANELS */}
              {/* 1. Moderator Accept / Reject Assignment */}
              {user?.role === 'moderator' && ticket.status === 'Assigned' && (
                <div className="p-4 rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/30 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold">Assignment Action Required</h4>
                      <p className="text-xs text-slate-600 dark:text-slate-300">
                        Accept this assignment to begin work, or reject with a reason for the IT Head.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleRespondAssignment('accept')}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Accept Assignment
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRejectBox(!showRejectBox)}
                        className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                      >
                        Reject with Reason
                      </button>
                    </div>
                  </div>
                  {showRejectBox && (
                    <div className="flex gap-2 pt-2">
                      <input
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Provide reason for rejecting assignment..."
                        className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                      <button
                        type="button"
                        onClick={() => handleRespondAssignment('reject')}
                        className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 text-white cursor-pointer"
                      >
                        Confirm Reject
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* 2. Employee Confirm Resolution or Reopen */}
              {(user?.role === 'employee' || user?.role === 'super_admin') &&
                ['Completed', 'Resolved', 'Closed', 'Pending Information', 'Waiting for Employee'].includes(ticket.status) && (
                  <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-semibold">Resolution Confirmation</h4>
                        <p className="text-xs text-slate-500">
                          Confirm if your technical issue is fully resolved, or reopen if the problem continues.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {ticket.employee_confirmed === 0 && (
                          <button
                            type="button"
                            onClick={() => handleEmployeeConfirm('confirm')}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Confirm Issue Resolved
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setShowReopenBox(!showReopenBox)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Reopen Ticket
                        </button>
                      </div>
                    </div>
                    {showReopenBox && (
                      <div className="flex gap-2">
                        <input
                          value={empFeedback}
                          onChange={(e) => setEmpFeedback(e.target.value)}
                          placeholder="Describe why the issue is still occurring..."
                          className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        <button
                          type="button"
                          onClick={() => handleEmployeeConfirm('reopen')}
                          className="px-4 py-2 text-xs font-semibold rounded-lg bg-amber-600 text-white cursor-pointer"
                        >
                          Submit Reopen
                        </button>
                      </div>
                    )}
                  </div>
                )}

              {/* 3. Admin Work Assignment (Moderators + Super Admin Self) */}
              {user?.role === 'super_admin' && (
                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                      <UserCheck className="w-4 h-4 text-blue-600" />
                      <span>
                        Assign Work (IT Head / Moderators)
                        {ticket.moderator_name && (
                          <span className="ml-2 font-normal text-slate-500">
                            · Currently:{' '}
                            <strong className="text-slate-900 dark:text-white">
                              {ticket.moderator_name}
                              {ticket.moderator_role === 'super_admin' ? ' (Super Admin)' : ''}
                            </strong>
                          </span>
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAssign(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 cursor-pointer"
                    >
                      Assign to Me ({user.full_name})
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <select
                      value={assignModId}
                      onChange={(e) => setAssignModId(e.target.value)}
                      className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="">Select Assignee (Super Admin or Moderator)...</option>
                      {moderators
                        .filter((m) => m.status === 'Active')
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.full_name}
                            {m.assignee_role === 'super_admin' ? ' (Super Admin · Self)' : ''} ({m.current_workload}/
                            {m.max_capacity} active)
                          </option>
                        ))}
                    </select>
                    <input
                      type="datetime-local"
                      value={assignDeadline}
                      onChange={(e) => setAssignDeadline(e.target.value)}
                      className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      onClick={() => handleAssign(false)}
                      disabled={!assignModId}
                      className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-blue-700 text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
                    >
                      {ticket.assigned_moderator_id ? 'Reassign Work' : 'Assign Work'}
                    </button>
                  </div>
                </div>
              )}

              {/* 3B. Super Admin Work Review & Completion Approval */}
              {user?.role === 'super_admin' && ticket.status !== 'Completed' && (
                <div
                  className={`p-4 rounded-xl border space-y-3 ${
                    ticket.status === 'Ready for Review'
                      ? 'border-cyan-300 dark:border-cyan-800 bg-cyan-50/60 dark:bg-cyan-950/30'
                      : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/30'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-semibold text-slate-900 dark:text-white">
                        Super Admin Verification & Final Approval
                      </h4>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {ticket.status === 'Ready for Review'
                          ? 'Moderator submitted this task as Ready for Review. Approve to mark Completed or request revisions.'
                          : 'Moderators cannot mark tasks Completed directly. Approve completion or request revisions here.'}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                      placeholder="Review remarks (mandatory if requesting revision)..."
                      className="flex-1 min-w-[220px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      onClick={() => handleSuperAdminReview('approve')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Approve & Complete
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSuperAdminReview('revision')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Request Revision
                    </button>
                  </div>
                </div>
              )}

              {/* 4. Admin / Moderator Resolution & Status Update Form */}
              {(user?.role === 'super_admin' || user?.role === 'moderator') && (
                <form
                  onSubmit={handleStatusUpdate}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Update Work Status, Troubleshooting Notes & Resolution
                    </span>
                    {user.role === 'moderator' && (
                      <span className="text-[11px] text-slate-500">
                        Submit as Ready for Review for final Super Admin approval.
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Work Status</label>
                      <select
                        value={nextStatus}
                        onChange={(e) => setNextStatus(e.target.value)}
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        {getOptions('task_status')
                          .filter(
                            (s) =>
                              user.role === 'super_admin' ||
                              !['Completed', 'Closed', 'Resolved', 'Revision Required', 'New', 'Assigned'].includes(s)
                          )
                          .map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Priority {user.role !== 'super_admin' && '(Super Admin only)'}
                      </label>
                      <select
                        value={nextPriority}
                        disabled={user.role !== 'super_admin'}
                        onChange={(e) => setNextPriority(e.target.value)}
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 disabled:opacity-60"
                      >
                        {getOptions('priority').map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Linked IT Asset</label>
                      <select
                        value={linkedAssetId}
                        onChange={(e) => setLinkedAssetId(e.target.value)}
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        <option value="">None</option>
                        {assets.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.asset_tag} · {a.brand} {a.model}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Parts Replaced</label>
                      <input
                        value={partsReplaced}
                        onChange={(e) => setPartsReplaced(e.target.value)}
                        placeholder="e.g. Printhead, CAT6 cable"
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Expenses Incurred (INR ₹)</label>
                      <input
                        type="number"
                        min="0"
                        value={expensesIncurred}
                        onChange={(e) => setExpensesIncurred(e.target.value)}
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Site Visits</label>
                      <input
                        type="number"
                        min="0"
                        value={visitCount}
                        onChange={(e) => setVisitCount(e.target.value)}
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Troubleshooting Step / Status Note
                        {['On Hold', 'Pending Information', 'Revision Required'].includes(nextStatus) && (
                          <span className="text-red-600 dark:text-red-400 font-semibold ml-1">* Required</span>
                        )}
                      </label>
                      <input
                        value={troubleshootNote}
                        required={['On Hold', 'Pending Information', 'Revision Required'].includes(nextStatus)}
                        onChange={(e) => setTroubleshootNote(e.target.value)}
                        placeholder={
                          ['On Hold', 'Pending Information', 'Revision Required'].includes(nextStatus)
                            ? `Explain why task is ${nextStatus}...`
                            : 'Log diagnostic step (appended to immutable history)'
                        }
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Final Resolution Description</label>
                      <input
                        value={resolutionDesc}
                        onChange={(e) => setResolutionDesc(e.target.value)}
                        placeholder="Root cause and verified fix"
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
                    >
                      Save Update & Append Activity
                    </button>
                  </div>
                </form>
              )}

              {/* Tabs */}
              <div className="border-b border-slate-200 dark:border-slate-800 flex items-center gap-6 text-xs font-semibold overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setActiveTab('timeline')}
                  className={`py-2.5 border-b-2 whitespace-nowrap cursor-pointer ${
                    activeTab === 'timeline'
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  Activity Timeline ({activities.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('comms')}
                  className={`py-2.5 border-b-2 whitespace-nowrap cursor-pointer ${
                    activeTab === 'comms'
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  Communications ({comments.length + emails.length + whatsapp.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('attachments')}
                  className={`py-2.5 border-b-2 whitespace-nowrap cursor-pointer ${
                    activeTab === 'attachments'
                      ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  Files & Media ({attachments.length})
                </button>
                {(user?.role === 'super_admin' || user?.role === 'moderator' || user?.role === 'management') && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('time')}
                    className={`py-2.5 border-b-2 whitespace-nowrap cursor-pointer ${
                      activeTab === 'time'
                        ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                        : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                    }`}
                  >
                    Time Logs ({timeLogs.length})
                  </button>
                )}
              </div>

              {/* Tab Content */}
              {activeTab === 'timeline' && (
                <div className="space-y-3">
                  {activities.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-start justify-between gap-4 py-2.5 border-b border-slate-100 dark:border-slate-800/80 text-xs"
                    >
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {a.action_type}
                          {a.new_status && a.previous_status !== a.new_status && (
                            <span className="font-normal text-slate-500">
                              {' '}
                              · {a.previous_status || 'Start'} → {a.new_status}
                            </span>
                          )}
                        </div>
                        <p className="text-slate-600 dark:text-slate-300 mt-0.5">{a.details}</p>
                        <div className="text-[11px] text-slate-400 mt-1">
                          By {a.actor_name} ({a.actor_role})
                        </div>
                      </div>
                      <div className="font-mono text-[11px] text-slate-400 whitespace-nowrap shrink-0">
                        {formatDateTime(a.created_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'comms' && (
                <div className="space-y-4">
                  {(user?.role === 'super_admin' || user?.role === 'moderator') && (
                    <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg w-fit">
                      <button
                        type="button"
                        onClick={() => setCommChannel('portal')}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                          commChannel === 'portal' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
                        }`}
                      >
                        Portal Chat
                      </button>
                      <button
                        type="button"
                        onClick={() => setCommChannel('outlook')}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                          commChannel === 'outlook' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
                        }`}
                      >
                        Microsoft Outlook ({emails.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setCommChannel('whatsapp')}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                          commChannel === 'whatsapp' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
                        }`}
                      >
                        WhatsApp ({whatsapp.length})
                      </button>
                    </div>
                  )}

                  {commChannel === 'portal' && (
                    <div className="space-y-4">
                      <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                        {comments.length === 0 ? (
                          <div className="text-xs text-slate-500 py-4">No portal messages yet.</div>
                        ) : (
                          comments.map((c) => (
                            <div
                              key={c.id}
                              className={`p-3 rounded-lg border text-xs ${
                                c.is_internal
                                  ? 'border-amber-200 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20'
                                  : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="font-semibold">
                                  {c.sender_name} · <span className="text-slate-500 font-normal">{c.sender_role}</span>
                                  {c.is_internal === 1 && (
                                    <span className="ml-2 text-amber-700 dark:text-amber-400 font-semibold">
                                      [Internal IT Note]
                                    </span>
                                  )}
                                </span>
                                <span className="font-mono text-[11px] text-slate-400">
                                  {formatDateTime(c.created_at)}
                                </span>
                              </div>
                              <p className="text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{c.message}</p>
                            </div>
                          ))
                        )}
                      </div>

                      {user?.role !== 'management' && (
                        <form onSubmit={handleSendComment} className="space-y-2">
                          <textarea
                            rows={2}
                            value={commentText}
                            onChange={(e) => setCommentText(e.target.value)}
                            placeholder="Write a message to IT Support / Employee..."
                            className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          />
                          <div className="flex items-center justify-between">
                            {(user?.role === 'super_admin' || user?.role === 'moderator') ? (
                              <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={isInternal}
                                  onChange={(e) => setIsInternal(e.target.checked)}
                                />
                                <span>Internal IT Note (hidden from employee)</span>
                              </label>
                            ) : (
                              <span />
                            )}
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                            >
                              <Send className="w-3.5 h-3.5" />
                              <span>Send Message</span>
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  )}

                  {commChannel === 'outlook' && (
                    <div className="space-y-4">
                      <form onSubmit={handleSendEmail} className="space-y-2.5 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                        <div className="text-xs font-semibold flex items-center gap-1.5">
                          <Mail className="w-3.5 h-3.5 text-blue-600" />
                          <span>Send Outlook Email via Microsoft Graph</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          <input
                            type="email"
                            required
                            value={emailTo}
                            onChange={(e) => setEmailTo(e.target.value)}
                            placeholder="Recipient email"
                            className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          />
                          <input
                            required
                            value={emailSubject}
                            onChange={(e) => setEmailSubject(e.target.value)}
                            placeholder="Subject"
                            className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          />
                        </div>
                        <textarea
                          required
                          rows={3}
                          value={emailBody}
                          onChange={(e) => setEmailBody(e.target.value)}
                          placeholder="Compose email update..."
                          className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        <div className="flex justify-end">
                          <button
                            type="submit"
                            className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                          >
                            Send Outlook Email
                          </button>
                        </div>
                      </form>
                      <div className="space-y-2">
                        {emails.map((em) => (
                          <div key={em.id} className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs">
                            <div className="flex justify-between font-semibold">
                              <span>
                                {em.direction}: {em.subject}
                              </span>
                              <span className="font-mono text-[11px] text-slate-400">{em.status}</span>
                            </div>
                            <div className="text-slate-500 mt-0.5">
                              {em.sender_email} → {em.recipient_email} · {formatDateTime(em.created_at)}
                            </div>
                            <p className="mt-1.5 text-slate-700 dark:text-slate-300">{em.body}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {commChannel === 'whatsapp' && (
                    <div className="space-y-4">
                      <form onSubmit={handleSendWhatsApp} className="space-y-2.5 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
                        <div className="text-xs font-semibold flex items-center gap-1.5">
                          <MessageSquare className="w-3.5 h-3.5 text-emerald-600" />
                          <span>Send WhatsApp Update via Meta Cloud API</span>
                        </div>
                        <input
                          required
                          value={waPhone}
                          onChange={(e) => setWaPhone(e.target.value)}
                          placeholder="+919820511021"
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        <textarea
                          required
                          rows={2}
                          value={waBody}
                          onChange={(e) => setWaBody(e.target.value)}
                          placeholder="WhatsApp notification message..."
                          className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        <div className="flex justify-end">
                          <button
                            type="submit"
                            className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                          >
                            Send WhatsApp
                          </button>
                        </div>
                      </form>
                      <div className="space-y-2">
                        {whatsapp.map((wa) => (
                          <div key={wa.id} className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 text-xs">
                            <div className="flex justify-between font-semibold">
                              <span>
                                {wa.direction} · {wa.phone_number}
                              </span>
                              <span className="font-mono text-[11px] text-slate-400">{wa.status}</span>
                            </div>
                            <p className="mt-1 text-slate-700 dark:text-slate-300">{wa.message_body}</p>
                            <div className="font-mono text-[11px] text-slate-400 mt-1">
                              {formatDateTime(wa.created_at)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'attachments' && (
                <div className="space-y-4">
                  {user?.role !== 'management' && (
                    <div className="space-y-2.5">
                      <label className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                        <Paperclip className="w-3.5 h-3.5" />
                        <span>Upload Photo / Video / Document</span>
                        <input
                          type="file"
                          multiple
                          accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                          className="hidden"
                          onChange={(e) => {
                            handleUploadMore(e.target.files);
                            e.target.value = '';
                          }}
                        />
                      </label>

                      {(pendingUploadFiles.length > 0 || uploadingMedia || uploadError || uploadCompleted) && (
                        <UploadProgressList
                          files={pendingUploadFiles}
                          uploading={uploadingMedia}
                          progress={uploadProgress}
                          error={uploadError}
                          completed={uploadCompleted}
                          onRemoveFile={(idx) =>
                            setPendingUploadFiles((prev) => prev.filter((_, i) => i !== idx))
                          }
                          onRetry={() => performMediaUpload(pendingUploadFiles)}
                        />
                      )}
                    </div>
                  )}

                  {attachments.length === 0 ? (
                    <div className="text-xs text-slate-500 py-6">No attachments uploaded for this ticket.</div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {attachments.map((att) => {
                        const fileUrl = `/api/tickets/attachments/${att.id}/file${tokenQuery}`;
                        return (
                          <div
                            key={att.id}
                            className="border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-2"
                          >
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-semibold truncate">{att.original_name}</span>
                              <span className="text-slate-400 font-mono shrink-0">
                                {att.file_category} · {Math.max(1, Math.round((att.file_size || 0) / 1024))} KB
                              </span>
                            </div>
                            {att.file_category === 'Photo' && (
                              <img
                                src={fileUrl}
                                alt={att.original_name}
                                onClick={() =>
                                  setPreviewMedia({
                                    file_name: att.original_name,
                                    mime_type: att.mime_type,
                                    file_size: att.file_size,
                                    url: `/api/tickets/attachments/${att.id}/file`,
                                  })
                                }
                                className="w-full h-44 object-cover rounded-lg bg-slate-100 dark:bg-slate-800 cursor-pointer"
                              />
                            )}
                            {att.file_category === 'Video' && (
                              <video controls src={fileUrl} className="w-full h-44 rounded-lg bg-black" />
                            )}
                            <div className="flex items-center justify-between gap-3 pt-1">
                              <button
                                type="button"
                                onClick={() =>
                                  setPreviewMedia({
                                    file_name: att.original_name,
                                    mime_type: att.mime_type,
                                    file_size: att.file_size,
                                    url: `/api/tickets/attachments/${att.id}/file`,
                                  })
                                }
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>Preview</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadAttachment(att)}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:underline cursor-pointer"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>Download</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'time' && (
                <div className="space-y-4">
                  {(user?.role === 'super_admin' || user?.role === 'moderator') && (
                    <form
                      onSubmit={handleAddTimeLog}
                      className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end"
                    >
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Minutes Spent *</label>
                        <input
                          type="number"
                          min="1"
                          required
                          value={logMinutes}
                          onChange={(e) => setLogMinutes(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Work Type</label>
                        <select
                          value={logWorkType}
                          onChange={(e) => setLogWorkType(e.target.value)}
                          className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          <option value="Troubleshooting">Troubleshooting</option>
                          <option value="On-Site Diagnostics & Repair">On-Site Diagnostics & Repair</option>
                          <option value="Hardware Replacement">Hardware Replacement</option>
                          <option value="Remote Support">Remote Support</option>
                          <option value="Vendor Coordination">Vendor Coordination</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Work Notes</label>
                        <input
                          value={logNotes}
                          onChange={(e) => setLogNotes(e.target.value)}
                          placeholder="What was completed"
                          className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                      </div>
                      <button
                        type="submit"
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                      >
                        <Clock className="w-3.5 h-3.5" />
                        <span>Log Time</span>
                      </button>
                    </form>
                  )}

                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                        <th className="py-2">Moderator</th>
                        <th className="py-2">Work Type</th>
                        <th className="py-2">Notes</th>
                        <th className="py-2 text-right">Duration</th>
                        <th className="py-2 text-right">Logged At</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {timeLogs.map((tl) => (
                        <tr key={tl.id}>
                          <td className="py-2.5 font-medium">{tl.moderator_name}</td>
                          <td className="py-2.5">{tl.work_type}</td>
                          <td className="py-2.5 text-slate-500">{tl.notes || '—'}</td>
                          <td className="py-2.5 text-right font-mono tabular-nums">{tl.duration_minutes} mins</td>
                          <td className="py-2.5 text-right font-mono text-slate-400">
                            {formatDateTime(tl.ended_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

      <MediaPreviewModal media={previewMedia} onClose={() => setPreviewMedia(null)} />
    </div>
  );
}
