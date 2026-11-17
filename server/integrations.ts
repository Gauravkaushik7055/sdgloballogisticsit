import { db } from './db.ts';
import { decryptFieldValue, encryptFieldValue } from './security.ts';

export interface OutlookConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  connectedEmail?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  autoNotifyOnCreate?: boolean;
  autoNotifyOnAssign?: boolean;
  autoNotifyOnResolve?: boolean;
}

export interface WhatsAppConfig {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  webhookVerifyToken: string;
  enabled: boolean;
  templates: {
    ticket_created: string;
    moderator_assigned: string;
    ticket_progress: string;
    ticket_resolved: string;
  };
}

const SENSITIVE_KEYS_BY_SETTING: Record<string, string[]> = {
  outlook: ['clientSecret', 'accessToken', 'refreshToken'],
  whatsapp: ['accessToken', 'webhookVerifyToken'],
};

function transformSensitiveFields(key: string, value: any, mode: 'encrypt' | 'decrypt'): any {
  const fields = SENSITIVE_KEYS_BY_SETTING[key];
  if (!fields || !value || typeof value !== 'object') return value;
  const copy = { ...value };
  for (const field of fields) {
    if (typeof copy[field] === 'string' && copy[field]) {
      copy[field] = mode === 'encrypt' ? encryptFieldValue(copy[field]) : decryptFieldValue(copy[field]);
    }
  }
  return copy;
}

export function getIntegrationSetting<T>(key: string): T | null {
  const row = db.prepare('SELECT value_json FROM integration_settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json);
    return transformSensitiveFields(key, parsed, 'decrypt') as T;
  } catch {
    return null;
  }
}

export function saveIntegrationSetting(key: string, value: unknown, userId?: number | null) {
  const protectedValue = transformSensitiveFields(key, value, 'encrypt');
  db.prepare(
    `INSERT INTO integration_settings (key, value_json, updated_by, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = datetime('now')`
  ).run(key, JSON.stringify(protectedValue), userId ?? null);
}

export function getEffectiveOutlookConfig(): OutlookConfig {
  const saved = getIntegrationSetting<Partial<OutlookConfig>>('outlook') || {};
  return {
    clientId: saved.clientId || process.env.MICROSOFT_CLIENT_ID || '',
    clientSecret: saved.clientSecret || process.env.MICROSOFT_CLIENT_SECRET || '',
    tenantId: saved.tenantId || process.env.MICROSOFT_TENANT_ID || 'common',
    connectedEmail: saved.connectedEmail || '',
    accessToken: saved.accessToken || '',
    refreshToken: saved.refreshToken || '',
    expiresAt: saved.expiresAt || '',
    autoNotifyOnCreate: saved.autoNotifyOnCreate ?? true,
    autoNotifyOnAssign: saved.autoNotifyOnAssign ?? true,
    autoNotifyOnResolve: saved.autoNotifyOnResolve ?? true,
  };
}

export function getEffectiveWhatsAppConfig(): WhatsAppConfig {
  const saved = getIntegrationSetting<Partial<WhatsAppConfig>>('whatsapp') || {};
  return {
    wabaId: saved.wabaId || process.env.WHATSAPP_WABA_ID || '',
    phoneNumberId: saved.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: saved.accessToken || process.env.WHATSAPP_ACCESS_TOKEN || '',
    webhookVerifyToken: saved.webhookVerifyToken || process.env.WHATSAPP_VERIFY_TOKEN || 'logicore-wa-verify-2026',
    enabled: saved.enabled ?? false,
    templates: saved.templates || {
      ticket_created: 'ticket_created_confirmation',
      moderator_assigned: 'ticket_moderator_assigned',
      ticket_progress: 'ticket_status_update',
      ticket_resolved: 'ticket_resolution_notice',
    },
  };
}

async function refreshOutlookTokenIfNeeded(cfg: OutlookConfig): Promise<string | null> {
  if (!cfg.accessToken) return null;
  if (cfg.expiresAt && new Date(cfg.expiresAt).getTime() > Date.now() + 60000) {
    return cfg.accessToken;
  }
  if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) {
    return cfg.accessToken;
  }
  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId || 'common')}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: cfg.refreshToken,
          grant_type: 'refresh_token',
          scope: 'openid profile email offline_access User.Read Mail.Read Mail.Send',
        }),
      }
    );
    if (!tokenRes.ok) return cfg.accessToken;
    const data = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const updated: OutlookConfig = {
      ...cfg,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || cfg.refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
    };
    saveIntegrationSetting('outlook', updated);
    return data.access_token;
  } catch {
    return cfg.accessToken;
  }
}

export async function dispatchOutlookEmail(params: {
  ticketId?: number | null;
  to: string;
  subject: string;
  body: string;
}): Promise<{ delivered: boolean; status: string; error?: string }> {
  const cfg = getEffectiveOutlookConfig();
  const token = await refreshOutlookTokenIfNeeded(cfg);

  if (!token) {
    db.prepare(
      `INSERT INTO email_communications (ticket_id, direction, sender_email, recipient_email, subject, body, status)
       VALUES (?, 'Outbound', ?, ?, ?, ?, 'Not Sent - OAuth Not Connected')`
    ).run(params.ticketId ?? null, cfg.connectedEmail || 'unconfigured@outlook', params.to, params.subject, params.body);
    return {
      delivered: false,
      status: 'Not Sent - OAuth Not Connected',
      error: 'Microsoft Outlook OAuth account is not connected. Configure Azure OAuth 2.0 in Integrations.',
    };
  }

  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject: params.subject,
          body: {
            contentType: 'Text',
            content: params.body,
          },
          toRecipients: [{ emailAddress: { address: params.to } }],
        },
        saveToSentItems: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      db.prepare(
        `INSERT INTO email_communications (ticket_id, direction, sender_email, recipient_email, subject, body, status)
         VALUES (?, 'Outbound', ?, ?, ?, ?, 'Failed')`
      ).run(params.ticketId ?? null, cfg.connectedEmail || 'outlook', params.to, params.subject, params.body);
      return { delivered: false, status: 'Failed', error: errText };
    }

    db.prepare(
      `INSERT INTO email_communications (ticket_id, direction, sender_email, recipient_email, subject, body, status)
       VALUES (?, 'Outbound', ?, ?, ?, ?, 'Sent')`
    ).run(params.ticketId ?? null, cfg.connectedEmail || 'outlook', params.to, params.subject, params.body);
    return { delivered: true, status: 'Sent' };
  } catch (err: any) {
    return { delivered: false, status: 'Failed', error: err?.message || 'Network error' };
  }
}

export async function dispatchWhatsAppMessage(params: {
  ticketId?: number | null;
  toPhone: string;
  messageBody: string;
  templateName?: string | null;
}): Promise<{ delivered: boolean; status: string; waMessageId?: string; error?: string }> {
  const cfg = getEffectiveWhatsAppConfig();
  const normalizedPhone = params.toPhone.replace(/[^0-9]/g, '');

  if (!cfg.accessToken || !cfg.phoneNumberId) {
    db.prepare(
      `INSERT INTO whatsapp_communications (ticket_id, direction, phone_number, template_name, message_body, status)
       VALUES (?, 'Outbound', ?, ?, ?, 'Not Sent - API Not Configured')`
    ).run(params.ticketId ?? null, params.toPhone, params.templateName ?? null, params.messageBody);
    return {
      delivered: false,
      status: 'Not Sent - API Not Configured',
      error: 'Meta WhatsApp Cloud API credentials are not configured.',
    };
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedPhone,
        type: 'text',
        text: { body: params.messageBody },
      }),
    });

    const data = (await res.json()) as any;
    if (!res.ok) {
      db.prepare(
        `INSERT INTO whatsapp_communications (ticket_id, direction, phone_number, template_name, message_body, status)
         VALUES (?, 'Outbound', ?, ?, ?, 'Failed')`
      ).run(params.ticketId ?? null, params.toPhone, params.templateName ?? null, params.messageBody);
      return { delivered: false, status: 'Failed', error: data?.error?.message || 'WhatsApp API error' };
    }

    const waId = data?.messages?.[0]?.id || null;
    db.prepare(
      `INSERT INTO whatsapp_communications (ticket_id, direction, phone_number, template_name, message_body, wa_message_id, status)
       VALUES (?, 'Outbound', ?, ?, ?, ?, 'Sent')`
    ).run(params.ticketId ?? null, params.toPhone, params.templateName ?? null, params.messageBody, waId);

    return { delivered: true, status: 'Sent', waMessageId: waId };
  } catch (err: any) {
    return { delivered: false, status: 'Failed', error: err?.message || 'Network error' };
  }
}
