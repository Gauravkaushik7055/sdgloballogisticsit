import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpDown,
  Building2,
  Check,
  Copy,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Ticket,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { DepartmentItem, LocationItem } from '../../types/index.ts';
import { apiFetch, formatDateTime, getPriorityColorClass, getStatusColorClass } from '../../utils/api.ts';
import { exportToCsv, exportToExcel, exportToPdf } from '../../utils/exportUtils.ts';

interface UsersDirectoryViewProps {
  onSelectTicket?: (ticketId: number) => void;
  onBackToDashboard?: () => void;
}

interface EmployeeDetailPayload {
  employee: any;
  sessions: any[];
  tickets: any[];
}

export default function UsersDirectoryView({ onSelectTicket, onBackToDashboard }: UsersDirectoryViewProps) {
  const { user, subscribeRealtime } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const [employees, setEmployees] = useState<any[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [portalBaseUrl, setPortalBaseUrl] = useState(() => window.location.origin);
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | 'Active' | 'Inactive'>('All');
  const [hubFilter, setHubFilter] = useState('All');
  const [sortField, setSortField] = useState<'full_name' | 'login_count' | 'ticket_count' | 'last_login_at'>('last_login_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const [locModalOpen, setLocModalOpen] = useState(false);
  const [mgmtModalOpen, setMgmtModalOpen] = useState(false);
  const [dirErr, setDirErr] = useState('');

  // Employee Detail Inspector (Login info + Ticket history)
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<EmployeeDetailPayload | null>(null);
  const [detailTab, setDetailTab] = useState<'tickets' | 'sessions'>('tickets');

  // Optional Management (Read-Only) provisioning
  const [empCode, setEmpCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [designation, setDesignation] = useState('');
  const [deptId, setDeptId] = useState('');
  const [locId, setLocId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  // Location form
  const [locCode, setLocCode] = useState('');
  const [locName, setLocName] = useState('');
  const [locType, setLocType] = useState('Warehouse');
  const [locCity, setLocCity] = useState('');
  const [locState, setLocState] = useState('');
  const [locAddress, setLocAddress] = useState('');
  const [locMgr, setLocMgr] = useState('');

  const shareableEmployeeLoginUrl = useMemo(() => {
    const clean = (portalBaseUrl || window.location.origin).trim().replace(/\/+$/, '');
    const sep = clean.includes('?') ? '&' : '/?';
    return `${clean}${sep}panel=employee-login`;
  }, [portalBaseUrl]);

  const loadData = useCallback(async () => {
    const [eRes, lRes, dRes] = await Promise.all([
      apiFetch<{ employees: any[] }>('/api/employees'),
      apiFetch<{ locations: LocationItem[] }>('/api/locations'),
      apiFetch<{ departments: DepartmentItem[] }>('/api/departments'),
    ]);
    setEmployees(eRes.employees);
    setLocations(lRes.locations);
    setDepartments(dRes.departments);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'directory:updated' || evt.event === 'ticket:updated') {
        loadData();
      }
    });
  }, [subscribeRealtime, loadData]);

  const handleCopyShareableLink = () => {
    navigator.clipboard.writeText(shareableEmployeeLoginUrl);
    setCopiedShareLink(true);
    setTimeout(() => setCopiedShareLink(false), 2500);
  };

  const openEmployeeDetails = async (employeeId: number) => {
    setDetailLoading(true);
    setDetailTab('tickets');
    try {
      const data = await apiFetch<EmployeeDetailPayload>(`/api/employees/${employeeId}/details`);
      setDetailData(data);
    } catch (e: any) {
      setDirErr(e.message || 'Failed to load employee login and ticket details');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCreateManagement = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      await apiFetch('/api/employees', {
        method: 'POST',
        body: JSON.stringify({
          employee_code: empCode,
          full_name: fullName,
          email,
          mobile,
          designation,
          department_id: deptId ? Number(deptId) : null,
          location_id: locId ? Number(locId) : null,
          role_name: 'management',
          password: password || undefined,
          portal_url: portalBaseUrl.trim() || window.location.origin,
        }),
      });
      setMgmtModalOpen(false);
      setEmpCode('');
      setFullName('');
      setEmail('');
      setMobile('');
      setDesignation('');
      setPassword('');
      loadData();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const handleCreateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/locations', {
      method: 'POST',
      body: JSON.stringify({
        code: locCode,
        name: locName,
        type: locType,
        city: locCity,
        state: locState,
        address: locAddress,
        manager_name: locMgr,
      }),
    });
    setLocModalOpen(false);
    setLocCode('');
    setLocName('');
    setLocCity('');
    setLocState('');
    setLocAddress('');
    loadData();
  };

  const toggleUserStatus = async (userId: number, current: string) => {
    setDirErr('');
    try {
      const next = current === 'Active' ? 'Inactive' : 'Active';
      await apiFetch(`/api/users/${userId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      loadData();
    } catch (e: any) {
      setDirErr(e.message || 'Failed to update account status');
    }
  };

  const deleteUser = async (userId: number) => {
    setDirErr('');
    try {
      await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
      loadData();
    } catch (e: any) {
      setDirErr(e.message || 'Failed to delete user');
    }
  };

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = employees.filter((e) => {
      if (statusFilter !== 'All' && (e.account_status || 'Active') !== statusFilter) return false;
      if (hubFilter !== 'All' && String(e.location_id || '') !== hubFilter) return false;
      if (!q) return true;
      return (
        (e.full_name || '').toLowerCase().includes(q) ||
        (e.mobile || '').toLowerCase().includes(q) ||
        (e.employee_code || '').toLowerCase().includes(q) ||
        (e.email || '').toLowerCase().includes(q) ||
        (e.location_name || '').toLowerCase().includes(q) ||
        (e.department_name || '').toLowerCase().includes(q)
      );
    });

    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'full_name') {
        cmp = (a.full_name || '').localeCompare(b.full_name || '');
      } else if (sortField === 'login_count') {
        cmp = Number(a.login_count || 0) - Number(b.login_count || 0);
      } else if (sortField === 'ticket_count') {
        cmp = Number(a.ticket_count || 0) - Number(b.ticket_count || 0);
      } else {
        cmp = new Date(a.last_login_at || 0).getTime() - new Date(b.last_login_at || 0).getTime();
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [employees, search, statusFilter, hubFilter, sortField, sortDir]);

  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedEmployees = filteredEmployees.slice((currentPage - 1) * pageSize, currentPage * pageSize);

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
      filteredEmployees.map((e) => ({
        EmployeeCode: e.employee_code,
        FullName: e.full_name,
        Mobile: e.mobile,
        Email: e.email,
        Department: e.department_name || '—',
        Location: e.location_name || '—',
        Logins: e.login_count ?? 0,
        TicketsRaised: e.ticket_count ?? 0,
        OpenTickets: e.open_ticket_count ?? 0,
        Status: e.account_status || 'Active',
        LastLogin: formatDateTime(e.last_login_at),
      })),
    [filteredEmployees]
  );

  const totalLogins = employees.reduce((acc, e) => acc + (Number(e.login_count) || 0), 0);
  const activeSessions = employees.reduce((acc, e) => acc + (Number(e.active_sessions) || 0), 0);
  const totalTicketsRaised = employees.reduce((acc, e) => acc + (Number(e.ticket_count) || 0), 0);

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

      {/* Shareable Employee Mobile + OTP Login Link Banner */}
      <div className="bg-white dark:bg-slate-900 border border-blue-200 dark:border-blue-900/60 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-blue-700 dark:text-blue-400">
              <Smartphone className="w-4 h-4" />
              <span>Zero-Setup Employee & HR Self-Service Panel</span>
            </div>
            <h2 className="text-base font-display font-bold text-slate-900 dark:text-white">
              Shareable Employee Login Link (Mobile + OTP)
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              No manual employee addition required. Share this link with all employees—any employee can log in with their mobile number and OTP to raise support tickets directly. Every employee login, IP/device session, and ticket history is captured below automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={handleCopyShareableLink}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer shrink-0"
          >
            {copiedShareLink ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            <span>{copiedShareLink ? 'Copied Employee Login Link' : 'Copy Shareable Login Link'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-center pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="lg:col-span-5 flex items-center gap-2">
            <span className="text-[11px] font-medium text-slate-500 whitespace-nowrap">Portal Base URL:</span>
            <input
              type="url"
              value={portalBaseUrl}
              onChange={(e) => setPortalBaseUrl(e.target.value)}
              className="flex-1 px-2.5 py-1.5 text-xs font-mono rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700"
            />
          </div>
          <div className="lg:col-span-7 flex items-center gap-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2">
            <Link2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            <code className="text-xs font-mono text-slate-800 dark:text-slate-200 break-all">
              {shareableEmployeeLoginUrl}
            </code>
          </div>
        </div>
      </div>

      {/* Live HR Capture KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Auto-Captured Employees</div>
          <div className="text-2xl font-mono font-bold mt-1">{employees.length}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Active Employee Sessions</div>
          <div className="text-2xl font-mono font-bold text-emerald-700 dark:text-emerald-400 mt-1">
            {activeSessions}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Captured OTP / Staff Logins</div>
          <div className="text-2xl font-mono font-bold text-blue-700 dark:text-blue-400 mt-1">{totalLogins}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Total Employee Tickets</div>
          <div className="text-2xl font-mono font-bold mt-1">{totalTicketsRaised}</div>
        </div>
      </div>

      {dirErr && (
        <div className="p-3 text-xs rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 flex items-center justify-between">
          <span>{dirErr}</span>
          <button type="button" onClick={() => setDirErr('')} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Auto-Captured Employee Login & Ticket History Directory */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-display font-semibold">
              Captured Employee Logins & Ticket History ({filteredEmployees.length})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Employees appear here automatically as soon as they log in via Mobile + OTP using the shareable link.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search name, mobile, hub..."
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <select
              value={hubFilter}
              onChange={(e) => {
                setHubFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Filter by location"
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="All">All Hubs</option>
              {locations.map((l) => (
                <option key={l.id} value={String(l.id)}>
                  {l.name}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as any);
                setPage(1);
              }}
              aria-label="Filter by status"
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="All">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
            <button
              type="button"
              disabled={exportRows.length === 0}
              onClick={() => exportToCsv('SD_Global_Employees', exportRows)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </button>
            <button
              type="button"
              disabled={exportRows.length === 0}
              onClick={() => exportToExcel('SD_Global_Employees', 'Employees', exportRows)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Excel
            </button>
            <button
              type="button"
              disabled={exportRows.length === 0}
              onClick={() => exportToPdf('SD_Global_Employees', 'Employee Directory', exportRows)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" />
              PDF
            </button>
            <button
              type="button"
              onClick={loadData}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => setMgmtModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Add Management Viewer
              </button>
            )}
          </div>
        </div>

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
                    Employee <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4">Mobile & Email</th>
                <th className="py-2.5 px-4">Department & Hub</th>
                <th className="py-2.5 px-4">
                  <button
                    type="button"
                    onClick={() => toggleSort('last_login_at')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Captured Login Info <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4 text-right">
                  <button
                    type="button"
                    onClick={() => toggleSort('ticket_count')}
                    className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                  >
                    Ticket History <ArrowUpDown className="w-3 h-3" />
                  </button>
                </th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {pagedEmployees.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-500">
                    No employees match the current filters.
                  </td>
                </tr>
              ) : (
                pagedEmployees.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900 dark:text-white">{e.full_name}</div>
                      <div className="font-mono text-slate-500">
                        {e.employee_code} · <span className="capitalize">{e.role_name?.replace('_', ' ') || 'employee'}</span>
                      </div>
                      <div className="text-slate-400">{e.designation}</div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-mono font-semibold text-slate-800 dark:text-slate-200">{e.mobile}</div>
                      <div className="truncate max-w-[190px] text-slate-500">{e.email}</div>
                    </td>
                    <td className="py-3 px-4">
                      <div>{e.department_name || '—'}</div>
                      <div className="text-slate-500">{e.location_name || 'Not specified'}</div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-mono">
                        <span className="font-semibold">{e.login_count ?? 0}</span> login(s) ·{' '}
                        <span className={e.active_sessions > 0 ? 'text-emerald-600 font-semibold' : 'text-slate-400'}>
                          {e.active_sessions > 0 ? 'Online' : 'Offline'}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-slate-500">
                        Last: {formatDateTime(e.last_login_at)}
                      </div>
                      {e.last_login_ip && (
                        <div className="font-mono text-[10px] text-slate-400">IP: {e.last_login_ip}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      <div className="font-semibold text-slate-900 dark:text-white">{e.ticket_count} total</div>
                      <div className="text-[11px] text-slate-500">
                        {e.open_ticket_count ?? 0} open · {e.resolved_ticket_count ?? 0} resolved
                      </div>
                      {e.latest_ticket_number && (
                        <div className="text-[10px] text-blue-600 dark:text-blue-400">{e.latest_ticket_number}</div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className={e.account_status === 'Active' ? 'text-emerald-600 font-semibold' : 'text-red-600'}>
                        {e.account_status || 'Active'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openEmployeeDetails(e.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 cursor-pointer"
                      >
                        <Eye className="w-3 h-3" />
                        Logins & Tickets
                      </button>
                      {isSuperAdmin && e.user_id && e.user_id !== user.id && (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleUserStatus(e.user_id, e.account_status)}
                            className="px-2 py-1 text-[11px] rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
                          >
                            {e.account_status === 'Active' ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteUser(e.user_id)}
                            aria-label="Delete user"
                            className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
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
            Showing {filteredEmployees.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, filteredEmployees.length)} of {filteredEmployees.length}
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

      {/* Locations & Warehouses Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-display font-semibold">Warehouses, Branches & Operational Hubs ({locations.length})</h3>
          </div>
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => setLocModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Hub / Branch
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4">Code</th>
                <th className="py-2.5 px-4">Facility Name</th>
                <th className="py-2.5 px-4">Type</th>
                <th className="py-2.5 px-4">City / State</th>
                <th className="py-2.5 px-4">Site Manager</th>
                <th className="py-2.5 px-4">Address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {locations.map((l) => (
                <tr key={l.id}>
                  <td className="py-2.5 px-4 font-mono font-semibold">{l.code}</td>
                  <td className="py-2.5 px-4 font-semibold">{l.name}</td>
                  <td className="py-2.5 px-4">{l.type}</td>
                  <td className="py-2.5 px-4">
                    {l.city}, {l.state}
                  </td>
                  <td className="py-2.5 px-4">{l.manager_name || '—'}</td>
                  <td className="py-2.5 px-4 text-slate-500">{l.address}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Employee Details, Login Info & Ticket History Modal */}
      {(detailLoading || detailData) && (
        <div className="fixed inset-0 z-50 bg-slate-950/65 flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-display font-bold">
                  {detailData ? `${detailData.employee.full_name} · Captured Profile & History` : 'Loading Employee History...'}
                </h3>
                {detailData && (
                  <p className="text-xs font-mono text-slate-500 mt-0.5">
                    {detailData.employee.employee_code} · {detailData.employee.mobile} · {detailData.employee.email}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setDetailData(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {detailLoading || !detailData ? (
              <div className="p-8 text-center text-xs text-slate-500">Loading login sessions and ticket history...</div>
            ) : (
              <div className="flex-1 overflow-y-auto p-6 space-y-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Department</div>
                    <div className="font-semibold mt-1">{detailData.employee.department_name || '—'}</div>
                  </div>
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Hub / Location</div>
                    <div className="font-semibold mt-1">{detailData.employee.location_name || '—'}</div>
                  </div>
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Last Login IP</div>
                    <div className="font-mono font-semibold mt-1">{detailData.employee.last_login_ip || '—'}</div>
                  </div>
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Last Login Time</div>
                    <div className="font-mono font-semibold mt-1">{formatDateTime(detailData.employee.last_login_at)}</div>
                  </div>
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
                  <button
                    type="button"
                    onClick={() => setDetailTab('tickets')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer inline-flex items-center gap-1.5 ${
                      detailTab === 'tickets' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
                    }`}
                  >
                    <Ticket className="w-3.5 h-3.5" />
                    Ticket History ({detailData.tickets.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetailTab('sessions')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer inline-flex items-center gap-1.5 ${
                      detailTab === 'sessions' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
                    }`}
                  >
                    <Smartphone className="w-3.5 h-3.5" />
                    Login Sessions ({detailData.sessions.length})
                  </button>
                </div>

                {detailTab === 'tickets' ? (
                  <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500">
                          <th className="py-2 px-3">Ticket #</th>
                          <th className="py-2 px-3">Category & Device</th>
                          <th className="py-2 px-3">Priority</th>
                          <th className="py-2 px-3">Status</th>
                          <th className="py-2 px-3">Assigned Moderator</th>
                          <th className="py-2 px-3">Created At</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {detailData.tickets.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="py-6 text-center text-slate-500">
                              No support tickets raised by this employee yet.
                            </td>
                          </tr>
                        ) : (
                          detailData.tickets.map((t) => (
                            <tr
                              key={t.id}
                              onClick={() => {
                                if (onSelectTicket) {
                                  setDetailData(null);
                                  onSelectTicket(t.id);
                                }
                              }}
                              className={onSelectTicket ? 'hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer' : ''}
                            >
                              <td className="py-2 px-3 font-mono font-semibold text-blue-700 dark:text-blue-400">
                                {t.ticket_number}
                              </td>
                              <td className="py-2 px-3">
                                <div className="font-medium">{t.category}</div>
                                <div className="text-slate-500">{t.device_name}</div>
                              </td>
                              <td className={`py-2 px-3 ${getPriorityColorClass(t.priority)}`}>{t.priority}</td>
                              <td className={`py-2 px-3 font-semibold ${getStatusColorClass(t.status)}`}>{t.status}</td>
                              <td className="py-2 px-3">{t.moderator_name || 'Unassigned'}</td>
                              <td className="py-2 px-3 font-mono text-slate-500">{formatDateTime(t.created_at)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500">
                          <th className="py-2 px-3">Login Time</th>
                          <th className="py-2 px-3">Last Activity</th>
                          <th className="py-2 px-3">Logout Time</th>
                          <th className="py-2 px-3 text-right">Duration</th>
                          <th className="py-2 px-3">IP Address</th>
                          <th className="py-2 px-3">Device / Browser</th>
                          <th className="py-2 px-3">State</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {detailData.sessions.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="py-6 text-center text-slate-500">
                              No login sessions recorded yet.
                            </td>
                          </tr>
                        ) : (
                          detailData.sessions.map((s) => (
                            <tr key={s.id}>
                              <td className="py-2 px-3 font-mono">{formatDateTime(s.login_at)}</td>
                              <td className="py-2 px-3 font-mono">{formatDateTime(s.last_activity_at || s.login_at)}</td>
                              <td className="py-2 px-3 font-mono">{formatDateTime(s.logout_at)}</td>
                              <td className="py-2 px-3 text-right font-mono">{s.duration_minutes ?? 0} mins</td>
                              <td className="py-2 px-3 font-mono text-slate-500">{s.ip_address}</td>
                              <td className="py-2 px-3 max-w-[200px] truncate text-slate-500">{s.user_agent}</td>
                              <td className="py-2 px-3">
                                <span className={s.is_active ? 'text-emerald-600 font-semibold' : 'text-slate-500'}>
                                  {s.is_active ? 'Active' : 'Ended'}
                                </span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Optional Management Read-Only Account Modal */}
      {mgmtModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateManagement}
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold">Add Management Read-Only Viewer</h3>
              <button type="button" onClick={() => setMgmtModalOpen(false)}>
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            {err && <div className="p-2.5 text-xs rounded bg-red-50 text-red-700">{err}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Employee ID *</label>
                <input
                  required
                  value={empCode}
                  onChange={(e) => setEmpCode(e.target.value)}
                  placeholder="MGMT-100"
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
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
                <label className="block text-xs font-medium mb-1">Email *</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Mobile *</label>
                <input
                  required
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Designation *</label>
                <input
                  required
                  value={designation}
                  onChange={(e) => setDesignation(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Initial Password (Optional)</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Optional"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Department</label>
                <select
                  value={deptId}
                  onChange={(e) => setDeptId(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="">Select...</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Location / Hub</label>
                <select
                  value={locId}
                  onChange={(e) => setLocId(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="">Select...</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setMgmtModalOpen(false)}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
              >
                Create Viewer
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add Location Modal */}
      {locModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateLocation}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3"
          >
            <h3 className="text-base font-display font-bold">Add Warehouse / Branch</h3>
            <input
              required
              placeholder="Location Code (e.g. WH-AMD-07)"
              value={locCode}
              onChange={(e) => setLocCode(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              required
              placeholder="Facility Name"
              value={locName}
              onChange={(e) => setLocName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <select
              value={locType}
              onChange={(e) => setLocType(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="Warehouse">Warehouse</option>
              <option value="Branch">Branch</option>
              <option value="Hub">Logistics Hub</option>
              <option value="Corporate Office">Corporate Office</option>
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input
                required
                placeholder="City"
                value={locCity}
                onChange={(e) => setLocCity(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <input
                required
                placeholder="State"
                value={locState}
                onChange={(e) => setLocState(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <input
              required
              placeholder="Full Street Address"
              value={locAddress}
              onChange={(e) => setLocAddress(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              placeholder="Site Manager Name"
              value={locMgr}
              onChange={(e) => setLocMgr(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setLocModalOpen(false)}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white"
              >
                Save Location
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
