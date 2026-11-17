import { getAuthToken } from './api.ts';

const VISITOR_STORAGE_KEY = 'sdgl_public_visitor_id';
const SESSION_STORAGE_KEY = 'sdgl_public_session_key';

function generateRandomId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getVisitorId(): string {
  try {
    let existing = localStorage.getItem(VISITOR_STORAGE_KEY);
    if (!existing) {
      existing = generateRandomId('v');
      localStorage.setItem(VISITOR_STORAGE_KEY, existing);
    }
    return existing;
  } catch {
    return '';
  }
}

function getSessionKey(): string {
  try {
    let existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!existing) {
      existing = generateRandomId('s');
      sessionStorage.setItem(SESSION_STORAGE_KEY, existing);
    }
    return existing;
  } catch {
    return generateRandomId('s');
  }
}

export function resolvePublicPagePath(fallback = '/'): string {
  try {
    const url = new URL(window.location.href);
    const panel = url.searchParams.get('panel');
    if (panel === 'employee-login') return '/portal/employee-login';
    if (panel === 'moderator-login') return '/portal/moderator-login';
    if (panel === 'login') return '/portal/login';
    if (url.searchParams.has('invite')) return '/portal/invite';
    return url.pathname || fallback;
  } catch {
    return fallback;
  }
}

export async function trackPublicVisit(explicitPath?: string): Promise<void> {
  // Never count authenticated internal dashboard users as public website visitors
  if (getAuthToken()) return;

  const pagePath = explicitPath || resolvePublicPagePath('/');
  const visitorId = getVisitorId();
  const sessionKey = getSessionKey();
  const referrer = typeof document !== 'undefined' ? document.referrer || '' : '';

  try {
    await fetch('/api/public/track-visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page_path: pagePath,
        referrer,
        session_key: sessionKey,
        visitor_id: visitorId,
      }),
    });
  } catch {
    // Non-blocking telemetry
  }
}

export async function sendVisitHeartbeat(explicitPath?: string): Promise<void> {
  if (getAuthToken()) return;
  const pagePath = explicitPath || resolvePublicPagePath('/');
  const sessionKey = getSessionKey();
  try {
    await fetch('/api/public/visit-heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page_path: pagePath,
        session_key: sessionKey,
      }),
    });
  } catch {
    // Non-blocking heartbeat
  }
}
