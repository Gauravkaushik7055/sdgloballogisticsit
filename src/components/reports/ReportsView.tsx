import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpDown,
  BookmarkCheck,
  BookmarkPlus,
  Download,
  FileSpreadsheet,
  FileText,
  Search,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { ISSUE_CATEGORIES, LocationItem, ModeratorItem, SavedReportItem } from '../../types/index.ts';
import { apiFetch, formatCurrency, formatDateTime } from '../../utils/api.ts';
import { exportToCsv, exportToExcel, exportToPdf } from '../../utils/exportUtils.ts';

const REPORT_TYPES = [
  { id: 'daily', label: 'Daily Ticket Report' },
  { id: 'weekly', label: 'Weekly Ticket Report' },
  { id: 'monthly', label: 'Monthly Ticket Report' },
  { id: 'location', label: 'Location-Wise Issue Report' },
  { id: 'moderator', label: 'Moderator Performance Report' },
  { id: 'pending', label: 'Pending Ticket Report' },
  { id: 'resolution-time', label: 'Resolution Time Report' },
  { id: 'first-response-time', label: 'First Response Time Report' },
  { id: 'asset-maintenance', label: 'Asset Maintenance Report' },
  { id: 'budget', label: 'IT Budget Report (INR)' },
  { id: 'expense', label: 'Expense Report (INR)' },
  { id: 'employee', label: 'Employee-Wise Issue Report' },
  { id: 'sla-breach', label: 'SLA Breach Report' },
];

const INR_COLUMNS = new Set([
  'ticket_expenses_inr',
  'cost_inr',
  'allocated_amount_inr',
  'amount_inr',
]);

function formatReportCell(col: string, val: any): string {
  if (val === null || val === undefined || val === '') return '—';
  if (INR_COLUMNS.has(col)) {
    const n = Number(val);
    if (!Number.isNaN(n)) return formatCurrency(n);
  }
  return String(val);
}

interface ReportsViewProps {
  initialReportType?: { key: number; reportType: string } | null;
  onBackToDashboard?: () => void;
}

export default function ReportsView({ initialReportType, onBackToDashboard }: ReportsViewProps) {
  const { user, subscribeRealtime } = useAuth();

  const canViewReports =
    user?.role !== 'management' || user.permissions?.can_view_reports !== false;
  const canViewBudgets =
    user?.role === 'super_admin' || (user?.role === 'management' && Boolean(user.permissions?.can_view_budgets));
  const canExport =
    user?.role !== 'management' || user.permissions?.can_export_data !== false;
  const canSaveSnapshots = user?.role === 'super_admin' || (user?.role === 'management' && canViewReports);

  const [tab, setTab] = useState<'live' | 'saved'>('live');
  const [selectedReport, setSelectedReport] = useState(initialReportType?.reportType || 'monthly');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [locationId, setLocationId] = useState('All');
  const [category, setCategory] = useState('All');
  const [moderatorId, setModeratorId] = useState('All');
  const [tableSearch, setTableSearch] = useState('');
  const [sortCol, setSortCol] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [moderators, setModerators] = useState<ModeratorItem[]>([]);
  const [reportData, setReportData] = useState<{ title: string; rows: any[]; generatedAt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [savingSnapshot, setSavingSnapshot] = useState(false);

  // Saved Report Snapshots
  const [savedReports, setSavedReports] = useState<SavedReportItem[]>([]);
  const [savedTypeFilter, setSavedTypeFilter] = useState('All');
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [activeSnapshot, setActiveSnapshot] = useState<SavedReportItem | null>(null);

  useEffect(() => {
    if (initialReportType?.reportType) {
      setTab('live');
      setSelectedReport(initialReportType.reportType);
      setSortCol('');
      setPage(1);
    }
  }, [initialReportType?.key]);

  const loadReport = useCallback(async () => {
    if (!canViewReports) return;
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set('date_from', dateFrom);
      if (dateTo) qs.set('date_to', dateTo);
      if (locationId !== 'All') qs.set('location_id', locationId);
      if (category !== 'All') qs.set('category', category);
      if (moderatorId !== 'All') qs.set('moderator_id', moderatorId);

      const res = await apiFetch<any>(`/api/reports/${selectedReport}?${qs.toString()}`);
      setReportData(res);
    } catch (err: any) {
      setError(err.message || 'Unable to generate report');
    } finally {
      setLoading(false);
    }
  }, [canViewReports, selectedReport, dateFrom, dateTo, locationId, category, moderatorId]);

  const loadSavedReports = useCallback(async () => {
    if (!canSaveSnapshots) return;
    setLoadingSaved(true);
    try {
      const qs = new URLSearchParams();
      if (savedTypeFilter !== 'All') qs.set('report_type', savedTypeFilter);
      const res = await apiFetch<{ savedReports: SavedReportItem[] }>(`/api/reports/saved?${qs.toString()}`);
      setSavedReports(res.savedReports || []);
    } catch {
      // ignore if restricted
    } finally {
      setLoadingSaved(false);
    }
  }, [canSaveSnapshots, savedTypeFilter]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  useEffect(() => {
    if (tab === 'saved') {
      loadSavedReports();
    }
  }, [tab, loadSavedReports]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'ticket:updated' || evt.event === 'directory:updated' || evt.event === 'budget:updated') {
        loadReport();
      }
    });
  }, [subscribeRealtime, loadReport]);

  useEffect(() => {
    apiFetch<{ locations: LocationItem[] }>('/api/locations')
      .then((r) => setLocations(r.locations || []))
      .catch(() => {});
    if (user?.role !== 'moderator') {
      apiFetch<{ moderators: ModeratorItem[] }>('/api/moderators')
        .then((r) => setModerators(r.moderators || []))
        .catch(() => {});
    }
  }, [user]);

  const rawRows = reportData?.rows || [];
  const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];

  const filteredAndSortedRows = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    const list = !q
      ? [...rawRows]
      : rawRows.filter((row) =>
          Object.values(row).some((val) => val !== null && val !== undefined && String(val).toLowerCase().includes(q))
        );

    if (sortCol) {
      list.sort((a, b) => {
        const va = a[sortCol];
        const vb = b[sortCol];
        if (va === vb) return 0;
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        const na = Number(va);
        const nb = Number(vb);
        const cmp = !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : String(va).localeCompare(String(vb));
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return list;
  }, [rawRows, tableSearch, sortCol, sortDir]);

  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(filteredAndSortedRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = filteredAndSortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const visibleReports = REPORT_TYPES.filter((r) => {
    if ((user?.role === 'moderator' || !canViewBudgets) && ['budget', 'expense'].includes(r.id)) {
      return false;
    }
    return true;
  });

  const toggleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
    setPage(1);
  };

  const handleSaveSnapshot = async () => {
    if (!reportData) return;
    setSavingSnapshot(true);
    setSaveMessage('');
    setError('');
    try {
      const label = REPORT_TYPES.find((r) => r.id === selectedReport)?.label || reportData.title;
      const stamp = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const res = await apiFetch<{ id: number; row_count: number }>('/api/reports/save', {
        method: 'POST',
        body: JSON.stringify({
          report_type: selectedReport,
          title: `${label} (${stamp})`,
          filters: { dateFrom, dateTo, locationId, category, moderatorId },
          rows: filteredAndSortedRows,
        }),
      });
      setSaveMessage(`Saved snapshot #${res.id} with ${res.row_count} row(s) to historical archive.`);
      loadSavedReports();
    } catch (err: any) {
      setError(err.message || 'Failed to save report snapshot');
    } finally {
      setSavingSnapshot(false);
    }
  };

  const handleOpenSnapshot = async (id: number) => {
    try {
      const res = await apiFetch<{ snapshot: SavedReportItem }>(`/api/reports/saved/${id}`);
      setActiveSnapshot(res.snapshot);
    } catch (err: any) {
      setError(err.message || 'Unable to load saved snapshot');
    }
  };

  const handleDeleteSnapshot = async (id: number) => {
    try {
      await apiFetch(`/api/reports/saved/${id}`, { method: 'DELETE' });
      if (activeSnapshot?.id === id) setActiveSnapshot(null);
      loadSavedReports();
    } catch (err: any) {
      setError(err.message || 'Unable to delete snapshot');
    }
  };

  if (!canViewReports) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center space-y-2">
        <ShieldAlert className="w-8 h-8 text-amber-500 mx-auto" />
        <h3 className="text-sm font-display font-bold">Enterprise Reports Restricted</h3>
        <p className="text-xs text-slate-500">
          Report generation is disabled for your Admin account. Contact the Super Admin to update permissions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {onBackToDashboard ? (
          <button
            type="button"
            onClick={onBackToDashboard}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Super Admin Dashboard
          </button>
        ) : (
          <div />
        )}

        {canSaveSnapshots && (
          <div className="flex items-center gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-1">
            <button
              type="button"
              onClick={() => setTab('live')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap ${
                tab === 'live' ? 'bg-blue-700 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              Live Enterprise Reports
            </button>
            <button
              type="button"
              onClick={() => setTab('saved')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer whitespace-nowrap ${
                tab === 'saved' ? 'bg-blue-700 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <BookmarkCheck className="w-3.5 h-3.5" />
              Saved Report History
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {saveMessage && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-700 dark:text-emerald-300">
          {saveMessage}
        </div>
      )}

      {tab === 'live' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Report Selector List */}
          <div className="lg:col-span-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 space-y-1 h-fit">
            <div className="px-2 py-1.5 text-xs font-semibold text-slate-500">Available Reports</div>
            {visibleReports.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setSelectedReport(r.id);
                  setSortCol('');
                  setPage(1);
                }}
                className={`w-full text-left px-3 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                  selectedReport === r.id
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Report Workspace */}
          <div className="lg:col-span-9 space-y-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-display font-bold">{reportData?.title || 'Enterprise Report'}</h2>
                  <p className="text-xs font-mono text-slate-500 mt-0.5 tabular-nums">
                    {filteredAndSortedRows.length} record(s) matched
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canSaveSnapshots && (
                    <button
                      type="button"
                      disabled={savingSnapshot || loading}
                      onClick={handleSaveSnapshot}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <BookmarkPlus className="w-3.5 h-3.5" />
                      {savingSnapshot ? 'Saving...' : 'Save Report Snapshot'}
                    </button>
                  )}
                  {canExport && (
                    <>
                      <button
                        type="button"
                        disabled={filteredAndSortedRows.length === 0}
                        onClick={() =>
                          exportToExcel(`SD_Global_${selectedReport}_report`, selectedReport, filteredAndSortedRows)
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        Excel (.xlsx)
                      </button>
                      <button
                        type="button"
                        disabled={filteredAndSortedRows.length === 0}
                        onClick={() =>
                          exportToPdf(
                            `SD_Global_${selectedReport}_report`,
                            reportData?.title || selectedReport,
                            filteredAndSortedRows
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-700 hover:opacity-90 text-white disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        PDF
                      </button>
                      <button
                        type="button"
                        disabled={filteredAndSortedRows.length === 0}
                        onClick={() => exportToCsv(`SD_Global_${selectedReport}_report`, filteredAndSortedRows)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Download className="w-3.5 h-3.5" />
                        CSV
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5">
                <div className="relative col-span-2 sm:col-span-2">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={tableSearch}
                    onChange={(e) => {
                      setTableSearch(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Search report rows..."
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
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
                <select
                  value={locationId}
                  onChange={(e) => {
                    setLocationId(e.target.value);
                    setPage(1);
                  }}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="All">All Locations</option>
                  {locations.map((l) => (
                    <option key={l.id} value={String(l.id)}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <select
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setPage(1);
                  }}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="All">All Categories</option>
                  {ISSUE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {user?.role !== 'moderator' && (
                  <select
                    value={moderatorId}
                    onChange={(e) => {
                      setModeratorId(e.target.value);
                      setPage(1);
                    }}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 col-span-2 sm:col-span-2"
                  >
                    <option value="All">All Moderators</option>
                    {moderators.map((m) => (
                      <option key={m.id} value={String(m.id)}>
                        {m.full_name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            {/* Report Table Preview */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                      {columns.map((col) => (
                        <th key={col} className="py-2.5 px-4 whitespace-nowrap capitalize">
                          <button
                            type="button"
                            onClick={() => toggleSort(col)}
                            className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                          >
                            {col.replace(/_/g, ' ')}
                            <ArrowUpDown className="w-3 h-3" />
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {loading ? (
                      <tr>
                        <td colSpan={Math.max(1, columns.length)} className="py-10 text-center text-slate-500">
                          Generating report...
                        </td>
                      </tr>
                    ) : pagedRows.length === 0 ? (
                      <tr>
                        <td colSpan={Math.max(1, columns.length)} className="py-10 text-center text-slate-500">
                          No records match this report filter.
                        </td>
                      </tr>
                    ) : (
                      pagedRows.map((r, idx) => (
                        <tr key={idx}>
                          {columns.map((col) => (
                            <td key={col} className="py-2.5 px-4 font-mono tabular-nums whitespace-nowrap">
                              {formatReportCell(col, r[col])}
                            </td>
                          ))}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
                <span className="font-mono tabular-nums">
                  Showing {filteredAndSortedRows.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}–
                  {Math.min(currentPage * pageSize, filteredAndSortedRows.length)} of {filteredAndSortedRows.length}
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
          </div>
        </div>
      ) : (
        /* Saved Report Snapshots History */
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-display font-bold">Saved Report Snapshots ({savedReports.length})</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Historical point-in-time report archives preserved per organizational data retention policies.
              </p>
            </div>
            <select
              value={savedTypeFilter}
              onChange={(e) => setSavedTypeFilter(e.target.value)}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="All">All Report Types</option>
              {visibleReports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                  <th className="py-2.5 px-4">Snapshot Title</th>
                  <th className="py-2.5 px-4">Type</th>
                  <th className="py-2.5 px-4 text-right">Rows</th>
                  <th className="py-2.5 px-4">Saved By</th>
                  <th className="py-2.5 px-4">Captured At</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {loadingSaved ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      Loading saved snapshots...
                    </td>
                  </tr>
                ) : savedReports.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      No report snapshots saved yet. Use "Save Report Snapshot" on any live report to archive it.
                    </td>
                  </tr>
                ) : (
                  savedReports.map((sr) => (
                    <tr key={sr.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-2.5 px-4 font-semibold">{sr.title}</td>
                      <td className="py-2.5 px-4 font-mono text-slate-500">{sr.report_type}</td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums">{sr.row_count}</td>
                      <td className="py-2.5 px-4">
                        {sr.created_by_name} <span className="text-slate-400">({sr.created_by_role})</span>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-500">{formatDateTime(sr.created_at)}</td>
                      <td className="py-2.5 px-4 text-right space-x-1.5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleOpenSnapshot(sr.id)}
                          className="px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          Open Snapshot
                        </button>
                        {user?.role === 'super_admin' && (
                          <button
                            type="button"
                            onClick={() => handleDeleteSnapshot(sr.id)}
                            aria-label="Delete snapshot"
                            className="p-1 rounded border border-red-200 dark:border-red-900 text-red-600 hover:bg-red-50 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
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
      )}

      {/* Saved Snapshot Viewer Modal */}
      {activeSnapshot && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-display font-bold">{activeSnapshot.title}</h3>
                <p className="text-xs font-mono text-slate-500 mt-0.5">
                  Type: {activeSnapshot.report_type} · {activeSnapshot.row_count} rows · Saved by{' '}
                  {activeSnapshot.created_by_name} on {formatDateTime(activeSnapshot.created_at)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {canExport && (activeSnapshot.rows || []).length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        exportToExcel(
                          `SD_Global_Snapshot_${activeSnapshot.id}`,
                          activeSnapshot.report_type,
                          activeSnapshot.rows || []
                        )
                      }
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 text-white cursor-pointer"
                    >
                      Excel
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        exportToCsv(`SD_Global_Snapshot_${activeSnapshot.id}`, activeSnapshot.rows || [])
                      }
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                    >
                      CSV
                    </button>
                  </>
                )}
                <button type="button" onClick={() => setActiveSnapshot(null)} className="cursor-pointer">
                  <X className="w-4 h-4 text-slate-400" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto border border-slate-200 dark:border-slate-800 rounded-lg">
              {(activeSnapshot.rows || []).length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">Snapshot contains 0 rows.</div>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-500">
                      {Object.keys(activeSnapshot.rows![0]).map((col) => (
                        <th key={col} className="py-2 px-3 whitespace-nowrap capitalize">
                          {col.replace(/_/g, ' ')}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {activeSnapshot.rows!.map((r, i) => (
                      <tr key={i}>
                        {Object.keys(activeSnapshot.rows![0]).map((col) => (
                          <td key={col} className="py-2 px-3 font-mono tabular-nums whitespace-nowrap">
                            {formatReportCell(col, r[col])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
