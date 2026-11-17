import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowUpDown,
  Check,
  Copy,
  Download,
  Edit2,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  KeyRound,
  Link2,
  Plus,
  Power,
  RefreshCw,
  Search,
  Shield,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { LocationItem, ModeratorItem } from '../../types/index.ts';
import { apiFetch, formatDateOnly, formatDateTime } from '../../utils/api.ts';
import { exportToCsv, exportToExcel, exportToPdf } from '../../utils/exportUtils.ts';

function buildFullInviteUrl(baseUrl: string, token: string): string {
  const clean = (baseUrl || window.location.origin).trim().replace(/\/+$/, '');
  const sep = clean.includes('?') ? '&' : '/?';
  return `${clean}${sep}invite=${encodeURIComponent(token)}`;
}

interface ModeratorActivityResponse {
  moderator: ModeratorItem;
  sessions: any[];
  activities: any[];
  ticketActivities: any[];
  timeLogs: any[];
  summary: {
    total_actions: number;
    total_sessions: number;
    active_sessions: number;
    total_time_logged_mins: number;
    last_activity_at: string | null;
  };
}

interface ModeratorsViewProps {
  initialStatusFilter?: { key: number; status: 'All' | 'Active' | 'Inactive' } | null;
  onBackToDashboard?: () => void;
}

export default function ModeratorsView({ initialStatusFilter, onBackToDashboard }: ModeratorsViewProps) {
  const { user, subscribeRealtime } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const [moderators, setModerators] = useState<ModeratorItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'all'>('monthly');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | 'Active' | 'Inactive'>(
    initialStatusFilter?.status || 'All'
  );
  const [sortField, setSortField] = useState<'full_name' | 'current_workload' | 'resolved_tickets' | 'performance_rating'>('resolved_tickets');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingMod, setEditingMod] = useState<ModeratorItem | null>(null);

  useEffect(() => {
    if (initialStatusFilter?.status) {
      setStatusFilter(initialStatusFilter.status);
      setPage(1);
    }
  }, [initialStatusFilter?.key]);

  // Portal link base URL & Common Moderator Access Link provided by Super Admin
  const [portalBaseUrl, setPortalBaseUrl] = useState<string>(() => window.location.origin);
  const [commonModLink, setCommonModLink] = useState<string>('');
  const [commonLinkUpdatedAt, setCommonLinkUpdatedAt] = useState<string | null>(null);
  const [commonLinkBusy, setCommonLinkBusy] = useState(false);

  const [provisionedBanner, setProvisionedBanner] = useState<{
    name: string;
    email: string;
    assignedPassword?: string;
    loginLink: string;
    commonLink?: string;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Moderator Activity Inspector Modal (Super Admin ONLY)
  const [activityMod, setActivityMod] = useState<ModeratorItem | null>(null);
  const [activityData, setActivityData] = useState<ModeratorActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityTab, setActivityTab] = useState<'audit' | 'sessions' | 'tickets'>('audit');

  const [empCode, setEmpCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [specialization, setSpecialization] = useState('');
  const [selectedLocs, setSelectedLocs] = useState<number[]>([]);
  const [joiningDate, setJoiningDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [maxCapacity, setMaxCapacity] = useState('10');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState('');

  const loadAll = useCallback(async () => {
    const mRes = await apiFetch<{ moderators: ModeratorItem[] }>(`/api/moderators?period=${period}`);
    setModerators(mRes.moderators);
    if (isSuperAdmin) {
      try {
        const [sRes, linkRes] = await Promise.all([
          apiFetch<{ sessions: any[] }>('/api/auth/sessions?role_name=moderator'),
          apiFetch<{ login_link: string; base_url: string; updated_at: string | null }>('/api/moderators/common-access-link'),
        ]);
        setSessions(sRes.sessions);
        setCommonModLink(linkRes.login_link);
        setCommonLinkUpdatedAt(linkRes.updated_at);
      } catch {
        setSessions([]);
      }
    } else {
      setSessions([]);
    }
  }, [period, isSuperAdmin]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'directory:updated' || evt.event === 'ticket:updated') {
        loadAll();
      }
    });
  }, [subscribeRealtime, loadAll]);

  useEffect(() => {
    apiFetch<{ locations: LocationItem[] }>('/api/locations')
      .then((r) => setLocations(r.locations))
      .catch(() => {});
  }, []);

  const loadModeratorActivities = useCallback(async (mod: ModeratorItem) => {
    if (!isSuperAdmin) return;
    setActivityMod(mod);
    setActivityLoading(true);
    try {
      const data = await apiFetch<ModeratorActivityResponse>(`/api/moderators/${mod.id}/activities`);
      setActivityData(data);
    } finally {
      setActivityLoading(false);
    }
  }, [isSuperAdmin]);

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(key);
    setTimeout(() => setCopiedId((prev) => (prev === key ? null : prev)), 2500);
  };

  const handleCopyModLink = async (m: ModeratorItem) => {
    const base = portalBaseUrl.trim() || m.invited_link_base || window.location.origin;
    if (m.invite_token) {
      const link = buildFullInviteUrl(base, m.invite_token);
      copyText(`mod-${m.id}`, link);
      return;
    }
    const res = await apiFetch<{ login_link: string }>(`/api/moderators/${m.id}/invite-link`, {
      method: 'POST',
      body: JSON.stringify({ portal_url: base }),
    });
    copyText(`mod-${m.id}`, res.login_link);
    loadAll();
  };

  const handleRegenerateModLink = async (m: ModeratorItem) => {
    const base = portalBaseUrl.trim() || window.location.origin;
    const res = await apiFetch<{ login_link: string }>(`/api/moderators/${m.id}/invite-link`, {
      method: 'POST',
      body: JSON.stringify({ portal_url: base }),
    });
    setProvisionedBanner({
      name: m.full_name,
      email: m.email,
      loginLink: res.login_link,
    });
    copyText(`mod-${m.id}`, res.login_link);
    loadAll();
    if (activityMod && activityMod.id === m.id) {
      loadModeratorActivities(m);
    }
  };

  const handleGenerateCommonLink = async () => {
    if (!isSuperAdmin) return;
    setCommonLinkBusy(true);
    try {
      const res = await apiFetch<{ login_link: string; updated_at: string | null }>('/api/moderators/common-access-link', {
        method: 'POST',
        body: JSON.stringify({ portal_url: portalBaseUrl.trim() || window.location.origin }),
      });
      setCommonModLink(res.login_link);
      setCommonLinkUpdatedAt(res.updated_at);
      copyText('common-link', res.login_link);
    } finally {
      setCommonLinkBusy(false);
    }
  };

  const generateStrongPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#';
    let out = 'Mod@';
    for (let i = 0; i < 8; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    setPassword(out);
    setShowPassword(true);
  };

  const openCreate = () => {
    setEditingMod(null);
    setEmpCode('');
    setFullName('');
    setEmail('');
    setPhone('');
    setSpecialization('');
    setSelectedLocs([]);
    setJoiningDate(new Date().toISOString().slice(0, 10));
    setMaxCapacity('10');
    setPassword('');
    setShowPassword(false);
    setErr('');
    setModalOpen(true);
  };

  const openEdit = (m: ModeratorItem) => {
    setEditingMod(m);
    setEmpCode(m.employee_code);
    setFullName(m.full_name);
    setEmail(m.email);
    setPhone(m.phone);
    setSpecialization(m.specialization);
    setSelectedLocs(m.assigned_location_ids || []);
    setJoiningDate(m.date_of_joining);
    setMaxCapacity(String(m.max_capacity));
    setPassword('');
    setShowPassword(false);
    setErr('');
    setModalOpen(true);
  };

  const toggleLoc = (id: number) => {
    setSelectedLocs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      if (editingMod) {
        if (password.trim() && password.trim().length < 8) {
          setErr('New password must be at least 8 characters.');
          return;
        }
        await apiFetch(`/api/moderators/${editingMod.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            full_name: fullName,
            email: email.trim(),
            new_password: password.trim() || undefined,
            phone,
            specialization,
            assigned_location_ids: selectedLocs,
            max_capacity: Number(maxCapacity),
          }),
        });
      } else {
        if (password.trim().length < 8) {
          setErr('Super Admin must assign a password of at least 8 characters.');
          return;
        }
        const res = await apiFetch<{ id: number; login_link: string }>('/api/moderators', {
          method: 'POST',
          body: JSON.stringify({
            employee_code: empCode,
            full_name: fullName,
            email,
            phone,
            specialization,
            assigned_location_ids: selectedLocs,
            date_of_joining: joiningDate,
            max_capacity: Number(maxCapacity),
            password: password.trim(),
            portal_url: portalBaseUrl.trim() || window.location.origin,
          }),
        });
        setProvisionedBanner({
          name: fullName.trim(),
          email: email.trim().toLowerCase(),
          assignedPassword: password.trim(),
          loginLink: res.login_link,
          commonLink: commonModLink || undefined,
        });
      }
      setModalOpen(false);
      loadAll();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const toggleStatus = async (m: ModeratorItem) => {
    const next = m.status === 'Active' ? 'Inactive' : 'Active';
    await apiFetch(`/api/moderators/${m.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: next }),
    });
    loadAll();
  };

  const filteredMods = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = moderators.filter((m) => {
      if (statusFilter !== 'All' && m.status !== statusFilter) return false;
      if (!q) return true;
      return (
        m.full_name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.employee_code.toLowerCase().includes(q) ||
        m.specialization.toLowerCase().includes(q) ||
        (m.assigned_location_names || []).join(', ').toLowerCase().includes(q)
      );
    });
    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'full_name') {
        cmp = a.full_name.localeCompare(b.full_name);
      } else if (sortField === 'current_workload') {
        cmp = a.current_workload - b.current_workload;
      } else if (sortField === 'performance_rating') {
        cmp = a.performance_rating - b.performance_rating;
      } else {
        cmp = a.resolved_tickets - b.resolved_tickets;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [moderators, search, statusFilter, sortField, sortDir]);

  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(filteredMods.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedMods = filteredMods.slice((currentPage - 1) * pageSize, currentPage * pageSize);

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
      filteredMods.map((m) => ({
        EmployeeCode: m.employee_code,
        FullName: m.full_name,
        Email: m.email,
        Specialization: m.specialization,
        Status: m.status,
        Workload: `${m.current_workload}/${m.max_capacity}`,
        Resolved: m.resolved_tickets,
        TotalAssigned: m.total_assigned,
        Avg1stResponseMins: m.avg_first_response_mins ?? '—',
        AvgResolutionHrs: m.avg_resolution_hours ?? '—',
        Rating: m.performance_rating.toFixed(1),
      })),
    [filteredMods]
  );

  return (
    <div className="space-y-6">
      {onBackToDashboard && (
        <div>
          <button
            type="button"
            onClick={onBackToDashboard}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Super Admin Dashboard
          </button>
        </div>
      )}

      {/* Header & Period Switch */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-display font-bold">
              {user?.role === 'moderator' ? 'My Personal Performance' : 'IT Moderator Team, Login Links & Activity Tracking'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {isSuperAdmin
                ? 'Provision moderators with a custom login link and monitor every moderator action & session (Super Admin exclusive).'
                : 'Active work hours tracked separately from elapsed ticket resolution duration.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
              {(['daily', 'weekly', 'monthly', 'all'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize cursor-pointer ${
                    period === p ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white' : 'text-slate-500'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            {isSuperAdmin && (
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Moderator</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
            <div className="relative flex-1 max-w-sm">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search moderator, email, specialization, or hub..."
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as any);
                setPage(1);
              }}
              aria-label="Filter moderators by status"
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="All">All Statuses</option>
              <option value="Active">Active Only</option>
              <option value="Inactive">Inactive Only</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={exportRows.length === 0}
              onClick={() => exportToCsv('SD_Global_Moderators', exportRows)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </button>
            <button
              type="button"
              disabled={exportRows.length === 0}
              onClick={() => exportToExcel('SD_Global_Moderators', 'Moderators', exportRows)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Excel
            </button>
            <button
              type="button"
              disabled={exportRows.length === 0}
              onClick={() => exportToPdf('SD_Global_Moderators', 'Moderators & Performance', exportRows)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              PDF
            </button>
          </div>
        </div>
      </div>

      {/* Super Admin Common Moderator Access Link & Provisioned Banner */}
      {isSuperAdmin && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                <Link2 className="w-4 h-4 text-blue-600" />
                <span>Common Moderator Access Link (Share with All Moderators)</span>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                All moderators can open this shared portal link and sign in with the unique Email ID and Password you assign to them.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={portalBaseUrl}
                onChange={(e) => setPortalBaseUrl(e.target.value)}
                placeholder="https://your-portal-url.run.app"
                aria-label="Moderator Portal Base URL"
                className="w-56 sm:w-64 px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
              <button
                type="button"
                disabled={commonLinkBusy}
                onClick={handleGenerateCommonLink}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${commonLinkBusy ? 'animate-spin' : ''}`} />
                <span>Generate New Link</span>
              </button>
            </div>
          </div>

          {commonModLink && (
            <div className="p-3 rounded-lg bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/60 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs text-blue-900 dark:text-blue-200 break-all">{commonModLink}</div>
                {commonLinkUpdatedAt && (
                  <div className="text-[10px] text-blue-700/80 dark:text-blue-300/70 mt-0.5">
                    Active link · Updated {formatDateTime(commonLinkUpdatedAt)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => copyText('common-link', commonModLink)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer shrink-0"
              >
                {copiedId === 'common-link' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedId === 'common-link' ? 'Copied' : 'Copy Common Link'}</span>
              </button>
            </div>
          )}

          {provisionedBanner && (
            <div className="p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">
                  Moderator credentials created for {provisionedBanner.name}
                </div>
                <div className="font-mono text-[11px] text-emerald-900 dark:text-emerald-200">
                  Email: <strong>{provisionedBanner.email}</strong>
                  {provisionedBanner.assignedPassword && (
                    <>
                      {' · '}Password: <strong>{provisionedBanner.assignedPassword}</strong>
                    </>
                  )}
                </div>
                <div className="font-mono text-[11px] text-emerald-800 dark:text-emerald-300 break-all">
                  Portal Link: {provisionedBanner.commonLink || provisionedBanner.loginLink}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    copyText(
                      'banner',
                      provisionedBanner.assignedPassword
                        ? `Moderator Login URL: ${provisionedBanner.commonLink || provisionedBanner.loginLink}\nEmail: ${provisionedBanner.email}\nPassword: ${provisionedBanner.assignedPassword}`
                        : provisionedBanner.loginLink
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white cursor-pointer"
                >
                  {copiedId === 'banner' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedId === 'banner' ? 'Copied' : 'Copy Credentials & Link'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setProvisionedBanner(null)}
                  className="p-1.5 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 rounded cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Moderators Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4">
                  <button
                    type="button"
                    onClick={() => toggleSort('full_name')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Moderator <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4">Specialization & Hubs</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort('current_workload')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Workload <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort('resolved_tickets')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Resolved / Total <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4 text-right">1st Resp / Avg Res</th>
                <th className="py-2.5 px-4 text-right">Work Logged</th>
                {isSuperAdmin && <th className="py-2.5 px-4 text-right">Tracked Actions</th>}
                <th className="py-2.5 px-4 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort('performance_rating')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Rating <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                {isSuperAdmin && <th className="py-2.5 px-4 text-right">Actions & Login Link</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {pagedMods.length === 0 ? (
                <tr>
                  <td colSpan={isSuperAdmin ? 10 : 8} className="py-8 text-center text-slate-500">
                    {isSuperAdmin
                      ? 'No moderators match the current filters.'
                      : 'No moderator profile found.'}
                  </td>
                </tr>
              ) : (
                pagedMods.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900 dark:text-white">{m.full_name}</div>
                      <div className="font-mono text-slate-500">
                        {m.employee_code} · {m.email}
                      </div>
                      <div className="font-mono text-slate-400">Joined {formatDateOnly(m.date_of_joining)}</div>
                    </td>
                    <td className="py-3 px-4 max-w-[220px]">
                      <div className="font-medium text-slate-800 dark:text-slate-200">{m.specialization}</div>
                      <div className="text-slate-500 truncate mt-0.5">
                        {m.assigned_location_names?.join(', ') || 'All Hubs'}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`font-semibold ${
                          m.status === 'Active' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {m.current_workload} / {m.max_capacity}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {m.resolved_tickets} / {m.total_assigned}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {m.avg_first_response_mins ?? '—'}m / {m.avg_resolution_hours ?? '—'}h
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {Math.round(((m.total_working_minutes ?? 0) / 60) * 10) / 10}h
                    </td>
                    {isSuperAdmin && (
                      <td className="py-3 px-4 text-right font-mono tabular-nums">
                        <div className="font-semibold text-blue-700 dark:text-blue-400">
                          {m.tracked_action_count ?? 0}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {m.last_activity_at ? formatDateTime(m.last_activity_at) : 'No activity'}
                        </div>
                      </td>
                    )}
                    <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums">
                      {m.performance_rating.toFixed(1)}
                    </td>
                    {isSuperAdmin && (
                      <td className="py-3 px-4 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => loadModeratorActivities(m)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 cursor-pointer"
                        >
                          <Activity className="w-3 h-3" />
                          Activity
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopyModLink(m)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          {copiedId === `mod-${m.id}` ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                          {copiedId === `mod-${m.id}` ? 'Copied' : 'Copy Link'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRegenerateModLink(m)}
                          title="Generate fresh login link with current Base URL"
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEdit(m)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <Edit2 className="w-3 h-3" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleStatus(m)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          <Power className="w-3 h-3" />
                          {m.status === 'Active' ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
          <span className="font-mono tabular-nums">
            Showing {filteredMods.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, filteredMods.length)} of {filteredMods.length}
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

      {/* Moderator Login & Session Duration Log (STRICTLY Super Admin ONLY) */}
      {isSuperAdmin && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-display font-semibold">
                Moderator Login & Session Duration Tracking (Super Admin Only)
              </h3>
            </div>
            <button
              type="button"
              onClick={loadAll}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                  <th className="py-2.5 px-4">Moderator</th>
                  <th className="py-2.5 px-4">Login Time</th>
                  <th className="py-2.5 px-4">Last Activity</th>
                  <th className="py-2.5 px-4">Logout Time</th>
                  <th className="py-2.5 px-4 text-right">Session Duration</th>
                  <th className="py-2.5 px-4">IP Address</th>
                  <th className="py-2.5 px-4">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {sessions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-500">
                      No moderator login sessions recorded yet.
                    </td>
                  </tr>
                ) : (
                  sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="py-2.5 px-4 font-medium">
                        {s.full_name} · <span className="text-slate-500">{s.email}</span>
                      </td>
                      <td className="py-2.5 px-4 font-mono">{formatDateTime(s.login_at)}</td>
                      <td className="py-2.5 px-4 font-mono">{formatDateTime(s.last_activity_at || s.login_at)}</td>
                      <td className="py-2.5 px-4 font-mono">{formatDateTime(s.logout_at)}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">{s.duration_minutes ?? 0} mins</td>
                      <td className="py-2.5 px-4 font-mono text-slate-500">{s.ip_address}</td>
                      <td className="py-2.5 px-4">
                        <span className={s.is_active ? 'text-emerald-600 font-semibold' : 'text-slate-500'}>
                          {s.is_active ? 'Active Session' : 'Closed'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add / Edit Moderator Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSave}
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold">
                {editingMod ? `Edit Moderator · ${editingMod.full_name}` : 'Add New IT Moderator'}
              </h3>
              <button type="button" onClick={() => setModalOpen(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            {err && <div className="p-2.5 text-xs rounded bg-red-50 text-red-700">{err}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Employee ID *</label>
                <input
                  required
                  disabled={Boolean(editingMod)}
                  value={empCode}
                  onChange={(e) => setEmpCode(e.target.value)}
                  placeholder="IT-MOD-101"
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Full Name *</label>
                <input
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Unique Email ID *</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="moderator@sdglobal.com"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Phone *</label>
                <input
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium mb-1">Specialization *</label>
                <input
                  required
                  value={specialization}
                  onChange={(e) => setSpecialization(e.target.value)}
                  placeholder="Barcode Scanners, Wi-Fi, WMS..."
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Max Active Workload</label>
                <input
                  type="number"
                  min="1"
                  value={maxCapacity}
                  onChange={(e) => setMaxCapacity(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium">
                    {editingMod ? 'Reset Password (Optional)' : 'Assigned Password *'}
                  </label>
                  <button
                    type="button"
                    onClick={generateStrongPassword}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                  >
                    <KeyRound className="w-3 h-3" />
                    Generate
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required={!editingMod}
                    minLength={editingMod ? undefined : 8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editingMod ? 'Leave blank to keep current' : 'Min 8 characters'}
                    className="w-full pr-9 pl-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                    aria-label="Toggle password visibility"
                  >
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5">Assigned Locations / Hubs</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto p-2 border border-slate-200 dark:border-slate-800 rounded-lg">
                {locations.map((loc) => (
                  <label key={loc.id} className="inline-flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedLocs.includes(loc.id)}
                      onChange={() => toggleLoc(loc.id)}
                    />
                    <span className="truncate">{loc.name}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
              >
                {editingMod ? 'Save Changes & Credentials' : 'Create Moderator Account'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Super-Admin-Only Moderator Activity Inspector Modal */}
      {isSuperAdmin && activityMod && (
        <div className="fixed inset-0 z-50 bg-slate-950/65 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-blue-600" />
                  <h3 className="text-base font-display font-bold">
                    Moderator Activity Monitor · {activityMod.full_name}
                  </h3>
                </div>
                <p className="text-xs text-slate-500 font-mono mt-0.5">
                  {activityMod.employee_code} · {activityMod.email} · Super Admin Exclusive Audit View
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadModeratorActivities(activityMod)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActivityMod(null);
                    setActivityData(null);
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {activityLoading || !activityData ? (
              <div className="p-8 text-center text-xs text-slate-500">Loading complete moderator activity log...</div>
            ) : (
              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                {/* Summary KPI Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-500">Total Tracked Actions</div>
                    <div className="text-xl font-mono font-bold mt-1">{activityData.summary.total_actions}</div>
                  </div>
                  <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-500">Login Sessions</div>
                    <div className="text-xl font-mono font-bold mt-1">
                      {activityData.summary.total_sessions}{' '}
                      <span className="text-xs font-normal text-emerald-600">
                        ({activityData.summary.active_sessions} active)
                      </span>
                    </div>
                  </div>
                  <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-500">Work Time Logged</div>
                    <div className="text-xl font-mono font-bold mt-1">{activityData.summary.total_time_logged_mins} mins</div>
                  </div>
                  <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-500">Last Recorded Activity</div>
                    <div className="text-xs font-mono font-semibold mt-1.5">
                      {formatDateTime(activityData.summary.last_activity_at)}
                    </div>
                  </div>
                </div>

                {/* Provisioned Invite Link Bar */}
                {activityData.moderator.invite_token && (
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold text-slate-700 dark:text-slate-300">Moderator Login Link: </span>
                      <span className="font-mono text-slate-600 dark:text-slate-400 break-all">
                        {buildFullInviteUrl(
                          portalBaseUrl.trim() || activityData.moderator.invited_link_base || window.location.origin,
                          activityData.moderator.invite_token
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopyModLink(activityData.moderator)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
                      >
                        <Copy className="w-3 h-3" />
                        Copy Link
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRegenerateModLink(activityData.moderator)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Regenerate
                      </button>
                    </div>
                  </div>
                )}

                {/* Activity Tabs */}
                <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
                  {[
                    { id: 'audit', label: `All Actions (${activityData.activities.length})` },
                    { id: 'sessions', label: `Login Sessions (${activityData.sessions.length})` },
                    { id: 'tickets', label: `Ticket Updates & Time (${activityData.ticketActivities.length})` },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActivityTab(tab.id as any)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                        activityTab === tab.id
                          ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white'
                          : 'text-slate-500'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {activityTab === 'audit' && (
                  <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500">
                          <th className="py-2 px-3">Timestamp</th>
                          <th className="py-2 px-3">Action</th>
                          <th className="py-2 px-3">Entity</th>
                          <th className="py-2 px-3">Details</th>
                          <th className="py-2 px-3">IP</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {activityData.activities.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-6 text-center text-slate-500">
                              No actions tracked yet for this moderator.
                            </td>
                          </tr>
                        ) : (
                          activityData.activities.map((a) => (
                            <tr key={a.id}>
                              <td className="py-2 px-3 font-mono text-slate-500 whitespace-nowrap">
                                {formatDateTime(a.created_at)}
                              </td>
                              <td className="py-2 px-3 font-mono font-semibold text-blue-700 dark:text-blue-400">
                                {a.action}
                              </td>
                              <td className="py-2 px-3 font-mono">
                                {a.entity_type} {a.entity_id ? `#${a.entity_id}` : ''}
                              </td>
                              <td className="py-2 px-3 font-mono text-slate-600 dark:text-slate-300 max-w-md break-all">
                                {a.details_json || '—'}
                              </td>
                              <td className="py-2 px-3 font-mono text-slate-400">{a.ip_address || '—'}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {activityTab === 'sessions' && (
                  <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500">
                          <th className="py-2 px-3">Login Time</th>
                          <th className="py-2 px-3">Last Activity</th>
                          <th className="py-2 px-3">Logout Time</th>
                          <th className="py-2 px-3 text-right">Duration</th>
                          <th className="py-2 px-3">IP Address</th>
                          <th className="py-2 px-3">State</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {activityData.sessions.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-6 text-center text-slate-500">
                              No login sessions recorded yet.
                            </td>
                          </tr>
                        ) : (
                          activityData.sessions.map((s) => (
                            <tr key={s.id}>
                              <td className="py-2 px-3 font-mono">{formatDateTime(s.login_at)}</td>
                              <td className="py-2 px-3 font-mono">{formatDateTime(s.last_activity_at || s.login_at)}</td>
                              <td className="py-2 px-3 font-mono">{formatDateTime(s.logout_at)}</td>
                              <td className="py-2 px-3 text-right font-mono">{s.duration_minutes ?? 0} mins</td>
                              <td className="py-2 px-3 font-mono text-slate-500">{s.ip_address}</td>
                              <td className="py-2 px-3">
                                <span className={s.is_active ? 'text-emerald-600 font-semibold' : 'text-slate-500'}>
                                  {s.is_active ? 'Active' : 'Closed'}
                                </span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {activityTab === 'tickets' && (
                  <div className="space-y-4">
                    <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500">
                            <th className="py-2 px-3">Timestamp</th>
                            <th className="py-2 px-3">Ticket</th>
                            <th className="py-2 px-3">Action</th>
                            <th className="py-2 px-3">Transition</th>
                            <th className="py-2 px-3">Details</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {activityData.ticketActivities.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="py-6 text-center text-slate-500">
                                No ticket actions recorded yet.
                              </td>
                            </tr>
                          ) : (
                            activityData.ticketActivities.map((ta) => (
                              <tr key={ta.id}>
                                <td className="py-2 px-3 font-mono text-slate-500 whitespace-nowrap">
                                  {formatDateTime(ta.created_at)}
                                </td>
                                <td className="py-2 px-3 font-mono font-semibold">{ta.ticket_number}</td>
                                <td className="py-2 px-3 font-semibold">{ta.action_type}</td>
                                <td className="py-2 px-3 font-mono text-slate-500">
                                  {ta.previous_status || '—'} → {ta.new_status || '—'}
                                </td>
                                <td className="py-2 px-3">{ta.details}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
