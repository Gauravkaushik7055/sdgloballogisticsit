import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Calendar,
  Download,
  FileSpreadsheet,
  FileText,
  Globe,
  Monitor,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAuth } from '../../context/AuthContext.tsx';
import { WebsiteTrafficResponse } from '../../types/index.ts';
import { apiFetch, formatDateTime } from '../../utils/api.ts';
import { exportToCsv, exportToExcel, exportToPdf } from '../../utils/exportUtils.ts';

interface WebsiteTrafficViewProps {
  onBackToDashboard?: () => void;
}

type Granularity = 'daily' | 'weekly' | 'monthly' | 'yearly';

export default function WebsiteTrafficView({ onBackToDashboard }: WebsiteTrafficViewProps) {
  const { subscribeRealtime } = useAuth();
  const [data, setData] = useState<WebsiteTrafficResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [pageFilter, setPageFilter] = useState('All');
  const [visitSearch, setVisitSearch] = useState('');
  const [pageIndex, setPageIndex] = useState(1);

  const loadTraffic = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('granularity', granularity);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (pageFilter && pageFilter !== 'All') params.set('page_path', pageFilter);
      const res = await apiFetch<WebsiteTrafficResponse>(`/api/analytics/website-traffic?${params.toString()}`);
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Unable to load website traffic analytics.');
    } finally {
      setLoading(false);
    }
  }, [granularity, dateFrom, dateTo, pageFilter]);

  useEffect(() => {
    loadTraffic();
  }, [loadTraffic]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'traffic:updated') {
        loadTraffic();
      }
    });
  }, [subscribeRealtime, loadTraffic]);

  const filteredRecent = useMemo(() => {
    const list = data?.recent_visits || [];
    const q = visitSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (v) =>
        v.page_path.toLowerCase().includes(q) ||
        v.referrer.toLowerCase().includes(q) ||
        v.device_type.toLowerCase().includes(q) ||
        v.visitor_token.toLowerCase().includes(q)
    );
  }, [data, visitSearch]);

  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(filteredRecent.length / pageSize));
  const currentPage = Math.min(pageIndex, totalPages);
  const pagedRecent = filteredRecent.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const totalDeviceVisits = useMemo(
    () => (data?.devices || []).reduce((acc, d) => acc + d.visits, 0),
    [data]
  );

  const exportRows = useMemo(
    () =>
      filteredRecent.map((v) => ({
        VisitedAt: formatDateTime(v.visited_at),
        PagePath: v.page_path,
        Referrer: v.referrer,
        Device: v.device_type,
        VisitorToken: v.visitor_token,
      })),
    [filteredRecent]
  );

  const s = data?.summary;
  const growth = s?.growth_pct ?? 0;

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
            Public Website Visit Counter & Traffic Analytics
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Privacy-safe visitor telemetry on public entry pages with automated bot filtering and 30-minute session deduplication.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={loadTraffic}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => exportToCsv('sd_global_website_traffic', exportRows)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
          <button
            type="button"
            onClick={() => exportToExcel('sd_global_website_traffic', 'Traffic', exportRows)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Excel
          </button>
          <button
            type="button"
            onClick={() =>
              exportToPdf('sd_global_website_traffic', 'SD Global Website Traffic Log', exportRows)
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            PDF
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Total Visits</div>
          <div className="text-xl font-mono font-bold tabular-nums mt-1">{s?.total_visits ?? 0}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Unique Visitors</div>
          <div className="text-xl font-mono font-bold text-blue-700 dark:text-blue-400 tabular-nums mt-1">
            {s?.unique_visitors ?? 0}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Today</div>
          <div className="text-xl font-mono font-bold tabular-nums mt-1">{s?.today_visits ?? 0}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Yesterday</div>
          <div className="text-xl font-mono font-bold tabular-nums mt-1">{s?.yesterday_visits ?? 0}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">This Week</div>
          <div className="text-xl font-mono font-bold tabular-nums mt-1">{s?.weekly_visits ?? 0}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">This Month</div>
          <div className="text-xl font-mono font-bold tabular-nums mt-1">{s?.monthly_visits ?? 0}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Active Now</div>
          <div className="text-xl font-mono font-bold text-emerald-600 dark:text-emerald-400 tabular-nums mt-1 flex items-center gap-1.5">
            <Activity className="w-4 h-4 shrink-0" />
            {s?.active_visitors_now ?? 0}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Weekly Growth</div>
          <div
            className={`text-xl font-mono font-bold tabular-nums mt-1 flex items-center gap-1 ${
              growth >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {growth >= 0 ? <TrendingUp className="w-4 h-4 shrink-0" /> : <TrendingDown className="w-4 h-4 shrink-0" />}
            {growth > 0 ? `+${growth}%` : `${growth}%`}
          </div>
        </div>
      </div>

      {/* Filter & Granularity Controls */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          {(['daily', 'weekly', 'monthly', 'yearly'] as Granularity[]).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGranularity(g)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md capitalize cursor-pointer transition-colors ${
                granularity === g
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {g}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Calendar className="w-3.5 h-3.5" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="From date"
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
            />
            <span>to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="To date"
              className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
            />
          </div>

          <select
            value={pageFilter}
            onChange={(e) => {
              setPageFilter(e.target.value);
              setPageIndex(1);
            }}
            aria-label="Filter by page path"
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Pages</option>
            {(data?.top_pages || []).map((p) => (
              <option key={p.page_path} value={p.page_path}>
                {p.page_path} ({p.visits})
              </option>
            ))}
          </select>

          {(dateFrom || dateTo || pageFilter !== 'All') && (
            <button
              type="button"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setPageFilter('All');
              }}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* Interactive Trend Chart */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              Visits & Unique Visitors Over Time ({granularity})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Deduplicated public page sessions across desktop, mobile, and tablet clients.
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500 tabular-nums">
            Annual Total: {s?.yearly_visits ?? 0}
          </span>
        </div>

        <div className="h-72 w-full">
          {loading && !data ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-500">
              Loading visit telemetry chart...
            </div>
          ) : (data?.trend || []).length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-500">
              No public visit data recorded for this window yet.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.trend || []} margin={{ top: 10, right: 16, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="visitFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="uniqueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#059669" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#059669" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.2} />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} stroke="#64748b" />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="#64748b" />
                <Tooltip
                  contentStyle={{
                    fontSize: '12px',
                    borderRadius: '8px',
                    borderColor: '#cbd5e1',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="visits"
                  name="Total Visits"
                  stroke="#1d4ed8"
                  strokeWidth={2}
                  fill="url(#visitFill)"
                />
                <Area
                  type="monotone"
                  dataKey="unique_visitors"
                  name="Unique Visitors"
                  stroke="#059669"
                  strokeWidth={2}
                  fill="url(#uniqueFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Pages / Referrers / Devices Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Top Visited Pages */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Globe className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-display font-semibold">Most Visited Pages</h3>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {(data?.top_pages || []).length === 0 ? (
              <div className="py-6 text-center text-slate-500">No pages recorded yet.</div>
            ) : (
              data!.top_pages.map((p) => (
                <div key={p.page_path} className="py-2.5 flex items-center justify-between gap-2">
                  <span className="font-mono text-slate-700 dark:text-slate-300 truncate">{p.page_path}</span>
                  <span className="font-mono font-semibold tabular-nums whitespace-nowrap shrink-0">
                    {p.visits} <span className="text-slate-400 font-normal">({p.unique_visitors} uniq)</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Referral Sources */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-emerald-600" />
            <h3 className="text-sm font-display font-semibold">Referral Sources</h3>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {(data?.referrers || []).length === 0 ? (
              <div className="py-6 text-center text-slate-500">No referrer records yet.</div>
            ) : (
              data!.referrers.map((r) => (
                <div key={r.source} className="py-2.5 flex items-center justify-between gap-2">
                  <span className="text-slate-700 dark:text-slate-300 truncate">{r.source}</span>
                  <span className="font-mono font-semibold tabular-nums whitespace-nowrap shrink-0">
                    {r.visits} visits
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Device Breakdown */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Monitor className="w-4 h-4 text-indigo-600" />
            <h3 className="text-sm font-display font-semibold">Device Type Breakdown</h3>
          </div>
          <div className="space-y-3 text-xs">
            {(data?.devices || []).length === 0 ? (
              <div className="py-6 text-center text-slate-500">No device telemetry yet.</div>
            ) : (
              data!.devices.map((d) => {
                const pct = totalDeviceVisits > 0 ? Math.round((d.visits / totalDeviceVisits) * 100) : 0;
                return (
                  <div key={d.device_type} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-700 dark:text-slate-300">{d.device_type}</span>
                      <span className="font-mono tabular-nums font-semibold">
                        {d.visits} ({pct}%)
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div className="h-full bg-blue-600 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Recent Sanitized Visits Log */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-display font-semibold">Recent Public Visits Log</h3>
            <p className="text-xs text-slate-500">Anonymized visitor hashes only (zero raw IP or PII stored).</p>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={visitSearch}
              onChange={(e) => {
                setVisitSearch(e.target.value);
                setPageIndex(1);
              }}
              placeholder="Filter path, device, referrer..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="py-2.5 px-4">Timestamp</th>
                <th className="py-2.5 px-4">Page Path</th>
                <th className="py-2.5 px-4">Referrer</th>
                <th className="py-2.5 px-4">Device</th>
                <th className="py-2.5 px-4">Visitor Token</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {pagedRecent.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    No visit entries found.
                  </td>
                </tr>
              ) : (
                pagedRecent.map((v, idx) => (
                  <tr key={`${v.visited_at}-${v.visitor_token}-${idx}`}>
                    <td className="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">
                      {formatDateTime(v.visited_at)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-900 dark:text-white">{v.page_path}</td>
                    <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300">{v.referrer}</td>
                    <td className="py-2.5 px-4 text-slate-700 dark:text-slate-300">{v.device_type}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-400">{v.visitor_token}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
          <span className="font-mono tabular-nums">
            Showing {filteredRecent.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, filteredRecent.length)} of {filteredRecent.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPageIndex((p) => Math.max(1, p - 1))}
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
              onClick={() => setPageIndex((p) => Math.min(totalPages, p + 1))}
              className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
