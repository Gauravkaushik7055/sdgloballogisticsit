import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NotificationItem, NotificationPrefs, UserBroadcastItem, UserSession } from '../types/index.ts';
import { apiFetch, getAuthToken, setAuthToken } from '../utils/api.ts';

export interface RealtimeEvent {
  event: string;
  data: any;
}

export interface MfaChallengeResult {
  mfa_required: true;
  mfa_challenge_token: string;
  user_preview?: {
    email: string;
    full_name: string;
    role_label: string;
  };
}

interface AuthContextValue {
  user: UserSession | null;
  loading: boolean;
  notifications: NotificationItem[];
  unreadCount: number;
  broadcasts: UserBroadcastItem[];
  broadcastUnreadCount: number;
  broadcastPopups: UserBroadcastItem[];
  chatUnreadCount: number;
  onlineUserIds: number[];
  notificationPrefs: NotificationPrefs;
  popupToasts: NotificationItem[];
  sessionNotice: string | null;
  clearSessionNotice: () => void;
  login: (
    email: string,
    password: string,
    options?: { portal_mode?: 'moderator_common'; mod_access?: string }
  ) => Promise<MfaChallengeResult | void>;
  completeMfaLogin: (mfaChallengeToken: string, code: string) => Promise<void>;
  loginWithInvite: (payload: { token: string; password?: string; new_password?: string }) => Promise<void>;
  loginWithMobileOtp: (payload: {
    mobile: string;
    otp: string;
    full_name?: string;
    email?: string;
    department_id?: number;
    location_id?: number;
    designation?: string;
  }) => Promise<{ is_new_employee: boolean }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
  refreshBroadcasts: () => Promise<void>;
  refreshChatUnread: () => Promise<void>;
  markNotificationRead: (id: number) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  markBroadcastRead: (id: number) => Promise<void>;
  markAllBroadcastsRead: () => Promise<void>;
  dismissBroadcastPopup: (id: number) => void;
  updateNotificationPrefs: (next: Partial<NotificationPrefs>) => Promise<NotificationPrefs>;
  dismissPopupToast: (id: number) => void;
  subscribeRealtime: (handler: (evt: RealtimeEvent) => void) => () => void;
}

const DEFAULT_PREFS: NotificationPrefs = { enabled: true, popups_enabled: true };

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  notifications: [],
  unreadCount: 0,
  broadcasts: [],
  broadcastUnreadCount: 0,
  broadcastPopups: [],
  chatUnreadCount: 0,
  onlineUserIds: [],
  notificationPrefs: DEFAULT_PREFS,
  popupToasts: [],
  sessionNotice: null,
  clearSessionNotice: () => {},
  login: async () => {},
  completeMfaLogin: async () => {},
  loginWithInvite: async () => {},
  loginWithMobileOtp: async () => ({ is_new_employee: false }),
  logout: async () => {},
  refreshUser: async () => {},
  refreshNotifications: async () => {},
  refreshBroadcasts: async () => {},
  refreshChatUnread: async () => {},
  markNotificationRead: async () => {},
  markAllNotificationsRead: async () => {},
  markBroadcastRead: async () => {},
  markAllBroadcastsRead: async () => {},
  dismissBroadcastPopup: () => {},
  updateNotificationPrefs: async () => DEFAULT_PREFS,
  dismissPopupToast: () => {},
  subscribeRealtime: () => () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [broadcasts, setBroadcasts] = useState<UserBroadcastItem[]>([]);
  const [broadcastUnreadCount, setBroadcastUnreadCount] = useState(0);
  const [broadcastPopups, setBroadcastPopups] = useState<UserBroadcastItem[]>([]);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [onlineUserIds, setOnlineUserIds] = useState<number[]>([]);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [popupToasts, setPopupToasts] = useState<NotificationItem[]>([]);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  const subscribersRef = useRef<Set<(evt: RealtimeEvent) => void>>(new Set());
  const prefsRef = useRef<NotificationPrefs>(DEFAULT_PREFS);
  prefsRef.current = notificationPrefs;
  const shownPopupIdsRef = useRef<Set<number>>(new Set());

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  const clearLocalSessionState = useCallback((notice?: string | null) => {
    shownPopupIdsRef.current.clear();
    setAuthToken(null);
    setUser(null);
    setNotifications([]);
    setUnreadCount(0);
    setBroadcasts([]);
    setBroadcastUnreadCount(0);
    setBroadcastPopups([]);
    setChatUnreadCount(0);
    setOnlineUserIds([]);
    setPopupToasts([]);
    if (notice) setSessionNotice(notice);
  }, []);

  const subscribeRealtime = useCallback((handler: (evt: RealtimeEvent) => void) => {
    subscribersRef.current.add(handler);
    return () => {
      subscribersRef.current.delete(handler);
    };
  }, []);

  const dismissPopupToast = useCallback((id: number) => {
    setPopupToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const dismissBroadcastPopup = useCallback((id: number) => {
    setBroadcastPopups((prev) => prev.filter((item) => item.id !== id));
    apiFetch(`/api/broadcasts/${id}/popup-seen`, { method: 'POST' }).catch(() => {});
  }, []);

  const triggerBroadcastPopups = useCallback((items: UserBroadcastItem[]) => {
    const eligible = items.filter(
      (b) =>
        b.display_mode === 'tab_and_popup' &&
        !b.popup_seen &&
        !shownPopupIdsRef.current.has(b.id)
    );
    if (eligible.length === 0) return;

    eligible.forEach((b) => {
      shownPopupIdsRef.current.add(b.id);
      // Persist immediately so refreshing the page never shows the same broadcast popup twice
      apiFetch(`/api/broadcasts/${b.id}/popup-seen`, { method: 'POST' }).catch(() => {});
    });

    setBroadcastPopups((prev) => {
      const existingIds = new Set(prev.map((p) => p.id));
      const merged = [...eligible.filter((e) => !existingIds.has(e.id)), ...prev];
      return merged.slice(0, 4);
    });
  }, []);

  const refreshNotifications = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const data = await apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>('/api/notifications');
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // ignore transient poll error
    }
  }, []);

  const refreshBroadcasts = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const data = await apiFetch<{
        broadcasts: UserBroadcastItem[];
        unreadCount: number;
        unseenPopups: UserBroadcastItem[];
      }>('/api/broadcasts/my');
      setBroadcasts(data.broadcasts || []);
      setBroadcastUnreadCount(data.unreadCount || 0);
      if (Array.isArray(data.unseenPopups) && data.unseenPopups.length > 0) {
        triggerBroadcastPopups(data.unseenPopups);
      }
    } catch {
      // ignore transient poll error
    }
  }, [triggerBroadcastPopups]);

  const refreshChatUnread = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const data = await apiFetch<{ totalUnread: number }>('/api/chat/unread-summary');
      setChatUnreadCount(data.totalUnread ?? 0);
    } catch {
      // ignore if user role does not use direct chat
    }
  }, []);

  const syncUserSessionData = useCallback(
    async (sessionUser: UserSession) => {
      if (sessionUser.notification_prefs) {
        setNotificationPrefs(sessionUser.notification_prefs);
      } else if (sessionUser.role === 'super_admin') {
        apiFetch<NotificationPrefs>('/api/notifications/preferences')
          .then(setNotificationPrefs)
          .catch(() => {});
      }
      await Promise.all([refreshNotifications(), refreshBroadcasts()]);
      if (sessionUser.role !== 'management' || sessionUser.permissions?.can_view_chats !== false) {
        await refreshChatUnread();
      } else {
        setChatUnreadCount(0);
      }
    },
    [refreshBroadcasts, refreshChatUnread, refreshNotifications]
  );

  const refreshUser = useCallback(async () => {
    if (!getAuthToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const data = await apiFetch<{ user: UserSession }>('/api/auth/me');
      setUser(data.user);
      await syncUserSessionData(data.user);
    } catch {
      setAuthToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [syncUserSessionData]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  useEffect(() => {
    const onSessionEnded = (ev: Event) => {
      const detail = (ev as CustomEvent<{ message?: string }>).detail;
      clearLocalSessionState(detail?.message || 'Your session has expired or was terminated. Please sign in again.');
    };
    window.addEventListener('sdglobal:session-ended', onSessionEnded);
    return () => window.removeEventListener('sdglobal:session-ended', onSessionEnded);
  }, [clearLocalSessionState]);

  // WebSocket live connection for Direct Chat, Presence, Notifications, Broadcasts, and Real-time Dashboard sync
  useEffect(() => {
    if (!user) {
      setOnlineUserIds([]);
      return;
    }

    const token = getAuthToken();
    if (!token) return;

    let ws: WebSocket | null = null;
    let closedByCleanup = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closedByCleanup) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(url);

      ws.onmessage = (msgEvent) => {
        try {
          const parsed = JSON.parse(msgEvent.data) as RealtimeEvent;
          if (!parsed?.event) return;

          if (parsed.event === 'presence:update' && Array.isArray(parsed.data?.onlineUserIds)) {
            setOnlineUserIds(parsed.data.onlineUserIds);
          } else if (parsed.event === 'notification:new' && parsed.data) {
            const notif = parsed.data as NotificationItem;
            setNotifications((prev) => [notif, ...prev.filter((n) => n.id !== notif.id)].slice(0, 60));
            setUnreadCount((c) => c + 1);
            if (prefsRef.current.enabled && prefsRef.current.popups_enabled) {
              setPopupToasts((prev) => [notif, ...prev.filter((p) => p.id !== notif.id)].slice(0, 4));
              setTimeout(() => {
                setPopupToasts((prev) => prev.filter((p) => p.id !== notif.id));
              }, 8500);
            }
          } else if (parsed.event === 'notifications:prefs' && parsed.data) {
            setNotificationPrefs(parsed.data as NotificationPrefs);
          } else if (parsed.event === 'broadcast:new' && parsed.data) {
            const incoming = parsed.data as UserBroadcastItem;
            setBroadcasts((prev) => [incoming, ...prev.filter((b) => b.id !== incoming.id)]);
            setBroadcastUnreadCount((c) => c + 1);
            // Strictly obey display_mode: 'tab_only' NEVER pops up; 'tab_and_popup' pops up once
            if (incoming.display_mode === 'tab_and_popup') {
              triggerBroadcastPopups([incoming]);
            }
          } else if (parsed.event === 'broadcast:updated') {
            refreshBroadcasts();
          } else if (parsed.event === 'session:terminated') {
            clearLocalSessionState(parsed.data?.reason || 'Your session was terminated by Super Admin.');
            return;
          } else if (parsed.event === 'chat:message' && parsed.data) {
            if (parsed.data.recipient_user_id === user.id) {
              refreshChatUnread();
            }
          } else if (parsed.event === 'chat:read') {
            refreshChatUnread();
          }

          subscribersRef.current.forEach((fn) => {
            try {
              fn(parsed);
            } catch {
              // protect loop
            }
          });
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (!closedByCleanup) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      closedByCleanup = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [user, refreshChatUnread, refreshBroadcasts, triggerBroadcastPopups, clearLocalSessionState]);

  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      refreshNotifications();
      refreshBroadcasts();
    }, 30000);
    return () => clearInterval(timer);
  }, [user, refreshNotifications, refreshBroadcasts]);

  const login = async (
    email: string,
    password: string,
    options?: { portal_mode?: 'moderator_common'; mod_access?: string }
  ): Promise<MfaChallengeResult | void> => {
    const data = await apiFetch<
      | { token: string; user: UserSession; mfa_required?: false }
      | MfaChallengeResult
    >('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        ...(options?.portal_mode ? { portal_mode: options.portal_mode } : {}),
        ...(options?.mod_access ? { mod_access: options.mod_access } : {}),
      }),
    });
    if ('mfa_required' in data && data.mfa_required) {
      return data;
    }
    const okData = data as { token: string; user: UserSession };
    setSessionNotice(null);
    shownPopupIdsRef.current.clear();
    setAuthToken(okData.token);
    setUser(okData.user);
    await syncUserSessionData(okData.user);
  };

  const completeMfaLogin = async (mfaChallengeToken: string, code: string) => {
    const data = await apiFetch<{ token: string; user: UserSession }>('/api/auth/mfa/verify-login', {
      method: 'POST',
      body: JSON.stringify({ mfa_challenge_token: mfaChallengeToken, code }),
    });
    setSessionNotice(null);
    shownPopupIdsRef.current.clear();
    setAuthToken(data.token);
    setUser(data.user);
    await syncUserSessionData(data.user);
  };

  const loginWithInvite = async (payload: { token: string; password?: string; new_password?: string }) => {
    const data = await apiFetch<{ token: string; user: UserSession }>('/api/auth/invite-login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setSessionNotice(null);
    shownPopupIdsRef.current.clear();
    setAuthToken(data.token);
    setUser(data.user);
    await syncUserSessionData(data.user);
  };

  const loginWithMobileOtp = async (payload: {
    mobile: string;
    otp: string;
    full_name?: string;
    email?: string;
    department_id?: number;
    location_id?: number;
    designation?: string;
  }) => {
    const data = await apiFetch<{ token: string; user: UserSession; is_new_employee: boolean }>(
      '/api/auth/employee-otp/verify',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    setSessionNotice(null);
    shownPopupIdsRef.current.clear();
    setAuthToken(data.token);
    setUser(data.user);
    await syncUserSessionData(data.user);
    return { is_new_employee: data.is_new_employee };
  };

  const logout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // continue local cleanup
    }
    setSessionNotice(null);
    clearLocalSessionState(null);
  };

  const markNotificationRead = async (id: number) => {
    await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
    await refreshNotifications();
  };

  const markAllNotificationsRead = async () => {
    await apiFetch('/api/notifications/read-all', { method: 'POST' });
    await refreshNotifications();
  };

  const markBroadcastRead = async (id: number) => {
    await apiFetch(`/api/broadcasts/${id}/read`, { method: 'POST' });
    await refreshBroadcasts();
  };

  const markAllBroadcastsRead = async () => {
    await apiFetch('/api/broadcasts/read-all', { method: 'POST' });
    await refreshBroadcasts();
  };

  const updateNotificationPrefs = async (next: Partial<NotificationPrefs>) => {
    const res = await apiFetch<NotificationPrefs>('/api/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify(next),
    });
    setNotificationPrefs(res);
    return res;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        notifications,
        unreadCount,
        broadcasts,
        broadcastUnreadCount,
        broadcastPopups,
        chatUnreadCount,
        onlineUserIds,
        notificationPrefs,
        popupToasts,
        sessionNotice,
        clearSessionNotice,
        login,
        completeMfaLogin,
        loginWithInvite,
        loginWithMobileOtp,
        logout,
        refreshUser,
        refreshNotifications,
        refreshBroadcasts,
        refreshChatUnread,
        markNotificationRead,
        markAllNotificationsRead,
        markBroadcastRead,
        markAllBroadcastsRead,
        dismissBroadcastPopup,
        updateNotificationPrefs,
        dismissPopupToast,
        subscribeRealtime,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
