import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Edit3,
  FileSpreadsheet,
  History,
  Plus,
  Search,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useDropdowns } from '../../context/DropdownContext.tsx';
import { AssetExcelImportResult, AssetHistoryItem, LocationItem } from '../../types/index.ts';
import {
  apiFetch,
  fetchProtectedBlobUrl,
  formatCurrency,
  formatDateOnly,
  formatDateTime,
  uploadWithProgress,
} from '../../utils/api.ts';
import { exportToCsv, exportToExcel } from '../../utils/exportUtils.ts';
import UploadProgressList from '../common/UploadProgressList.tsx';

export default function AssetsView({ onSelectTicket }: { onSelectTicket: (id: number) => void }) {
  const { user, subscribeRealtime } = useAuth();
  const { getOptions } = useDropdowns();
  const assetCategories = getOptions('asset_category');

  const canManageAssets =
    user?.role === 'super_admin' || (user?.role === 'management' && Boolean(user.permissions?.can_manage_assets));
  const canExport =
    user?.role === 'super_admin' || (user?.role === 'management' && user.permissions?.can_export_data !== false);

  const [assets, setAssets] = useState<any[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [catFilter, setCatFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState('');

  // Create / Edit modal state
  const [formOpen, setFormOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<any | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [assetTag, setAssetTag] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [category, setCategory] = useState<string>(() => assetCategories[0] || 'Laptop');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [purchaseCost, setPurchaseCost] = useState('');
  const [warrantyExpiry, setWarrantyExpiry] = useState('');
  const [warrantyProvider, setWarrantyProvider] = useState('');
  const [serviceContract, setServiceContract] = useState('');
  const [locationId, setLocationId] = useState('');
  const [assignedEmployeeId, setAssignedEmployeeId] = useState('');
  const [conditionStatus, setConditionStatus] = useState('Operational');
  const [notes, setNotes] = useState('');
  const [savingAsset, setSavingAsset] = useState(false);
  const [formError, setFormError] = useState('');

  // Lifecycle & Maintenance drawer
  const [selectedAsset, setSelectedAsset] = useState<any | null>(null);
  const [maintHistory, setMaintHistory] = useState<any[]>([]);
  const [linkedTickets, setLinkedTickets] = useState<any[]>([]);
  const [assetHistory, setAssetHistory] = useState<AssetHistoryItem[]>([]);
  const [maintSummary, setMaintSummary] = useState<any>(null);
  const [drawerTab, setDrawerTab] = useState<'repairs' | 'timeline' | 'tickets'>('repairs');
  const [maintType, setMaintType] = useState('Repair');
  const [maintDesc, setMaintDesc] = useState('');
  const [maintCost, setMaintCost] = useState('0');
  const [maintVendorId, setMaintVendorId] = useState('');
  const [maintNextStatus, setMaintNextStatus] = useState('');
  const [maintDate, setMaintDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Excel import modal
  const [excelModalOpen, setExcelModalOpen] = useState(false);
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [importingExcel, setImportingExcel] = useState(false);
  const [excelProgress, setExcelProgress] = useState(0);
  const [excelError, setExcelError] = useState('');
  const [importResult, setImportResult] = useState<AssetExcelImportResult | null>(null);
  const [importBatches, setImportBatches] = useState<any[]>([]);
  const excelInputRef = useRef<HTMLInputElement | null>(null);

  const loadAssets = useCallback(async () => {
    try {
      const res = await apiFetch<{ assets: any[] }>('/api/assets');
      setAssets(res.assets || []);
    } catch (err: any) {
      setActionError(err.message || 'Failed to load IT assets');
    }
  }, []);

  const loadImportBatches = useCallback(async () => {
    if (!canManageAssets) return;
    try {
      const res = await apiFetch<{ batches: any[] }>('/api/assets/import-batches');
      setImportBatches(res.batches || []);
    } catch {
      // non-fatal
    }
  }, [canManageAssets]);

  useEffect(() => {
    loadAssets();
    apiFetch<{ locations: LocationItem[] }>('/api/locations')
      .then((r) => setLocations(r.locations || []))
      .catch(() => {});
    apiFetch<{ vendors: any[] }>('/api/vendors')
      .then((r) => setVendors(r.vendors || []))
      .catch(() => {});
    if (user?.role === 'super_admin' || user?.role === 'management') {
      apiFetch<{ employees: any[] }>('/api/employees')
        .then((r) => setEmployees(r.employees || []))
        .catch(() => {});
    }
  }, [loadAssets, user?.role]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'asset:updated') {
        loadAssets();
      }
    });
  }, [subscribeRealtime, loadAssets]);

  const openMaint = async (asset: any) => {
    setSelectedAsset(asset);
    setDrawerTab('repairs');
    try {
      const data = await apiFetch<{
        asset: any;
        maintenance: any[];
        linkedTickets: any[];
        history: AssetHistoryItem[];
        summary: any;
      }>(`/api/assets/${asset.id}/maintenance`);
      setSelectedAsset(data.asset || asset);
      setMaintHistory(data.maintenance || []);
      setLinkedTickets(data.linkedTickets || []);
      setAssetHistory(data.history || []);
      setMaintSummary(data.summary || null);
    } catch (err: any) {
      setActionError(err.message || 'Unable to load asset lifecycle');
    }
  };

  const openCreateModal = () => {
    setEditingAsset(null);
    setDeviceName('');
    setAssetTag('');
    setSerialNumber('');
    setCategory(assetCategories[0] || 'Laptop');
    setBrand('');
    setModel('');
    setPurchaseDate(new Date().toISOString().slice(0, 10));
    setPurchaseCost('');
    setWarrantyExpiry('');
    setWarrantyProvider('');
    setServiceContract('');
    setLocationId('');
    setAssignedEmployeeId('');
    setConditionStatus('Operational');
    setNotes('');
    setFormError('');
    setFormOpen(true);
  };

  const openEditModal = (a: any) => {
    setEditingAsset(a);
    setDeviceName(a.device_name || `${a.brand} ${a.model}`.trim());
    setAssetTag(a.asset_tag || '');
    setSerialNumber(a.serial_number || '');
    setCategory(a.category || assetCategories[0] || 'Laptop');
    setBrand(a.brand || '');
    setModel(a.model || '');
    setPurchaseDate(a.purchase_date || new Date().toISOString().slice(0, 10));
    setPurchaseCost(String(a.purchase_cost ?? ''));
    setWarrantyExpiry(a.warranty_expiry || '');
    setWarrantyProvider(a.warranty_provider || '');
    setServiceContract(a.service_contract || '');
    setLocationId(a.location_id ? String(a.location_id) : '');
    setAssignedEmployeeId(a.assigned_employee_id ? String(a.assigned_employee_id) : '');
    setConditionStatus(a.condition_status || 'Operational');
    setNotes(a.notes || '');
    setFormError('');
    setFormOpen(true);
  };

  const handleSubmitAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setSavingAsset(true);
    try {
      const payload = {
        device_name: deviceName.trim() || `${brand.trim()} ${model.trim()}`.trim(),
        asset_tag: assetTag.trim(),
        serial_number: serialNumber.trim(),
        category,
        brand: brand.trim(),
        model: model.trim(),
        purchase_date: purchaseDate,
        purchase_cost: Number(purchaseCost) || 0,
        warranty_expiry: warrantyExpiry || null,
        warranty_provider: warrantyProvider.trim() || null,
        service_contract: serviceContract.trim() || null,
        location_id: locationId ? Number(locationId) : null,
        assigned_employee_id: assignedEmployeeId ? Number(assignedEmployeeId) : null,
        condition_status: conditionStatus,
        notes,
      };
      if (editingAsset) {
        await apiFetch(`/api/assets/${editingAsset.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/assets', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setFormOpen(false);
      loadAssets();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save IT asset');
    } finally {
      setSavingAsset(false);
    }
  };

  const handleAddMaintenance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAsset) return;
    setActionError('');
    try {
      await apiFetch(`/api/assets/${selectedAsset.id}/maintenance`, {
        method: 'POST',
        body: JSON.stringify({
          maintenance_type: maintType,
          description: maintDesc,
          cost: Number(maintCost) || 0,
          vendor_id: maintVendorId ? Number(maintVendorId) : null,
          performed_at: maintDate,
          next_status: maintNextStatus || undefined,
        }),
      });
      setMaintDesc('');
      setMaintCost('0');
      setMaintNextStatus('');
      await openMaint(selectedAsset);
      loadAssets();
    } catch (err: any) {
      setActionError(err.message || 'Failed to log maintenance record');
    }
  };

  const updateCondition = async (assetId: number, status: string) => {
    try {
      await apiFetch(`/api/assets/${assetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ condition_status: status }),
      });
      loadAssets();
    } catch (err: any) {
      setActionError(err.message || 'Failed to update condition');
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      const blobUrl = await fetchProtectedBlobUrl('/api/assets/import-template');
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'sdglobal-it-assets-template.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    } catch (err: any) {
      setExcelError(err.message || 'Failed to download Excel template');
    }
  };

  const handleExcelUpload = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!excelFile) {
      setExcelError('Please choose an .xlsx or .xls workbook first.');
      return;
    }
    setExcelError('');
    setImportingExcel(true);
    setExcelProgress(0);
    try {
      const fd = new FormData();
      fd.append('file', excelFile);
      const res = await uploadWithProgress<AssetExcelImportResult>('/api/assets/import-excel', fd, {
        onProgress: (pct) => setExcelProgress(pct),
      });
      setImportResult(res);
      setExcelFile(null);
      if (excelInputRef.current) excelInputRef.current.value = '';
      loadAssets();
      loadImportBatches();
    } catch (err: any) {
      setExcelError(err.message || 'Excel import failed');
    } finally {
      setImportingExcel(false);
    }
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return assets.filter((a) => {
      if (catFilter !== 'All' && a.category !== catFilter) return false;
      if (statusFilter !== 'All' && a.condition_status !== statusFilter) return false;
      if (!q) return true;
      return (
        String(a.asset_tag || '').toLowerCase().includes(q) ||
        String(a.serial_number || '').toLowerCase().includes(q) ||
        String(a.device_name || '').toLowerCase().includes(q) ||
        String(a.brand || '').toLowerCase().includes(q) ||
        String(a.model || '').toLowerCase().includes(q) ||
        String(a.assigned_employee_name || '').toLowerCase().includes(q) ||
        String(a.location_name || '').toLowerCase().includes(q)
      );
    });
  }, [assets, catFilter, statusFilter, searchQuery]);

  const kpis = useMemo(() => {
    const totalDevices = filtered.length;
    const operational = filtered.filter((a) => a.condition_status === 'Operational' || a.condition_status === 'Spare').length;
    const underRepair = filtered.filter((a) => a.condition_status === 'Under Repair').length;
    const totalPurchase = filtered.reduce((s, a) => s + (Number(a.purchase_cost) || 0), 0);
    const totalRepair = filtered.reduce((s, a) => s + (Number(a.total_maintenance_cost) || 0), 0);
    return { totalDevices, operational, underRepair, totalTco: totalPurchase + totalRepair, totalRepair };
  }, [filtered]);

  const exportRows = filtered.map((a) => ({
    Asset_ID: a.asset_tag,
    Device_Name: a.device_name || `${a.brand} ${a.model}`,
    Category: a.category,
    Brand: a.brand,
    Model: a.model,
    Serial_Number: a.serial_number,
    Location: a.location_name || 'Unassigned',
    Assigned_Employee: a.assigned_employee_name || 'Shared / Unassigned',
    Purchase_Date: a.purchase_date,
    Purchase_Cost_INR: a.purchase_cost,
    Repair_Count: a.repair_count ?? 0,
    Repair_Cost_INR: a.total_maintenance_cost ?? 0,
    Warranty_Expiry: a.warranty_expiry || '-',
    Warranty_Provider: a.warranty_provider || '-',
    Service_Contract: a.service_contract || '-',
    Condition_Status: a.condition_status,
  }));

  return (
    <div className="space-y-5">
      {/* Header & Controls */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-display font-bold">
              IT Asset & Inventory Lifecycle ({filtered.length})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Track hardware procurement (INR), employee allocations, warranties, repair expenses, and bulk Excel imports.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canExport && (
              <>
                <button
                  type="button"
                  disabled={filtered.length === 0}
                  onClick={() => exportToExcel('SD_Global_IT_Assets', 'IT_Inventory', exportRows)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  Export Excel
                </button>
                <button
                  type="button"
                  disabled={filtered.length === 0}
                  onClick={() => exportToCsv('SD_Global_IT_Assets', exportRows)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
                >
                  <Download className="w-3.5 h-3.5" />
                  CSV
                </button>
              </>
            )}

            {canManageAssets && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setImportResult(null);
                    setExcelError('');
                    setExcelFile(null);
                    loadImportBatches();
                    setExcelModalOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-blue-600 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Import Excel (.xlsx)
                </button>
                <button
                  type="button"
                  onClick={openCreateModal}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Register IT Asset
                </button>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
          <div className="relative sm:col-span-2">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search Asset ID, Serial, Device Name, Brand, Employee, Hub..."
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Equipment Types</option>
            {assetCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="All">All Conditions</option>
            <option value="Operational">Operational</option>
            <option value="Under Repair">Under Repair</option>
            <option value="Spare">Spare</option>
            <option value="Decommissioned">Decommissioned</option>
          </select>
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Total Filtered Devices</div>
          <div className="mt-1 text-2xl font-mono font-semibold tabular-nums">{kpis.totalDevices}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Operational / Spare</div>
          <div className="mt-1 text-2xl font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
            {kpis.operational}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Under Repair</div>
          <div className="mt-1 text-2xl font-mono font-semibold tabular-nums text-amber-700 dark:text-amber-400">
            {kpis.underRepair}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">Total Asset + Repair Value</div>
          <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-blue-700 dark:text-blue-400">
            {formatCurrency(kpis.totalTco)}
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-0.5 tabular-nums">
            Repairs: {formatCurrency(kpis.totalRepair)}
          </div>
        </div>
      </div>

      {actionError && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
          {actionError}
        </div>
      )}

      {/* Inventory Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                <th className="py-2.5 px-4">Asset ID / Serial</th>
                <th className="py-2.5 px-4">Device & Specs</th>
                <th className="py-2.5 px-4">Hub / Employee</th>
                <th className="py-2.5 px-4">Warranty & AMC</th>
                <th className="py-2.5 px-4 text-right">Purchase / Repair Cost</th>
                <th className="py-2.5 px-4">Condition</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    No IT assets match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4">
                      <div className="font-mono font-semibold text-blue-700 dark:text-blue-400">{a.asset_tag}</div>
                      <div className="font-mono text-slate-500">{a.serial_number}</div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {a.device_name || `${a.brand} ${a.model}`}
                      </div>
                      <div className="text-slate-500">
                        {a.brand} {a.model} · {a.category}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div>{a.location_name || 'Unassigned Hub'}</div>
                      <div className="text-slate-500">
                        {a.assigned_employee_name || 'Shared / Unassigned'}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-500">
                      <div>Bought: {formatDateOnly(a.purchase_date)}</div>
                      <div>Exp: {formatDateOnly(a.warranty_expiry)}</div>
                      {(a.warranty_provider || a.service_contract) && (
                        <div className="text-[11px] font-sans text-slate-400 truncate max-w-[180px]">
                          {[a.warranty_provider, a.service_contract].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      <div className="font-semibold">{formatCurrency(a.purchase_cost)}</div>
                      <div className="text-slate-500">
                        Repairs ({a.repair_count ?? 0}x): {formatCurrency(a.total_maintenance_cost)}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      {canManageAssets ? (
                        <select
                          value={a.condition_status}
                          onChange={(e) => updateCondition(a.id, e.target.value)}
                          className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        >
                          <option value="Operational">Operational</option>
                          <option value="Under Repair">Under Repair</option>
                          <option value="Spare">Spare</option>
                          <option value="Decommissioned">Decommissioned</option>
                        </select>
                      ) : (
                        <span className="font-medium">{a.condition_status}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {canManageAssets && (
                          <button
                            type="button"
                            onClick={() => openEditModal(a)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                          >
                            <Edit3 className="w-3 h-3" />
                            Edit / Assign
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openMaint(a)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                        >
                          <Wrench className="w-3 h-3" />
                          <span>Lifecycle ({a.repair_count ?? 0}/{a.linked_tickets ?? 0})</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Asset Modal */}
      {formOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSubmitAsset}
            className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold">
                {editingAsset ? `Update Asset · ${editingAsset.asset_tag}` : 'Register New IT Asset'}
              </h3>
              <button type="button" onClick={() => setFormOpen(false)} className="cursor-pointer">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {formError && (
              <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                {formError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                placeholder="Device Name (e.g. Dell Latitude 5430 Laptop)"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                className="sm:col-span-2 px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <input
                required
                disabled={Boolean(editingAsset)}
                placeholder="Asset ID / Tag (e.g. SDGL-LAP-101) *"
                value={assetTag}
                onChange={(e) => setAssetTag(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 disabled:opacity-60"
              />
              <input
                required
                disabled={Boolean(editingAsset)}
                placeholder="Serial Number *"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
                className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 disabled:opacity-60"
              />
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {assetCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={conditionStatus}
                onChange={(e) => setConditionStatus(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="Operational">Operational</option>
                <option value="Spare">Spare</option>
                <option value="Under Repair">Under Repair</option>
                <option value="Decommissioned">Decommissioned</option>
              </select>
              <input
                required
                placeholder="Brand (Dell, HP, Cisco, Zebra...) *"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <input
                required
                placeholder="Model *"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="">Assigned Hub / Branch...</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.code})
                  </option>
                ))}
              </select>
              <select
                value={assignedEmployeeId}
                onChange={(e) => setAssignedEmployeeId(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="">Unassigned / Shared Facility Device</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.full_name} ({emp.employee_code})
                  </option>
                ))}
              </select>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Purchase Date *</label>
                <input
                  type="date"
                  required
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Purchase Cost (₹ INR)</label>
                <input
                  type="number"
                  min="0"
                  placeholder="Purchase Cost (₹)"
                  value={purchaseCost}
                  onChange={(e) => setPurchaseCost(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Warranty Expiry</label>
                <input
                  type="date"
                  value={warrantyExpiry}
                  onChange={(e) => setWarrantyExpiry(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Warranty Provider</label>
                <input
                  placeholder="e.g. Dell ProSupport India"
                  value={warrantyProvider}
                  onChange={(e) => setWarrantyProvider(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <input
                placeholder="Service Contract / AMC ID"
                value={serviceContract}
                onChange={(e) => setServiceContract(e.target.value)}
                className="sm:col-span-2 px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <input
              placeholder="Location / Rack / Allocation notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingAsset}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer"
              >
                {savingAsset ? 'Saving...' : editingAsset ? 'Save Changes' : 'Register Asset'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Asset Lifecycle, Maintenance & Timeline Modal */}
      {selectedAsset && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-display font-bold">
                  {selectedAsset.device_name || `${selectedAsset.brand} ${selectedAsset.model}`} ({selectedAsset.asset_tag})
                </h3>
                <p className="text-xs font-mono text-slate-500 mt-0.5">
                  Serial: {selectedAsset.serial_number} · {selectedAsset.location_name || 'Unassigned Hub'} ·{' '}
                  {selectedAsset.assigned_employee_name || 'Shared Asset'}
                </p>
                {(selectedAsset.warranty_provider || selectedAsset.service_contract) && (
                  <p className="text-xs text-slate-500 mt-0.5">
                    Warranty: {selectedAsset.warranty_provider || '—'} · Contract: {selectedAsset.service_contract || '—'} (Exp:{' '}
                    {formatDateOnly(selectedAsset.warranty_expiry)})
                  </p>
                )}
              </div>
              <button type="button" onClick={() => setSelectedAsset(null)} className="cursor-pointer">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {maintSummary && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500">Repair Count</div>
                  <div className="text-lg font-mono font-bold tabular-nums">{maintSummary.repairCount}</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500">Purchase Cost</div>
                  <div className="text-lg font-mono font-bold tabular-nums">
                    {formatCurrency(maintSummary.purchaseCost)}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500">Repair Spend</div>
                  <div className="text-lg font-mono font-bold tabular-nums text-amber-700 dark:text-amber-400">
                    {formatCurrency(maintSummary.totalRepairCost)}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                  <div className="text-[11px] text-slate-500">Total Lifecycle TCO</div>
                  <div className="text-lg font-mono font-bold tabular-nums text-blue-700 dark:text-blue-400">
                    {formatCurrency(maintSummary.totalLifecycleCost)}
                  </div>
                </div>
              </div>
            )}

            {canManageAssets && (
              <form
                onSubmit={handleAddMaintenance}
                className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3"
              >
                <div className="text-xs font-semibold">Log Maintenance / Repair Event</div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                  <select
                    value={maintType}
                    onChange={(e) => setMaintType(e.target.value)}
                    className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="Repair">Repair</option>
                    <option value="Parts Replacement">Parts Replacement</option>
                    <option value="Preventive">Preventive Maintenance</option>
                  </select>
                  <select
                    value={maintVendorId}
                    onChange={(e) => setMaintVendorId(e.target.value)}
                    className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="">In-House IT</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    placeholder="Cost (₹)"
                    value={maintCost}
                    onChange={(e) => setMaintCost(e.target.value)}
                    className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <input
                    type="date"
                    value={maintDate}
                    onChange={(e) => setMaintDate(e.target.value)}
                    className="px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    required
                    placeholder="Describe repair, replacement part, or preventive service..."
                    value={maintDesc}
                    onChange={(e) => setMaintDesc(e.target.value)}
                    className="flex-1 min-w-[200px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <select
                    value={maintNextStatus}
                    onChange={(e) => setMaintNextStatus(e.target.value)}
                    className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="">Keep Status ({selectedAsset.condition_status})</option>
                    <option value="Operational">Mark Operational</option>
                    <option value="Under Repair">Mark Under Repair</option>
                    <option value="Spare">Mark Spare</option>
                    <option value="Decommissioned">Mark Decommissioned</option>
                  </select>
                  <button
                    type="submit"
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer whitespace-nowrap shrink-0"
                  >
                    Add Record
                  </button>
                </div>
              </form>
            )}

            {/* Drawer Sub-Tabs */}
            <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
              <button
                type="button"
                onClick={() => setDrawerTab('repairs')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                  drawerTab === 'repairs' ? 'bg-blue-700 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                Repairs & Service ({maintHistory.length})
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab('timeline')}
                className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                  drawerTab === 'timeline' ? 'bg-blue-700 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                Custody & Lifecycle ({assetHistory.length})
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab('tickets')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                  drawerTab === 'tickets' ? 'bg-blue-700 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                Linked Tickets ({linkedTickets.length})
              </button>
            </div>

            {drawerTab === 'repairs' && (
              <div>
                {maintHistory.length === 0 ? (
                  <div className="text-xs text-slate-500">No maintenance records logged yet.</div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    {maintHistory.map((m) => (
                      <div key={m.id} className="py-2.5 flex justify-between gap-4">
                        <div>
                          <div className="font-semibold">
                            {m.maintenance_type} · {m.vendor_name || 'In-House IT'}
                          </div>
                          <div className="text-slate-600 dark:text-slate-300">{m.description}</div>
                          {m.performed_by && <div className="text-[11px] text-slate-400">Tech: {m.performed_by}</div>}
                        </div>
                        <div className="text-right font-mono shrink-0">
                          <div className="font-semibold">{formatCurrency(m.cost)}</div>
                          <div className="text-slate-400">{m.performed_at}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {drawerTab === 'timeline' && (
              <div>
                {assetHistory.length === 0 ? (
                  <div className="text-xs text-slate-500">No custody or lifecycle history recorded yet.</div>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                    {assetHistory.map((h) => (
                      <div key={h.id} className="py-2.5 flex justify-between gap-4">
                        <div>
                          <div className="font-semibold">
                            {h.event_type}
                            {h.previous_value || h.new_value
                              ? `: ${h.previous_value ? `${h.previous_value} → ` : ''}${h.new_value || ''}`
                              : ''}
                          </div>
                          {h.notes && <div className="text-slate-600 dark:text-slate-300 mt-0.5">{h.notes}</div>}
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            By {h.actor_name}
                            {h.location_name ? ` · Hub: ${h.location_name}` : ''}
                            {h.employee_name ? ` · Employee: ${h.employee_name}` : ''}
                          </div>
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 shrink-0 whitespace-nowrap">
                          {formatDateTime(h.created_at)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {drawerTab === 'tickets' && (
              <div>
                {linkedTickets.length === 0 ? (
                  <div className="text-xs text-slate-500">No tickets linked to this asset.</div>
                ) : (
                  <div className="space-y-1.5 text-xs">
                    {linkedTickets.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setSelectedAsset(null);
                          onSelectTicket(t.id);
                        }}
                        className="w-full text-left p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 flex justify-between cursor-pointer"
                      >
                        <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                          {t.ticket_number} · {t.category}
                        </span>
                        <span>
                          {t.priority} · {t.status}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Excel Bulk Import Modal */}
      {excelModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-display font-bold">Import IT Devices from Excel (.xlsx / .xls)</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Download the formatted Excel template, populate device records, and upload for transactional validation.
                </p>
              </div>
              <button type="button" onClick={() => setExcelModalOpen(false)} className="cursor-pointer">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs">
              <div>
                <div className="font-semibold">Step 1: Download Sample Template</div>
                <div className="text-slate-500">Includes all supported columns & INR Purchase Cost header.</div>
              </div>
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-semibold hover:bg-slate-100 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                Download .xlsx Template
              </button>
            </div>

            <form onSubmit={handleExcelUpload} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold mb-1.5">Step 2: Upload Filled Workbook (.xlsx / .xls)</label>
                <input
                  ref={excelInputRef}
                  type="file"
                  accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  onChange={(e) => {
                    setExcelError('');
                    setExcelFile(e.target.files?.[0] || null);
                  }}
                  className="w-full text-xs"
                />
              </div>

              {(excelFile || importingExcel || excelError) && (
                <UploadProgressList
                  files={excelFile ? [excelFile] : []}
                  uploading={importingExcel}
                  progress={excelProgress}
                  error={excelError}
                  completed={Boolean(importResult && !importingExcel && !excelError)}
                  onRemoveFile={() => setExcelFile(null)}
                  onRetry={() => handleExcelUpload()}
                />
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setExcelModalOpen(false)}
                  className="px-4 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={!excelFile || importingExcel}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {importingExcel ? `Importing (${excelProgress}%)...` : 'Validate & Import Devices'}
                </button>
              </div>
            </form>

            {importResult && (
              <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                <div className="grid grid-cols-3 gap-2.5 text-xs">
                  <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Total Rows</div>
                    <div className="text-base font-mono font-bold tabular-nums">{importResult.totalRows}</div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900">
                    <div className="text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Imported
                    </div>
                    <div className="text-base font-mono font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                      {importResult.importedCount}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900">
                    <div className="text-red-700 dark:text-red-400 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Failed Rows
                    </div>
                    <div className="text-base font-mono font-bold tabular-nums text-red-700 dark:text-red-300">
                      {importResult.failedCount}
                    </div>
                  </div>
                </div>

                {importResult.errors.length > 0 && (
                  <div className="border border-red-200 dark:border-red-900 rounded-lg overflow-hidden">
                    <div className="px-3 py-2 bg-red-50 dark:bg-red-950/40 text-xs font-semibold text-red-700 dark:text-red-300">
                      Row Validation Error Report
                    </div>
                    <div className="max-h-44 overflow-y-auto divide-y divide-red-100 dark:divide-red-900/40 text-xs">
                      {importResult.errors.map((err, i) => (
                        <div key={i} className="px-3 py-2 flex items-start justify-between gap-3">
                          <span className="font-mono text-slate-600 dark:text-slate-300 shrink-0">
                            Row {err.row} {err.asset_tag ? `· ${err.asset_tag}` : ''}
                          </span>
                          <span className="text-red-700 dark:text-red-300 text-right">{err.error}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {importBatches.length > 0 && (
              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <div className="text-xs font-semibold text-slate-500">Recent Import Batches</div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs max-h-36 overflow-y-auto">
                  {importBatches.map((b) => (
                    <div key={b.id} className="py-1.5 flex items-center justify-between gap-2">
                      <span className="truncate font-medium">
                        {b.filename} <span className="text-slate-400">by {b.imported_by_name}</span>
                      </span>
                      <span className="font-mono tabular-nums shrink-0 text-slate-500">
                        {b.imported_count}/{b.total_rows} ok · {formatDateTime(b.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
