import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Clock, Cloud, ExternalLink, Mail, MessageSquare, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { apiFetch, formatDateTime } from '../../utils/api.ts';
import DriveDatabaseSyncPanel from '../audit/DriveDatabaseSyncPanel.tsx';

export default function IntegrationsView() {
  const { notificationPrefs, updateNotificationPrefs } = useAuth();
  const [tab, setTab] = useState<'notifications' | 'outlook' | 'whatsapp' | 'sla' | 'drive_sync'>('notifications');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Outlook state
  const [outlookStatus, setOutlookStatus] = useState<any>(null);
  const [oClientId, setOClientId] = useState('');
  const [oClientSecret, setOClientSecret] = useState('');
  const [oTenantId, setOTenantId] = useState('common');
  const [oAutoCreate, setOAutoCreate] = useState(true);
  const [oAutoAssign, setOAutoAssign] = useState(true);
  const [oAutoResolve, setOAutoResolve] = useState(true);
  const [tickets, setTickets] = useState<any[]>([]);

  // WhatsApp state
  const [waStatus, setWaStatus] = useState<any>(null);
  const [wabaId, setWabaId] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [waToken, setWaToken] = useState('');
  const [waVerifyToken, setWaVerifyToken] = useState('');
  const [waEnabled, setWaEnabled] = useState(false);
  const [tplCreated, setTplCreated] = useState('ticket_created_confirmation');
  const [tplAssigned, setTplAssigned] = useState('ticket_moderator_assigned');
  const [tplProgress, setTplProgress] = useState('ticket_status_update');
  const [tplResolved, setTplResolved] = useState('ticket_resolution_notice');

  // SLA state
  const [slaConfigs, setSlaConfigs] = useState<any[]>([]);

  const loadAll = useCallback(async () => {
    const [oRes, wRes, sRes, tRes] = await Promise.all([
      apiFetch<any>('/api/integrations/outlook/status'),
      apiFetch<any>('/api/integrations/whatsapp/status'),
      apiFetch<{ configs: any[] }>('/api/sla-configs'),
      apiFetch<{ tickets: any[] }>('/api/tickets'),
    ]);
    setOutlookStatus(oRes);
    setOTenantId(oRes.tenantId || 'common');
    setOAutoCreate(Boolean(oRes.autoNotifyOnCreate));
    setOAutoAssign(Boolean(oRes.autoNotifyOnAssign));
    setOAutoResolve(Boolean(oRes.autoNotifyOnResolve));

    setWaStatus(wRes);
    setWabaId(wRes.wabaId || '');
    setPhoneNumberId(wRes.phoneNumberId || '');
    setWaVerifyToken('');
    setWaEnabled(Boolean(wRes.enabled));
    if (wRes.templates) {
      setTplCreated(wRes.templates.ticket_created || 'ticket_created_confirmation');
      setTplAssigned(wRes.templates.moderator_assigned || 'ticket_moderator_assigned');
      setTplProgress(wRes.templates.ticket_progress || 'ticket_status_update');
      setTplResolved(wRes.templates.ticket_resolved || 'ticket_resolution_notice');
    }

    setSlaConfigs(sRes.configs);
    setTickets(tRes.tickets);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.data?.type === 'OUTLOOK_OAUTH_SUCCESS') {
        setMsg(`Connected Microsoft Outlook account: ${ev.data.email || 'Authorized'}`);
        setErr('');
        loadAll();
      } else if (ev.data?.type === 'OUTLOOK_OAUTH_ERROR') {
        setErr(ev.data.error || 'Outlook OAuth failed');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadAll]);

  const handleSaveOutlookConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    await apiFetch('/api/integrations/outlook/config', {
      method: 'POST',
      body: JSON.stringify({
        clientId: oClientId || undefined,
        clientSecret: oClientSecret || undefined,
        tenantId: oTenantId,
        autoNotifyOnCreate: oAutoCreate,
        autoNotifyOnAssign: oAutoAssign,
        autoNotifyOnResolve: oAutoResolve,
      }),
    });
    setOClientSecret('');
    setMsg('Outlook OAuth settings saved securely on server.');
    loadAll();
  };

  const handleConnectOutlook = async () => {
    setErr('');
    try {
      const { url } = await apiFetch<{ url: string }>('/api/integrations/outlook/auth-url');
      const popup = window.open(url, 'outlook_oauth', 'width=600,height=720');
      if (!popup) {
        setErr('Popup was blocked by browser. Allow popups for this site to authorize Microsoft Outlook.');
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const handleDisconnectOutlook = async () => {
    await apiFetch('/api/integrations/outlook/config', {
      method: 'POST',
      body: JSON.stringify({ disconnect: true }),
    });
    setMsg('Outlook account disconnected.');
    loadAll();
  };

  const handleSyncOutlookInbox = async () => {
    setErr('');
    try {
      const res = await apiFetch<{ synced: number }>('/api/integrations/outlook/sync-inbox', { method: 'POST' });
      setMsg(`Synced ${res.synced} new inbound email(s) from Microsoft Graph.`);
      loadAll();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const handleLinkEmailToTicket = async (emailId: number, ticketId: string) => {
    if (!ticketId) return;
    await apiFetch('/api/integrations/outlook/link-ticket', {
      method: 'POST',
      body: JSON.stringify({ email_id: emailId, ticket_id: Number(ticketId) }),
    });
    loadAll();
  };

  const handleSaveWhatsAppConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    await apiFetch('/api/integrations/whatsapp/config', {
      method: 'POST',
      body: JSON.stringify({
        wabaId,
        phoneNumberId,
        accessToken: waToken || undefined,
        webhookVerifyToken: waVerifyToken || undefined,
        enabled: waEnabled,
        templates: {
          ticket_created: tplCreated,
          moderator_assigned: tplAssigned,
          ticket_progress: tplProgress,
          ticket_resolved: tplResolved,
        },
      }),
    });
    setWaToken('');
    setMsg('Meta WhatsApp Cloud API settings saved securely.');
    loadAll();
  };

  const handleSaveSla = async (cfg: any) => {
    await apiFetch(`/api/sla-configs/${cfg.id}`, {
      method: 'PUT',
      body: JSON.stringify(cfg),
    });
    setMsg(`Updated ${cfg.priority} SLA policy.`);
    loadAll();
  };

  const runtimeOrigin = window.location.origin;

  return (
    <div className="space-y-6">
      {/* Sub-Navigation */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setTab('notifications')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'notifications' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <Bell className="w-3.5 h-3.5" />
          Super Admin Notifications
        </button>
        <button
          type="button"
          onClick={() => setTab('outlook')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'outlook' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <Mail className="w-3.5 h-3.5" />
          Microsoft Outlook (Graph API)
        </button>
        <button
          type="button"
          onClick={() => setTab('whatsapp')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'whatsapp' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Meta WhatsApp Cloud API
        </button>
        <button
          type="button"
          onClick={() => setTab('sla')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'sla' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          SLA & Escalation Rules
        </button>
        <button
          type="button"
          onClick={() => setTab('drive_sync')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'drive_sync' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <Cloud className="w-3.5 h-3.5" />
          Google Drive DB Sync (1s)
        </button>
      </div>

      {err && (
        <div className="p-3 text-xs rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
          {err}
        </div>
      )}
      {msg && (
        <div className="p-3 text-xs rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
          {msg}
        </div>
      )}

      {/* TAB 0: SUPER ADMIN NOTIFICATIONS */}
      {tab === 'notifications' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div>
            <h2 className="text-base font-display font-bold">Super Admin Notification Controls</h2>
            <p className="text-xs text-slate-500 mt-1">
              Control workflow notifications and live popup alerts for moderator activity, task reviews, and direct chat messages.
            </p>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="p-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  Enable Super Admin Notifications (Master ON / OFF)
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  When OFF, workflow notification generation for moderator updates, notes, holds, reviews, and chat messages is paused cleanly without cluttering your inbox.
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const res = await updateNotificationPrefs({ enabled: !notificationPrefs.enabled });
                  setMsg(`Super Admin notifications turned ${res.enabled ? 'ON' : 'OFF'}.`);
                }}
                className={`px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer shrink-0 ${
                  notificationPrefs.enabled
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {notificationPrefs.enabled ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="p-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  Live On-Screen Popup Alerts (ON / OFF)
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Display live toast popups in the bottom-right corner whenever a new alert arrives (requires Master Notifications ON).
                </p>
              </div>
              <button
                type="button"
                disabled={!notificationPrefs.enabled}
                onClick={async () => {
                  const res = await updateNotificationPrefs({ popups_enabled: !notificationPrefs.popups_enabled });
                  setMsg(`Live popup alerts turned ${res.popups_enabled ? 'ON' : 'OFF'}.`);
                }}
                className={`px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer shrink-0 disabled:opacity-40 ${
                  notificationPrefs.popups_enabled && notificationPrefs.enabled
                    ? 'bg-blue-700 text-white hover:bg-blue-800'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {notificationPrefs.popups_enabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
            <div className="font-semibold text-slate-800 dark:text-slate-200">Monitored Super Admin Triggers</div>
            <div className="grid sm:grid-cols-2 gap-1.5 text-slate-600 dark:text-slate-400">
              <span>• Moderator accepts an assigned task</span>
              <span>• Moderator updates task status or adds notes</span>
              <span>• Task placed On Hold (with reason)</span>
              <span>• Moderator requests Pending Information</span>
              <span>• Task submitted as Ready for Review</span>
              <span>• Moderator sends a Direct Chat message</span>
              <span>• Task marked Completed after approval</span>
              <span>• Deduplicated in-app Notification Center</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 1: MICROSOFT OUTLOOK */}
      {tab === 'outlook' && outlookStatus && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-display font-bold">Microsoft Outlook OAuth 2.0 & Graph API</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Status:{' '}
                  <strong className={outlookStatus.connected ? 'text-emerald-600' : 'text-amber-600'}>
                    {outlookStatus.connected
                      ? `Connected as ${outlookStatus.connectedEmail}`
                      : 'Not Connected (Requires Azure App Registration & OAuth Sign-In)'}
                  </strong>
                </p>
              </div>
              <div className="flex items-center gap-2">
                {outlookStatus.connected ? (
                  <>
                    <button
                      type="button"
                      onClick={handleSyncOutlookInbox}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Sync Inbox
                    </button>
                    <button
                      type="button"
                      onClick={handleDisconnectOutlook}
                      className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-red-300 text-red-600 cursor-pointer"
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleConnectOutlook}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Connect Microsoft Outlook
                  </button>
                )}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="font-semibold">Azure Entra ID Redirect URI (Add to App Registration):</div>
              <code className="font-mono text-blue-700 dark:text-blue-400 block break-all">
                {runtimeOrigin}/auth/outlook/callback
              </code>
              <div className="text-slate-500 pt-1">
                Required Microsoft Graph Delegated Permissions: <code className="font-mono">User.Read, Mail.Read, Mail.Send, offline_access</code>
              </div>
            </div>

            <form onSubmit={handleSaveOutlookConfig} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Azure Client ID</label>
                  <input
                    value={oClientId}
                    onChange={(e) => setOClientId(e.target.value)}
                    placeholder={outlookStatus.clientIdSet ? `${outlookStatus.clientIdMasked || '••••'} (Configured)` : 'Application (client) ID'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Azure Client Secret</label>
                  <input
                    type="password"
                    value={oClientSecret}
                    onChange={(e) => setOClientSecret(e.target.value)}
                    placeholder={outlookStatus.hasClientSecret ? `${outlookStatus.clientSecretMasked || '••••'} (Enter to rotate)` : 'Enter client secret'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Tenant ID</label>
                  <input
                    value={oTenantId}
                    onChange={(e) => setOTenantId(e.target.value)}
                    placeholder="common or directory-tenant-id"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-6 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={oAutoCreate} onChange={(e) => setOAutoCreate(e.target.checked)} />
                  <span>Auto-email confirmation on ticket creation</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={oAutoAssign} onChange={(e) => setOAutoAssign(e.target.checked)} />
                  <span>Auto-email employee on moderator assignment</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={oAutoResolve} onChange={(e) => setOAutoResolve(e.target.checked)} />
                  <span>Auto-email employee on ticket resolution</span>
                </label>
              </div>

              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-blue-700 text-white cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                Save Outlook Configuration
              </button>
            </form>
          </div>

          {/* Email History & Ticket Association */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-sm font-display font-semibold">Outlook Email Log & Ticket Linking</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                    <th className="py-2.5 px-4">Direction</th>
                    <th className="py-2.5 px-4">From / To</th>
                    <th className="py-2.5 px-4">Subject</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4">Linked Ticket</th>
                    <th className="py-2.5 px-4">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(outlookStatus.history || []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        No Outlook emails dispatched or synced yet.
                      </td>
                    </tr>
                  ) : (
                    outlookStatus.history.map((em: any) => (
                      <tr key={em.id}>
                        <td className="py-2.5 px-4 font-semibold">{em.direction}</td>
                        <td className="py-2.5 px-4">
                          {em.sender_email} → {em.recipient_email}
                        </td>
                        <td className="py-2.5 px-4">{em.subject}</td>
                        <td className="py-2.5 px-4 font-mono">{em.status}</td>
                        <td className="py-2.5 px-4">
                          <select
                            value={em.ticket_id || ''}
                            onChange={(e) => handleLinkEmailToTicket(em.id, e.target.value)}
                            className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          >
                            <option value="">Unlinked</option>
                            {tickets.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.ticket_number}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-500">{formatDateTime(em.created_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: WHATSAPP CLOUD API */}
      {tab === 'whatsapp' && waStatus && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
            <div>
              <h2 className="text-base font-display font-bold">Official Meta WhatsApp Business Cloud API</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Status:{' '}
                <strong className={waStatus.configured && waStatus.enabled ? 'text-emerald-600' : 'text-amber-600'}>
                  {waStatus.configured && waStatus.enabled
                    ? 'Active & Configured'
                    : 'Not Configured (Enter Meta Business Cloud API Credentials)'}
                </strong>
              </p>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="font-semibold">Meta Webhook Callback URL (Configure in Meta Developer App):</div>
              <code className="font-mono text-blue-700 dark:text-blue-400 block break-all">
                {runtimeOrigin}/api/webhooks/whatsapp
              </code>
              <div className="text-slate-500 pt-1">
                Verify Token Status:{' '}
                <code className="font-mono">
                  {waStatus.hasVerifyToken ? `${waStatus.webhookVerifyTokenMasked || '••••'} (Encrypted on server)` : 'Not Configured'}
                </code>
              </div>
            </div>

            <form onSubmit={handleSaveWhatsAppConfig} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Meta Business Account ID (WABA ID)</label>
                  <input
                    value={wabaId}
                    onChange={(e) => setWabaId(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">WhatsApp Phone Number ID</label>
                  <input
                    value={phoneNumberId}
                    onChange={(e) => setPhoneNumberId(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Permanent System Access Token</label>
                  <input
                    type="password"
                    value={waToken}
                    onChange={(e) => setWaToken(e.target.value)}
                    placeholder={waStatus.hasAccessToken ? `${waStatus.accessTokenMasked || '••••'} (Enter to rotate)` : 'EAAG...'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Webhook Verification Token</label>
                  <input
                    type="password"
                    value={waVerifyToken}
                    onChange={(e) => setWaVerifyToken(e.target.value)}
                    placeholder={waStatus.hasVerifyToken ? `${waStatus.webhookVerifyTokenMasked || '••••'} (Enter to rotate)` : 'Verify token'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Template: Ticket Created</label>
                  <input
                    value={tplCreated}
                    onChange={(e) => setTplCreated(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Template: Moderator Assigned</label>
                  <input
                    value={tplAssigned}
                    onChange={(e) => setTplAssigned(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Template: Progress Update</label>
                  <input
                    value={tplProgress}
                    onChange={(e) => setTplProgress(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Template: Issue Resolved</label>
                  <input
                    value={tplResolved}
                    onChange={(e) => setTplResolved(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={waEnabled} onChange={(e) => setWaEnabled(e.target.checked)} />
                <span>Enable automatic WhatsApp notifications for ticket lifecycle events</span>
              </label>

              <div>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save WhatsApp Cloud API Settings
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB 3: SLA & ESCALATION */}
      {tab === 'sla' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            <h2 className="text-base font-display font-bold">Configurable SLA Targets & Escalation Rules</h2>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {slaConfigs.map((cfg, idx) => (
              <div key={cfg.id} className="p-5 grid grid-cols-1 sm:grid-cols-6 gap-3 items-end text-xs">
                <div>
                  <span className="text-slate-500 block mb-1">Priority Level</span>
                  <span className="font-display font-bold text-sm">{cfg.priority}</span>
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">1st Response (mins)</label>
                  <input
                    type="number"
                    value={cfg.first_response_minutes}
                    onChange={(e) => {
                      const next = [...slaConfigs];
                      next[idx] = { ...cfg, first_response_minutes: Number(e.target.value) };
                      setSlaConfigs(next);
                    }}
                    className="w-full px-3 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">Resolution (hours)</label>
                  <input
                    type="number"
                    value={cfg.resolution_hours}
                    onChange={(e) => {
                      const next = [...slaConfigs];
                      next[idx] = { ...cfg, resolution_hours: Number(e.target.value) };
                      setSlaConfigs(next);
                    }}
                    className="w-full px-3 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">Working Hours</label>
                  <div className="flex gap-1">
                    <input
                      value={cfg.working_hours_start}
                      onChange={(e) => {
                        const next = [...slaConfigs];
                        next[idx] = { ...cfg, working_hours_start: e.target.value };
                        setSlaConfigs(next);
                      }}
                      className="w-full px-2 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <input
                      value={cfg.working_hours_end}
                      onChange={(e) => {
                        const next = [...slaConfigs];
                        next[idx] = { ...cfg, working_hours_end: e.target.value };
                        setSlaConfigs(next);
                      }}
                      className="w-full px-2 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">Escalate To Email</label>
                  <input
                    value={cfg.escalate_to_email || ''}
                    onChange={(e) => {
                      const next = [...slaConfigs];
                      next[idx] = { ...cfg, escalate_to_email: e.target.value };
                      setSlaConfigs(next);
                    }}
                    className="w-full px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleSaveSla(cfg)}
                    className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                  >
                    Update SLA
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: GOOGLE DRIVE DATABASE SYNC */}
      {tab === 'drive_sync' && <DriveDatabaseSyncPanel />}
    </div>
  );
}
