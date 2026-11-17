import React, { useEffect, useState } from 'react';
import { Download, FileText, Film, Image as ImageIcon, Loader2, RefreshCw, X } from 'lucide-react';
import { fetchProtectedBlobUrl } from '../../utils/api.ts';

export interface PreviewMediaDescriptor {
  file_name: string;
  mime_type?: string | null;
  file_size?: number | null;
  url: string;
}

interface MediaPreviewModalProps {
  media: PreviewMediaDescriptor | null;
  onClose: () => void;
}

export function formatBytesCompact(bytes?: number | null): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function MediaPreviewModal({ media, onClose }: MediaPreviewModalProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadFile = async (target: PreviewMediaDescriptor) => {
    setLoading(true);
    setError('');
    try {
      const objUrl = await fetchProtectedBlobUrl(target.url);
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return objUrl;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load media preview.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!media) {
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setError('');
      return;
    }
    loadFile(media);
    return () => {
      setBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [media?.url]);

  if (!media) return null;

  const mime = (media.mime_type || '').toLowerCase();
  const nameLower = (media.file_name || '').toLowerCase();
  const isImage = mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(nameLower);
  const isVideo = mime.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(nameLower);
  const isPdf = mime === 'application/pdf' || nameLower.endsWith('.pdf');

  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = media.file_name || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950/75 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            {isImage ? (
              <ImageIcon className="w-4 h-4 text-blue-600 shrink-0" />
            ) : isVideo ? (
              <Film className="w-4 h-4 text-purple-600 shrink-0" />
            ) : (
              <FileText className="w-4 h-4 text-slate-500 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                {media.file_name}
              </div>
              <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                {media.mime_type || 'application/octet-stream'} · {formatBytesCompact(media.file_size)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {blobUrl && (
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close media preview"
              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-slate-100 dark:bg-slate-950 flex items-center justify-center p-4 min-h-[320px]">
          {loading ? (
            <div className="flex flex-col items-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
              <span>Decrypting & loading secure file stream...</span>
            </div>
          ) : error ? (
            <div className="max-w-md text-center space-y-3">
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
              <button
                type="button"
                onClick={() => loadFile(media)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry Preview
              </button>
            </div>
          ) : blobUrl ? (
            isImage ? (
              <img
                src={blobUrl}
                alt={media.file_name}
                className="max-w-full max-h-[72vh] object-contain rounded-lg shadow-sm"
              />
            ) : isVideo ? (
              <video
                src={blobUrl}
                controls
                className="max-w-full max-h-[72vh] rounded-lg shadow-sm bg-black"
              />
            ) : isPdf ? (
              <iframe
                src={blobUrl}
                title={media.file_name}
                className="w-full h-[72vh] rounded-lg border border-slate-200 dark:border-slate-800 bg-white"
              />
            ) : (
              <div className="text-center space-y-3 p-6 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
                <FileText className="w-10 h-10 text-blue-600 mx-auto" />
                <div className="text-sm font-semibold">{media.file_name}</div>
                <p className="text-xs text-slate-500">
                  Browser inline preview is unavailable for this document format. Download the verified file safely.
                </p>
                <button
                  type="button"
                  onClick={handleDownload}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download File ({formatBytesCompact(media.file_size)})
                </button>
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
