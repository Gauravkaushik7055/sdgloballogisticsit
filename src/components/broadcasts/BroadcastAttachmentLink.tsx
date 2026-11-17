import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, Image as ImageIcon } from 'lucide-react';
import { fetchProtectedBlobUrl } from '../../utils/api.ts';

interface BroadcastAttachmentLinkProps {
  path?: string | null;
  name?: string | null;
  mime?: string | null;
  showImagePreview?: boolean;
}

export default function BroadcastAttachmentLink({
  path,
  name,
  mime,
  showImagePreview = false,
}: BroadcastAttachmentLinkProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isImage = Boolean(mime && mime.startsWith('image/'));

  useEffect(() => {
    if (!path || !showImagePreview || !isImage) {
      setBlobUrl(null);
      return;
    }
    let active = true;
    let createdUrl: string | null = null;
    setLoading(true);
    fetchProtectedBlobUrl(path)
      .then((url) => {
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setBlobUrl(url);
      })
      .catch(() => {
        if (active) setBlobUrl(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [path, showImagePreview, isImage]);

  if (!path) return null;

  const handleOpenOrDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const url = blobUrl || (await fetchProtectedBlobUrl(path));
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'attachment';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (!blobUrl) {
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch {
      // ignore failed download
    }
  };

  return (
    <div className="mt-2 space-y-2">
      {showImagePreview && isImage && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-100 dark:bg-slate-800/60 max-h-40 flex items-center justify-center">
          {loading ? (
            <span className="text-[11px] text-slate-400 py-4">Loading preview...</span>
          ) : blobUrl ? (
            <img src={blobUrl} alt={name || 'Broadcast attachment'} className="max-h-40 w-full object-contain" />
          ) : (
            <span className="text-[11px] text-slate-400 py-3">Image preview unavailable</span>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={handleOpenOrDownload}
        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-700 dark:text-blue-400 hover:underline cursor-pointer"
      >
        {isImage ? <ImageIcon className="w-3.5 h-3.5 shrink-0" /> : <FileText className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate max-w-[200px]">{name || 'Download Attachment'}</span>
        {isImage ? <ExternalLink className="w-3 h-3 shrink-0" /> : <Download className="w-3 h-3 shrink-0" />}
      </button>
    </div>
  );
}
