import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NextFunction, Response } from 'express';
import { db } from './db.ts';
import { type AuthRequest, type AuthUser, writeAuditLog } from './auth.ts';

const RAW_KEY_SOURCE =
  process.env.DATA_ENCRYPTION_KEY ||
  process.env.JWT_SECRET ||
  'sdglobal-it-crm-enterprise-encryption-key-v1';

function getEncryptionKey(): Buffer {
  return crypto.createHash('sha256').update(RAW_KEY_SOURCE).digest();
}

export function encryptSensitive(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSensitive(cipherText: string | null | undefined): string {
  if (!cipherText) return '';
  const parts = cipherText.split(':');
  if (parts.length !== 3) return '';
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const data = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

const ENC_PREFIX = 'enc::v1:';

export function encryptFieldValue(plainText: string | null | undefined): string {
  const raw = (plainText || '').trim();
  if (!raw) return '';
  if (raw.startsWith(ENC_PREFIX)) return raw;
  return `${ENC_PREFIX}${encryptSensitive(raw)}`;
}

export function decryptFieldValue(storedValue: string | null | undefined): string {
  if (!storedValue) return '';
  if (storedValue.startsWith(ENC_PREFIX)) {
    return decryptSensitive(storedValue.slice(ENC_PREFIX.length));
  }
  return storedValue;
}

export function maskSecret(value: string | null | undefined, visibleTail = 4): string {
  const val = (value || '').trim();
  if (!val) return '';
  if (val.length <= visibleTail + 2) return '••••';
  return `••••${val.slice(-visibleTail)}`;
}

// --- RFC 4648 Base32 & RFC 6238 TOTP (6 digits, 30s step, HMAC-SHA1) ---
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(str: string): Buffer {
  const cleaned = (str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function buildOtpAuthUri(email: string, secret: string, issuer = 'SD Global IT CRM'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateTotpCode(secret: string, counterOffset = 0, timestampMs = Date.now()): string {
  const key = base32Decode(secret);
  const step = Math.floor(timestampMs / 1000 / 30) + counterOffset;
  const counterBuf = Buffer.alloc(8);
  const high = Math.floor(step / 0x100000000);
  const low = step >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low, 4);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(codeInt % 1000000).padStart(6, '0');
}

export function verifyTotpCode(secret: string, token: string, window = 1): boolean {
  const cleaned = (token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  for (let offset = -window; offset <= window; offset++) {
    const candidate = generateTotpCode(secret, offset);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(cleaned))) {
      return true;
    }
  }
  return false;
}

export function generateRecoveryCodes(count = 6): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

// --- Upload Validation & Threat Filtering ---
const DANGEROUS_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.ps1',
  '.msi',
  '.dll',
  '.so',
  '.dylib',
  '.js',
  '.mjs',
  '.cjs',
  '.vbs',
  '.html',
  '.htm',
  '.svg',
  '.php',
  '.py',
  '.rb',
  '.pl',
  '.jar',
  '.apk',
  '.scr',
  '.com',
  '.pif',
]);

export type UploadGroup = 'media' | 'invoice' | 'excel';

const ALLOWED_EXT_BY_GROUP: Record<UploadGroup, Set<string>> = {
  media: new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.gif',
    '.mp4',
    '.webm',
    '.mov',
    '.pdf',
    '.txt',
    '.csv',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
  ]),
  invoice: new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx']),
  excel: new Set(['.xlsx', '.xls']),
};

const ALLOWED_MIME_BY_GROUP: Record<UploadGroup, Set<string>> = {
  media: new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
  invoice: new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
  excel: new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream', // some browsers emit octet-stream for .xlsx/.xls
  ]),
};

export function sanitizeFilename(name: string): string {
  const base = path.basename(name || 'file').replace(/[^a-zA-Z0-9._ -]/g, '_');
  return base.slice(0, 140) || 'file';
}

export function classifyMediaCategory(mimeType: string): 'Photo' | 'Video' | 'Document' {
  if ((mimeType || '').startsWith('image/')) return 'Photo';
  if ((mimeType || '').startsWith('video/')) return 'Video';
  return 'Document';
}

export function validateFileBufferOrDisk(
  file: { originalname: string; mimetype: string; size: number; path?: string; buffer?: Buffer },
  group: UploadGroup
): { ok: true } | { ok: false; error: string } {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ext || DANGEROUS_EXTENSIONS.has(ext)) {
    return { ok: false, error: `Blocked unsafe or unsupported file extension: ${ext || '(none)'}` };
  }
  if (!ALLOWED_EXT_BY_GROUP[group].has(ext)) {
    return { ok: false, error: `File extension ${ext} is not allowed for ${group} upload.` };
  }
  if (!ALLOWED_MIME_BY_GROUP[group].has((file.mimetype || '').toLowerCase())) {
    return { ok: false, error: `Unsupported MIME type: ${file.mimetype}` };
  }
  if (file.size <= 0) {
    return { ok: false, error: `Uploaded file "${file.originalname}" is empty (0 bytes).` };
  }

  let head: Uint8Array = new Uint8Array(0);
  try {
    if (file.buffer) {
      head = file.buffer.subarray(0, 512);
    } else if (file.path && fs.existsSync(file.path)) {
      const fd = fs.openSync(file.path, 'r');
      const buf = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      head = buf.subarray(0, bytesRead);
    }
  } catch {
    return { ok: false, error: `Unable to inspect uploaded file "${file.originalname}".` };
  }

  // Block Windows PE / Linux ELF / Mach-O / Shebang executable signatures disguised as allowed files
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
    return { ok: false, error: `Security check failed: executable binary header detected in "${file.originalname}".` };
  }
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    return { ok: false, error: `Security check failed: ELF binary detected in "${file.originalname}".` };
  }
  if (head.length >= 2 && Buffer.from(head.subarray(0, 2)).toString('utf8') === '#!') {
    return { ok: false, error: `Security check failed: shell script header detected in "${file.originalname}".` };
  }

  // Check active HTML/SVG/Script XSS payloads inside text/csv/pdf/image headers
  const headText = Buffer.from(head).toString('utf8').toLowerCase();
  if (
    ext !== '.xlsx' &&
    ext !== '.docx' &&
    (headText.includes('<script') || headText.includes('<!doctype html') || headText.includes('<html') || headText.includes('<svg'))
  ) {
    return { ok: false, error: `Security check failed: active HTML/script payload detected in "${file.originalname}".` };
  }

  // Validate key magic headers to catch spoofed extensions
  if (ext === '.pdf' && !Buffer.from(head.subarray(0, 5)).toString('ascii').startsWith('%PDF-')) {
    return { ok: false, error: `File "${file.originalname}" is not a valid PDF document.` };
  }
  if (ext === '.png' && (head.length < 4 || head[0] !== 0x89 || head[1] !== 0x50 || head[2] !== 0x4e || head[3] !== 0x47)) {
    return { ok: false, error: `File "${file.originalname}" is not a valid PNG image.` };
  }
  if ((ext === '.jpg' || ext === '.jpeg') && (head.length < 3 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff)) {
    return { ok: false, error: `File "${file.originalname}" is not a valid JPEG image.` };
  }
  if (ext === '.xlsx' && (head.length < 2 || head[0] !== 0x50 || head[1] !== 0x4b)) {
    return { ok: false, error: `File "${file.originalname}" is not a valid .xlsx workbook.` };
  }
  if (ext === '.xls' && (head.length < 4 || head[0] !== 0xd0 || head[1] !== 0xcf || head[2] !== 0x11 || head[3] !== 0xe0)) {
    // Some tools export CSV/XML with .xls, allow only real OLE2 compound document
    return { ok: false, error: `File "${file.originalname}" is not a valid binary .xls workbook.` };
  }

  return { ok: true };
}

export function validateAndCleanDiskFiles(files: Express.Multer.File[], group: UploadGroup): string | null {
  for (const f of files) {
    const check = validateFileBufferOrDisk(f, group);
    if (!check.ok) {
      for (const item of files) {
        try {
          if (item.path && fs.existsSync(item.path)) fs.unlinkSync(item.path);
        } catch {
          // ignore cleanup failure
        }
      }
      return check.error;
    }
  }
  return null;
}

// --- Admin Permissions & Operational Scope ---
export interface AdminPermissionPolicy {
  user_id: number;
  is_unrestricted: boolean;
  allowed_location_ids: number[];
  allowed_department_ids: number[];
  allowed_moderator_ids: number[];
  can_view_chats: boolean;
  can_monitor_chats: boolean;
  can_view_reports: boolean;
  can_manage_assets: boolean;
  can_view_budgets: boolean;
  can_manage_budgets: boolean;
  can_approve_expenses: boolean;
  can_export_data: boolean;
  can_manage_tickets: boolean;
}

export type AdminCapabilityKey =
  | 'can_view_chats'
  | 'can_monitor_chats'
  | 'can_view_reports'
  | 'can_manage_assets'
  | 'can_view_budgets'
  | 'can_manage_budgets'
  | 'can_approve_expenses'
  | 'can_export_data'
  | 'can_manage_tickets';

function parseIdArray(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0) : [];
  } catch {
    return [];
  }
}

export function getAdminPermissionPolicy(user: Pick<AuthUser, 'id' | 'role'>): AdminPermissionPolicy {
  if (user.role === 'super_admin') {
    return {
      user_id: user.id,
      is_unrestricted: true,
      allowed_location_ids: [],
      allowed_department_ids: [],
      allowed_moderator_ids: [],
      can_view_chats: true,
      can_monitor_chats: true,
      can_view_reports: true,
      can_manage_assets: true,
      can_view_budgets: true,
      can_manage_budgets: true,
      can_approve_expenses: true,
      can_export_data: true,
      can_manage_tickets: true,
    };
  }

  if (user.role !== 'management') {
    return {
      user_id: user.id,
      is_unrestricted: false,
      allowed_location_ids: [],
      allowed_department_ids: [],
      allowed_moderator_ids: [],
      can_view_chats: user.role === 'moderator' || user.role === 'employee',
      can_monitor_chats: false,
      can_view_reports: false,
      can_manage_assets: false,
      can_view_budgets: false,
      can_manage_budgets: false,
      can_approve_expenses: false,
      can_export_data: false,
      can_manage_tickets: false,
    };
  }

  const row = db.prepare('SELECT * FROM admin_permissions WHERE user_id = ?').get(user.id) as any;
  if (!row) {
    // Sensible baseline for management Admin accounts until Super Admin restricts/grants more
    return {
      user_id: user.id,
      is_unrestricted: false,
      allowed_location_ids: [],
      allowed_department_ids: [],
      allowed_moderator_ids: [],
      can_view_chats: true,
      can_monitor_chats: true,
      can_view_reports: true,
      can_manage_assets: false,
      can_view_budgets: true,
      can_manage_budgets: false,
      can_approve_expenses: false,
      can_export_data: true,
      can_manage_tickets: false,
    };
  }

  return {
    user_id: user.id,
    is_unrestricted: false,
    allowed_location_ids: parseIdArray(row.allowed_location_ids_json),
    allowed_department_ids: parseIdArray(row.allowed_department_ids_json),
    allowed_moderator_ids: parseIdArray(row.allowed_moderator_ids_json),
    can_view_chats: Boolean(row.can_view_chats),
    can_monitor_chats: Boolean(row.can_monitor_chats),
    can_view_reports: Boolean(row.can_view_reports),
    can_manage_assets: Boolean(row.can_manage_assets),
    can_view_budgets: Boolean(row.can_view_budgets),
    can_manage_budgets: Boolean(row.can_manage_budgets),
    can_approve_expenses: Boolean(row.can_approve_expenses),
    can_export_data: Boolean(row.can_export_data),
    can_manage_tickets: Boolean(row.can_manage_tickets),
  };
}

export function buildAdminTicketScopeClause(
  user: Pick<AuthUser, 'id' | 'role'>,
  alias = 't'
): { clause: string | null; params: any[] } {
  if (user.role !== 'management') return { clause: null, params: [] };
  const policy = getAdminPermissionPolicy(user);
  const parts: string[] = [];
  const params: any[] = [];

  if (policy.allowed_location_ids.length > 0) {
    parts.push(`${alias}.location_id IN (${policy.allowed_location_ids.map(() => '?').join(',')})`);
    params.push(...policy.allowed_location_ids);
  }
  if (policy.allowed_department_ids.length > 0) {
    parts.push(`${alias}.department_id IN (${policy.allowed_department_ids.map(() => '?').join(',')})`);
    params.push(...policy.allowed_department_ids);
  }
  if (policy.allowed_moderator_ids.length > 0) {
    parts.push(`${alias}.assigned_moderator_id IN (${policy.allowed_moderator_ids.map(() => '?').join(',')})`);
    params.push(...policy.allowed_moderator_ids);
  }

  if (parts.length === 0) return { clause: null, params: [] };
  return { clause: `(${parts.join(' AND ')})`, params };
}

export function getScopedModeratorIdsForAdmin(user: Pick<AuthUser, 'id' | 'role'>): number[] | null {
  if (user.role === 'super_admin') return null;
  if (user.role !== 'management') return [];
  const policy = getAdminPermissionPolicy(user);
  if (policy.allowed_moderator_ids.length > 0) return policy.allowed_moderator_ids;
  if (policy.allowed_location_ids.length === 0 && policy.allowed_department_ids.length === 0) {
    return null; // unrestricted across company when no location/dept scope was pinned
  }
  const mods = db.prepare('SELECT id, assigned_location_ids FROM moderators').all() as Array<{
    id: number;
    assigned_location_ids: string;
  }>;
  if (policy.allowed_location_ids.length === 0) return null;
  const locSet = new Set(policy.allowed_location_ids);
  return mods
    .filter((m) => {
      try {
        const arr = JSON.parse(m.assigned_location_ids || '[]');
        return Array.isArray(arr) && arr.some((id) => locSet.has(Number(id)));
      } catch {
        return false;
      }
    })
    .map((m) => m.id);
}

export function canUserAccessTicket(user: AuthUser, ticket: any): boolean {
  if (!ticket) return false;
  if (user.role === 'super_admin') return true;
  if (user.role === 'employee') {
    return Boolean(ticket.created_by_user_id === user.id || (user.employee_id && ticket.employee_id === user.employee_id));
  }
  if (user.role === 'moderator') {
    return Boolean(user.moderator_id && ticket.assigned_moderator_id === user.moderator_id);
  }
  if (user.role === 'management') {
    const policy = getAdminPermissionPolicy(user);
    if (policy.allowed_location_ids.length > 0 && !policy.allowed_location_ids.includes(Number(ticket.location_id))) {
      return false;
    }
    if (policy.allowed_department_ids.length > 0 && !policy.allowed_department_ids.includes(Number(ticket.department_id))) {
      return false;
    }
    if (
      policy.allowed_moderator_ids.length > 0 &&
      !policy.allowed_moderator_ids.includes(Number(ticket.assigned_moderator_id))
    ) {
      return false;
    }
    return true;
  }
  return false;
}

export function requireCapability(capability: AdminCapabilityKey) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (user.role === 'super_admin') return next();
    if (user.role === 'management') {
      const policy = getAdminPermissionPolicy(user);
      if (policy[capability]) return next();
    }
    writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      roleName: user.role,
      action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
      entityType: 'permission',
      entityId: capability,
      details: { path: req.originalUrl, method: req.method },
      ipAddress: req.ip,
    });
    return res.status(403).json({
      error: `Access denied: missing required permission (${capability.replace('can_', '').replace(/_/g, ' ')})`,
    });
  };
}

export function logUnauthorizedAttempt(req: AuthRequest, resource: string, entityId?: string | number | null) {
  writeAuditLog({
    userId: req.user?.id ?? null,
    userEmail: req.user?.email ?? null,
    roleName: req.user?.role ?? null,
    action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
    entityType: resource,
    entityId: entityId ?? null,
    details: { path: req.originalUrl, method: req.method },
    ipAddress: req.ip,
  });
}
