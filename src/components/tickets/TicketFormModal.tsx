import React, { useEffect, useState } from 'react';
import { FileText, Film, Image as ImageIcon, Upload, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { useDropdowns } from '../../context/DropdownContext.tsx';
import { DepartmentItem, LocationItem } from '../../types/index.ts';
import { apiFetch, uploadWithProgress } from '../../utils/api.ts';
import UploadProgressList, { checkClientFileSafety } from '../common/UploadProgressList.tsx';

interface TicketFormModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (ticketNumber: string) => void;
}

export default function TicketFormModal({ open, onClose, onCreated }: TicketFormModalProps) {
  const { user } = useAuth();
  const { getOptions } = useDropdowns();
  const categoryOptions = getOptions('work_category');
  const priorityOptions = getOptions('priority');
  const deviceTypeOptions = getOptions('device_type');
  const impactOptions = getOptions('business_impact');

  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [assets, setAssets] = useState<any[]>([]);

  const [reporterName, setReporterName] = useState('');
  const [reporterEmpCode, setReporterEmpCode] = useState('');
  const [reporterDept, setReporterDept] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [reporterDesignation, setReporterDesignation] = useState('');
  const [reporterMobile, setReporterMobile] = useState('');
  const [reporterEmail, setReporterEmail] = useState('');
  const [locationId, setLocationId] = useState('');
  const [reporterBranchName, setReporterBranchName] = useState('');
  const [reporterCity, setReporterCity] = useState('');
  const [reporterFullLocation, setReporterFullLocation] = useState('');
  const [reporterManager, setReporterManager] = useState('');

  const [category, setCategory] = useState<string>(() => categoryOptions[0] || 'Laptop / Desktop Issues');
  const [deviceType, setDeviceType] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [assetId, setAssetId] = useState('');
  const [assetSerialInput, setAssetSerialInput] = useState('');
  const [description, setDescription] = useState('');
  const [issueOccurredAt, setIssueOccurredAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [businessImpact, setBusinessImpact] = useState<string>(() => impactOptions[0] || 'Single User');
  const [priority, setPriority] = useState<string>('Medium');

  const [photos, setPhotos] = useState<File[]>([]);
  const [videos, setVideos] = useState<File[]>([]);
  const [documents, setDocuments] = useState<File[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    Promise.all([
      apiFetch<{ locations: LocationItem[] }>('/api/locations'),
      apiFetch<{ departments: DepartmentItem[] }>('/api/departments'),
      apiFetch<{ assets: any[] }>('/api/assets'),
    ])
      .then(([locRes, deptRes, assetRes]) => {
        setLocations(locRes.locations);
        setDepartments(deptRes.departments);
        setAssets(assetRes.assets);

        const emp = user?.employee_profile;
        if (emp) {
          setReporterName(emp.full_name || user?.full_name || '');
          setReporterEmpCode(emp.employee_code || '');
          setReporterDept(emp.department_name || '');
          setDepartmentId(emp.department_id ? String(emp.department_id) : '');
          setReporterDesignation(emp.designation || '');
          setReporterMobile(emp.mobile || '');
          setReporterEmail(emp.email || user?.email || '');
          setLocationId(emp.location_id ? String(emp.location_id) : '');
          setReporterBranchName(emp.location_name || '');
          setReporterCity(emp.location_city || '');
          setReporterManager(emp.reporting_manager || '');
        } else if (user) {
          setReporterName(user.full_name);
          setReporterEmail(user.email);
        }
      })
      .catch(() => {});
  }, [open, user]);

  if (!open || user?.role === 'moderator') return null;

  const handleLocationSelect = (idStr: string) => {
    setLocationId(idStr);
    const found = locations.find((l) => String(l.id) === idStr);
    if (found) {
      setReporterBranchName(found.name);
      setReporterCity(found.city);
      if (!reporterFullLocation) {
        setReporterFullLocation(found.address);
      }
    }
  };

  const handleDeptSelect = (idStr: string) => {
    setDepartmentId(idStr);
    const found = departments.find((d) => String(d.id) === idStr);
    if (found) setReporterDept(found.name);
  };

  const handleAssetSelect = (idStr: string) => {
    setAssetId(idStr);
    const found = assets.find((a) => String(a.id) === idStr);
    if (found) {
      setDeviceType(found.category);
      setDeviceName(`${found.brand} ${found.model}`);
      setAssetSerialInput(found.serial_number);
    }
  };

  const handleAddFiles = (
    incoming: FileList | null,
    setter: React.Dispatch<React.SetStateAction<File[]>>
  ) => {
    if (!incoming) return;
    setError('');
    setUploadError('');
    const accepted: File[] = [];
    for (const file of Array.from(incoming)) {
      const err = checkClientFileSafety(file, 25);
      if (err) {
        setUploadError(err);
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) {
      setter((prev) => [...prev, ...accepted]);
    }
  };

  const allSelectedFiles = [...photos, ...videos, ...documents];

  const submitTicketRequest = async () => {
    setError('');
    setUploadError('');
    setSubmitting(true);
    setUploadProgress(0);

    try {
      const fd = new FormData();
      fd.append('reporter_name', reporterName);
      fd.append('reporter_employee_code', reporterEmpCode);
      fd.append('reporter_department', reporterDept || 'Operations');
      if (departmentId) fd.append('department_id', departmentId);
      fd.append('reporter_designation', reporterDesignation);
      fd.append('reporter_mobile', reporterMobile);
      fd.append('reporter_email', reporterEmail);
      if (locationId) fd.append('location_id', locationId);
      fd.append('reporter_branch_name', reporterBranchName);
      fd.append('reporter_city', reporterCity);
      fd.append('reporter_full_location', reporterFullLocation);
      fd.append('reporter_manager', reporterManager);

      fd.append('category', category);
      fd.append('device_type', deviceType);
      fd.append('device_name', deviceName);
      if (assetId) fd.append('asset_id', assetId);
      fd.append('asset_serial_input', assetSerialInput);
      fd.append('description', description);
      fd.append('issue_occurred_at', new Date(issueOccurredAt).toISOString());
      fd.append('business_impact', businessImpact);
      fd.append('priority', priority);

      allSelectedFiles.forEach((file) => {
        fd.append('files', file);
      });

      const res = await uploadWithProgress<{ ticket: { ticket_number: string } }>('/api/tickets', fd, {
        method: 'POST',
        onProgress: (pct) => setUploadProgress(pct),
      });

      setDescription('');
      setPhotos([]);
      setVideos([]);
      setDocuments([]);
      setUploadProgress(0);
      onCreated(res.ticket.ticket_number);
      onClose();
    } catch (err: any) {
      const msg = err.message || 'Failed to submit IT ticket';
      setError(msg);
      if (allSelectedFiles.length > 0) setUploadError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitTicketRequest();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/65 flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
      <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl overflow-hidden my-auto max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-display font-bold text-slate-900 dark:text-white">
              Submit IT Support Request
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              A unique ticket reference (e.g. IT-2026-00015) will be automatically assigned upon submission.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-6">
          {error && (
            <div className="p-3 text-sm rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Section 1: Employee & Location Details */}
          <div>
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white mb-3 pb-2 border-b border-slate-100 dark:border-slate-800">
              1. Employee & Operational Location Details
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">Employee Name *</label>
                <input
                  required
                  value={reporterName}
                  onChange={(e) => setReporterName(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Employee ID *</label>
                <input
                  required
                  value={reporterEmpCode}
                  onChange={(e) => setReporterEmpCode(e.target.value)}
                  placeholder="EMP-4021"
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Department *</label>
                <select
                  value={departmentId}
                  onChange={(e) => handleDeptSelect(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="">Select department</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Designation *</label>
                <input
                  required
                  value={reporterDesignation}
                  onChange={(e) => setReporterDesignation(e.target.value)}
                  placeholder="Shift Floor Supervisor"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Mobile Number *</label>
                <input
                  required
                  value={reporterMobile}
                  onChange={(e) => setReporterMobile(e.target.value)}
                  placeholder="+91-98205-11021"
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Email Address *</label>
                <input
                  type="email"
                  required
                  value={reporterEmail}
                  onChange={(e) => setReporterEmail(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Branch / Warehouse *</label>
                <select
                  value={locationId}
                  onChange={(e) => handleLocationSelect(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="">Select warehouse / branch</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} ({l.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Branch / Warehouse Name *</label>
                <input
                  required
                  value={reporterBranchName}
                  onChange={(e) => setReporterBranchName(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">City *</label>
                <input
                  required
                  value={reporterCity}
                  onChange={(e) => setReporterCity(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium mb-1">Complete Location (Zone / Dock / Floor) *</label>
                <input
                  required
                  value={reporterFullLocation}
                  onChange={(e) => setReporterFullLocation(e.target.value)}
                  placeholder="Dock Bay 4, Zone C, Ground Floor"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Reporting Manager *</label>
                <input
                  required
                  value={reporterManager}
                  onChange={(e) => setReporterManager(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Technical Issue Details */}
          <div>
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white mb-3 pb-2 border-b border-slate-100 dark:border-slate-800">
              2. Technical Issue & Equipment Details
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">Issue Category *</label>
                <select
                  required
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {categoryOptions.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Link Registered IT Asset (Optional)</label>
                <select
                  value={assetId}
                  onChange={(e) => handleAssetSelect(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="">Manual entry / Not listed</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.asset_tag} · {a.brand} {a.model}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Asset ID / Serial Number</label>
                <input
                  value={assetSerialInput}
                  onChange={(e) => setAssetSerialInput(e.target.value)}
                  placeholder="e.g. ZBR-MC9300-88412"
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Device Type *</label>
                <input
                  required
                  list="dropdown-device-types"
                  value={deviceType}
                  onChange={(e) => setDeviceType(e.target.value)}
                  placeholder="Handheld RF Scanner, Printer, NVR..."
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
                <datalist id="dropdown-device-types">
                  {deviceTypeOptions.map((dt) => (
                    <option key={dt} value={dt} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Device Name / Model *</label>
                <input
                  required
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="Zebra MC9300 #4"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Date and Time of Issue *</label>
                <input
                  type="datetime-local"
                  required
                  value={issueOccurredAt}
                  onChange={(e) => setIssueOccurredAt(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Business Impact *</label>
                <select
                  required
                  value={businessImpact}
                  onChange={(e) => setBusinessImpact(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {impactOptions.map((imp) => (
                    <option key={imp} value={imp}>
                      {imp}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Priority Level *</label>
                <select
                  required
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {priorityOptions.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2 lg:col-span-3">
                <label className="block text-xs font-medium mb-1">Issue Description *</label>
                <textarea
                  required
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the error message, symptoms, affected dock/system, and any steps already tried..."
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
          </div>

          {/* Section 3: Evidence Uploads (Photos, Videos, Documents) */}
          <div>
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white mb-3 pb-2 border-b border-slate-100 dark:border-slate-800">
              3. Supporting Evidence Uploads (Max 25 MB per file)
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex flex-col items-center justify-center p-4 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer text-center">
                <ImageIcon className="w-5 h-5 text-blue-600 mb-1.5" />
                <span className="text-xs font-semibold">Upload Photos</span>
                <span className="text-[11px] text-slate-500 mt-0.5">JPG, PNG, WEBP</span>
                <input
                  type="file"
                  multiple
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleAddFiles(e.target.files, setPhotos)}
                />
                {photos.length > 0 && (
                  <span className="text-[11px] font-mono text-blue-700 dark:text-blue-400 mt-2">
                    {photos.length} photo(s) selected
                  </span>
                )}
              </label>

              <label className="flex flex-col items-center justify-center p-4 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer text-center">
                <Film className="w-5 h-5 text-blue-600 mb-1.5" />
                <span className="text-xs font-semibold">Upload Videos</span>
                <span className="text-[11px] text-slate-500 mt-0.5">MP4, WEBM, MOV</span>
                <input
                  type="file"
                  multiple
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => handleAddFiles(e.target.files, setVideos)}
                />
                {videos.length > 0 && (
                  <span className="text-[11px] font-mono text-blue-700 dark:text-blue-400 mt-2">
                    {videos.length} video(s) selected
                  </span>
                )}
              </label>

              <label className="flex flex-col items-center justify-center p-4 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer text-center">
                <FileText className="w-5 h-5 text-blue-600 mb-1.5" />
                <span className="text-xs font-semibold">Upload Documents</span>
                <span className="text-[11px] text-slate-500 mt-0.5">PDF, DOCX, XLSX, TXT</span>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
                  className="hidden"
                  onChange={(e) => handleAddFiles(e.target.files, setDocuments)}
                />
                {documents.length > 0 && (
                  <span className="text-[11px] font-mono text-blue-700 dark:text-blue-400 mt-2">
                    {documents.length} document(s) selected
                  </span>
                )}
              </label>
            </div>

            {(allSelectedFiles.length > 0 || uploadError) && (
              <div className="mt-3">
                <UploadProgressList
                  files={allSelectedFiles}
                  uploading={submitting}
                  progress={uploadProgress}
                  error={uploadError}
                  onRemoveFile={(idx) => {
                    if (idx < photos.length) {
                      setPhotos((prev) => prev.filter((_, i) => i !== idx));
                    } else if (idx < photos.length + videos.length) {
                      const vIdx = idx - photos.length;
                      setVideos((prev) => prev.filter((_, i) => i !== vIdx));
                    } else {
                      const dIdx = idx - photos.length - videos.length;
                      setDocuments((prev) => prev.filter((_, i) => i !== dIdx));
                    }
                  }}
                  onRetry={submitTicketRequest}
                />
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors disabled:opacity-60 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>{submitting ? 'Submitting Request...' : 'Submit Support Request'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
