import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudOff,
  Database,
  Download,
  ExternalLink,
  FileCode2,
  FolderOpen,
  HardDrive,
  Laptop,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import {
  apiFetch,
  fetchProtectedBlobUrl,
  formatDateTime,
  setAuthToken,
  uploadWithProgress,
} from '../../utils/api.ts';
import {
  clearInMemoryDriveAuth,
  getInMemoryDriveAccessToken,
  GoogleSignInButton,
  initGoogleDriveAuth,
  signInWithGoogleDrive,
} from '../../utils/googleDriveAuth.tsx';
import { formatBytesCompact } from '../common/MediaPreviewModal.tsx';

export interface AttachedLaptopDbInfo {
  filename: string;
  sizeBytes: number;
  sha256: string;
  attachedAt: string;
  attachedBy: string;
  source: 'laptop_upload' | 'laptop_handle' | 'drive_restore';
  localPathHint?: string;
}

export interface DriveSyncStatus {
  folderId: string;
  folderUrl: string;
  folderName: string | null;
  autoSyncEnabled: boolean;
  syncIntervalMs: number;
  syncMode: 'smart_1s' | 'continuous_1s';
  attachedLaptopDb: AttachedLaptopDbInfo | null;
  driveFileIds: {
    liveDb?: string;
    fullExportJson?: string;
    auditLogsJson?: string;
    consoleLogs?: string;
    manifestJson?: string;
  };
  connectedGoogleEmail: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: 'Idle' | 'Syncing' | 'Synced' | 'Waiting Google Sign-In' | 'Error';
  lastSyncError: string | null;
  lastSyncDurationMs: number;
  lastDbDigest: string | null;
  lastLogVersion: number;
  totalSyncCount: number;
  tokenActive: boolean;
  workerRunning: boolean;
  syncInFlight: boolean;
  dbFilePath: string;
  dbFileSizeBytes: number;
  dbModifiedAt: string | null;
  consoleLogLines: number;
  tableCounts: Record<string, number>;
}

interface DriveRemoteFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

interface CapturedLogEntry {
  seq: number;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SYNC' | 'DB';
  source: string;
  message: string;
}

type ConfirmModalState =
  | {
      kind: 'connect_drive';
      email: string | null;
      accessToken: string;
      folderUrlOrId: string;
    }
  | {
      kind: 'sync_now';
      folderId: string;
    }
  | {
      kind: 'attach_local';
      file: File;
      sourceType: 'laptop_upload' | 'laptop_handle';
      handle: any | null;
    }
  | {
      kind: 'restore_drive';
      fileId: string;
      filename: string;
    }
  | {
      kind: 'trash_drive';
      fileId: string;
      filename: string;
    };

export default function DriveDatabaseSyncPanel() {
  const { user, refreshUser, subscribeRealtime } = useAuth();
  const [status, setStatus] = useState<DriveSyncStatus | null>(null);
  const [consoleLogs, setConsoleLogs] = useState<CapturedLogEntry[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveRemoteFile[]>([]);
  const [folderInput, setFolderInput] = useState(
    'https://drive.google.com/drive/folders/1OlM-Weze7_FAu7C8tU7pidbN0AcMAM6N?usp=drive_link'
  );
  const [syncModeDraft, setSyncModeDraft] = useState<'smart_1s' | 'continuous_1s'>('smart_1s');
  const [autoSyncDraft, setAutoSyncDraft] = useState<boolean>(true);
  const [folderSyncedOnce, setFolderSyncedOnce] = useState(false);

  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [connectingDrive, setConnectingDrive] = useState(false);
  const [syncingNow, setSyncingNow] = useState(false);
  const [attachingDb, setAttachingDb] = useState(false);
  const [attachProgress, setAttachProgress] = useState<number | null>(null);
  const [downloadingDb, setDownloadingDb] = useState(false);
  const [mirroringLaptop, setMirroringLaptop] = useState(false);

  const [laptopFileHandle, setLaptopFileHandle] = useState<any | null>(null);
  const [logLevelFilter, setLogLevelFilter] = useState<'ALL' | 'DB' | 'SYNC' | 'WARN' | 'ERROR' | 'INFO'>('ALL');
  const [logTailActive, setLogTailActive] = useState(true);

  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [busyConfirm, setBusyConfirm] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const buildDriveHeaders = useCallback((): Record<string, string> => {
    const token = getInMemoryDriveAccessToken();
    return token ? { 'X-Google-Drive-Token': `Bearer ${token}` } : {};
  }, []);

  const loadDriveFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      const res = await apiFetch<{ files: DriveRemoteFile[] }>('/api/auth/drive-sync/files', {
        headers: buildDriveHeaders(),
      });
      setDriveFiles(res.files || []);
    } catch {
      // ignore if Drive session isn't active yet
    } finally {
      setLoadingFiles(false);
    }
  }, [buildDriveHeaders]);

  const loadStatus = useCallback(
    async (alsoLoadFiles = false) => {
      setLoadingStatus(true);
      try {
        const res = await apiFetch<{ status: DriveSyncStatus; consoleLogs: CapturedLogEntry[] }>(
          '/api/auth/drive-sync/status'
        );
        setStatus(res.status);
        setConsoleLogs(res.consoleLogs || []);
        if (!folderSyncedOnce && res.status) {
          setFolderInput(res.status.folderUrl || res.status.folderId);
          setSyncModeDraft(res.status.syncMode || 'smart_1s');
          setAutoSyncDraft(Boolean(res.status.autoSyncEnabled));
          setFolderSyncedOnce(true);
        }
        if (alsoLoadFiles || res.status?.tokenActive) {
          loadDriveFiles();
        }
      } catch (e: any) {
        setErr(e?.message || 'Unable to load Google Drive & Database Sync status.');
      } finally {
        setLoadingStatus(false);
      }
    },
    [folderSyncedOnce, loadDriveFiles]
  );

  const loadConsoleLogs = useCallback(async () => {
    try {
      const res = await apiFetch<{ logs: CapturedLogEntry[] }>('/api/auth/drive-sync/console-logs?limit=250');
      setConsoleLogs(res.logs || []);
    } catch {
      // ignore transient log fetch error
    }
  }, []);

  useEffect(() => {
    initGoogleDriveAuth();
    loadStatus(false);
  }, [loadStatus]);

  // Listen for 1s live status updates streamed over authenticated WebSocket
  useEffect(() => {
    const unsub = subscribeRealtime((evt) => {
      if (evt.event === 'drive:sync-status' && evt.data) {
        setStatus(evt.data as DriveSyncStatus);
      }
    });
    return unsub;
  }, [subscribeRealtime]);

  // Tail server & console logs smoothly while viewing this panel
  useEffect(() => {
    if (!logTailActive) return;
    const timer = setInterval(() => {
      loadConsoleLogs();
    }, 1500);
    return () => clearInterval(timer);
  }, [logTailActive, loadConsoleLogs]);

  const handleSaveConfig = async (overrideAuto?: boolean, overrideMode?: 'smart_1s' | 'continuous_1s') => {
    setSavingConfig(true);
    setErr('');
    setMsg('');
    try {
      const nextAuto = overrideAuto !== undefined ? overrideAuto : autoSyncDraft;
      const nextMode = overrideMode !== undefined ? overrideMode : syncModeDraft;
      const res = await apiFetch<{ status: DriveSyncStatus }>('/api/auth/drive-sync/config', {
        method: 'PUT',
        body: JSON.stringify({
          folderUrlOrId: folderInput.trim(),
          autoSyncEnabled: nextAuto,
          syncMode: nextMode,
        }),
      });
      setStatus(res.status);
      setAutoSyncDraft(res.status.autoSyncEnabled);
      setSyncModeDraft(res.status.syncMode);
      setFolderInput(res.status.folderUrl || res.status.folderId);
      setMsg(
        `Saved 1-second sync configuration for folder ${res.status.folderId} (${
          res.status.autoSyncEnabled ? 'Auto-Sync ON' : 'Auto-Sync Paused'
        }, mode: ${res.status.syncMode}).`
      );
    } catch (e: any) {
      setErr(e?.message || 'Failed to update Drive sync configuration.');
    } finally {
      setSavingConfig(false);
    }
  };

  // Must invoke popup synchronously inside click handler so browsers do not block OAuth popup
  const handleStartGoogleSignIn = async () => {
    setConnectingDrive(true);
    setErr('');
    setMsg('');
    try {
      const authRes = await signInWithGoogleDrive();
      setConfirmModal({
        kind: 'connect_drive',
        email: authRes.email,
        accessToken: authRes.accessToken,
        folderUrlOrId: folderInput.trim() || status?.folderId || '1OlM-Weze7_FAu7C8tU7pidbN0AcMAM6N',
      });
    } catch (e: any) {
      setErr(e?.message || 'Google Drive sign-in was cancelled or failed.');
    } finally {
      setConnectingDrive(false);
    }
  };

  const handleDisconnectDrive = async () => {
    setErr('');
    setMsg('');
    try {
      const res = await apiFetch<{ status: DriveSyncStatus }>('/api/auth/drive-sync/disconnect', {
        method: 'POST',
      });
      await clearInMemoryDriveAuth();
      setStatus(res.status);
      setDriveFiles([]);
      setMsg('Google Drive OAuth session disconnected and auto-sync worker stopped.');
    } catch (e: any) {
      setErr(e?.message || 'Failed to disconnect Google Drive.');
    }
  };

  const handlePickLaptopDbWithFsApi = async () => {
    setErr('');
    const picker = (window as unknown as { showOpenFilePicker?: (opts?: any) => Promise<any[]> }).showOpenFilePicker;
    if (typeof picker !== 'function') {
      fileInputRef.current?.click();
      return;
    }

    try {
      const handles = await picker({
        multiple: false,
        types: [
          {
            description: 'SQLite Database Files',
            accept: {
              'application/x-sqlite3': ['.db', '.sqlite', '.sqlite3'],
            },
          },
        ],
      });
      if (!handles || handles.length === 0) return;
      const handle = handles[0];
      const file: File = await handle.getFile();
      setConfirmModal({
        kind: 'attach_local',
        file,
        sourceType: 'laptop_handle',
        handle,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      // Sandboxed iframe or unsupported restriction -> seamlessly fall back to standard file picker
      fileInputRef.current?.click();
    }
  };

  const handleLocalInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setConfirmModal({
      kind: 'attach_local',
      file,
      sourceType: 'laptop_upload',
      handle: null,
    });
  };

  const handleDownloadLiveDbToLaptop = async () => {
    setDownloadingDb(true);
    setErr('');
    try {
      const blobUrl = await fetchProtectedBlobUrl('/api/auth/database/download-live');
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `sdglobal-it_crm-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 20000);
      setMsg('Downloaded clean SQLite database snapshot to your computer.');
    } catch (e: any) {
      setErr(e?.message || 'Failed to export database file.');
    } finally {
      setDownloadingDb(false);
    }
  };

  const handleMirrorLiveDbToLaptopHandle = async () => {
    if (!laptopFileHandle) return;
    setMirroringLaptop(true);
    setErr('');
    setMsg('');
    try {
      if (typeof laptopFileHandle.requestPermission === 'function') {
        const perm = await laptopFileHandle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          throw new Error('Write permission to the selected laptop database file was declined.');
        }
      }
      const blobUrl = await fetchProtectedBlobUrl('/api/auth/database/download-live');
      const resp = await fetch(blobUrl);
      const blob = await resp.blob();
      URL.revokeObjectURL(blobUrl);

      const writable = await laptopFileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      setMsg(`Synced live CRM database back to laptop file "${laptopFileHandle.name}".`);
    } catch (e: any) {
      setErr(e?.message || 'Unable to write live database back to laptop file handle.');
    } finally {
      setMirroringLaptop(false);
    }
  };

  const executeConfirmedAction = async () => {
    if (!confirmModal) return;
    setBusyConfirm(true);
    setErr('');
    setMsg('');

    try {
      if (confirmModal.kind === 'connect_drive') {
        const res = await apiFetch<{ verified: any; status: DriveSyncStatus }>('/api/auth/drive-sync/connect', {
          method: 'POST',
          headers: {
            'X-Google-Drive-Token': `Bearer ${confirmModal.accessToken}`,
          },
          body: JSON.stringify({
            folderUrlOrId: confirmModal.folderUrlOrId,
          }),
        });
        setStatus(res.status);
        setFolderInput(res.status.folderUrl || res.status.folderId);
        setAutoSyncDraft(res.status.autoSyncEnabled);
        setSyncModeDraft(res.status.syncMode);
        setConfirmModal(null);
        setMsg(
          `Connected Google Drive folder "${res.verified?.folderName || res.status.folderId}" (${
            res.verified?.googleEmail || confirmModal.email || 'Authorized Google Account'
          }). 1-second database & log auto-sync is now running.`
        );
        await Promise.all([loadDriveFiles(), loadConsoleLogs()]);
      } else if (confirmModal.kind === 'sync_now') {
        setSyncingNow(true);
        try {
          const res = await apiFetch<{ synced?: boolean; status: DriveSyncStatus }>('/api/auth/drive-sync/sync-now', {
            method: 'POST',
            headers: buildDriveHeaders(),
          });
          setStatus(res.status);
          setConfirmModal(null);
          setMsg('Full database snapshot, JSON exports, audit logs, and server console logs synced to Google Drive.');
          await Promise.all([loadDriveFiles(), loadConsoleLogs()]);
        } finally {
          setSyncingNow(false);
        }
      } else if (confirmModal.kind === 'attach_local') {
        setAttachingDb(true);
        setAttachProgress(0);
        try {
          const fd = new FormData();
          fd.append('database', confirmModal.file);
          fd.append('confirm', 'CONFIRM_ATTACH_DATABASE');
          fd.append('sourceType', confirmModal.sourceType);
          fd.append('localPathHint', confirmModal.file.name);

          const res = await uploadWithProgress<{
            ok: boolean;
            token: string;
            attachedInfo: AttachedLaptopDbInfo;
            preRestoreFilename: string;
            status: DriveSyncStatus;
          }>('/api/auth/database/attach-local', fd, {
            method: 'POST',
            onProgress: (p) => setAttachProgress(p),
          });

          if (res.token) {
            setAuthToken(res.token);
            await refreshUser();
          }
          if (confirmModal.handle) {
            setLaptopFileHandle(confirmModal.handle);
          }
          setStatus(res.status);
          setConfirmModal(null);
          setMsg(
            `Attached laptop database "${res.attachedInfo.filename}" (${formatBytesCompact(
              res.attachedInfo.sizeBytes
            )}). Auto safety snapshot saved as ${res.preRestoreFilename}.`
          );
          await loadConsoleLogs();
        } finally {
          setAttachingDb(false);
          setAttachProgress(null);
        }
      } else if (confirmModal.kind === 'restore_drive') {
        const res = await apiFetch<{
          ok: boolean;
          token: string;
          attachedInfo: AttachedLaptopDbInfo;
          preRestoreFilename: string;
          status: DriveSyncStatus;
        }>('/api/auth/drive-sync/restore-file', {
          method: 'POST',
          headers: buildDriveHeaders(),
          body: JSON.stringify({
            fileId: confirmModal.fileId,
            filename: confirmModal.filename,
            confirm: 'CONFIRM_ATTACH_DATABASE',
          }),
        });
        if (res.token) {
          setAuthToken(res.token);
          await refreshUser();
        }
        setStatus(res.status);
        setConfirmModal(null);
        setMsg(
          `Attached Drive database "${res.attachedInfo.filename}". Pre-restore snapshot saved as ${res.preRestoreFilename}.`
        );
        await loadConsoleLogs();
      } else if (confirmModal.kind === 'trash_drive') {
        await apiFetch(`/api/auth/drive-sync/files/${encodeURIComponent(confirmModal.fileId)}`, {
          method: 'DELETE',
          headers: buildDriveHeaders(),
          body: JSON.stringify({ confirm: 'CONFIRM_DRIVE_DELETE' }),
        });
        const removedName = confirmModal.filename;
        setConfirmModal(null);
        setMsg(`Moved "${removedName}" in Google Drive folder to Trash.`);
        await loadDriveFiles();
      }
    } catch (e: any) {
      setErr(e?.message || 'Action failed.');
    } finally {
      setBusyConfirm(false);
    }
  };

  if (user?.role !== 'super_admin') {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 text-xs text-slate-500">
        Only Super Administrators can configure Google Drive database sync or attach local laptop SQLite files.
      </div>
    );
  }

  const filteredLogs = consoleLogs
    .filter((entry) => logLevelFilter === 'ALL' || entry.level === logLevelFilter)
    .slice()
    .reverse();

  const statusTone =
    status?.lastSyncStatus === 'Synced'
      ? 'text-emerald-700 dark:text-emerald-400'
      : status?.lastSyncStatus === 'Error'
      ? 'text-red-600 dark:text-red-400'
      : status?.lastSyncStatus === 'Syncing'
      ? 'text-blue-700 dark:text-blue-400'
      : 'text-amber-600 dark:text-amber-400';

  return (
    <div className="space-y-5">
      {err && (
        <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
          <span>{err}</span>
          <button type="button" onClick={() => setErr('')} className="underline cursor-pointer shrink-0">
            Dismiss
          </button>
        </div>
      )}
      {msg && (
        <div className="p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-xs text-emerald-700 dark:text-emerald-300 flex items-center justify-between gap-2">
          <span>{msg}</span>
          <button type="button" onClick={() => setMsg('')} className="underline cursor-pointer shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {/* SECTION 1: GOOGLE DRIVE REAL-TIME DATABASE & LOG SERVER */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Cloud className="w-5 h-5 text-blue-600 shrink-0" />
              <h2 className="text-base font-display font-bold text-slate-900 dark:text-white">
                Google Drive Database Server & 1-Second Auto-Sync
              </h2>
            </div>
            <p className="text-xs text-slate-500 max-w-3xl">
              Connect your Google Drive folder to continuously synchronize the live SQLite database (
              <span className="font-mono">it_crm_live.db</span>), full table JSON export, immutable audit/activity logs,
              server console logs, and verified snapshots every 1 second.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {status?.tokenActive ? (
              <>
                <GoogleSignInButton
                  onClick={handleStartGoogleSignIn}
                  disabled={connectingDrive}
                  label={connectingDrive ? 'Authorizing...' : 'Switch Google Account'}
                />
                <button
                  type="button"
                  disabled={syncingNow}
                  onClick={() =>
                    setConfirmModal({
                      kind: 'sync_now',
                      folderId: status.folderId,
                    })
                  }
                  className="inline-flex items-center gap-1.5 h-10 px-4 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50 cursor-pointer whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${syncingNow || status.syncInFlight ? 'animate-spin' : ''}`} />
                  {syncingNow ? 'Syncing All...' : 'Sync All Now'}
                </button>
                <button
                  type="button"
                  onClick={handleDisconnectDrive}
                  className="inline-flex items-center gap-1.5 h-10 px-3.5 text-xs font-semibold rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer whitespace-nowrap"
                >
                  <CloudOff className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              </>
            ) : (
              <GoogleSignInButton
                onClick={handleStartGoogleSignIn}
                disabled={connectingDrive}
                label={connectingDrive ? 'Opening Google OAuth...' : 'Sign in with Google Drive'}
              />
            )}
          </div>
        </div>

        {/* Live Telemetry Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Drive Sync Status</div>
            <div className={`mt-1 text-sm font-display font-bold ${statusTone}`}>
              {status?.lastSyncStatus || 'Loading...'}
            </div>
            <div className="mt-0.5 text-[11px] font-mono text-slate-500 truncate">
              {status?.connectedGoogleEmail || 'Not connected'}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">1s Worker Loop</div>
            <div className="mt-1 text-sm font-display font-bold text-slate-900 dark:text-white">
              {status?.workerRunning && status?.autoSyncEnabled ? 'Active (Every 1s)' : 'Paused / Idle'}
            </div>
            <div className="mt-0.5 text-[11px] font-mono text-slate-500">
              Mode: {status?.syncMode === 'continuous_1s' ? 'Continuous 1s' : 'Change-Triggered 1s'}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Last Synced</div>
            <div className="mt-1 text-xs font-mono font-semibold text-slate-900 dark:text-white">
              {status?.lastSyncAt ? formatDateTime(status.lastSyncAt) : 'Not synced yet'}
            </div>
            <div className="mt-0.5 text-[11px] font-mono text-slate-500 tabular-nums">
              {status?.totalSyncCount ?? 0} syncs · {status?.lastSyncDurationMs ?? 0}ms
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Live SQLite Size</div>
            <div className="mt-1 text-sm font-mono font-bold tabular-nums text-slate-900 dark:text-white">
              {formatBytesCompact(status?.dbFileSizeBytes || 0)}
            </div>
            <div className="mt-0.5 text-[11px] font-mono text-slate-500 truncate">{status?.dbFilePath || 'data/it_crm.db'}</div>
          </div>

          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">Console Log Stream</div>
            <div className="mt-1 text-sm font-mono font-bold tabular-nums text-slate-900 dark:text-white">
              {status?.consoleLogLines ?? consoleLogs.length} events
            </div>
            <div className="mt-0.5 text-[11px] font-mono text-slate-500 truncate">
              Folder: {status?.folderName || status?.folderId || 'Pending verify'}
            </div>
          </div>
        </div>

        {status?.lastSyncError && (
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Latest Sync Notice:</span> {status.lastSyncError}
            </div>
          </div>
        )}

        {/* Drive Folder URL & 1-Second Auto-Sync Controls */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800 items-end">
          <div className="lg:col-span-6 space-y-1">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Google Drive Folder URL or Folder ID
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/..."
                className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              {status?.folderUrl && (
                <a
                  href={status.folderUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
                >
                  Open Drive
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>

          <div className="lg:col-span-3 space-y-1">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">1-Second Sync Mode</label>
            <select
              value={syncModeDraft}
              onChange={(e) => setSyncModeDraft(e.target.value as 'smart_1s' | 'continuous_1s')}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="smart_1s">Every 1s Change-Triggered (Recommended)</option>
              <option value="continuous_1s">Every 1s Continuous Console & DB Stream</option>
            </select>
          </div>

          <div className="lg:col-span-3 flex items-center justify-end gap-2">
            <label className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoSyncDraft}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setAutoSyncDraft(checked);
                  handleSaveConfig(checked, syncModeDraft);
                }}
              />
              <span>Auto-Sync 1s</span>
            </label>
            <button
              type="button"
              disabled={savingConfig}
              onClick={() => handleSaveConfig()}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-blue-700 text-white hover:opacity-90 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              {savingConfig ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>

        {/* Tracked Table Counts Strip */}
        {status?.tableCounts && (
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Database Tables Included in Every Sync
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 text-xs">
              {Object.entries(status.tableCounts).map(([tbl, count]) => (
                <div
                  key={tbl}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800"
                >
                  <span className="font-mono text-slate-600 dark:text-slate-300 truncate">{tbl}</span>
                  <span className="font-mono font-bold tabular-nums text-slate-900 dark:text-white ml-2">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* SECTION 2: LAPTOP DATABASE ATTACHMENT + DRIVE FOLDER BROWSER */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Laptop DB Card */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <Laptop className="w-5 h-5 text-emerald-600 shrink-0" />
              <div>
                <h3 className="text-sm font-display font-bold text-slate-900 dark:text-white">
                  Laptop SQLite Database File (.db / .sqlite)
                </h3>
                <p className="text-xs text-slate-500">
                  Attach your local laptop <span className="font-mono">it_crm.db</span> file directly to this CRM server and mirror updates back anytime.
                </p>
              </div>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".db,.sqlite,.sqlite3"
            className="hidden"
            onChange={handleLocalInputChange}
          />

          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-700 dark:text-slate-200">Currently Attached Laptop / External DB</span>
              {status?.attachedLaptopDb ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Attached
                </span>
              ) : (
                <span className="text-slate-400">Default Server DB</span>
              )}
            </div>

            {status?.attachedLaptopDb ? (
              <div className="grid grid-cols-2 gap-2 pt-1 font-mono text-[11px]">
                <div>
                  <span className="text-slate-400">File:</span>{' '}
                  <span className="text-slate-900 dark:text-white font-semibold">{status.attachedLaptopDb.filename}</span>
                </div>
                <div>
                  <span className="text-slate-400">Size:</span>{' '}
                  <span className="text-slate-900 dark:text-white">
                    {formatBytesCompact(status.attachedLaptopDb.sizeBytes)}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">Attached:</span>{' '}
                  <span>{formatDateTime(status.attachedLaptopDb.attachedAt)}</span>
                </div>
                <div>
                  <span className="text-slate-400">SHA-256:</span>{' '}
                  <span>{status.attachedLaptopDb.sha256.slice(0, 14)}...</span>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">
                No external laptop database attached yet. Select a <span className="font-mono">.db</span> file from your laptop to mount its data onto this CRM server and sync it with Google Drive.
              </p>
            )}
          </div>

          {attachProgress !== null && (
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] font-mono text-slate-500">
                <span>Uploading & verifying SQLite header...</span>
                <span>{attachProgress}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${attachProgress}%` }} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={attachingDb}
              onClick={handlePickLaptopDbWithFsApi}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              {attachingDb ? 'Attaching Laptop DB...' : 'Attach Laptop .db File'}
            </button>

            <button
              type="button"
              disabled={downloadingDb}
              onClick={handleDownloadLiveDbToLaptop}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              {downloadingDb ? 'Exporting .db...' : 'Download Live .db to Laptop'}
            </button>

            {laptopFileHandle && (
              <button
                type="button"
                disabled={mirroringLaptop}
                onClick={handleMirrorLiveDbToLaptopHandle}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-50 cursor-pointer"
              >
                <HardDrive className="w-3.5 h-3.5" />
                {mirroringLaptop ? 'Writing to Laptop File...' : `Mirror Back to "${laptopFileHandle.name}"`}
              </button>
            )}
          </div>
        </div>

        {/* Google Drive Files Browser */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-blue-600" />
              <h3 className="text-sm font-display font-bold">
                Synced Files in Google Drive Folder ({driveFiles.length})
              </h3>
            </div>
            <button
              type="button"
              disabled={loadingFiles || !status?.tokenActive}
              onClick={loadDriveFiles}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingFiles ? 'animate-spin' : ''}`} />
              Refresh Folder
            </button>
          </div>

          <div className="overflow-x-auto max-h-72 overflow-y-auto flex-1">
            {!status?.tokenActive ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Sign in with Google Drive above to view live synced files in folder{' '}
                <span className="font-mono">{status?.folderId || '1OlM-Weze7_FAu7C8tU7pidbN0AcMAM6N'}</span>.
              </div>
            ) : driveFiles.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                No files returned yet. Click "Sync All Now" or "Refresh Folder".
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                    <th className="py-2 px-4">File Name</th>
                    <th className="py-2 px-4 text-right">Size</th>
                    <th className="py-2 px-4">Updated</th>
                    <th className="py-2 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {driveFiles.map((f) => {
                    const isSqlite = /\.(db|sqlite|sqlite3)$/i.test(f.name);
                    return (
                      <tr key={f.id}>
                        <td className="py-2 px-4 font-mono">
                          <div className="flex items-center gap-1.5">
                            {isSqlite ? (
                              <Database className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                            ) : (
                              <FileCode2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            )}
                            <span className="truncate max-w-[200px]" title={f.name}>
                              {f.name}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-500">
                          {f.size ? formatBytesCompact(Number(f.size)) : '—'}
                        </td>
                        <td className="py-2 px-4 font-mono text-slate-500 whitespace-nowrap">
                          {f.modifiedTime ? formatDateTime(f.modifiedTime) : '—'}
                        </td>
                        <td className="py-2 px-4 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {isSqlite && (
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmModal({
                                    kind: 'restore_drive',
                                    fileId: f.id,
                                    filename: f.name,
                                  })
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer"
                              >
                                <RotateCcw className="w-3 h-3" />
                                Attach DB
                              </button>
                            )}
                            {f.webViewLink && (
                              <a
                                href={f.webViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                                title="Open in Google Drive"
                              >
                                <ExternalLink className="w-3 h-3 text-slate-500" />
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmModal({
                                  kind: 'trash_drive',
                                  fileId: f.id,
                                  filename: f.name,
                                })
                              }
                              className="p-1 rounded border border-red-200 dark:border-red-900 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                              title="Move to Drive Trash"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* SECTION 3: LIVE SERVER CONSOLE & DATABASE LOG STREAM */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-blue-600" />
            <div>
              <h3 className="text-sm font-display font-bold">
                Live Console & Database Activity Logs (Synced as server_console_logs.log)
              </h3>
              <p className="text-[11px] text-slate-500">
                All server console messages, SQLite mutations, backups, and Google Drive 1-second sync events.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={logLevelFilter}
              onChange={(e) => setLogLevelFilter(e.target.value as any)}
              className="px-2.5 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="ALL">All Levels ({consoleLogs.length})</option>
              <option value="SYNC">SYNC</option>
              <option value="DB">DB</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
            </select>

            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={logTailActive}
                onChange={(e) => setLogTailActive(e.target.checked)}
              />
              Live Tail
            </label>

            <button
              type="button"
              onClick={() => loadStatus(false)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loadingStatus ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto bg-slate-950 text-slate-200 font-mono text-[11px] divide-y divide-slate-800/70">
          {filteredLogs.length === 0 ? (
            <div className="p-6 text-center text-slate-500">No console or database log entries match this filter.</div>
          ) : (
            filteredLogs.map((entry) => {
              const lvlClass =
                entry.level === 'ERROR'
                  ? 'text-red-400'
                  : entry.level === 'WARN'
                  ? 'text-amber-400'
                  : entry.level === 'SYNC'
                  ? 'text-cyan-400'
                  : entry.level === 'DB'
                  ? 'text-emerald-400'
                  : 'text-slate-400';
              return (
                <div key={entry.seq} className="px-4 py-1.5 flex items-start gap-3 hover:bg-slate-900/70">
                  <span className="text-slate-600 shrink-0 w-10">#{entry.seq}</span>
                  <span className="text-slate-500 shrink-0 whitespace-nowrap">{formatDateTime(entry.timestamp)}</span>
                  <span className={`shrink-0 w-12 font-semibold ${lvlClass}`}>[{entry.level}]</span>
                  <span className="text-slate-400 shrink-0 w-24 truncate">[{entry.source}]</span>
                  <span className="text-slate-100 break-all">{entry.message}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* EXPLICIT CONFIRMATION MODAL FOR DRIVE MUTATIONS & DATABASE ATTACHMENT */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/65 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
                {confirmModal.kind === 'connect_drive' && 'Confirm Google Drive 1-Second Auto-Sync'}
                {confirmModal.kind === 'sync_now' && 'Confirm Immediate Google Drive Upload & Sync'}
                {confirmModal.kind === 'attach_local' && 'Confirm Attach Laptop SQLite Database File'}
                {confirmModal.kind === 'restore_drive' && 'Confirm Attach Database from Google Drive'}
                {confirmModal.kind === 'trash_drive' && 'Confirm Move Google Drive File to Trash'}
              </h3>
              <button
                type="button"
                disabled={busyConfirm}
                onClick={() => setConfirmModal(null)}
                className="cursor-pointer text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {confirmModal.kind === 'connect_drive' && (
              <div className="text-xs text-slate-600 dark:text-slate-300 space-y-2.5">
                <p>
                  Google account{' '}
                  <strong className="font-mono text-slate-900 dark:text-white">
                    {confirmModal.email || 'Authorized Google Account'}
                  </strong>{' '}
                  will connect to target Drive folder{' '}
                  <strong className="font-mono text-slate-900 dark:text-white">{confirmModal.folderUrlOrId}</strong>.
                </p>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1 font-mono text-[11px]">
                  <div>Files synced & updated in Drive every 1 second on change:</div>
                  <div>• it_crm_live.db (SQLite binary snapshot)</div>
                  <div>• crm_full_database_export.json (all database tables)</div>
                  <div>• crm_audit_and_activity_logs.json (audit & sessions)</div>
                  <div>• server_console_logs.log (server console & DB stream)</div>
                  <div>• database_sync_manifest.json + versioned backups</div>
                </div>
              </div>
            )}

            {confirmModal.kind === 'sync_now' && (
              <div className="text-xs text-slate-600 dark:text-slate-300 space-y-2">
                <p>
                  This will immediately create/overwrite the latest database snapshot, full JSON export, audit logs,
                  console logs, and sync manifest inside Google Drive folder{' '}
                  <strong className="font-mono">{confirmModal.folderId}</strong>.
                </p>
              </div>
            )}

            {confirmModal.kind === 'attach_local' && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 space-y-1.5">
                <div>
                  Laptop File: <strong className="font-mono">{confirmModal.file.name}</strong> (
                  {formatBytesCompact(confirmModal.file.size)})
                </div>
                <p>
                  The server will verify the SQLite header, save a automatic <strong className="font-mono">pre_restore</strong>{' '}
                  safety snapshot of the current database, attach this laptop database onto the CRM server, keep your Super Admin session signed in, and sync to Google Drive.
                </p>
              </div>
            )}

            {confirmModal.kind === 'restore_drive' && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 space-y-1.5">
                <div>
                  Drive Database File: <strong className="font-mono">{confirmModal.filename}</strong>
                </div>
                <p>
                  This will download the selected SQLite database from Google Drive, save a{' '}
                  <strong className="font-mono">pre_restore</strong> safety backup of the current live database, and make{' '}
                  <strong>{confirmModal.filename}</strong> the active live database.
                </p>
              </div>
            )}

            {confirmModal.kind === 'trash_drive' && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                Move <strong className="font-mono">{confirmModal.filename}</strong> in Google Drive to Trash?
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={busyConfirm}
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyConfirm}
                onClick={executeConfirmedAction}
                className={`px-4 py-2 text-xs font-semibold rounded-lg text-white disabled:opacity-50 cursor-pointer ${
                  confirmModal.kind === 'trash_drive'
                    ? 'bg-red-600 hover:bg-red-700'
                    : confirmModal.kind === 'attach_local' || confirmModal.kind === 'restore_drive'
                    ? 'bg-amber-600 hover:bg-amber-700'
                    : 'bg-blue-700 hover:bg-blue-800'
                }`}
              >
                {busyConfirm
                  ? 'Processing...'
                  : confirmModal.kind === 'connect_drive'
                  ? 'Confirm & Start 1-Second Auto-Sync'
                  : confirmModal.kind === 'sync_now'
                  ? 'Confirm & Sync Now'
                  : confirmModal.kind === 'attach_local'
                  ? 'Confirm & Attach Laptop Database'
                  : confirmModal.kind === 'restore_drive'
                  ? 'Confirm & Attach Drive Database'
                  : 'Confirm Move to Trash'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
