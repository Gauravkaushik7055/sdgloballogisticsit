import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Download,
  Edit3,
  Eye,
  FileText,
  History,
  Plus,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../../context/AuthContext.tsx';
import { useDropdowns } from '../../context/DropdownContext.tsx';
import { LocationItem } from '../../types/index.ts';
import { apiFetch, formatCurrency, formatDateTime, uploadWithProgress } from '../../utils/api.ts';
import { exportToCsv, exportToExcel, exportToPdf } from '../../utils/exportUtils.ts';
import MediaPreviewModal, { PreviewMediaDescriptor } from '../common/MediaPreviewModal.tsx';
import UploadProgressList, { checkClientFileSafety } from '../common/UploadProgressList.tsx';

export default function BudgetExpensesView() {
  const { user, subscribeRealtime } = useAuth();
  const { getOptions } = useDropdowns();
  const expenseCategories = getOptions('expense_category');

  const canViewBudgets =
    user?.role === 'super_admin' || (user?.role === 'management' && Boolean(user.permissions?.can_view_budgets));
  const canManageBudgets =
    user?.role === 'super_admin' || (user?.role === 'management' && Boolean(user.permissions?.can_manage_budgets));
  const canApproveExpenses =
    user?.role === 'super_admin' || (user?.role === 'management' && Boolean(user.permissions?.can_approve_expenses));
  const canExport =
    user?.role === 'super_admin' || (user?.role === 'management' && user.permissions?.can_export_data !== false);

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(String(currentYear));
  const [data, setData] = useState<any>(null);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [tickets, setTickets] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [error, setError] = useState('');

  // Budget Modal
  const [budgetModal, setBudgetModal] = useState(false);
  const [editingBudget, setEditingBudget] = useState<any | null>(null);
  const [bYear, setBYear] = useState(String(currentYear));
  const [bMonth, setBMonth] = useState('0');
  const [bLocId, setBLocId] = useState('');
  const [bCategory, setBCategory] = useState('');
  const [bAmount, setBAmount] = useState('');
  const [bNotes, setBNotes] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);

  // Expense Modal
  const [expenseModal, setExpenseModal] = useState(false);
  const [eCategory, setECategory] = useState<string>(() => expenseCategories[0] || 'Hardware Purchase');
  const [eTicketId, setETicketId] = useState('');
  const [eVendorName, setEVendorName] = useState('');
  const [eLocId, setELocId] = useState('');
  const [eAmount, setEAmount] = useState('');
  const [eInvoiceNum, setEInvoiceNum] = useState('');
  const [ePayDate, setEPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [eDesc, setEDesc] = useState('');
  const [eFile, setEFile] = useState<File | null>(null);
  const [uploadingExpense, setUploadingExpense] = useState(false);
  const [expenseProgress, setExpenseProgress] = useState(0);
  const [expenseErr, setExpenseErr] = useState('');

  const [previewInvoice, setPreviewInvoice] = useState<PreviewMediaDescriptor | null>(null);

  const loadBudget = useCallback(async () => {
    if (!canViewBudgets) return;
    setError('');
    try {
      const res = await apiFetch<any>(`/api/budgets?year=${encodeURIComponent(selectedYear)}`);
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Failed to load IT budgets and expenses');
    }
  }, [canViewBudgets, selectedYear]);

  useEffect(() => {
    loadBudget();
    apiFetch<{ locations: LocationItem[] }>('/api/locations')
      .then((r) => setLocations(r.locations || []))
      .catch(() => {});
    apiFetch<{ tickets: any[] }>('/api/tickets')
      .then((r) => setTickets(r.tickets || []))
      .catch(() => {});
    apiFetch<{ vendors: any[] }>('/api/vendors')
      .then((r) => setVendors(r.vendors || []))
      .catch(() => {});
  }, [loadBudget]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'budget:updated') {
        loadBudget();
      }
    });
  }, [subscribeRealtime, loadBudget]);

  const openNewBudgetModal = () => {
    setEditingBudget(null);
    setBYear(selectedYear);
    setBMonth('0');
    setBLocId('');
    setBCategory('');
    setBAmount('');
    setBNotes('');
    setBudgetModal(true);
  };

  const openEditBudgetModal = (b: any) => {
    setEditingBudget(b);
    setBYear(String(b.fiscal_year));
    setBMonth(String(b.month ?? 0));
    setBLocId(b.location_id ? String(b.location_id) : '');
    setBCategory(b.category || '');
    setBAmount(String(b.allocated_amount ?? ''));
    setBNotes(b.notes || '');
    setBudgetModal(true);
  };

  const handleSaveBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBudget(true);
    setError('');
    try {
      const payload = {
        fiscal_year: Number(bYear),
        month: Number(bMonth),
        location_id: bLocId ? Number(bLocId) : null,
        category: bCategory || null,
        allocated_amount: Number(bAmount),
        notes: bNotes,
      };
      if (editingBudget) {
        await apiFetch(`/api/budgets/${editingBudget.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/budgets', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setBudgetModal(false);
      loadBudget();
    } catch (err: any) {
      setError(err.message || 'Failed to save budget allocation');
    } finally {
      setSavingBudget(false);
    }
  };

  const handleDeleteBudget = async (id: number) => {
    try {
      await apiFetch(`/api/budgets/${id}`, { method: 'DELETE' });
      loadBudget();
    } catch (err: any) {
      setError(err.message || 'Failed to delete budget allocation');
    }
  };

  const submitExpenseForm = async () => {
    setExpenseErr('');
    if (eFile) {
      const safetyErr = checkClientFileSafety(eFile, 25);
      if (safetyErr) {
        setExpenseErr(safetyErr);
        return;
      }
    }
    setUploadingExpense(true);
    setExpenseProgress(0);
    try {
      const fd = new FormData();
      fd.append('category', eCategory);
      if (eTicketId) fd.append('ticket_id', eTicketId);
      fd.append('vendor_name', eVendorName);
      if (eLocId) fd.append('location_id', eLocId);
      fd.append('amount', eAmount);
      fd.append('invoice_number', eInvoiceNum);
      fd.append('payment_date', ePayDate);
      fd.append('description', eDesc);
      if (eFile) fd.append('invoice', eFile);

      await uploadWithProgress('/api/expenses', fd, {
        onProgress: (pct) => setExpenseProgress(pct),
      });
      setExpenseModal(false);
      setEVendorName('');
      setEAmount('');
      setEInvoiceNum('');
      setEDesc('');
      setEFile(null);
      setExpenseProgress(0);
      loadBudget();
    } catch (err: any) {
      setExpenseErr(err.message || 'Failed to save expense');
    } finally {
      setUploadingExpense(false);
    }
  };

  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitExpenseForm();
  };

  const handleApprove = async (expenseId: number, decision: 'Approved' | 'Rejected') => {
    try {
      await apiFetch(`/api/expenses/${expenseId}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          remarks: `${decision} by ${user?.full_name || 'IT Head'}`,
        }),
      });
      loadBudget();
    } catch (err: any) {
      setError(err.message || 'Failed to process approval');
    }
  };

  if (!canViewBudgets) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center space-y-2">
        <ShieldAlert className="w-8 h-8 text-amber-500 mx-auto" />
        <h3 className="text-sm font-display font-bold">IT Budget & Expense Access Restricted</h3>
        <p className="text-xs text-slate-500">
          Financial budget viewing is disabled in your Admin permission profile. Contact the Super Admin if access is needed.
        </p>
      </div>
    );
  }

  const summary = data?.summary || {};
  const budgets = data?.budgets || [];
  const expenses = data?.expenses || [];
  const locationSummary = data?.locationSummary || [];
  const categorySummary = data?.categorySummary || [];
  const approvalHistory = data?.approvalHistory || [];

  const exportExpenseRows = expenses.map((e: any) => ({
    Date: e.payment_date,
    Invoice: e.invoice_number,
    Category: e.category,
    Vendor: e.vendor_name,
    Location: e.location_name || 'Global',
    Ticket: e.ticket_number || '-',
    Amount_INR: e.amount,
    Status: e.approval_status,
    Approved_By: e.approved_by_name || '-',
  }));

  const yearChoices = [currentYear - 1, currentYear, currentYear + 1].map(String);

  return (
    <div className="space-y-6">
      {/* Header & Exports */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-base font-display font-bold">
              IT Budget & Expense Management (INR ₹ · FY {selectedYear})
            </h2>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              className="px-2.5 py-1 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              {yearChoices.map((yr) => (
                <option key={yr} value={yr}>
                  FY {yr}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Track company-wide, category-wise, and location-wise INR allocations, vendor invoices, and approvals.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canExport && (
            <>
              <button
                type="button"
                disabled={exportExpenseRows.length === 0}
                onClick={() => exportToExcel(`SD_Global_IT_Expenses_${selectedYear}`, 'Expenses_INR', exportExpenseRows)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                <Download className="w-3.5 h-3.5" />
                Excel
              </button>
              <button
                type="button"
                disabled={exportExpenseRows.length === 0}
                onClick={() =>
                  exportToPdf(
                    `SD_Global_IT_Expenses_${selectedYear}`,
                    `IT Budget & Expense Report (INR · FY ${selectedYear})`,
                    exportExpenseRows
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                <FileText className="w-3.5 h-3.5" />
                PDF
              </button>
              <button
                type="button"
                disabled={exportExpenseRows.length === 0}
                onClick={() => exportToCsv(`SD_Global_IT_Expenses_${selectedYear}`, exportExpenseRows)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                CSV
              </button>
            </>
          )}

          {canManageBudgets && (
            <>
              <button
                type="button"
                onClick={openNewBudgetModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Allocate Budget
              </button>
              <button
                type="button"
                onClick={() => {
                  setExpenseErr('');
                  setExpenseModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Record Expense
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Budget Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Allocated Annual Budget</div>
          <div className="mt-1 text-xl font-mono font-semibold tabular-nums">
            {formatCurrency(summary.totalAnnualBudget)}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Total Approved Spent</div>
          <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-blue-700 dark:text-blue-400">
            {formatCurrency(summary.totalApprovedSpent)}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Pending Approvals</div>
          <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-400">
            {formatCurrency(summary.totalPendingSpent)}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Remaining Budget</div>
          <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
            {formatCurrency(summary.remainingBudget)}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Budget Utilization</div>
          <div className="mt-1 text-xl font-mono font-semibold tabular-nums">{summary.utilizationPct ?? 0}%</div>
        </div>
      </div>

      {/* Category & Location Analytics Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h3 className="text-sm font-display font-semibold mb-1">
            Location-Wise Budget vs Expenditure (INR)
          </h3>
          <p className="text-xs text-slate-500 mb-4">Annual allocation compared against approved branch spending</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={locationSummary}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.4} />
                <XAxis dataKey="location_code" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v)} />
                <Tooltip formatter={(val: any) => formatCurrency(Number(val))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="allocated" name="Allocated Budget" fill="#94a3b8" />
                <Bar dataKey="spent" name="Approved Spent" fill="#1d4ed8" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h3 className="text-sm font-display font-semibold mb-1">
            Category-Wise Budget & Spending Breakdown (INR)
          </h3>
          <p className="text-xs text-slate-500 mb-4">Allocated vs approved & pending IT expenditure by category</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categorySummary}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.4} />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v)} />
                <Tooltip formatter={(val: any) => formatCurrency(Number(val))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="allocated" name="Allocated" fill="#94a3b8" />
                <Bar dataKey="spent" name="Approved Spent" fill="#1d4ed8" />
                <Bar dataKey="pending" name="Pending" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Category Summary Table & Allocated Budgets Register */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-display font-semibold">Category-Wise Ledger Summary (₹)</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                  <th className="py-2 px-4">Category</th>
                  <th className="py-2 px-4 text-right">Allocated</th>
                  <th className="py-2 px-4 text-right">Approved</th>
                  <th className="py-2 px-4 text-right">Pending</th>
                  <th className="py-2 px-4 text-right">Remaining</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {categorySummary.map((c: any) => (
                  <tr key={c.category}>
                    <td className="py-2 px-4 font-medium">
                      {c.category} <span className="text-slate-400 font-mono">({c.count})</span>
                    </td>
                    <td className="py-2 px-4 text-right font-mono tabular-nums">
                      {c.allocated > 0 ? formatCurrency(c.allocated) : '—'}
                    </td>
                    <td className="py-2 px-4 text-right font-mono tabular-nums text-blue-700 dark:text-blue-400">
                      {formatCurrency(c.spent)}
                    </td>
                    <td className="py-2 px-4 text-right font-mono tabular-nums text-amber-600">
                      {formatCurrency(c.pending)}
                    </td>
                    <td className="py-2 px-4 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                      {c.remaining !== null ? formatCurrency(c.remaining) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-display font-semibold">
              Allocated Budget Records ({budgets.length})
            </h3>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                  <th className="py-2 px-4">Period & Scope</th>
                  <th className="py-2 px-4">Category</th>
                  <th className="py-2 px-4 text-right">Allocated (₹)</th>
                  {(canManageBudgets || user?.role === 'super_admin') && <th className="py-2 px-4 text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {budgets.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-slate-500">
                      No budget allocations defined for FY {selectedYear}.
                    </td>
                  </tr>
                ) : (
                  budgets.map((b: any) => (
                    <tr key={b.id}>
                      <td className="py-2 px-4">
                        <div className="font-semibold">
                          {b.location_name || 'Company-Wide'} ·{' '}
                          {Number(b.month) === 0 ? 'Annual' : `Month ${String(b.month).padStart(2, '0')}`}
                        </div>
                        {b.notes && <div className="text-[11px] text-slate-400 truncate max-w-[200px]">{b.notes}</div>}
                      </td>
                      <td className="py-2 px-4">{b.category || 'All Categories'}</td>
                      <td className="py-2 px-4 text-right font-mono font-semibold tabular-nums">
                        {formatCurrency(b.allocated_amount)}
                      </td>
                      {(canManageBudgets || user?.role === 'super_admin') && (
                        <td className="py-2 px-4 text-right whitespace-nowrap space-x-1">
                          {canManageBudgets && (
                            <button
                              type="button"
                              onClick={() => openEditBudgetModal(b)}
                              aria-label="Edit Budget"
                              className="p-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                            >
                              <Edit3 className="w-3 h-3" />
                            </button>
                          )}
                          {user?.role === 'super_admin' && (
                            <button
                              type="button"
                              onClick={() => handleDeleteBudget(b.id)}
                              aria-label="Delete Budget"
                              className="p-1 rounded border border-red-200 dark:border-red-900 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Expenses Ledger Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-display font-semibold">IT Expense & Invoice Register ({expenses.length})</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4">Date & Invoice</th>
                <th className="py-2.5 px-4">Category & Description</th>
                <th className="py-2.5 px-4">Vendor</th>
                <th className="py-2.5 px-4">Hub / Ticket</th>
                <th className="py-2.5 px-4 text-right">Amount (₹)</th>
                <th className="py-2.5 px-4">Approval Status</th>
                {canApproveExpenses && <th className="py-2.5 px-4 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {expenses.length === 0 ? (
                <tr>
                  <td colSpan={canApproveExpenses ? 7 : 6} className="py-8 text-center text-slate-500">
                    No IT expenses recorded for FY {selectedYear}.
                  </td>
                </tr>
              ) : (
                expenses.map((e: any) => (
                  <tr key={e.id}>
                    <td className="py-3 px-4 font-mono">
                      <div>{e.payment_date}</div>
                      <div className="text-slate-500">{e.invoice_number}</div>
                      {e.invoice_attachment_path && (
                        <button
                          type="button"
                          onClick={() =>
                            setPreviewInvoice({
                              file_name: `Invoice-${e.invoice_number}`,
                              mime_type: e.invoice_attachment_path.toLowerCase().endsWith('.pdf')
                                ? 'application/pdf'
                                : 'image/png',
                              url: `/api/expenses/${e.id}/invoice`,
                            })
                          }
                          className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-sans mt-0.5 cursor-pointer"
                        >
                          <Eye className="w-3 h-3" />
                          View Invoice
                        </button>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold">{e.category}</div>
                      <div className="text-slate-500 max-w-[260px] truncate">{e.description}</div>
                    </td>
                    <td className="py-3 px-4">{e.vendor_name}</td>
                    <td className="py-3 px-4">
                      <div>{e.location_name || 'Global'}</div>
                      <div className="font-mono text-slate-500">{e.ticket_number || '—'}</div>
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums">
                      {formatCurrency(e.amount)}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`font-semibold ${
                          e.approval_status === 'Approved'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : e.approval_status === 'Rejected'
                            ? 'text-red-600'
                            : 'text-amber-600'
                        }`}
                      >
                        {e.approval_status}
                      </span>
                      {e.approved_by_name && <div className="text-[11px] text-slate-400">By {e.approved_by_name}</div>}
                    </td>
                    {canApproveExpenses && (
                      <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                        {e.approval_status === 'Pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleApprove(e.id, 'Approved')}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                            >
                              <Check className="w-3 h-3" />
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => handleApprove(e.id, 'Rejected')}
                              className="px-2 py-1 text-[11px] font-semibold rounded border border-red-300 text-red-600 hover:bg-red-50 cursor-pointer"
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Expense Approval History */}
      {approvalHistory.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
            <History className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-display font-semibold">Expense Approval Audit History</h3>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs max-h-60 overflow-y-auto">
            {approvalHistory.map((ah: any) => (
              <div key={ah.id} className="px-5 py-2.5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">{ah.invoice_number}</span>
                  {' · '}
                  <span className="font-semibold">{ah.vendor_name}</span> ({ah.category}) —{' '}
                  <span className="font-mono font-semibold tabular-nums">{formatCurrency(ah.amount)}</span>
                  {ah.remarks && <div className="text-slate-500 mt-0.5">{ah.remarks}</div>}
                </div>
                <div className="text-right">
                  <span
                    className={`font-semibold ${
                      ah.decision === 'Approved' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'
                    }`}
                  >
                    {ah.decision}
                  </span>{' '}
                  by {ah.approver_name}
                  <div className="font-mono text-[11px] text-slate-400">{formatDateTime(ah.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Allocate / Edit Budget Modal */}
      {budgetModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveBudget}
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold">
                {editingBudget ? 'Update IT Budget Allocation (₹)' : 'Allocate IT Budget (₹)'}
              </h3>
              <button type="button" onClick={() => setBudgetModal(false)} className="cursor-pointer">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="number"
                required
                value={bYear}
                onChange={(e) => setBYear(e.target.value)}
                placeholder="Fiscal Year"
                className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <select
                value={bMonth}
                onChange={(e) => setBMonth(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="0">Annual Budget</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={String(m)}>
                    Month {String(m).padStart(2, '0')}
                  </option>
                ))}
              </select>
            </div>
            <select
              value={bLocId}
              onChange={(e) => setBLocId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="">Company-Wide (Global)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <select
              value={bCategory}
              onChange={(e) => setBCategory(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="">All Categories (General Pool)</option>
              {expenseCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              type="number"
              required
              min="0"
              placeholder="Allocated Amount (₹ INR) *"
              value={bAmount}
              onChange={(e) => setBAmount(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <input
              placeholder="Budget Notes"
              value={bNotes}
              onChange={(e) => setBNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setBudgetModal(false)}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingBudget}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer"
              >
                {savingBudget ? 'Saving...' : 'Save Allocation'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Record Expense Modal */}
      {expenseModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveExpense}
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-3 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold">Record IT Expense (INR ₹)</h3>
              <button type="button" onClick={() => setExpenseModal(false)} className="cursor-pointer">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <select
                value={eCategory}
                onChange={(e) => setECategory(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {expenseCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                required
                list="vendor-suggestions"
                placeholder="Vendor Name *"
                value={eVendorName}
                onChange={(e) => setEVendorName(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <datalist id="vendor-suggestions">
                {vendors.map((v) => (
                  <option key={v.id} value={v.name} />
                ))}
              </datalist>
              <input
                type="number"
                required
                min="1"
                placeholder="Amount (₹ INR) *"
                value={eAmount}
                onChange={(e) => setEAmount(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <input
                required
                placeholder="Invoice Number *"
                value={eInvoiceNum}
                onChange={(e) => setEInvoiceNum(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <input
                type="date"
                required
                value={ePayDate}
                onChange={(e) => setEPayDate(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <select
                value={eLocId}
                onChange={(e) => setELocId(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="">Location / Hub...</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <select
                value={eTicketId}
                onChange={(e) => setETicketId(e.target.value)}
                className="sm:col-span-2 px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="">Link to Ticket Reference (Optional)</option>
                {tickets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.ticket_number} · {t.category}
                  </option>
                ))}
              </select>
            </div>
            <input
              placeholder="Description / Spare parts breakdown"
              value={eDesc}
              onChange={(e) => setEDesc(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Invoice Attachment (PDF / Image)</label>
              <input
                type="file"
                accept=".pdf,image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  if (file) {
                    const err = checkClientFileSafety(file, 25);
                    if (err) {
                      setExpenseErr(err);
                      return;
                    }
                  }
                  setExpenseErr('');
                  setEFile(file);
                }}
                className="text-xs"
              />
            </div>

            {(eFile || uploadingExpense || expenseErr) && (
              <UploadProgressList
                files={eFile ? [eFile] : []}
                uploading={uploadingExpense}
                progress={expenseProgress}
                error={expenseErr}
                onRemoveFile={() => setEFile(null)}
                onRetry={() => submitExpenseForm()}
              />
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setExpenseModal(false)}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={uploadingExpense}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer"
              >
                {uploadingExpense ? `Uploading ${expenseProgress}%...` : 'Save Expense'}
              </button>
            </div>
          </form>
        </div>
      )}

      <MediaPreviewModal media={previewInvoice} onClose={() => setPreviewInvoice(null)} />
    </div>
  );
}
