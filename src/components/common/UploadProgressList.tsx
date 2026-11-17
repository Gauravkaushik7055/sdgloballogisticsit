import React from 'react';
import { AlertTriangle, CheckCircle2, FileText, RefreshCw, X } from 'lucide-react';
import { formatBytesCompact } from './MediaPreviewModal.tsx';

const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.ps1',
  '.msi',
  '.dll',
  '.js',
  '.vbs',
  '.html',
  '.htm',
  '.svg',
  '.php',
  '.apk',
]);

export function checkClientFileSafety(file: File, maxMb = 25): string | null {
  const lower = file.name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  if (!ext || BLOCKED_EXTENSIONS.has(ext)) {
    return `File "${file.name}" (${ext || 'unknown'}) is blocked by security policy.`;
  }
  if (file.size <= 0) {
    return `File "${file.name}" is empty (0 bytes).`;
  }
  if (file.size > maxMb * 1024 * 1024) {
    return `File "${file.name}" exceeds the ${maxMb} MB per-file limit.`;
  }
  return null;
}

interface UploadProgressListProps {
  files: File[];
  uploading: boolean;
  progress: number;
  error?: string;
  completed?: boolean;
  onRemoveFile?: (index: number) => void;
  onRetry?: () => void;
}

export default function UploadProgressList({
  files,
  uploading,
  progress,
  error,
  completed,
  onRemoveFile,
  onRetry,
}: UploadProgressListProps) {
  if (files.length === 0 && !uploading && !error) return null;

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3">
      {files.length > 0 && (
        <div className="space-y-1.5">
          {files.map((f, idx) => (
            <div
              key={`${f.name}-${idx}`}
              className="flex items-center justify-between gap-2 text-xs bg-white dark:bg-slate-900 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-800"
            >
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <FileText className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span className="truncate font-medium">{f.name}</span>
                <span className="font-mono text-[11px] text-slate-400 shrink-0">
                  ({formatBytesCompact(f.size)})
                </span>
              </span>
              {!uploading && onRemoveFile && (
                <button
                  type="button"
                  onClick={() => onRemoveFile(idx)}
                  aria-label={`Remove ${f.name}`}
                  className="text-slate-400 hover:text-red-600 cursor-pointer shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {uploading && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-medium text-blue-700 dark:text-blue-400">
            <span>Uploading & verifying media integrity...</span>
            <span className="font-mono tabular-nums">{progress}%</span>
          </div>
          <div className="w-full h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-150"
              style={{ width: `${Math.max(4, progress)}%` }}
            />
          </div>
        </div>
      )}

      {completed && !uploading && !error && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>All files uploaded and verified cleanly.</span>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-2 p-2 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-[11px] text-red-700 dark:text-red-300">
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </span>
          {onRetry && !uploading && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-semibold whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
