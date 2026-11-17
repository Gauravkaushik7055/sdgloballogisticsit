import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cloud,
  Database,
  Download,
  HardDrive,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
  UserCog,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { AdminPermissionPolicy, RetentionPolicyItem } from '../../types/index.ts';
import { apiFetch, fetchProtectedBlobUrl, formatDateTime } from '../../utils/api.ts';
import { formatBytesCompact } from '../common/MediaPreviewModal.tsx';
import DriveDatabaseSyncPanel from './DriveDatabaseSyncPanel.tsx';

interface ManagedAdminRow {
  user_id: number;
  email: string;
  full_name: string;
  status: 'Active' | 'Inactive';
  last_login_at?: string | null;
  mfa_enabled: boolean;
  policy: AdminPermissionPolicy;
}

const CAPABILITY_LABELS: Array<{ key: keyof AdminPermissionPolicy; label: string; desc: string }> = [
  { key: 'can_view_chats', label: 'Direct & Task Chat', desc: 'Allows messaging scoped staff and moderators.' },
  { key: 'can_monitor_chats', label: 'Chat Archive Monitoring', desc: 'Audit scoped moderator conversations (logged).' },
  { key: 'can_view_reports', label: 'Enterprise Reports', desc: 'View live reports and saved report snapshots.' },
  { key: 'can_manage_assets', label: 'IT Asset & Excel Import', desc: 'Register, edit, assign, repair, and import IT assets.' },
  { key: 'can_view_budgets', label: 'View IT Budgets & Invoices', desc: 'Inspect INR financial allocations and expenses.' },
  { key: 'can_manage_budgets', label: 'Manage Budgets & Record Expenses', desc: 'Create/edit INR budgets and upload invoices.' },
  { key: 'can_approve_expenses', label: 'Approve / Reject Expenses', desc: 'Authorized to approve or reject pending invoices.' },
  { key: 'can_export_data', label: 'Export Excel / PDF / CSV', desc: 'Allow exporting datasets to spreadsheets and PDFs.' },
  { key: 'can_manage_tickets', label: 'Ticket Assignment & Edits', desc: 'Modify/assign scoped support tickets.' },
];

const DEFAULT_POLICY: AdminPermissionPolicy = {
  allowed_location_ids: [],
  allowed_department_ids: [],
  allowed_moderator_ids: [],
  can_view_chats: true,
  can_monitor_chats: false,
  can_view_reports: true,
  can_manage_assets: false,
  can_view_budgets: false,
  can_manage_budgets: false,
  can_approve_expenses: false,
  can_export_data: true,
  can_manage_tickets: true,
};

type SecurityTab = 'dashboard' | 'backups' | 'drive' | 'activity' | 'permissions' | 'retention';

export default function AuditSessionsView() {
  const { user, subscribeRealtime } = useAuth();
  const [activeTab, setActiveTab] = useState<SecurityTab>('dashboard');

  // Tab 1: Super Admin Security Dashboard
  const [secDash, setSecDash] = useState<any>(null);
  const [secLoading, setSecLoading] = useState(false);
  const [secMsg, setSecMsg] = useState('');
  const [secErr, setSecErr] = useState('');
  const [idleTimeoutDraft, setIdleTimeoutDraft] = useState<number>(60);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [terminatingSessionId, setTerminatingSessionId] = useState<number | null>(null);

  // Tab 2: Backups & Restore
  const [backups, setBackups] = useState<any[]>([]);
  const [runningBackup, setRunningBackup] = useState(false);
  const [verifyingBackupId, setVerifyingBackupId] = useState<number | null>(null);
  const [downloadingBackupId, setDownloadingBackupId] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<any | null>(null);
  const [restoreConfirmText, setRestoreConfirmText] = useState('');
  const [restoringBackup, setRestoringBackup] = useState(false);

  // Tab 3: Activity Monitor & Sessions
  const [monitorUserId, setMonitorUserId] = useState<string>('All');
  const [monitorRole, setMonitorRole] = useState<string>('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [monitorData, setMonitorData] = useState<{
    staff: any[];
    auditLogs: any[];
    ticketActivities: any[];
    assetHistory: any[];
    sessions: any[];
  }>({ staff: [], auditLogs: [], ticketActivities: [], assetHistory: [], sessions: [] });
  const [allAuditLogs, setAllAuditLogs] = useState<any[]>([]);
  const [allEntityFilter, setAllEntityFilter] = useState<string>('All');

  // Tab 4: Admin Scopes & Permissions
  const [admins, setAdmins] = useState<ManagedAdminRow[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [moderators, setModerators] = useState<any[]>([]);
  const [draftPolicies, setDraftPolicies] = useState<Record<number, AdminPermissionPolicy & { status: 'Active' | 'Inactive' }>>({});
  const [savingAdminId, setSavingAdminId] = useState<number | null>(null);
  const [permMessage, setPermMessage] = useState('');
  const [permError, setPermError] = useState('');
  const [createAdminModal, setCreateAdminModal] = useState(false);
  const [newAdminName, setNewAdminName] = useState('');
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [creatingAdmin, setCreatingAdmin] = useState(false);

  // Tab 5: Data Archival & Media Audit
  const [retentionPolicies, setRetentionPolicies] = useState<RetentionPolicyItem[]>([]);
  const [retentionCounts, setRetentionCounts] = useState<Record<string, number>>({});
  const [mediaAudit, setMediaAudit] = useState<{
    diskFileCount: number;
    diskBytes: number;
    ticketFiles: any[];
    chatFiles: any[];
  } | null>(null);
  const [savingRetention, setSavingRetention] = useState(false);
  const [archiveConfirmText, setArchiveConfirmText] = useState('');
  const [archiving, setArchiving] = useState(false);
  const [retentionMsg, setRetentionMsg] = useState('');
  const [retentionErr, setRetentionErr] = useState('');
  const [downloadingBackup, setDownloadingBackup] = useState<'sqlite' | 'json' | null>(null);

  const loadSecurityDashboard = useCallback(async () => {
    setSecLoading(true);
    try {
      const res = await apiFetch<any>('/api/auth/security/dashboard');
      setSecDash(res);
      if (res?.sessions?.idleTimeoutMinutes) {
        setIdleTimeoutDraft(Number(res.sessions.idleTimeoutMinutes));
      }
    } catch (err: any) {
      setSecErr(err.message || 'Unable to load security telemetry');
    } finally {
      setSecLoading(false);
    }
  }, []);

  const loadBackups = useCallback(async () => {
    try {
      const res = await apiFetch<{ backups: any[] }>('/api/auth/backups');
      setBackups(res.backups || []);
    } catch (err: any) {
      setSecErr(err.message || 'Unable to load backups');
    }
  }, []);

  const loadActivityMonitor = useCallback(async () => {
    const monParams = new URLSearchParams();
    if (monitorUserId !== 'All') monParams.set('user_id', monitorUserId);
    if (monitorRole !== 'All') monParams.set('role_name', monitorRole);
    if (dateFrom) monParams.set('date_from', dateFrom);
    if (dateTo) monParams.set('date_to', dateTo);
    if (search.trim()) monParams.set('search', search.trim());

    const logParams = new URLSearchParams({ limit: '250' });
    if (monitorUserId !== 'All') logParams.set('user_id', monitorUserId);
    if (monitorRole !== 'All') logParams.set('role_name', monitorRole);
    if (allEntityFilter !== 'All') logParams.set('entity_type', allEntityFilter);
    if (dateFrom) logParams.set('date_from', dateFrom);
    if (dateTo) logParams.set('date_to', dateTo);
    if (search.trim()) logParams.set('search', search.trim());

    try {
      const [monRes, allLogRes] = await Promise.all([
        apiFetch<any>(`/api/auth/activity-monitor?${monParams.toString()}`),
        apiFetch<{ logs: any[] }>(`/api/auth/audit-logs?${logParams.toString()}`),
      ]);
      setMonitorData({
        staff: monRes.staff || [],
        auditLogs: monRes.auditLogs || [],
        ticketActivities: monRes.ticketActivities || [],
        assetHistory: monRes.assetHistory || [],
        sessions: monRes.sessions || [],
      });
      setAllAuditLogs(allLogRes.logs || []);
    } catch {
      // handled by auth layer
    }
  }, [monitorUserId, monitorRole, allEntityFilter, dateFrom, dateTo, search]);

  const loadPermissions = useCallback(async () => {
    try {
      const res = await apiFetch<{
        admins: ManagedAdminRow[];
        locations: any[];
        departments: any[];
        moderators: any[];
      }>('/api/auth/admin-permissions');
      setAdmins(res.admins || []);
      setLocations(res.locations || []);
      setDepartments(res.departments || []);
      setModerators(res.moderators || []);
      const drafts: Record<number, AdminPermissionPolicy & { status: 'Active' | 'Inactive' }> = {};
      for (const a of res.admins || []) {
        drafts[a.user_id] = { ...a.policy, status: a.status };
      }
      setDraftPolicies(drafts);
    } catch (err: any) {
      setPermError(err.message || 'Unable to load Admin permission policies');
    }
  }, []);

  const loadSecurityRetention = useCallback(async () => {
    try {
      const [rRes, mRes] = await Promise.all([
        apiFetch<{ policies: RetentionPolicyItem[]; counts: Record<string, number> }>('/api/auth/security/retention'),
        apiFetch<any>('/api/auth/security/media-audit'),
      ]);
      setRetentionPolicies(rRes.policies || []);
      setRetentionCounts(rRes.counts || {});
      setMediaAudit(mRes);
    } catch (err: any) {
      setRetentionErr(err.message || 'Failed to load retention & media audit telemetry');
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'dashboard') loadSecurityDashboard();
    else if (activeTab === 'backups') loadBackups();
    else if (activeTab === 'activity') loadActivityMonitor();
    else if (activeTab === 'permissions') loadPermissions();
    else if (activeTab === 'retention') loadSecurityRetention();
  }, [activeTab, loadSecurityDashboard, loadBackups, loadActivityMonitor, loadPermissions, loadSecurityRetention]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'backup:updated' || evt.event === 'session:terminated' || evt.event === 'system:restored') {
        if (activeTab === 'dashboard') loadSecurityDashboard();
        if (activeTab === 'backups') loadBackups();
        if (activeTab === 'activity') loadActivityMonitor();
      }
    });
  }, [activeTab, subscribeRealtime, loadSecurityDashboard, loadBackups, loadActivityMonitor]);

  const handleSaveSessionPolicy = async () => {
    setSavingPolicy(true);
    setSecErr('');
    setSecMsg('');
    try {
      const saved = await apiFetch<{ idleTimeoutMinutes: number }>('/api/auth/security/session-policy', {
        method: 'PUT',
        body: JSON.stringify({ idleTimeoutMinutes: idleTimeoutDraft }),
      });
      setIdleTimeoutDraft(saved.idleTimeoutMinutes);
      setSecMsg(`Session inactivity auto-expiry updated to ${saved.idleTimeoutMinutes} minutes.`);
      loadSecurityDashboard();
    } catch (err: any) {
      setSecErr(err.message || 'Failed to update session policy');
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleTerminateSession = async (sessionId: number, label: string) => {
    setTerminatingSessionId(sessionId);
    setSecErr('');
    setSecMsg('');
    try {
      await apiFetch(`/api/auth/sessions/${sessionId}/terminate`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Terminated by Super Admin from Security Center' }),
      });
      setSecMsg(`Session #${sessionId} (${label}) terminated immediately.`);
      loadSecurityDashboard();
      if (activeTab === 'activity') loadActivityMonitor();
    } catch (err: any) {
      setSecErr(err.message || 'Failed to terminate session');
    } finally {
      setTerminatingSessionId(null);
    }
  };

  const handleRunBackupNow = async () => {
    setRunningBackup(true);
    setSecErr('');
    setSecMsg('');
    try {
      const res = await apiFetch<{ backup: any }>('/api/auth/backups/run', { method: 'POST' });
      setSecMsg(
        `Backup ${res.backup?.filename || ''} completed and verified (${res.backup?.email_status || 'Logged'}).`
      );
      loadSecurityDashboard();
      loadBackups();
    } catch (err: any) {
      setSecErr(err.message || 'Manual backup failed');
    } finally {
      setRunningBackup(false);
    }
  };

  const handleVerifyBackup = async (backupId: number) => {
    setVerifyingBackupId(backupId);
    setSecErr('');
    setSecMsg('');
    try {
      const res = await apiFetch<{ backup: any; verification: any }>(`/api/auth/backups/${backupId}/verify`, {
        method: 'POST',
      });
      setSecMsg(
        `Backup ${res.backup?.filename} integrity: ${res.verification?.valid ? 'Verified (OK)' : res.verification?.error || 'Corrupted'}`
      );
      loadBackups();
    } catch (err: any) {
      setSecErr(err.message || 'Verification failed');
    } finally {
      setVerifyingBackupId(null);
    }
  };

  const handleDownloadStoredBackup = async (backup: any) => {
    setDownloadingBackupId(backup.id);
    setSecErr('');
    try {
      const blobUrl = await fetchProtectedBlobUrl(`/api/auth/backups/${backup.id}/download`);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = backup.filename || `sdglobal-crm-backup-${backup.id}.db`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 20000);
    } catch (err: any) {
      setSecErr(err.message || 'Failed to download backup file');
    } finally {
      setDownloadingBackupId(null);
    }
  };

  const handleConfirmRestore = async () => {
    if (!restoreTarget || restoreConfirmText !== 'CONFIRM_DATABASE_RESTORE') return;
    setRestoringBackup(true);
    setSecErr('');
    setSecMsg('');
    try {
      const res = await apiFetch<{ restoredFrom: string; preRestoreFilename: string }>(
        `/api/auth/backups/${restoreTarget.id}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({ confirm: 'CONFIRM_DATABASE_RESTORE' }),
        }
      );
      setRestoreTarget(null);
      setRestoreConfirmText('');
      setSecMsg(
        `Database restored cleanly from ${res.restoredFrom}. Automatic pre-restore safety snapshot saved as ${res.preRestoreFilename}.`
      );
      loadBackups();
      loadSecurityDashboard();
    } catch (err: any) {
      setSecErr(err.message || 'Database restore failed');
    } finally {
      setRestoringBackup(false);
    }
  };

  const toggleScopeId = (
    userId: number,
    field: 'allowed_location_ids' | 'allowed_department_ids' | 'allowed_moderator_ids',
    id: number
  ) => {
    setDraftPolicies((prev) => {
      const cur = prev[userId];
      if (!cur) return prev;
      const arr = cur[field] || [];
      const next = arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
      return { ...prev, [userId]: { ...cur, [field]: next } };
    });
  };

  const handleSaveAdminPolicy = async (userId: number) => {
    const policy = draftPolicies[userId];
    if (!policy) return;
    setSavingAdminId(userId);
    setPermMessage('');
    setPermError('');
    try {
      await apiFetch(`/api/auth/admin-permissions/${userId}`, {
        method: 'PUT',
        body: JSON.stringify(policy),
      });
      setPermMessage('Admin scopes and permission matrix updated cleanly.');
      loadPermissions();
    } catch (err: any) {
      setPermError(err.message || 'Failed to update permissions');
    } finally {
      setSavingAdminId(null);
    }
  };

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingAdmin(true);
    setPermError('');
    setPermMessage('');
    try {
      await apiFetch('/api/auth/admin-accounts', {
        method: 'POST',
        body: JSON.stringify({
          full_name: newAdminName,
          email: newAdminEmail,
          password: newAdminPassword,
          policy: DEFAULT_POLICY,
        }),
      });
      setCreateAdminModal(false);
      setNewAdminName('');
      setNewAdminEmail('');
      setNewAdminPassword('');
      setPermMessage('New scoped Admin account created. Configure scopes & capabilities below.');
      loadPermissions();
    } catch (err: any) {
      setPermError(err.message || 'Failed to create Admin account');
    } finally {
      setCreatingAdmin(false);
    }
  };

  const handleSaveRetention = async () => {
    setSavingRetention(true);
    setRetentionMsg('');
    setRetentionErr('');
    try {
      const res = await apiFetch<{ policies: RetentionPolicyItem[] }>('/api/auth/security/retention', {
        method: 'PUT',
        body: JSON.stringify({
          policies: retentionPolicies.map((p) => ({
            entity_key: p.entity_key,
            retention_days: p.retention_days,
            auto_archive: Boolean(p.auto_archive),
          })),
        }),
      });
      setRetentionPolicies(res.policies || []);
      setRetentionMsg('Retention & archival policies saved.');
    } catch (err: any) {
      setRetentionErr(err.message || 'Failed to save retention policies');
    } finally {
      setSavingRetention(false);
    }
  };

  const handleExecuteArchive = async () => {
    if (archiveConfirmText !== 'CONFIRM_RETENTION_ARCHIVE') return;
    setArchiving(true);
    setRetentionMsg('');
    setRetentionErr('');
    try {
      const res = await apiFetch<{ archivedChats: number; archivedReports: number; note: string }>(
        '/api/auth/security/retention/purge',
        {
          method: 'POST',
          body: JSON.stringify({ confirm: 'CONFIRM_RETENTION_ARCHIVE' }),
        }
      );
      setArchiveConfirmText('');
      setRetentionMsg(
        `Archival complete: archived ${res.archivedChats ?? 0} chat message(s) and ${res.archivedReports ?? 0} saved report(s). ${res.note}`
      );
      loadSecurityRetention();
    } catch (err: any) {
      setRetentionErr(err.message || 'Archival execution failed');
    } finally {
      setArchiving(false);
    }
  };

  const handleDownloadBackup = async (format: 'sqlite' | 'json') => {
    setDownloadingBackup(format);
    setRetentionErr('');
    try {
      const blobUrl = await fetchProtectedBlobUrl(`/api/auth/security/backup?format=${format}`);
      const a = document.createElement('a');
      a.href = blobUrl;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = format === 'sqlite' ? `sdglobal-it-crm-${stamp}.db` : `sdglobal-it-crm-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 20000);
    } catch (err: any) {
      setRetentionErr(err.message || 'Backup download failed');
    } finally {
      setDownloadingBackup(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Security Center Navigation Header */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Shield className="w-5 h-5 text-blue-600 shrink-0" />
          <div>
            <h2 className="text-sm font-display font-bold text-slate-900 dark:text-white">
              Super Admin Security, Backup & Activity Protection Center
            </h2>
            <p className="text-xs text-slate-500">
              Daily verified backups, permanent CRM data protection triggers, active session control, and Admin/Moderator accountability.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
          <button
            type="button"
            onClick={() => setActiveTab('dashboard')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'dashboard'
                ? 'bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            Security Dashboard
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('backups')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'backups'
                ? 'bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            Backups & Restore
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('drive')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'drive'
                ? 'bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <Cloud className="w-3.5 h-3.5" />
            Drive & Laptop DB Sync
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('activity')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'activity'
                ? 'bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            Activity Monitor & Sessions
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('permissions')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'permissions'
                ? 'bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <UserCog className="w-3.5 h-3.5" />
            Admin Scopes
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('retention')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap shrink-0 ${
              activeTab === 'retention'
                ? 'bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-400 shadow-xs'
                : 'text-slate-600 dark:text-slate-300'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            Archival & Media Audit
          </button>
        </div>
      </div>

      {secErr && (
        <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
          <span>{secErr}</span>
          <button type="button" onClick={() => setSecErr('')} className="underline cursor-pointer shrink-0">
            Dismiss
          </button>
        </div>
      )}
      {secMsg && (
        <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between gap-2">
          <span>{secMsg}</span>
          <button type="button" onClick={() => setSecMsg('')} className="underline cursor-pointer shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {/* TAB 1: SUPER ADMIN SECURITY DASHBOARD */}
      {activeTab === 'dashboard' && (
        <div className="space-y-5">
          {/* Quick Status & Immutability Strip */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                <Lock className="w-3.5 h-3.5" />
                Permanent Protection Active: Tickets, Chats, Asset History & Audit Logs are SQLite trigger-protected against deletion
              </span>
              <span className="text-slate-400 hidden sm:inline">·</span>
              <span className="text-slate-500">AES-256-GCM Secret Encryption & Source Path Blocking Enabled</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={runningBackup}
                onClick={handleRunBackupNow}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Database className="w-3.5 h-3.5" />
                {runningBackup ? 'Running Backup...' : 'Run Backup Now'}
              </button>
              <button
                type="button"
                disabled={secLoading}
                onClick={loadSecurityDashboard}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${secLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          {secDash && (
            <>
              {/* Top Telemetry KPI Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
                <button
                  type="button"
                  onClick={() => setActiveTab('backups')}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 text-left hover:border-blue-500 transition-colors cursor-pointer"
                >
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Last Backup</div>
                  <div
                    className={`mt-1 text-base font-display font-bold ${
                      secDash.lastBackup?.integrity_status === 'Verified'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : secDash.lastBackup?.status === 'Failed'
                        ? 'text-red-600'
                        : 'text-amber-600'
                    }`}
                  >
                    {secDash.lastBackup ? secDash.lastBackup.integrity_status : 'Scheduled'}
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-slate-500 truncate">
                    {secDash.lastBackup ? formatDateTime(secDash.lastBackup.created_at) : 'Waiting initial run'}
                  </div>
                </button>

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Saved Tickets</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                    {secDash.records.ticketsTotal}
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-slate-500 tabular-nums">
                    {secDash.records.ticketsActive} active · {secDash.records.ticketsArchived} archived
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Customer & CRM Chats</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                    {secDash.records.chatsTotal + secDash.records.ticketCommentsTotal}
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-slate-500 tabular-nums">
                    {secDash.records.conversationsTotal} threads · {secDash.records.ticketCommentsTotal} ticket notes
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">CRM History Records</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                    {secDash.records.crmHistoryTotal}
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-slate-500 tabular-nums">
                    {secDash.records.auditLogsTotal} audit · {secDash.records.assetHistoryTotal} asset logs
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setActiveTab('activity')}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 text-left hover:border-blue-500 transition-colors cursor-pointer"
                >
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Admins & Moderators</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                    {secDash.team.adminsCount + secDash.team.moderatorsCount}
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-slate-500 tabular-nums">
                    {secDash.team.activeAdminsCount} admins · {secDash.team.activeModeratorsCount} mods active
                  </div>
                </button>

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Active Sessions & Alerts</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                    {secDash.sessions.activeCount}
                    <span className="text-sm font-normal text-slate-400"> / {secDash.securityAlerts.length} alerts</span>
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-slate-500 tabular-nums">
                    Auto-expire idle: {secDash.sessions.idleTimeoutMinutes}m
                  </div>
                </div>
              </div>

              {/* Active Sessions + Idle Session Timeout Policy */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-display font-bold">
                      Live Active Sessions ({secDash.sessions.activeSessions.length})
                    </h3>
                    <p className="text-xs text-slate-500">
                      Terminate compromised or idle sessions immediately. Users are disconnected over HTTP & WebSocket on the spot.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    <span className="text-slate-500">Idle Timeout:</span>
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      value={idleTimeoutDraft}
                      onChange={(e) => setIdleTimeoutDraft(Number(e.target.value) || 60)}
                      className="w-20 px-2 py-1 text-xs font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <span className="text-slate-500">mins</span>
                    <button
                      type="button"
                      disabled={savingPolicy}
                      onClick={handleSaveSessionPolicy}
                      className="px-3 py-1 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-blue-700 text-white hover:opacity-90 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                    >
                      {savingPolicy ? 'Saving...' : 'Save Policy'}
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto max-h-72 overflow-y-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                        <th className="py-2.5 px-4">User</th>
                        <th className="py-2.5 px-4">Role</th>
                        <th className="py-2.5 px-4">Login Time</th>
                        <th className="py-2.5 px-4">Last Activity</th>
                        <th className="py-2.5 px-4 text-right">Duration</th>
                        <th className="py-2.5 px-4">IP Address</th>
                        <th className="py-2.5 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {secDash.sessions.activeSessions.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-6 text-center text-slate-500">
                            No active sessions found.
                          </td>
                        </tr>
                      ) : (
                        secDash.sessions.activeSessions.map((s: any) => {
                          const isCurrent = s.id === user?.session_id;
                          return (
                            <tr key={s.id}>
                              <td className="py-2.5 px-4 font-medium">
                                {s.full_name} · <span className="text-slate-500 font-mono">{s.email}</span>
                              </td>
                              <td className="py-2.5 px-4 capitalize">{s.role_name?.replace('_', ' ')}</td>
                              <td className="py-2.5 px-4 font-mono tabular-nums">{formatDateTime(s.login_at)}</td>
                              <td className="py-2.5 px-4 font-mono tabular-nums">
                                {formatDateTime(s.last_activity_at || s.login_at)}
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono tabular-nums">{s.duration_minutes ?? 0}m</td>
                              <td className="py-2.5 px-4 font-mono text-slate-500">{s.ip_address}</td>
                              <td className="py-2.5 px-4 text-right">
                                {isCurrent ? (
                                  <span className="text-[11px] font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                                    Current Session
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={terminatingSessionId === s.id}
                                    onClick={() => handleTerminateSession(s.id, s.email)}
                                    className="px-2.5 py-1 text-[11px] font-semibold rounded border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                                  >
                                    {terminatingSessionId === s.id ? 'Ending...' : 'Terminate'}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Split Feeds: Recent Admin/Moderator Activities & Asset History */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <h3 className="text-sm font-display font-bold">Recent Admin & Moderator Activity</h3>
                    <button
                      type="button"
                      onClick={() => setActiveTab('activity')}
                      className="text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
                    >
                      Inspect Full Monitor
                    </button>
                  </div>
                  <div className="overflow-x-auto max-h-72 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                          <th className="py-2 px-4">Time</th>
                          <th className="py-2 px-4">Actor</th>
                          <th className="py-2 px-4">Action</th>
                          <th className="py-2 px-4">Target</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {secDash.recentAdminModActivities.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-slate-500">
                              No Admin or Moderator actions logged yet.
                            </td>
                          </tr>
                        ) : (
                          secDash.recentAdminModActivities.map((a: any) => (
                            <tr key={a.id}>
                              <td className="py-2 px-4 font-mono text-slate-500 whitespace-nowrap">
                                {formatDateTime(a.created_at)}
                              </td>
                              <td className="py-2 px-4">
                                <span className="font-medium">{a.user_full_name || a.user_email}</span>
                                <span className="text-slate-400"> · {a.role_name}</span>
                              </td>
                              <td className="py-2 px-4 font-mono text-blue-700 dark:text-blue-400">{a.action}</td>
                              <td className="py-2 px-4 font-mono text-slate-500">
                                {a.entity_type} {a.entity_id ? `#${a.entity_id}` : ''}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                    <h3 className="text-sm font-display font-bold">Immutable IT Asset Inventory History</h3>
                  </div>
                  <div className="overflow-x-auto max-h-72 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                          <th className="py-2 px-4">Time</th>
                          <th className="py-2 px-4">Asset</th>
                          <th className="py-2 px-4">Event</th>
                          <th className="py-2 px-4">Actor</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {secDash.recentAssetChanges.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-slate-500">
                              No asset lifecycle changes recorded yet.
                            </td>
                          </tr>
                        ) : (
                          secDash.recentAssetChanges.map((ah: any) => (
                            <tr key={ah.id}>
                              <td className="py-2 px-4 font-mono text-slate-500 whitespace-nowrap">
                                {formatDateTime(ah.created_at)}
                              </td>
                              <td className="py-2 px-4">
                                <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                                  {ah.asset_tag}
                                </span>
                                <span className="text-slate-500"> · {ah.device_name}</span>
                              </td>
                              <td className="py-2 px-4">
                                <span className="font-semibold">{ah.event_type}</span>
                                {ah.new_value && (
                                  <span className="text-slate-500">
                                    {' '}
                                    ({ah.previous_value ? `${ah.previous_value} → ` : ''}
                                    {ah.new_value})
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-4 text-slate-600 dark:text-slate-300">{ah.actor_name}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Security Alerts */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <h3 className="text-sm font-display font-bold">
                    Security Alerts, Failed Logins & Unauthorized Access Attempts ({secDash.securityAlerts.length})
                  </h3>
                </div>
                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                        <th className="py-2 px-4">Timestamp</th>
                        <th className="py-2 px-4">Alert Event</th>
                        <th className="py-2 px-4">Principal / Email</th>
                        <th className="py-2 px-4">Target</th>
                        <th className="py-2 px-4">IP / Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {secDash.securityAlerts.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-emerald-600 font-medium">
                            Zero security violations or failed login alerts recorded.
                          </td>
                        </tr>
                      ) : (
                        secDash.securityAlerts.map((al: any) => (
                          <tr key={al.id}>
                            <td className="py-2 px-4 font-mono text-slate-500 whitespace-nowrap">
                              {formatDateTime(al.created_at)}
                            </td>
                            <td className="py-2 px-4 font-mono font-semibold text-red-600 dark:text-red-400">
                              {al.action}
                            </td>
                            <td className="py-2 px-4">{al.user_full_name || al.user_email || 'Anonymous'}</td>
                            <td className="py-2 px-4 font-mono">
                              {al.entity_type} {al.entity_id ? `#${al.entity_id}` : ''}
                            </td>
                            <td className="py-2 px-4 font-mono text-slate-500 max-w-md break-all">
                              {al.ip_address || 'unknown'} · {al.details_json || '—'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 2: AUTOMATIC DAILY BACKUPS & RESTORE */}
      {activeTab === 'backups' && (
        <div className="space-y-5">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-display font-bold">Automatic Daily CRM Backups & Point-in-Time Restore</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Versioned SQLite snapshots are stored in protected server storage (never overwritten), verified with SHA-256 & PRAGMA integrity_check, and emailed to the Super Admin after every backup.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={runningBackup}
                onClick={handleRunBackupNow}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Database className="w-3.5 h-3.5" />
                {runningBackup ? 'Creating Verified Backup...' : 'Run Full Backup Now'}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('drive')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Cloud className="w-3.5 h-3.5" />
                Google Drive & Laptop DB Sync
              </button>
              <button
                type="button"
                onClick={loadBackups}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h4 className="text-sm font-display font-bold">Versioned Protected Backup Archive ({backups.length})</h4>
              <span className="text-[11px] text-slate-500">Strictly accessible to Super Admin ONLY</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                    <th className="py-2.5 px-4">Snapshot File</th>
                    <th className="py-2.5 px-4">Type</th>
                    <th className="py-2.5 px-4">Created At</th>
                    <th className="py-2.5 px-4 text-right">Size</th>
                    <th className="py-2.5 px-4">SHA-256 Checksum</th>
                    <th className="py-2.5 px-4">Integrity</th>
                    <th className="py-2.5 px-4">Email Alert</th>
                    <th className="py-2.5 px-4">Records</th>
                    <th className="py-2.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {backups.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-slate-500">
                        No backup snapshots recorded yet. Click "Run Full Backup Now" to capture the initial verified snapshot.
                      </td>
                    </tr>
                  ) : (
                    backups.map((b) => (
                      <tr key={b.id}>
                        <td className="py-2.5 px-4 font-mono font-semibold text-slate-900 dark:text-slate-100">
                          {b.filename}
                        </td>
                        <td className="py-2.5 px-4 uppercase font-mono text-[11px] text-slate-500">{b.backup_type}</td>
                        <td className="py-2.5 px-4 font-mono tabular-nums whitespace-nowrap">
                          {formatDateTime(b.created_at)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          {formatBytesCompact(b.file_size_bytes || 0)}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-500" title={b.checksum_sha256}>
                          {b.checksum_sha256 ? b.checksum_sha256.slice(0, 12) : '—'}
                        </td>
                        <td className="py-2.5 px-4 font-semibold">
                          <span
                            className={
                              b.integrity_status === 'Verified'
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : b.integrity_status === 'Corrupted' || b.status === 'Failed'
                                ? 'text-red-600'
                                : 'text-amber-600'
                            }
                          >
                            {b.integrity_status}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-[11px] font-mono text-slate-500">{b.email_status || '—'}</td>
                        <td className="py-2.5 px-4 text-[11px] font-mono tabular-nums text-slate-500">
                          {b.record_counts && b.record_counts.tickets !== undefined
                            ? `${b.record_counts.tickets}T · ${b.record_counts.chats}C · ${b.record_counts.it_assets}A`
                            : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {b.status === 'Completed' && b.file_exists && (
                              <>
                                <button
                                  type="button"
                                  disabled={verifyingBackupId === b.id}
                                  onClick={() => handleVerifyBackup(b.id)}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                                >
                                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                  {verifyingBackupId === b.id ? 'Checking...' : 'Verify'}
                                </button>
                                <button
                                  type="button"
                                  disabled={downloadingBackupId === b.id}
                                  onClick={() => handleDownloadStoredBackup(b)}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                                >
                                  <Download className="w-3 h-3" />
                                  {downloadingBackupId === b.id ? '...' : 'Save'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRestoreTarget(b);
                                    setRestoreConfirmText('');
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded border border-amber-400 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 cursor-pointer whitespace-nowrap"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  Restore
                                </button>
                              </>
                            )}
                          </div>
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

      {/* TAB 2B: GOOGLE DRIVE 1s AUTO-SYNC & LAPTOP DATABASE ATTACHMENT */}
      {activeTab === 'drive' && <DriveDatabaseSyncPanel />}

      {/* TAB 3: ACTIVITY MONITOR & SESSIONS */}
      {activeTab === 'activity' && (
        <div className="space-y-5">
          {/* Filter Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                <Lock className="w-3.5 h-3.5" />
                <span>Append-only triggers enforced — Admins & Moderators cannot alter or delete their activity history.</span>
              </div>
              <button
                type="button"
                onClick={loadActivityMonitor}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
              <select
                value={monitorUserId}
                onChange={(e) => setMonitorUserId(e.target.value)}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="All">All Admins & Moderators</option>
                {monitorData.staff.map((st) => (
                  <option key={st.user_id} value={String(st.user_id)}>
                    {st.full_name} ({st.role_name === 'management' ? 'Admin' : 'Moderator'})
                  </option>
                ))}
              </select>

              <select
                value={monitorRole}
                onChange={(e) => {
                  setMonitorRole(e.target.value);
                  setMonitorUserId('All');
                }}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="All">Role: Admins & Moderators</option>
                <option value="management">Admins Only</option>
                <option value="moderator">Moderators Only</option>
                <option value="super_admin">Super Admin (Audit Log)</option>
                <option value="employee">Employees (Audit Log)</option>
              </select>

              <select
                value={allEntityFilter}
                onChange={(e) => setAllEntityFilter(e.target.value)}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="All">All Entity Types</option>
                <option value="ticket">Tickets</option>
                <option value="direct_message">Chats</option>
                <option value="asset">IT Assets</option>
                <option value="budget">IT Budgets</option>
                <option value="expense">Expenses</option>
                <option value="session">Sessions</option>
                <option value="database">Backups & Restore</option>
              </select>

              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                aria-label="Date from"
                className="px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                aria-label="Date to"
                className="px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Action, ticket, email..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
          </div>

          {/* Admin & Moderator Accountability Matrix */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-display font-bold">
                Admin & Moderator Accountability Summary ({monitorData.staff.length})
              </h3>
              <span className="text-[11px] text-slate-500">Click any person row to filter activity feeds below</span>
            </div>
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                    <th className="py-2 px-4">Staff Member</th>
                    <th className="py-2 px-4">Role</th>
                    <th className="py-2 px-4 text-right">Sessions</th>
                    <th className="py-2 px-4 text-right">Audit Actions</th>
                    <th className="py-2 px-4 text-right">Ticket Actions</th>
                    <th className="py-2 px-4 text-right">Completed</th>
                    <th className="py-2 px-4 text-right">Chats Sent</th>
                    <th className="py-2 px-4 text-right">Asset Edits</th>
                    <th className="py-2 px-4">Last Activity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {monitorData.staff.map((st) => {
                    const selected = monitorUserId === String(st.user_id);
                    return (
                      <tr
                        key={st.user_id}
                        onClick={() => setMonitorUserId(selected ? 'All' : String(st.user_id))}
                        className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                          selected ? 'bg-blue-50/70 dark:bg-blue-950/30' : ''
                        }`}
                      >
                        <td className="py-2 px-4 font-medium">
                          {st.full_name} · <span className="font-mono text-slate-500">{st.email}</span>
                        </td>
                        <td className="py-2 px-4">{st.role_name === 'management' ? 'Operations Admin' : 'IT Moderator'}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">
                          {st.active_sessions_count > 0 ? (
                            <span className="text-emerald-600 font-semibold">{st.active_sessions_count} live</span>
                          ) : (
                            '0 live'
                          )}{' '}
                          / {st.sessions_count}
                        </td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">{st.audit_actions_count}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">{st.ticket_actions_count}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">{st.completed_tasks_count}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">{st.chat_messages_count}</td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums">{st.asset_changes_count}</td>
                        <td className="py-2 px-4 font-mono text-slate-500 whitespace-nowrap">
                          {formatDateTime(st.last_activity_at || st.last_login_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Ticket Actions & Asset Changes Feeds */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                <h3 className="text-sm font-display font-bold">
                  Handled Tickets & Work Updates ({monitorData.ticketActivities.length})
                </h3>
              </div>
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                      <th className="py-2 px-4">Time</th>
                      <th className="py-2 px-4">Actor</th>
                      <th className="py-2 px-4">Ticket</th>
                      <th className="py-2 px-4">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {monitorData.ticketActivities.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-slate-500">
                          No ticket actions match this filter.
                        </td>
                      </tr>
                    ) : (
                      monitorData.ticketActivities.map((ta) => (
                        <tr key={ta.id}>
                          <td className="py-2 px-4 font-mono text-slate-500 whitespace-nowrap">
                            {formatDateTime(ta.created_at)}
                          </td>
                          <td className="py-2 px-4 font-medium">{ta.actor_name}</td>
                          <td className="py-2 px-4 font-mono text-blue-700 dark:text-blue-400">{ta.ticket_number}</td>
                          <td className="py-2 px-4">
                            <span className="font-semibold">{ta.action_type}</span>
                            <div className="text-[11px] text-slate-500 truncate max-w-xs">{ta.details}</div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                <h3 className="text-sm font-display font-bold">
                  Login & Session Accountability ({monitorData.sessions.length})
                </h3>
              </div>
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                      <th className="py-2 px-4">User</th>
                      <th className="py-2 px-4">Login</th>
                      <th className="py-2 px-4">Duration</th>
                      <th className="py-2 px-4">State</th>
                      <th className="py-2 px-4 text-right">Control</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {monitorData.sessions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-slate-500">
                          No login sessions recorded for this filter.
                        </td>
                      </tr>
                    ) : (
                      monitorData.sessions.map((s) => (
                        <tr key={s.id}>
                          <td className="py-2 px-4">
                            <div className="font-medium">{s.full_name}</div>
                            <div className="font-mono text-[11px] text-slate-500">{s.ip_address}</div>
                          </td>
                          <td className="py-2 px-4 font-mono whitespace-nowrap">{formatDateTime(s.login_at)}</td>
                          <td className="py-2 px-4 font-mono tabular-nums">{s.duration_minutes ?? 0}m</td>
                          <td className="py-2 px-4">
                            {s.is_active ? (
                              <span className="text-emerald-600 font-semibold">Active</span>
                            ) : (
                              <span className="text-slate-500">{s.termination_reason || 'Ended'}</span>
                            )}
                          </td>
                          <td className="py-2 px-4 text-right">
                            {s.is_active && s.id !== user?.session_id ? (
                              <button
                                type="button"
                                disabled={terminatingSessionId === s.id}
                                onClick={() => handleTerminateSession(s.id, s.email)}
                                className="px-2 py-1 text-[11px] font-semibold rounded border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                              >
                                Terminate
                              </button>
                            ) : (
                              <span className="text-slate-400">—</span>
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

          {/* Complete Immutable Audit Trail */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-display font-bold">
                Immutable Security & Activity Audit Trail ({allAuditLogs.length})
              </h3>
              <span className="text-[11px] text-slate-500">Correlated with session_id & IP address</span>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                    <th className="py-2.5 px-4">Timestamp</th>
                    <th className="py-2.5 px-4">Actor</th>
                    <th className="py-2.5 px-4">Session</th>
                    <th className="py-2.5 px-4">Action</th>
                    <th className="py-2.5 px-4">Entity</th>
                    <th className="py-2.5 px-4">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {allAuditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-500">
                        No activity logs match the current filter.
                      </td>
                    </tr>
                  ) : (
                    allAuditLogs.map((l) => (
                      <tr key={l.id}>
                        <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                          {formatDateTime(l.created_at)}
                        </td>
                        <td className="py-2.5 px-4">
                          <span>{l.user_full_name ? `${l.user_full_name} (${l.user_email})` : l.user_email || 'System'}</span>
                          {l.role_name && <span className="text-slate-400"> · {l.role_name}</span>}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-500">
                          {l.session_id ? `#${l.session_id}` : '—'}
                        </td>
                        <td
                          className={`py-2.5 px-4 font-mono font-semibold ${
                            l.action === 'UNAUTHORIZED_ACCESS_ATTEMPT' || l.action.includes('FAILED')
                              ? 'text-red-600'
                              : 'text-blue-700 dark:text-blue-400'
                          }`}
                        >
                          {l.action}
                        </td>
                        <td className="py-2.5 px-4 font-mono">
                          {l.entity_type} {l.entity_id ? `#${l.entity_id}` : ''}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-500 max-w-md break-all">
                          {l.details_json || '—'}
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

      {/* TAB 4: Admin Scopes & Permissions */}
      {activeTab === 'permissions' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-display font-bold">Scoped Operations Admins ({admins.length})</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Assign hub/department/moderator boundaries and granular module permissions per Admin account. Leave scope boxes unchecked for unrestricted access.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreateAdminModal(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              Create Scoped Admin
            </button>
          </div>

          {permError && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
              {permError}
            </div>
          )}
          {permMessage && (
            <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-700 dark:text-emerald-300">
              {permMessage}
            </div>
          )}

          {admins.length === 0 ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-xs text-slate-500">
              No Operations Admin (management) accounts exist yet. Create one above to delegate scoped permissions.
            </div>
          ) : (
            admins.map((adm) => {
              const draft = draftPolicies[adm.user_id];
              if (!draft) return null;
              return (
                <div
                  key={adm.user_id}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-display font-bold">{adm.full_name}</span>
                        <span
                          className={`text-[11px] font-semibold ${
                            adm.mfa_enabled ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-600'
                          }`}
                        >
                          {adm.mfa_enabled ? 'MFA Active' : 'MFA Not Enabled'}
                        </span>
                      </div>
                      <div className="text-xs font-mono text-slate-500">
                        {adm.email} · Last login: {adm.last_login_at ? formatDateTime(adm.last_login_at) : 'Never'}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={draft.status}
                        onChange={(e) =>
                          setDraftPolicies((prev) => ({
                            ...prev,
                            [adm.user_id]: { ...prev[adm.user_id], status: e.target.value as 'Active' | 'Inactive' },
                          }))
                        }
                        className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        <option value="Active">Active</option>
                        <option value="Inactive">Inactive</option>
                      </select>
                      <button
                        type="button"
                        disabled={savingAdminId === adm.user_id}
                        onClick={() => handleSaveAdminPolicy(adm.user_id)}
                        className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer whitespace-nowrap"
                      >
                        {savingAdminId === adm.user_id ? 'Saving...' : 'Save Permissions & Scope'}
                      </button>
                    </div>
                  </div>

                  {/* Scope Pickers */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                    <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-2">
                      <div className="font-semibold">
                        Allowed Hubs / Locations ({draft.allowed_location_ids.length || 'All'})
                      </div>
                      <div className="max-h-36 overflow-y-auto space-y-1">
                        {locations.map((loc) => (
                          <label key={loc.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={draft.allowed_location_ids.includes(loc.id)}
                              onChange={() => toggleScopeId(adm.user_id, 'allowed_location_ids', loc.id)}
                            />
                            <span className="truncate">
                              {loc.name} ({loc.code})
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-2">
                      <div className="font-semibold">
                        Allowed Departments ({draft.allowed_department_ids.length || 'All'})
                      </div>
                      <div className="max-h-36 overflow-y-auto space-y-1">
                        {departments.map((dept) => (
                          <label key={dept.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={draft.allowed_department_ids.includes(dept.id)}
                              onChange={() => toggleScopeId(adm.user_id, 'allowed_department_ids', dept.id)}
                            />
                            <span className="truncate">{dept.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-2">
                      <div className="font-semibold">
                        Allowed Moderators ({draft.allowed_moderator_ids.length || 'All'})
                      </div>
                      <div className="max-h-36 overflow-y-auto space-y-1">
                        {moderators.map((mod) => (
                          <label key={mod.id} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={draft.allowed_moderator_ids.includes(mod.id)}
                              onChange={() => toggleScopeId(adm.user_id, 'allowed_moderator_ids', mod.id)}
                            />
                            <span className="truncate">{mod.full_name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Capability Toggles */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
                    {CAPABILITY_LABELS.map((cap) => (
                      <label
                        key={String(cap.key)}
                        className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(draft[cap.key])}
                          onChange={(e) =>
                            setDraftPolicies((prev) => ({
                              ...prev,
                              [adm.user_id]: { ...prev[adm.user_id], [cap.key]: e.target.checked },
                            }))
                          }
                          className="mt-0.5"
                        />
                        <div>
                          <div className="font-semibold">{cap.label}</div>
                          <div className="text-[11px] text-slate-500">{cap.desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* TAB 5: Data Archival, Media Audit & Portable Exports */}
      {activeTab === 'retention' && (
        <div className="space-y-5">
          {retentionErr && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
              {retentionErr}
            </div>
          )}
          {retentionMsg && (
            <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-700 dark:text-emerald-300">
              {retentionMsg}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-display font-bold">Permanent Retention & Non-Destructive Archival</h3>
                  <p className="text-xs text-slate-500">
                    All chats, tickets, asset histories, and audit logs are preserved permanently. Older records are marked archived rather than deleted.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={savingRetention}
                  onClick={handleSaveRetention}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  {savingRetention ? 'Saving...' : 'Save Policies'}
                </button>
              </div>

              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {retentionPolicies.map((rp) => (
                  <div key={rp.entity_key} className="py-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold capitalize">{rp.entity_key.replace('_', ' ')}</div>
                      <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                        Stored permanently: {retentionCounts[rp.entity_key] ?? 0}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={Boolean(rp.auto_archive)}
                          onChange={(e) =>
                            setRetentionPolicies((prev) =>
                              prev.map((p) =>
                                p.entity_key === rp.entity_key ? { ...p, auto_archive: e.target.checked ? 1 : 0 } : p
                              )
                            )
                          }
                        />
                        Auto-Archive
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={30}
                          max={3650}
                          value={rp.retention_days}
                          onChange={(e) => {
                            const val = Number(e.target.value) || 30;
                            setRetentionPolicies((prev) =>
                              prev.map((p) => (p.entity_key === rp.entity_key ? { ...p, retention_days: val } : p))
                            );
                          }}
                          className="w-20 px-2 py-1 text-xs font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        <span className="text-slate-500">days</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <div className="text-xs font-semibold text-blue-700 dark:text-blue-400">
                  Archive Aged Chats & Reports (Preserved Permanently)
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={archiveConfirmText}
                    onChange={(e) => setArchiveConfirmText(e.target.value)}
                    placeholder="Type CONFIRM_RETENTION_ARCHIVE"
                    className="flex-1 min-w-[210px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    disabled={archiving || archiveConfirmText !== 'CONFIRM_RETENTION_ARCHIVE'}
                    onClick={handleExecuteArchive}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-40 cursor-pointer whitespace-nowrap"
                  >
                    <Database className="w-3.5 h-3.5" />
                    {archiving ? 'Archiving...' : 'Archive Aged Records'}
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
              <div>
                <h3 className="text-sm font-display font-bold">Instant Portable Exports & Media Integrity</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Download point-in-time SQLite database files or portable JSON archive bundles.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={downloadingBackup !== null}
                  onClick={() => handleDownloadBackup('sqlite')}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-blue-600 text-left space-y-1.5 cursor-pointer disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <Database className="w-5 h-5 text-blue-600" />
                    <Download className="w-4 h-4 text-slate-400" />
                  </div>
                  <div className="text-xs font-semibold">
                    {downloadingBackup === 'sqlite' ? 'Creating SQLite backup...' : 'Download SQLite (.db)'}
                  </div>
                  <div className="text-[11px] text-slate-500">Full hot SQLite binary snapshot via sqlite.backup().</div>
                </button>

                <button
                  type="button"
                  disabled={downloadingBackup !== null}
                  onClick={() => handleDownloadBackup('json')}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-blue-600 text-left space-y-1.5 cursor-pointer disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <HardDrive className="w-5 h-5 text-emerald-600" />
                    <Download className="w-4 h-4 text-slate-400" />
                  </div>
                  <div className="text-xs font-semibold">
                    {downloadingBackup === 'json' ? 'Generating JSON...' : 'Download JSON Archive'}
                  </div>
                  <div className="text-[11px] text-slate-500">Portable JSON bundle of operational tables & logs.</div>
                </button>
              </div>

              {mediaAudit && (
                <div className="pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-3 text-xs">
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Verified Disk Files</div>
                    <div className="text-lg font-mono font-bold tabular-nums">{mediaAudit.diskFileCount}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Media Storage Footprint</div>
                    <div className="text-lg font-mono font-bold tabular-nums">
                      {formatBytesCompact(mediaAudit.diskBytes)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {mediaAudit && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                  <h4 className="text-xs font-display font-bold">
                    Recent Ticket Attachments ({mediaAudit.ticketFiles.length})
                  </h4>
                </div>
                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                        <th className="py-2 px-3">Ticket</th>
                        <th className="py-2 px-3">File</th>
                        <th className="py-2 px-3 text-right">Size</th>
                        <th className="py-2 px-3">Uploader</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {mediaAudit.ticketFiles.map((f) => (
                        <tr key={f.id}>
                          <td className="py-2 px-3 font-mono text-blue-700 dark:text-blue-400">{f.ref_code}</td>
                          <td className="py-2 px-3 truncate max-w-[180px]">{f.original_name}</td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">{formatBytesCompact(f.file_size)}</td>
                          <td className="py-2 px-3 text-slate-500">{f.uploaded_by || 'System'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                  <h4 className="text-xs font-display font-bold">
                    Recent Chat Attachments ({mediaAudit.chatFiles.length})
                  </h4>
                </div>
                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                        <th className="py-2 px-3">Ref</th>
                        <th className="py-2 px-3">File</th>
                        <th className="py-2 px-3 text-right">Size</th>
                        <th className="py-2 px-3">Uploader</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {mediaAudit.chatFiles.map((f) => (
                        <tr key={f.id}>
                          <td className="py-2 px-3 font-mono text-blue-700 dark:text-blue-400">{f.ref_code}</td>
                          <td className="py-2 px-3 truncate max-w-[180px]">{f.original_name}</td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums">{formatBytesCompact(f.file_size)}</td>
                          <td className="py-2 px-3 text-slate-500">{f.uploaded_by || 'System'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Restore Database Confirmation Modal */}
      {restoreTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-600">
                <RotateCcw className="w-4 h-4" />
                <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
                  Restore CRM Database Snapshot
                </h3>
              </div>
              <button type="button" onClick={() => setRestoreTarget(null)} className="cursor-pointer">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <div>
                Target Backup: <strong className="font-mono">{restoreTarget.filename}</strong>
              </div>
              <div>
                Integrity Check: <strong className="font-mono">{restoreTarget.integrity_status}</strong>
              </div>
              <p className="pt-1">
                Before replacing the live database, the system will verify the backup file and automatically save a{' '}
                <strong>pre_restore</strong> safety snapshot of your current live database so you can always revert.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Type <code className="font-mono font-bold">CONFIRM_DATABASE_RESTORE</code> to proceed:
              </label>
              <input
                type="text"
                value={restoreConfirmText}
                onChange={(e) => setRestoreConfirmText(e.target.value)}
                placeholder="CONFIRM_DATABASE_RESTORE"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setRestoreTarget(null)}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restoringBackup || restoreConfirmText !== 'CONFIRM_DATABASE_RESTORE'}
                onClick={handleConfirmRestore}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40 cursor-pointer"
              >
                {restoringBackup ? 'Restoring Database...' : 'Restore Snapshot'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Scoped Admin Account Modal */}
      {createAdminModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateAdmin}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold">Create Operations Admin Account</h3>
              <button type="button" onClick={() => setCreateAdminModal(false)} className="cursor-pointer">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <input
              required
              placeholder="Full Name *"
              value={newAdminName}
              onChange={(e) => setNewAdminName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              type="email"
              required
              placeholder="Work Email Address *"
              value={newAdminEmail}
              onChange={(e) => setNewAdminEmail(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              type="password"
              required
              minLength={8}
              placeholder="Initial Password (min 8 chars) *"
              value={newAdminPassword}
              onChange={(e) => setNewAdminPassword(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <p className="text-[11px] text-slate-500">
              After creating the account, customize hub/department/moderator scopes and feature permissions directly in the Admin Scopes list.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateAdminModal(false)}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creatingAdmin}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer"
              >
                {creatingAdmin ? 'Creating...' : 'Create Admin'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
