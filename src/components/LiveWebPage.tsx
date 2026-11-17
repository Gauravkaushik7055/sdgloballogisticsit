import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Building2,
  Check,
  Clock,
  Headphones,
  Moon,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Sun,
  Ticket,
  Wrench,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext.tsx';
import { apiFetch, formatDateTime, getPriorityColorClass, getStatusColorClass } from '../utils/api.ts';
import { sendVisitHeartbeat, trackPublicVisit } from '../utils/visitTracker.ts';
import heroImage from '../assets/images/logistics_hub_hero_1794807790640.jpg';
import SdGlobalLogo from './SdGlobalLogo.tsx';

export type PortalEntryMode = 'employee_otp' | 'staff_email' | 'moderator_common';

interface LiveOverviewResponse {
  company: {
    name: string;
    portal_title: string;
    support_email: string;
  };
  metrics: {
    active_locations: number;
    active_moderators: number;
    total_tickets: number;
    active_tickets: number;
    completed_tickets: number;
  };
  locations: Array<{
    id: number;
    code: string;
    name: string;
    type: string;
    city: string;
    state: string;
  }>;
  sla_tiers: Array<{
    priority: string;
    first_response_minutes: number;
    resolution_hours: number;
    working_hours_start: string;
    working_hours_end: string;
  }>;
  server_time: string;
}

interface TrackedTicketResponse {
  ticket: {
    ticket_number: string;
    status: string;
    priority: string;
    category: string;
    device_name: string;
    location_name: string;
    assignment_state: string;
    created_at: string;
    updated_at: string;
    sla_resolution_due_at: string | null;
  };
  timeline: Array<{
    action: string;
    previous_status: string | null;
    new_status: string | null;
    created_at: string;
  }>;
}

interface LiveWebPageProps {
  isAuthenticated: boolean;
  onEnterWorkspace?: () => void;
  onOpenPortal: (mode: PortalEntryMode) => void;
}

const CORE_FLOW_STEPS = [
  'Assigned',
  'Accepted',
  'Under Review',
  'In Progress',
  'Ready for Review',
  'Completed',
] as const;

export default function LiveWebPage({
  isAuthenticated,
  onEnterWorkspace,
  onOpenPortal,
}: LiveWebPageProps) {
  const { theme, toggleTheme } = useTheme();
  const [overview, setOverview] = useState<LiveOverviewResponse | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [ticketQuery, setTicketQuery] = useState('');
  const [mobileLast4, setMobileLast4] = useState('');
  const [tracking, setTracking] = useState(false);
  const [trackError, setTrackError] = useState('');
  const [trackedResult, setTrackedResult] = useState<TrackedTicketResponse | null>(null);

  const loadOverview = useCallback(async (silent = false) => {
    if (!silent) setLoadingOverview(true);
    else setRefreshing(true);
    try {
      const res = await apiFetch<LiveOverviewResponse>('/api/public/live-overview');
      setOverview(res);
    } catch {
      // Keep previous overview on transient errors
    } finally {
      setLoadingOverview(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadOverview(false);
    const interval = window.setInterval(() => {
      loadOverview(true);
    }, 30000);
    return () => window.clearInterval(interval);
  }, [loadOverview]);

  useEffect(() => {
    if (isAuthenticated) return;
    trackPublicVisit('/');
    const hb = window.setInterval(() => {
      sendVisitHeartbeat('/');
    }, 60000);
    return () => window.clearInterval(hb);
  }, [isAuthenticated]);

  const handleTrackTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    setTrackError('');
    setTrackedResult(null);

    const cleanNum = ticketQuery.trim().toUpperCase();
    const cleanDigits = mobileLast4.replace(/\D/g, '');
    if (!cleanNum) {
      setTrackError('Please enter your ticket number (e.g. INC-2026-0001).');
      return;
    }
    if (cleanDigits.length !== 4) {
      setTrackError('Enter the last 4 digits of the mobile number used on the ticket.');
      return;
    }

    setTracking(true);
    try {
      const res = await apiFetch<TrackedTicketResponse>('/api/public/track-ticket', {
        method: 'POST',
        body: JSON.stringify({
          ticket_number: cleanNum,
          mobile_last4: cleanDigits,
        }),
      });
      setTrackedResult(res);
    } catch (err: any) {
      setTrackError(err?.message || 'Unable to verify ticket status.');
    } finally {
      setTracking(false);
    }
  };

  const formatSlaMinutes = (mins: number) => {
    if (mins < 60) return `${mins} min`;
    const hrs = Math.round((mins / 60) * 10) / 10;
    return `${hrs} hr${hrs === 1 ? '' : 's'}`;
  };

  const getProgressIndex = (status: string) => {
    const idx = CORE_FLOW_STEPS.indexOf(status as (typeof CORE_FLOW_STEPS)[number]);
    if (idx >= 0) return idx;
    if (status === 'On Hold' || status === 'Pending Information') return 3;
    if (status === 'Revision Required') return 4;
    if (status === 'New') return -1;
    return 0;
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-950/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between gap-4">
          <a href="#top" className="flex items-center gap-3 shrink-0">
            <SdGlobalLogo size={36} withWhiteSurface />
            <span className="font-display font-bold text-base tracking-tight text-slate-900 dark:text-white">
              SD Global
            </span>
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600 dark:text-slate-300">
            <a href="#capabilities" className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors">
              Capabilities
            </a>
            <a href="#network" className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors">
              Live Network
            </a>
            <a href="#track-ticket" className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors">
              Track Ticket
            </a>
            <a href="#sla" className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors">
              SLA Schedule
            </a>
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle color theme"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-900 text-slate-600 dark:text-slate-300 cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            {isAuthenticated && onEnterWorkspace ? (
              <button
                type="button"
                onClick={onEnterWorkspace}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors cursor-pointer"
              >
                <span>Open Workspace</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onOpenPortal('staff_email')}
                  className="hidden sm:inline-flex items-center px-3.5 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer"
                >
                  Staff Sign In
                </button>
                <button
                  type="button"
                  onClick={() => onOpenPortal('employee_otp')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors cursor-pointer"
                >
                  <span>Raise IT Ticket</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="top" className="flex-1">
        {/* Hero Section */}
        <section className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
          <div className="max-w-7xl mx-auto px-5 sm:px-8 py-12 lg:py-20 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
            <div className="lg:col-span-6 space-y-6">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-400">
                SD Global IT Operations &amp; Support Desk
              </div>

              <h1 className="font-display font-bold tracking-tight text-slate-900 dark:text-white text-[clamp(2.25rem,4vw,3.5rem)] leading-[1.08]">
                Centralized IT Support Across Every SD Global Hub.
              </h1>

              <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                Report barcode scanner, printer, CCTV, network, and WMS issues from any warehouse or corporate branch
                via mobile OTP, and follow every repair step through Super Admin sign-off.
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => (isAuthenticated && onEnterWorkspace ? onEnterWorkspace() : onOpenPortal('employee_otp'))}
                  className="inline-flex items-center gap-2 px-6 py-3.5 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors cursor-pointer"
                >
                  <Smartphone className="w-4 h-4" />
                  <span>{isAuthenticated ? 'Go to Dashboard' : 'Raise Support Ticket'}</span>
                </button>

                {!isAuthenticated && (
                  <button
                    type="button"
                    onClick={() => onOpenPortal('staff_email')}
                    className="inline-flex items-center gap-2 px-5 py-3.5 text-sm font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors cursor-pointer"
                  >
                    <ShieldCheck className="w-4 h-4 text-blue-700 dark:text-blue-400" />
                    <span>Admin &amp; Moderator Portal</span>
                  </button>
                )}
              </div>

              <div className="pt-2 text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-x-6 gap-y-2">
                <span>Role-Based Access Control</span>
                <span>9-Step Verified Task Workflow</span>
                <span>24/7 Critical Priority Routing</span>
              </div>
            </div>

            <div className="lg:col-span-6">
              <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-900">
                <img
                  src={heroImage}
                  alt="SD Global automated logistics facility and IT infrastructure"
                  className="w-full aspect-16/10 object-cover"
                />
                <div className="px-5 py-3.5 bg-slate-950 text-slate-300 flex items-center justify-between gap-4 text-xs border-t border-slate-800">
                  <span>Multi-Hub Infrastructure &amp; Field IT Operations</span>
                  <span className="font-mono text-slate-400">
                    {overview?.server_time ? `Synced ${formatDateTime(overview.server_time)}` : 'Live Service Desk'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Live Operational Pulse Strip */}
          <div className="border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50">
            <div className="max-w-7xl mx-auto px-5 sm:px-8 py-5 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 flex-1">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Active Logistics Hubs</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                    {loadingOverview ? '--' : overview?.metrics.active_locations ?? 0}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Active Support Queue</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-blue-700 dark:text-blue-400">
                    {loadingOverview ? '--' : overview?.metrics.active_tickets ?? 0}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Verified Completed</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {loadingOverview ? '--' : overview?.metrics.completed_tickets ?? 0}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">Active SLA Tiers</div>
                  <div className="mt-1 text-2xl font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                    {loadingOverview ? '--' : overview?.sla_tiers.length ?? 4}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => loadOverview(true)}
                disabled={refreshing}
                className="inline-flex items-center gap-2 self-start lg:self-center px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                <span>Refresh Live Stats</span>
              </button>
            </div>
          </div>
        </section>

        {/* Core Capabilities Bento Grid */}
        <section id="capabilities" className="max-w-7xl mx-auto px-5 sm:px-8 py-16">
          <div className="max-w-2xl mb-10">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-400">
              How It Works
            </div>
            <h2 className="mt-2 font-display font-bold text-2xl sm:text-3xl tracking-tight text-slate-900 dark:text-white">
              Structured Incident Intake, Verification, and Resolution
            </h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-7 flex flex-col justify-between gap-4">
              <div>
                <div className="text-xs font-mono font-semibold text-blue-700 dark:text-blue-400">01</div>
                <h3 className="mt-2 text-lg font-display font-semibold text-slate-900 dark:text-white">
                  Instant Mobile + OTP Employee Reporting
                </h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  Warehouse operators, dispatch leads, and branch staff sign in directly with their mobile number and
                  one-time code—no manual pre-registration needed. Attach photos or videos of faulty scanners, label
                  printers, or network racks straight from the floor.
                </p>
              </div>
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-6 text-xs text-slate-500 dark:text-slate-400">
                <span>Photo &amp; Video Evidence Upload</span>
                <span>Automatic Hub &amp; Department Capture</span>
                <span>Direct Ticket History</span>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-7 flex flex-col justify-between gap-4">
              <div>
                <div className="text-xs font-mono font-semibold text-blue-700 dark:text-blue-400">02</div>
                <h3 className="mt-2 text-lg font-display font-semibold text-slate-900 dark:text-white">
                  9-Step Verified Roadmap
                </h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  Every assignment moves through Assigned, Accepted, Under Review, In Progress, Hold/Info states, and
                  Ready for Review before Super Admin sign-off marks it Completed.
                </p>
              </div>
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                Full timestamped audit trail on every status change
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-7 flex flex-col justify-between gap-4">
              <div>
                <div className="text-xs font-mono font-semibold text-blue-700 dark:text-blue-400">03</div>
                <h3 className="mt-2 text-lg font-display font-semibold text-slate-900 dark:text-white">
                  SLA Timers &amp; Auto-Escalation
                </h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  Critical dock and WMS outages trigger 15-minute first-response targets and 4-hour resolution clocks
                  with automated IT Head escalation alerts.
                </p>
              </div>
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                Priority-based SLA targets across all shifts
              </div>
            </div>

            <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-7 flex flex-col justify-between gap-4">
              <div>
                <div className="text-xs font-mono font-semibold text-blue-700 dark:text-blue-400">04</div>
                <h3 className="mt-2 text-lg font-display font-semibold text-slate-900 dark:text-white">
                  Real-Time IT Command, Chat &amp; Asset Governance
                </h3>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  Assigned IT Moderators communicate directly with the Super Admin via live WebSocket chat, log
                  resolution time, and link repairs to serial-tracked hardware assets and location IT budgets.
                </p>
              </div>
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-6 text-xs text-slate-500 dark:text-slate-400">
                <span>Live 1-on-1 Admin ↔ Moderator Chat</span>
                <span>Hardware Asset Registry</span>
                <span>Location IT Budget Tracking</span>
              </div>
            </div>
          </div>
        </section>

        {/* Live Hub Directory & SLA Schedule */}
        <section id="network" className="border-y border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40">
          <div className="max-w-7xl mx-auto px-5 sm:px-8 py-16 grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-7 space-y-5">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-400">
                  Live Network Coverage
                </div>
                <h2 className="mt-1.5 font-display font-bold text-2xl tracking-tight text-slate-900 dark:text-white">
                  Connected SD Global Facilities
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Live list of warehouses, fulfillment hubs, branches, and corporate offices served by the IT desk.
                </p>
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-slate-500">
                        <th className="py-3 px-4 font-semibold">Code</th>
                        <th className="py-3 px-4 font-semibold">Facility Name</th>
                        <th className="py-3 px-4 font-semibold">Type</th>
                        <th className="py-3 px-4 font-semibold">City / State</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {loadingOverview ? (
                        <tr>
                          <td colSpan={4} className="py-8 text-center text-slate-500">
                            Loading connected locations...
                          </td>
                        </tr>
                      ) : (overview?.locations || []).length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-8 text-center text-slate-500">
                            No locations registered yet.
                          </td>
                        </tr>
                      ) : (
                        overview?.locations.map((loc) => (
                          <tr key={loc.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="py-3 px-4 font-mono font-semibold text-blue-700 dark:text-blue-400 whitespace-nowrap">
                              {loc.code}
                            </td>
                            <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">{loc.name}</td>
                            <td className="py-3 px-4 text-slate-600 dark:text-slate-300 whitespace-nowrap">{loc.type}</td>
                            <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                              {loc.city}, {loc.state}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div id="sla" className="lg:col-span-5 space-y-5">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-400">
                  Response Targets
                </div>
                <h2 className="mt-1.5 font-display font-bold text-2xl tracking-tight text-slate-900 dark:text-white">
                  Live SLA Schedule
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Active response and resolution commitments enforced across ticket priorities.
                </p>
              </div>

              <div className="space-y-3">
                {(overview?.sla_tiers || []).map((tier) => (
                  <div
                    key={tier.priority}
                    className="border border-slate-200 dark:border-slate-800 rounded-xl p-4 bg-white dark:bg-slate-900 flex items-center justify-between gap-4"
                  >
                    <div>
                      <div className={`text-sm font-display font-bold ${getPriorityColorClass(tier.priority)}`}>
                        {tier.priority} Priority
                      </div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        Support Window: {tier.working_hours_start} – {tier.working_hours_end}
                      </div>
                    </div>
                    <div className="text-right font-mono text-xs space-y-1">
                      <div className="text-slate-900 dark:text-slate-100 font-semibold">
                        First Response: {formatSlaMinutes(tier.first_response_minutes)}
                      </div>
                      <div className="text-slate-500 dark:text-slate-400">
                        Resolution SLA: {tier.resolution_hours} hrs
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Live Ticket Status Tracker */}
        <section id="track-ticket" className="max-w-7xl mx-auto px-5 sm:px-8 py-16">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 sm:p-8">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              <div className="lg:col-span-5 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-400">
                  Live Verification Lookup
                </div>
                <h2 className="font-display font-bold text-2xl tracking-tight text-slate-900 dark:text-white">
                  Track Your Support Ticket
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  Check real-time repair progress on any active or completed ticket using your ticket number and the last
                  4 digits of the registered mobile number.
                </p>

                <form onSubmit={handleTrackTicket} className="pt-2 space-y-3.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Ticket Number
                    </label>
                    <input
                      type="text"
                      required
                      value={ticketQuery}
                      onChange={(e) => setTicketQuery(e.target.value)}
                      placeholder="e.g. INC-2026-0001"
                      className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Last 4 Digits of Mobile Number
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      required
                      value={mobileLast4}
                      onChange={(e) => setMobileLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="4 digits (e.g. 4321)"
                      className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  {trackError && (
                    <div className="p-3 text-xs rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300">
                      {trackError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={tracking}
                    className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors cursor-pointer disabled:opacity-60"
                  >
                    <Search className="w-4 h-4" />
                    <span>{tracking ? 'Checking Live Status...' : 'Check Live Status'}</span>
                  </button>
                </form>
              </div>

              <div className="lg:col-span-7">
                {!trackedResult ? (
                  <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-8 text-center space-y-3 bg-slate-50/70 dark:bg-slate-950/50">
                    <Ticket className="w-8 h-8 text-slate-400 mx-auto" />
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                      Enter a ticket number and 4-digit mobile check
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
                      You will see the live 9-step resolution stage, facility assignment, SLA target window, and
                      timestamped status milestones. To upload files or message your engineer, sign in to the Employee
                      Portal.
                    </p>
                  </div>
                ) : (
                  <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 bg-slate-50/60 dark:bg-slate-950/60 space-y-5">
                    <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
                      <div>
                        <div className="text-xs font-mono text-slate-500">{trackedResult.ticket.location_name}</div>
                        <div className="mt-0.5 text-lg font-mono font-bold text-slate-900 dark:text-white">
                          {trackedResult.ticket.ticket_number}
                        </div>
                        <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                          {trackedResult.ticket.category} · {trackedResult.ticket.device_name}
                        </div>
                      </div>
                      <div className="text-right space-y-1">
                        <div className={`text-sm font-semibold ${getStatusColorClass(trackedResult.ticket.status)}`}>
                          {trackedResult.ticket.status}
                        </div>
                        <div className={`text-xs ${getPriorityColorClass(trackedResult.ticket.priority)}`}>
                          {trackedResult.ticket.priority} Priority · {trackedResult.ticket.assignment_state}
                        </div>
                      </div>
                    </div>

                    {/* Visual Milestone Strip */}
                    <div>
                      <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-3">
                        Work Roadmap Progress
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                        {CORE_FLOW_STEPS.map((step, idx) => {
                          const activeIdx = getProgressIndex(trackedResult.ticket.status);
                          const isCompleted =
                            activeIdx > idx || (step === 'Completed' && trackedResult.ticket.status === 'Completed');
                          const isCurrent =
                            trackedResult.ticket.status === step ||
                            (activeIdx === idx && trackedResult.ticket.status !== 'New');
                          return (
                            <div
                              key={step}
                              className={`p-2.5 rounded-lg border text-xs ${
                                isCurrent
                                  ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200 font-semibold'
                                  : isCompleted
                                    ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300'
                                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-1 mb-1">
                                <span className="font-mono text-[10px]">0{idx + 1}</span>
                                {isCompleted && <Check className="w-3.5 h-3.5 text-emerald-600" />}
                              </div>
                              <div className="leading-tight">{step}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {trackedResult.timeline.length > 0 && (
                      <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
                        <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                          Status Milestones
                        </div>
                        <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                          {trackedResult.timeline.map((item, i) => (
                            <div
                              key={`${item.created_at}-${i}`}
                              className="flex items-center justify-between gap-3 text-xs py-1.5 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
                            >
                              <span className="font-medium text-slate-700 dark:text-slate-200">
                                {item.new_status ? `Status → ${item.new_status}` : item.action.replaceAll('_', ' ')}
                              </span>
                              <span className="font-mono text-[11px] text-slate-500 whitespace-nowrap">
                                {formatDateTime(item.created_at)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Role Portal Access Directory */}
        <section className="border-t border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-900/30">
          <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14">
            <div className="mb-8">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700 dark:text-blue-400">
                Portal Directory
              </div>
              <h2 className="mt-1.5 font-display font-bold text-2xl tracking-tight text-slate-900 dark:text-white">
                Select Your Access Portal
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between gap-5">
                <div className="space-y-2">
                  <Headphones className="w-5 h-5 text-blue-700 dark:text-blue-400" />
                  <h3 className="text-base font-display font-semibold">Employee &amp; HR Self-Service</h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    Sign in with your mobile number and OTP to raise IT tickets, upload facility photos, and confirm
                    repairs.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => (isAuthenticated && onEnterWorkspace ? onEnterWorkspace() : onOpenPortal('employee_otp'))}
                  className="inline-flex items-center justify-between w-full px-4 py-2.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
                >
                  <span>{isAuthenticated ? 'Open Workspace' : 'Employee Mobile Login'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between gap-5">
                <div className="space-y-2">
                  <Wrench className="w-5 h-5 text-blue-700 dark:text-blue-400" />
                  <h3 className="text-base font-display font-semibold">IT Moderator Portal</h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    Dedicated sign-in for assigned IT engineers to update task roadmaps, log time, and message the Super
                    Admin.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    isAuthenticated && onEnterWorkspace ? onEnterWorkspace() : onOpenPortal('moderator_common')
                  }
                  className="inline-flex items-center justify-between w-full px-4 py-2.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <span>{isAuthenticated ? 'Open Workspace' : 'Moderator Sign In'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between gap-5">
                <div className="space-y-2">
                  <Building2 className="w-5 h-5 text-blue-700 dark:text-blue-400" />
                  <h3 className="text-base font-display font-semibold">Super Admin / IT Head Console</h3>
                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    Complete command over work assignments, moderator credentials, approvals, IT assets, budgets, and
                    dropdowns.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => (isAuthenticated && onEnterWorkspace ? onEnterWorkspace() : onOpenPortal('staff_email'))}
                  className="inline-flex items-center justify-between w-full px-4 py-2.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <span>{isAuthenticated ? 'Open Workspace' : 'Admin Console Sign In'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-3">
            <SdGlobalLogo size={28} withWhiteSurface />
            <span>SD Global Enterprise IT Operations &amp; Helpdesk CRM</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              <span>Support Desk: {overview?.company.support_email || 'techsupport@sdgloballogistics.com'}</span>
            </span>
            <span>&copy; {new Date().getFullYear()} SD Global</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
