import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import { BACKUP_ROOT, db, UPLOAD_ROOT } from '../db.ts';
import {
  type AuthRequest,
  getSessionSecurityPolicy,
  getSuperAdminNotificationPrefs,
  notifyAdmins,
  requireAuth,
  requireRole,
  setSessionSecurityPolicy,
  signToken,
  sweepExpiredSessions,
  writeAuditLog,
} from '../auth.ts';
import {
  buildOtpAuthUri,
  decryptSensitive,
  encryptSensitive,
  generateRecoveryCodes,
  generateTotpSecret,
  getAdminPermissionPolicy,
  verifyTotpCode,
} from '../security.ts';
import { dispatchOutlookEmail, dispatchWhatsAppMessage, getEffectiveWhatsAppConfig } from '../integrations.ts';
import { disconnectSession, sendToRoles, sendToSuperAdmins } from '../realtime.ts';
import { restoreStoredBackup, runCrmBackup, verifyStoredBackup } from '../backupService.ts';

const router = Router();
const MFA_CHALLENGE_SECRET = process.env.JWT_SECRET || 'logicore-dev-secret-change-in-production';

function buildFullLoginResponse(user: any, req: any, loginAction: string, extraDetails?: Record<string, unknown>) {
  const employee = db.prepare('SELECT id FROM employees WHERE user_id = ?').get(user.id) as { id: number } | undefined;
  const moderator = db.prepare('SELECT id FROM moderators WHERE user_id = ?').get(user.id) as { id: number } | undefined;

  const nowIso = new Date().toISOString();
  db.prepare('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?').run(nowIso, req.ip || 'unknown', user.id);

  const sessionRes = db
    .prepare(
      `INSERT INTO login_sessions (user_id, role_name, login_at, last_activity_at, ip_address, user_agent, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(user.id, user.role_name, nowIso, nowIso, req.ip || 'unknown', req.headers['user-agent'] || 'unknown');

  const authPayload = {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role_name,
    role_label: user.role_label,
    session_id: Number(sessionRes.lastInsertRowid),
    employee_id: employee?.id ?? null,
    moderator_id: moderator?.id ?? null,
  };

  const token = signToken(authPayload);
  const mfaRow = db.prepare('SELECT mfa_enabled FROM user_mfa WHERE user_id = ?').get(user.id) as
    | { mfa_enabled: number }
    | undefined;

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role_name,
    action: loginAction,
    entityType: 'session',
    entityId: authPayload.session_id,
    details: extraDetails,
    ipAddress: req.ip,
  });

  return {
    token,
    user: {
      ...authPayload,
      must_reset_password: Boolean(user.must_reset_password),
      mfa_enabled: Boolean(mfaRow?.mfa_enabled),
      permissions: getAdminPermissionPolicy({ id: user.id, role: user.role_name }),
      employee_profile: employee
        ? db
            .prepare(
              `SELECT e.*, d.name as department_name, l.name as location_name, l.city as location_city
               FROM employees e
               LEFT JOIN departments d ON e.department_id = d.id
               LEFT JOIN locations l ON e.location_id = l.id
               WHERE e.id = ?`
            )
            .get(employee.id)
        : null,
      moderator_profile: moderator
        ? db.prepare('SELECT * FROM moderators WHERE id = ?').get(moderator.id)
        : null,
      notification_prefs: user.role_name === 'super_admin' ? getSuperAdminNotificationPrefs() : null,
    },
  };
}

function normalizeMobileDigits(raw: string): string {
  return (raw || '').replace(/\D/g, '');
}

function canonicalMobileKey(raw: string): string {
  const digits = normalizeMobileDigits(raw);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password, portal_mode, mod_access } = req.body as {
    email?: string;
    password?: string;
    portal_mode?: string;
    mod_access?: string;
  };
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (portal_mode === 'moderator_common' && mod_access) {
    const portalRow = db
      .prepare("SELECT value_json FROM integration_settings WHERE key = 'moderator_common_portal'")
      .get() as { value_json: string } | undefined;
    if (portalRow) {
      let activeKey = '';
      try {
        activeKey = JSON.parse(portalRow.value_json)?.access_key || '';
      } catch {
        activeKey = '';
      }
      if (activeKey && mod_access.trim() !== activeKey) {
        return res.status(403).json({
          error: 'This common moderator access link is outdated or invalid. Request the latest link from the Super Admin.',
        });
      }
    }
  }

  const user = db
    .prepare(
      `SELECT u.*, r.name as role_name, r.label as role_label
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE lower(u.email) = lower(?)`
    )
    .get(email.trim()) as any;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    writeAuditLog({
      userEmail: email.trim(),
      action: 'LOGIN_FAILED',
      entityType: 'auth',
      details: { reason: 'Invalid credentials', portal_mode: portal_mode || 'standard' },
      ipAddress: req.ip,
    });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.status !== 'Active') {
    return res.status(403).json({ error: 'Your account has been deactivated. Contact the IT Head.' });
  }

  if (portal_mode === 'moderator_common' && !['moderator', 'super_admin'].includes(user.role_name)) {
    return res.status(403).json({
      error: 'Only authorized IT Moderator or Super Admin accounts can sign in via the Moderator Portal link.',
    });
  }

  // Enforce MFA challenge if configured for Super Admin or Admin (management)
  const mfaRow = db.prepare('SELECT * FROM user_mfa WHERE user_id = ? AND mfa_enabled = 1').get(user.id) as any;
  if (mfaRow && mfaRow.secret_encrypted && ['super_admin', 'management'].includes(user.role_name)) {
    const challengeToken = jwt.sign(
      {
        purpose: 'mfa_challenge',
        user_id: user.id,
        portal_mode: portal_mode || 'standard',
      },
      MFA_CHALLENGE_SECRET,
      { expiresIn: '5m' }
    );
    writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      roleName: user.role_name,
      action: 'MFA_CHALLENGE_ISSUED',
      entityType: 'auth',
      ipAddress: req.ip,
    });
    return res.json({
      mfa_required: true,
      mfa_challenge_token: challengeToken,
      user_preview: {
        full_name: user.full_name,
        email: user.email,
        role_label: user.role_label,
      },
    });
  }

  const loginResult = buildFullLoginResponse(
    user,
    req,
    portal_mode === 'moderator_common' ? 'MODERATOR_COMMON_LINK_LOGIN' : 'LOGIN_SUCCESS',
    portal_mode === 'moderator_common' ? { via: 'common_moderator_link' } : undefined
  );

  res.cookie('logicore_token', loginResult.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.json(loginResult);
});

// POST /api/auth/mfa/verify-login
router.post('/mfa/verify-login', (req, res) => {
  const { mfa_challenge_token, code } = req.body as { mfa_challenge_token?: string; code?: string };
  if (!mfa_challenge_token || !code || !code.trim()) {
    return res.status(400).json({ error: 'Verification challenge token and 6-digit code or recovery code are required' });
  }

  let decoded: any;
  try {
    decoded = jwt.verify(mfa_challenge_token, MFA_CHALLENGE_SECRET);
  } catch {
    return res.status(401).json({ error: 'MFA verification window expired. Please sign in again.' });
  }
  if (decoded?.purpose !== 'mfa_challenge' || !decoded?.user_id) {
    return res.status(401).json({ error: 'Invalid MFA challenge token' });
  }

  const user = db
    .prepare(
      `SELECT u.*, r.name as role_name, r.label as role_label
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?`
    )
    .get(Number(decoded.user_id)) as any;

  if (!user || user.status !== 'Active') {
    return res.status(401).json({ error: 'Account inactive or not found' });
  }

  const mfaRow = db.prepare('SELECT * FROM user_mfa WHERE user_id = ? AND mfa_enabled = 1').get(user.id) as any;
  if (!mfaRow || !mfaRow.secret_encrypted) {
    return res.status(400).json({ error: 'MFA is not active on this account' });
  }

  const secret = decryptSensitive(mfaRow.secret_encrypted);
  const cleanCode = code.trim().toUpperCase();
  let verified = verifyTotpCode(secret, cleanCode, 1);
  let usedRecovery = false;

  if (!verified && mfaRow.recovery_codes_encrypted) {
    try {
      const recoveryCodes: string[] = JSON.parse(decryptSensitive(mfaRow.recovery_codes_encrypted) || '[]');
      const idx = recoveryCodes.findIndex((c) => c.toUpperCase() === cleanCode);
      if (idx !== -1) {
        verified = true;
        usedRecovery = true;
        recoveryCodes.splice(idx, 1);
        db.prepare("UPDATE user_mfa SET recovery_codes_encrypted = ?, updated_at = datetime('now') WHERE user_id = ?").run(
          encryptSensitive(JSON.stringify(recoveryCodes)),
          user.id
        );
      }
    } catch {
      verified = false;
    }
  }

  if (!verified) {
    writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      roleName: user.role_name,
      action: 'MFA_LOGIN_FAILED',
      entityType: 'auth',
      ipAddress: req.ip,
    });
    return res.status(401).json({ error: 'Invalid 6-digit authenticator code or recovery code' });
  }

  const loginResult = buildFullLoginResponse(
    user,
    req,
    usedRecovery ? 'MFA_RECOVERY_LOGIN_SUCCESS' : 'MFA_LOGIN_SUCCESS',
    { portal_mode: decoded.portal_mode || 'standard', used_recovery_code: usedRecovery }
  );

  res.cookie('logicore_token', loginResult.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.json(loginResult);
});

// GET /api/auth/moderator-portal-check (Public check for common moderator portal access link)
router.get('/moderator-portal-check', (req, res) => {
  const modAccess = typeof req.query.mod_access === 'string' ? req.query.mod_access.trim() : '';
  const row = db
    .prepare("SELECT value_json FROM integration_settings WHERE key = 'moderator_common_portal'")
    .get() as { value_json: string } | undefined;

  if (modAccess && row) {
    let activeKey = '';
    try {
      activeKey = JSON.parse(row.value_json)?.access_key || '';
    } catch {
      activeKey = '';
    }
    if (activeKey && modAccess !== activeKey) {
      return res.status(403).json({
        valid: false,
        error: 'This common moderator login link has expired or been regenerated. Ask the Super Admin for the updated link.',
      });
    }
  }

  res.json({ valid: true });
});

// GET /api/auth/invite/:token (Verify a Super-Admin-issued login link)
router.get('/invite/:token', (req, res) => {
  const token = (req.params.token || '').trim();
  if (!token) {
    return res.status(400).json({ error: 'Invite token is required' });
  }

  const user = db
    .prepare(
      `SELECT u.id, u.email, u.full_name, u.status, u.must_reset_password, u.invite_expires_at,
              r.name as role_name, r.label as role_label
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.invite_token = ?`
    )
    .get(token) as any;

  if (!user) {
    return res.status(404).json({ error: 'This login link is invalid or has been superseded by a newer link.' });
  }
  if (user.status !== 'Active') {
    return res.status(403).json({ error: 'This account has been deactivated by the Super Admin.' });
  }
  if (user.invite_expires_at && new Date(user.invite_expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'This login link has expired. Ask the Super Admin to generate a new link.' });
  }

  res.json({
    valid: true,
    invite: {
      email: user.email,
      full_name: user.full_name,
      role_name: user.role_name,
      role_label: user.role_label,
      requires_password_setup: Boolean(user.must_reset_password),
    },
  });
});

// POST /api/auth/invite-login (Authenticate using Super-Admin-issued invite link)
router.post('/invite-login', (req, res) => {
  const { token, password, new_password } = req.body as {
    token?: string;
    password?: string;
    new_password?: string;
  };

  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Invite token is required' });
  }

  const user = db
    .prepare(
      `SELECT u.*, r.name as role_name, r.label as role_label
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.invite_token = ?`
    )
    .get(token.trim()) as any;

  if (!user) {
    return res.status(404).json({ error: 'Invalid or superseded login link' });
  }
  if (user.status !== 'Active') {
    return res.status(403).json({ error: 'Your account is deactivated. Contact the Super Admin.' });
  }
  if (user.invite_expires_at && new Date(user.invite_expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'This login link has expired. Request a fresh link from Super Admin.' });
  }

  let passwordAction: string | null = null;
  if (user.must_reset_password) {
    const chosenPassword = (new_password || password || '').trim();
    if (chosenPassword.length < 8) {
      return res.status(400).json({ error: 'Please set a password of at least 8 characters to activate your link.' });
    }
    const hash = bcrypt.hashSync(chosenPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, must_reset_password = 0 WHERE id = ?').run(hash, user.id);
    passwordAction = 'INVITE_PASSWORD_ACTIVATED';
  } else {
    if (!password || !bcrypt.compareSync(password, user.password_hash)) {
      writeAuditLog({
        userId: user.id,
        userEmail: user.email,
        roleName: user.role_name,
        action: 'INVITE_LOGIN_FAILED',
        entityType: 'auth',
        entityId: user.id,
        details: { reason: 'Incorrect password on invite link' },
        ipAddress: req.ip,
      });
      return res.status(401).json({ error: 'Incorrect password for this invited account' });
    }
  }

  const employee = db.prepare('SELECT id FROM employees WHERE user_id = ?').get(user.id) as { id: number } | undefined;
  const moderator = db.prepare('SELECT id FROM moderators WHERE user_id = ?').get(user.id) as { id: number } | undefined;

  const nowIso = new Date().toISOString();
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso, user.id);

  const sessionRes = db
    .prepare(
      `INSERT INTO login_sessions (user_id, role_name, login_at, last_activity_at, ip_address, user_agent, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(user.id, user.role_name, nowIso, nowIso, req.ip || 'unknown', req.headers['user-agent'] || 'unknown');

  const authPayload = {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role_name,
    role_label: user.role_label,
    session_id: Number(sessionRes.lastInsertRowid),
    employee_id: employee?.id ?? null,
    moderator_id: moderator?.id ?? null,
  };

  const jwtToken = signToken(authPayload);

  if (passwordAction) {
    writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      roleName: user.role_name,
      action: passwordAction,
      entityType: 'user',
      entityId: user.id,
      details: { via: 'invite_link' },
      ipAddress: req.ip,
    });
  }

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role_name,
    action: 'INVITE_LINK_LOGIN',
    entityType: 'session',
    entityId: authPayload.session_id,
    details: { via: 'invite_link', invited_link_base: user.invited_link_base || null },
    ipAddress: req.ip,
  });

  res.cookie('logicore_token', jwtToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.json({
    token: jwtToken,
    user: {
      ...authPayload,
      must_reset_password: false,
      permissions: getAdminPermissionPolicy({ id: user.id, role: user.role_name }),
      employee_profile: employee
        ? db
            .prepare(
              `SELECT e.*, d.name as department_name, l.name as location_name, l.city as location_city
               FROM employees e
               LEFT JOIN departments d ON e.department_id = d.id
               LEFT JOIN locations l ON e.location_id = l.id
               WHERE e.id = ?`
            )
            .get(employee.id)
        : null,
      moderator_profile: moderator
        ? db.prepare('SELECT * FROM moderators WHERE id = ?').get(moderator.id)
        : null,
    },
  });
});

// GET /api/auth/employee-portal-meta (Public lookup of hubs & departments for Employee OTP self-login)
router.get('/employee-portal-meta', (_req, res) => {
  const locations = db.prepare('SELECT id, code, name, type, city FROM locations ORDER BY name ASC').all();
  const departments = db.prepare('SELECT id, name, code FROM departments ORDER BY name ASC').all();
  res.json({ locations, departments });
});

// POST /api/auth/employee-otp/request (Any employee requests an OTP using their mobile number — no manual registration needed)
router.post('/employee-otp/request', async (req, res) => {
  const { mobile } = req.body as { mobile?: string };
  const digits = normalizeMobileDigits(mobile || '');
  if (digits.length < 7 || digits.length > 15) {
    return res.status(400).json({ error: 'Please enter a valid mobile number (7 to 15 digits).' });
  }

  const mobileKey = canonicalMobileKey(mobile || '');
  const displayMobile = mobile!.trim();
  const otpCode = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db.prepare('INSERT INTO mobile_otps (mobile, otp_code, expires_at, ip_address) VALUES (?, ?, ?, ?)').run(
    mobileKey,
    otpCode,
    expiresAt,
    req.ip || 'unknown'
  );

  // Check if returning employee
  const existingEmp = db
    .prepare(
      `SELECT e.id, e.full_name, u.status
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       WHERE (
         CASE
           WHEN length(replace(replace(replace(replace(replace(e.mobile, '+', ''), '-', ''), ' ', ''), '(', ''), ')', '')) > 10
           THEN substr(replace(replace(replace(replace(replace(e.mobile, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)
           ELSE replace(replace(replace(replace(replace(e.mobile, '+', ''), '-', ''), ' ', ''), '(', ''), ')', '')
         END
       ) = ?
       LIMIT 1`
    )
    .get(mobileKey) as { id: number; full_name: string; status: string } | undefined;

  if (existingEmp && existingEmp.status === 'Inactive') {
    return res.status(403).json({ error: 'This employee account has been deactivated. Contact HR / IT Head.' });
  }

  // Send via WhatsApp Cloud API if configured & enabled
  let smsOrWaDelivered = false;
  const waCfg = getEffectiveWhatsAppConfig();
  if (waCfg.enabled && waCfg.accessToken && waCfg.phoneNumberId) {
    const waRes = await dispatchWhatsAppMessage({
      toPhone: displayMobile,
      messageBody: `SD Global Employee Portal OTP: ${otpCode}. Valid for 10 minutes. Do not share this code.`,
    }).catch(() => ({ delivered: false }));
    smsOrWaDelivered = Boolean(waRes.delivered);
  }

  writeAuditLog({
    userEmail: displayMobile,
    roleName: 'employee',
    action: 'EMPLOYEE_OTP_REQUESTED',
    entityType: 'auth',
    entityId: digits,
    details: { existing_employee: Boolean(existingEmp), whatsapp_delivered: smsOrWaDelivered },
    ipAddress: req.ip,
  });

  res.json({
    message: smsOrWaDelivered
      ? 'OTP sent to your mobile via WhatsApp.'
      : 'OTP generated. Enter the 6-digit verification code below to sign in.',
    mobile: displayMobile,
    expires_in_minutes: 10,
    existing_employee: Boolean(existingEmp),
    full_name: existingEmp?.full_name || null,
    otp_preview: smsOrWaDelivered ? undefined : otpCode,
  });
});

// POST /api/auth/employee-otp/verify (Verify OTP, auto-capture/create employee record on first login, and issue session)
router.post('/employee-otp/verify', (req, res) => {
  const { mobile, otp, full_name, email, department_id, location_id, designation } = req.body as {
    mobile?: string;
    otp?: string;
    full_name?: string;
    email?: string;
    department_id?: number | string;
    location_id?: number | string;
    designation?: string;
  };

  const digits = normalizeMobileDigits(mobile || '');
  const mobileKey = canonicalMobileKey(mobile || '');
  if (digits.length < 7 || !otp || !otp.trim()) {
    return res.status(400).json({ error: 'Mobile number and 6-digit OTP are required' });
  }

  const otpRow = db
    .prepare(
      `SELECT * FROM mobile_otps
       WHERE mobile = ? AND otp_code = ? AND verified_at IS NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(mobileKey, otp.trim()) as any;

  if (!otpRow) {
    writeAuditLog({
      userEmail: mobile?.trim() || mobileKey,
      roleName: 'employee',
      action: 'EMPLOYEE_OTP_FAILED',
      entityType: 'auth',
      entityId: mobileKey,
      details: { reason: 'Invalid OTP code' },
      ipAddress: req.ip,
    });
    return res.status(401).json({ error: 'Invalid OTP code. Please check and try again.' });
  }

  if (new Date(otpRow.expires_at).getTime() < Date.now()) {
    return res.status(410).json({ error: 'OTP has expired. Please request a new OTP.' });
  }

  const nowIso = new Date().toISOString();
  const displayMobile = mobile!.trim();
  const clientIp = req.ip || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';

  const existingEmp = db
    .prepare(
      `SELECT e.*, u.id as u_id, u.email as u_email, u.full_name as u_full_name, u.status as u_status
       FROM employees e
       LEFT JOIN users u ON e.user_id = u.id
       WHERE (
         CASE
           WHEN length(replace(replace(replace(replace(replace(e.mobile, '+', ''), '-', ''), ' ', ''), '(', ''), ')', '')) > 10
           THEN substr(replace(replace(replace(replace(replace(e.mobile, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), -10)
           ELSE replace(replace(replace(replace(replace(e.mobile, '+', ''), '-', ''), ' ', ''), '(', ''), ')', '')
         END
       ) = ?
       LIMIT 1`
    )
    .get(mobileKey) as any;

  if (existingEmp && existingEmp.u_status === 'Inactive') {
    return res.status(403).json({ error: 'Your account has been deactivated. Contact HR / IT Head.' });
  }

  let userId: number;
  let employeeId: number;
  let userEmail: string;
  let userFullName: string;
  let isNewEmployee = false;

  const roleRow = db.prepare("SELECT id, label FROM roles WHERE name = 'employee'").get() as { id: number; label: string };

  const tx = db.transaction(() => {
    db.prepare('UPDATE mobile_otps SET verified_at = ? WHERE id = ?').run(nowIso, otpRow.id);

    if (!existingEmp || !existingEmp.u_id) {
      isNewEmployee = true;
      const cleanName = (full_name || '').trim() || `Employee ${digits.slice(-4)}`;
      const candidateEmail = (email || '').trim().toLowerCase();
      const emailTaken = candidateEmail
        ? db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(candidateEmail)
        : true;
      const resolvedEmail = candidateEmail && !emailTaken ? candidateEmail : `emp.${digits}@mobile.logicore.local`;

      const randomHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
      const uRes = db
        .prepare(
          `INSERT INTO users (role_id, email, password_hash, full_name, status, mobile, last_login_at, last_login_ip)
           VALUES (?, ?, ?, ?, 'Active', ?, ?, ?)`
        )
        .run(roleRow.id, resolvedEmail, randomHash, cleanName, displayMobile, nowIso, clientIp);

      userId = Number(uRes.lastInsertRowid);
      userEmail = resolvedEmail;
      userFullName = cleanName;

      if (existingEmp) {
        // Employee row existed without a user_id; link it
        db.prepare(
          `UPDATE employees
           SET user_id = ?, login_count = COALESCE(login_count, 0) + 1, last_login_at = ?, last_login_ip = ?
           WHERE id = ?`
        ).run(userId, nowIso, clientIp, existingEmp.id);
        employeeId = existingEmp.id;
      } else {
        const autoCode = `EMP-M-${digits.slice(-4)}-${String(userId).padStart(3, '0')}`;
        const eRes = db
          .prepare(
            `INSERT INTO employees (
              user_id, employee_code, full_name, department_id, designation, mobile, email, location_id, reporting_manager,
              login_count, last_login_at, last_login_ip
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
          )
          .run(
            userId,
            autoCode,
            cleanName,
            department_id ? Number(department_id) : null,
            (designation || '').trim() || 'Self-Service Staff',
            displayMobile,
            resolvedEmail,
            location_id ? Number(location_id) : null,
            '',
            nowIso,
            clientIp
          );
        employeeId = Number(eRes.lastInsertRowid);
      }
    } else {
      userId = existingEmp.u_id;
      employeeId = existingEmp.id;
      userEmail = existingEmp.u_email;
      const updatedName =
        full_name && full_name.trim() && existingEmp.full_name.startsWith('Employee ')
          ? full_name.trim()
          : existingEmp.u_full_name;
      userFullName = updatedName;

      db.prepare('UPDATE users SET full_name = ?, mobile = ?, last_login_at = ?, last_login_ip = ? WHERE id = ?').run(
        updatedName,
        displayMobile,
        nowIso,
        clientIp,
        userId
      );
      db.prepare(
        `UPDATE employees
         SET full_name = ?,
             department_id = COALESCE(?, department_id),
             location_id = COALESCE(?, location_id),
             login_count = COALESCE(login_count, 0) + 1,
             last_login_at = ?,
             last_login_ip = ?
         WHERE id = ?`
      ).run(
        updatedName,
        department_id ? Number(department_id) : null,
        location_id ? Number(location_id) : null,
        nowIso,
        clientIp,
        employeeId
      );
    }

    const sessRes = db
      .prepare(
        `INSERT INTO login_sessions (user_id, role_name, login_at, last_activity_at, ip_address, user_agent, is_active)
         VALUES (?, 'employee', ?, ?, ?, ?, 1)`
      )
      .run(userId, nowIso, nowIso, clientIp, userAgent);

    return Number(sessRes.lastInsertRowid);
  });

  const sessionId = tx();

  const authPayload = {
    id: userId!,
    email: userEmail!,
    full_name: userFullName!,
    role: 'employee' as const,
    role_label: roleRow.label,
    session_id: sessionId,
    employee_id: employeeId!,
    moderator_id: null,
  };

  const token = signToken(authPayload);

  writeAuditLog({
    userId: userId!,
    userEmail: userEmail!,
    roleName: 'employee',
    action: isNewEmployee ? 'EMPLOYEE_OTP_AUTO_ONBOARD_LOGIN' : 'EMPLOYEE_OTP_LOGIN',
    entityType: 'employee',
    entityId: String(employeeId!),
    details: { mobile: displayMobile, session_id: sessionId, is_new_employee: isNewEmployee },
    ipAddress: clientIp,
  });

  if (isNewEmployee) {
    notifyAdmins({
      title: `New Employee Self-Onboarded: ${userFullName!}`,
      message: `${userFullName!} (${displayMobile}) signed in via Mobile + OTP and was automatically captured in the Employee & HR Panel.`,
      type: 'info',
    });
  }

  sendToRoles(['super_admin', 'management'], 'directory:updated', {
    entity: 'employee',
    action: isNewEmployee ? 'auto_onboarded' : 'otp_login',
    employeeId: employeeId!,
  });

  res.cookie('logicore_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 12 * 60 * 60 * 1000,
  });

  const employeeProfile = db
    .prepare(
      `SELECT e.*, d.name as department_name, l.name as location_name, l.city as location_city
       FROM employees e
       LEFT JOIN departments d ON e.department_id = d.id
       LEFT JOIN locations l ON e.location_id = l.id
       WHERE e.id = ?`
    )
    .get(employeeId!);

  res.json({
    token,
    is_new_employee: isNewEmployee,
    user: {
      ...authPayload,
      must_reset_password: false,
      permissions: getAdminPermissionPolicy({ id: userId!, role: 'employee' }),
      employee_profile: employeeProfile,
      moderator_profile: null,
    },
  });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const nowIso = new Date().toISOString();
  const sess = db.prepare('SELECT * FROM login_sessions WHERE id = ?').get(user.session_id) as any;
  if (sess && sess.is_active) {
    const startMs = new Date(sess.login_at).getTime();
    const durationMins = Math.max(1, Math.round((Date.now() - startMs) / 60000));
    db.prepare(
      "UPDATE login_sessions SET logout_at = ?, duration_minutes = ?, is_active = 0, termination_reason = 'User Logout' WHERE id = ?"
    ).run(nowIso, durationMins, user.session_id);
  }
  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    roleName: user.role,
    action: 'LOGOUT',
    entityType: 'session',
    entityId: user.session_id,
    ipAddress: req.ip,
  });
  res.clearCookie('logicore_token', { httpOnly: true, secure: true, sameSite: 'none' });
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const dbUser = db
    .prepare('SELECT id, email, full_name, status, must_reset_password, last_login_at FROM users WHERE id = ?')
    .get(user.id) as any;

  const employee = user.employee_id
    ? db
        .prepare(
          `SELECT e.*, d.name as department_name, l.name as location_name, l.city as location_city
           FROM employees e
           LEFT JOIN departments d ON e.department_id = d.id
           LEFT JOIN locations l ON e.location_id = l.id
           WHERE e.id = ?`
        )
        .get(user.employee_id)
    : null;

  const moderator = user.moderator_id
    ? db.prepare('SELECT * FROM moderators WHERE id = ?').get(user.moderator_id)
    : null;

  const mfaRow = db.prepare('SELECT mfa_enabled, verified_at FROM user_mfa WHERE user_id = ?').get(user.id) as
    | { mfa_enabled: number; verified_at: string | null }
    | undefined;

  res.json({
    user: {
      ...user,
      full_name: dbUser?.full_name || user.full_name,
      email: dbUser?.email || user.email,
      must_reset_password: Boolean(dbUser?.must_reset_password),
      mfa_enabled: Boolean(mfaRow?.mfa_enabled),
      permissions: getAdminPermissionPolicy(user),
      last_login_at: dbUser?.last_login_at,
      employee_profile: employee,
      moderator_profile: moderator,
      notification_prefs: user.role === 'super_admin' ? getSuperAdminNotificationPrefs() : null,
    },
  });
});

// --- MFA MANAGEMENT (Super Admin & Admin/Management) ---
router.get('/mfa/status', requireAuth, (req: AuthRequest, res) => {
  const row = db
    .prepare('SELECT mfa_enabled, verified_at, recovery_codes_encrypted FROM user_mfa WHERE user_id = ?')
    .get(req.user!.id) as any;
  let recoveryRemaining = 0;
  if (row?.recovery_codes_encrypted) {
    try {
      const codes = JSON.parse(decryptSensitive(row.recovery_codes_encrypted) || '[]');
      recoveryRemaining = Array.isArray(codes) ? codes.length : 0;
    } catch {
      recoveryRemaining = 0;
    }
  }
  res.json({
    supported: ['super_admin', 'management'].includes(req.user!.role),
    mfa_enabled: Boolean(row?.mfa_enabled),
    verified_at: row?.verified_at || null,
    recovery_codes_remaining: recoveryRemaining,
  });
});

router.post('/mfa/setup', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes(6);
  const otpAuthUri = buildOtpAuthUri(req.user!.email, secret);

  db.prepare(
    `INSERT INTO user_mfa (user_id, mfa_enabled, secret_encrypted, recovery_codes_encrypted, updated_at)
     VALUES (?, 0, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       mfa_enabled = 0,
       secret_encrypted = excluded.secret_encrypted,
       recovery_codes_encrypted = excluded.recovery_codes_encrypted,
       updated_at = excluded.updated_at`
  ).run(req.user!.id, encryptSensitive(secret), encryptSensitive(JSON.stringify(recoveryCodes)));

  res.json({
    secret,
    otpauth_uri: otpAuthUri,
    recovery_codes: recoveryCodes,
  });
});

router.post('/mfa/enable', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  const { code } = req.body as { code?: string };
  if (!code) return res.status(400).json({ error: '6-digit verification code is required' });
  const row = db.prepare('SELECT * FROM user_mfa WHERE user_id = ?').get(req.user!.id) as any;
  if (!row?.secret_encrypted) {
    return res.status(400).json({ error: 'Initiate MFA setup first before verifying' });
  }
  const secret = decryptSensitive(row.secret_encrypted);
  if (!verifyTotpCode(secret, code.trim(), 1)) {
    return res.status(400).json({ error: 'Verification code is invalid or expired. Check your authenticator clock.' });
  }
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE user_mfa SET mfa_enabled = 1, verified_at = ?, updated_at = ? WHERE user_id = ?').run(
    nowIso,
    nowIso,
    req.user!.id
  );
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'ENABLE_MFA',
    entityType: 'user_mfa',
    entityId: String(req.user!.id),
    ipAddress: req.ip,
  });
  res.json({ ok: true, mfa_enabled: true, verified_at: nowIso });
});

router.post('/mfa/disable', requireAuth, requireRole('super_admin', 'management'), (req: AuthRequest, res) => {
  const { password } = req.body as { password?: string };
  const userRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as { password_hash: string };
  if (!password || !bcrypt.compareSync(password, userRow.password_hash)) {
    return res.status(400).json({ error: 'Valid account password is required to disable MFA' });
  }
  db.prepare("UPDATE user_mfa SET mfa_enabled = 0, updated_at = datetime('now') WHERE user_id = ?").run(req.user!.id);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'DISABLE_MFA',
    entityType: 'user_mfa',
    entityId: String(req.user!.id),
    ipAddress: req.ip,
  });
  res.json({ ok: true, mfa_enabled: false });
});

// PATCH /api/auth/profile (Authenticated user updates their own name/email cleanly)
router.patch('/profile', requireAuth, (req: AuthRequest, res) => {
  const user = req.user!;
  const { full_name, email } = req.body as { full_name?: string; email?: string };
  const cleanName = typeof full_name === 'string' ? full_name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!cleanName) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }

  if (cleanEmail) {
    const dup = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?').get(cleanEmail, user.id);
    if (dup) {
      return res.status(400).json({ error: 'Another user account already uses this email address' });
    }
  }

  db.transaction(() => {
    db.prepare('UPDATE users SET full_name = ?, email = COALESCE(NULLIF(?, \'\'), email) WHERE id = ?').run(
      cleanName,
      cleanEmail,
      user.id
    );
    db.prepare('UPDATE moderators SET full_name = ?, email = COALESCE(NULLIF(?, \'\'), email) WHERE user_id = ?').run(
      cleanName,
      cleanEmail,
      user.id
    );
    db.prepare('UPDATE employees SET full_name = ?, email = COALESCE(NULLIF(?, \'\'), email) WHERE user_id = ?').run(
      cleanName,
      cleanEmail,
      user.id
    );
  })();

  const updated = db
    .prepare(
      `SELECT u.id, u.email, u.full_name, r.name as role, r.label as role_label
       FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?`
    )
    .get(user.id) as any;

  const refreshedToken = signToken({
    id: updated.id,
    email: updated.email,
    full_name: updated.full_name,
    role: updated.role,
    role_label: updated.role_label,
    session_id: user.session_id,
    employee_id: user.employee_id ?? null,
    moderator_id: user.moderator_id ?? null,
  });

  res.cookie('logicore_token', refreshedToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 12 * 60 * 60 * 1000,
  });

  writeAuditLog({
    userId: user.id,
    userEmail: updated.email,
    roleName: user.role,
    action: 'UPDATE_PROFILE',
    entityType: 'user',
    entityId: String(user.id),
    details: { full_name: cleanName, email: updated.email },
    ipAddress: req.ip,
  });

  res.json({
    ok: true,
    token: refreshedToken,
    user: {
      ...user,
      full_name: updated.full_name,
      email: updated.email,
    },
  });
});

// POST /api/auth/request-reset
router.post('/request-reset', (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  const user = db.prepare('SELECT id, email, full_name FROM users WHERE lower(email) = lower(?)').get(email.trim()) as any;
  if (!user) {
    return res.json({
      message: 'If an authorized company account matches this email, a password reset code has been generated.',
    });
  }
  const resetCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(resetCode, expiresAt, user.id);

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    action: 'PASSWORD_RESET_REQUESTED',
    entityType: 'user',
    entityId: user.id,
    ipAddress: req.ip,
  });

  dispatchOutlookEmail({
    to: user.email,
    subject: '[SD Global IT CRM] Password Reset Verification Code',
    body: `Hello ${user.full_name},\n\nYour password reset verification code is: ${resetCode}\n\nThis code expires in 30 minutes.`,
  }).catch(() => {});

  res.json({
    message: 'If an authorized company account matches this email, a password reset verification code has been issued.',
  });
});

// POST /api/auth/reset-password
router.post('/reset-password', (req, res) => {
  const { email, reset_code, new_password } = req.body as {
    email?: string;
    reset_code?: string;
    new_password?: string;
  };
  if (!email || !reset_code || !new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'Email, reset code, and a new password (min 8 chars) are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email.trim()) as any;
  if (!user || !user.reset_token || user.reset_token !== reset_code.trim().toUpperCase()) {
    return res.status(400).json({ error: 'Invalid reset verification code' });
  }
  if (user.reset_token_expires && new Date(user.reset_token_expires).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Reset verification code has expired' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, must_reset_password = 0 WHERE id = ?').run(
    hash,
    user.id
  );

  writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    action: 'PASSWORD_RESET_COMPLETED',
    entityType: 'user',
    entityId: user.id,
    ipAddress: req.ip,
  });

  res.json({ message: 'Password updated successfully. You may now sign in.' });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, (req: AuthRequest, res) => {
  const { current_password, new_password } = req.body as { current_password?: string; new_password?: string };
  if (!current_password || !new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'Current password and new password (min 8 chars) are required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as any;
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_reset_password = 0 WHERE id = ?').run(hash, user.id);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'PASSWORD_CHANGED',
    entityType: 'user',
    entityId: req.user!.id,
    ipAddress: req.ip,
  });
  res.json({ ok: true });
});

// GET /api/auth/sessions (Strictly Super Admin ONLY)
router.get('/sessions', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { role_name, user_id } = req.query as { role_name?: string; user_id?: string };
  const where: string[] = [];
  const params: any[] = [];
  if (role_name && role_name !== 'All') {
    where.push('ls.role_name = ?');
    params.push(role_name);
  }
  if (user_id) {
    where.push('ls.user_id = ?');
    params.push(Number(user_id));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT ls.*, u.full_name, u.email
       FROM login_sessions ls
       JOIN users u ON ls.user_id = u.id
       ${whereSql}
       ORDER BY ls.login_at DESC LIMIT 250`
    )
    .all(...params);
  res.json({ sessions: rows });
});

// GET /api/auth/audit-logs (Strictly Super Admin ONLY)
router.get('/audit-logs', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 300);
  const { role_name, user_id, action, entity_type, date_from, date_to, search } = req.query as Record<
    string,
    string | undefined
  >;
  const where: string[] = [];
  const params: any[] = [];

  if (role_name && role_name !== 'All') {
    where.push('a.role_name = ?');
    params.push(role_name);
  }
  if (user_id && user_id !== 'All') {
    where.push('a.user_id = ?');
    params.push(Number(user_id));
  }
  if (action && action !== 'All') {
    where.push('a.action = ?');
    params.push(action);
  }
  if (entity_type && entity_type !== 'All') {
    where.push('a.entity_type = ?');
    params.push(entity_type);
  }
  if (date_from) {
    where.push('date(a.created_at) >= date(?)');
    params.push(date_from);
  }
  if (date_to) {
    where.push('date(a.created_at) <= date(?)');
    params.push(date_to);
  }
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    where.push('(a.user_email LIKE ? OR a.action LIKE ? OR a.entity_id LIKE ? OR a.details_json LIKE ? OR u.full_name LIKE ?)');
    params.push(q, q, q, q, q);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const logs = db
    .prepare(
      `SELECT a.*, u.full_name as user_full_name
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       ${whereSql}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`
    )
    .all(...params, limit);
  res.json({ logs, immutable: true });
});

// --- ADMIN PERMISSION & SCOPE MATRIX (SUPER ADMIN ONLY) ---
router.get('/admin-permissions', requireAuth, requireRole('super_admin'), (_req, res) => {
  const admins = db
    .prepare(
      `SELECT u.id as user_id, u.email, u.full_name, u.status, u.last_login_at, u.created_at,
              r.name as role_name, r.label as role_label,
              COALESCE(mfa.mfa_enabled, 0) as mfa_enabled
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN user_mfa mfa ON mfa.user_id = u.id
       WHERE r.name = 'management'
       ORDER BY u.full_name ASC`
    )
    .all() as any[];

  const enriched = admins.map((a) => ({
    ...a,
    mfa_enabled: Boolean(a.mfa_enabled),
    policy: getAdminPermissionPolicy({ id: a.user_id, role: 'management' }),
  }));

  const locations = db.prepare('SELECT id, code, name, type, city FROM locations ORDER BY name ASC').all();
  const departments = db.prepare('SELECT id, name, code FROM departments ORDER BY name ASC').all();
  const moderators = db
    .prepare(
      `SELECT m.id, m.full_name, m.employee_code, m.specialization
       FROM moderators m
       JOIN users u ON m.user_id = u.id
       JOIN roles r ON u.role_id = r.id
       WHERE r.name = 'moderator' AND m.status = 'Active'
       ORDER BY m.full_name ASC`
    )
    .all();

  res.json({ admins: enriched, locations, departments, moderators });
});

router.post('/admin-accounts', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { full_name, email, password, policy } = req.body as {
    full_name?: string;
    email?: string;
    password?: string;
    policy?: Record<string, any>;
  };

  if (!full_name?.trim() || !email?.trim() || !password || password.trim().length < 8) {
    return res.status(400).json({ error: 'Full name, email, and password (min 8 chars) are required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const dup = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(cleanEmail);
  if (dup) {
    return res.status(400).json({ error: 'An account with this email already exists' });
  }

  const roleRow = db.prepare("SELECT id FROM roles WHERE name = 'management'").get() as { id: number };
  const hash = bcrypt.hashSync(password.trim(), 10);

  const newUserId = db.transaction(() => {
    const uRes = db
      .prepare(
        `INSERT INTO users (role_id, email, password_hash, full_name, status, must_reset_password)
         VALUES (?, ?, ?, ?, 'Active', 0)`
      )
      .run(roleRow.id, cleanEmail, hash, full_name.trim());
    const uid = Number(uRes.lastInsertRowid);

    const p = policy || {};
    db.prepare(
      `INSERT INTO admin_permissions (
        user_id, allowed_location_ids_json, allowed_department_ids_json, allowed_moderator_ids_json,
        can_view_chats, can_monitor_chats, can_view_reports, can_manage_assets,
        can_view_budgets, can_manage_budgets, can_approve_expenses, can_export_data, can_manage_tickets, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uid,
      JSON.stringify(Array.isArray(p.allowed_location_ids) ? p.allowed_location_ids.map(Number) : []),
      JSON.stringify(Array.isArray(p.allowed_department_ids) ? p.allowed_department_ids.map(Number) : []),
      JSON.stringify(Array.isArray(p.allowed_moderator_ids) ? p.allowed_moderator_ids.map(Number) : []),
      p.can_view_chats !== false ? 1 : 0,
      p.can_monitor_chats !== false ? 1 : 0,
      p.can_view_reports !== false ? 1 : 0,
      p.can_manage_assets ? 1 : 0,
      p.can_view_budgets !== false ? 1 : 0,
      p.can_manage_budgets ? 1 : 0,
      p.can_approve_expenses ? 1 : 0,
      p.can_export_data !== false ? 1 : 0,
      p.can_manage_tickets ? 1 : 0,
      req.user!.id
    );
    return uid;
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'CREATE_ADMIN_ACCOUNT',
    entityType: 'user',
    entityId: String(newUserId),
    details: { email: cleanEmail, full_name: full_name.trim() },
    ipAddress: req.ip,
  });

  res.status(201).json({ id: newUserId });
});

router.put('/admin-permissions/:userId', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const targetUserId = Number(req.params.userId);
  const target = db
    .prepare(
      `SELECT u.id, u.email, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?`
    )
    .get(targetUserId) as { id: number; email: string; role_name: string } | undefined;

  if (!target || target.role_name !== 'management') {
    return res.status(404).json({ error: 'Target Admin (management) account not found' });
  }

  const p = req.body || {};
  db.prepare(
    `INSERT INTO admin_permissions (
      user_id, allowed_location_ids_json, allowed_department_ids_json, allowed_moderator_ids_json,
      can_view_chats, can_monitor_chats, can_view_reports, can_manage_assets,
      can_view_budgets, can_manage_budgets, can_approve_expenses, can_export_data, can_manage_tickets, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      allowed_location_ids_json = excluded.allowed_location_ids_json,
      allowed_department_ids_json = excluded.allowed_department_ids_json,
      allowed_moderator_ids_json = excluded.allowed_moderator_ids_json,
      can_view_chats = excluded.can_view_chats,
      can_monitor_chats = excluded.can_monitor_chats,
      can_view_reports = excluded.can_view_reports,
      can_manage_assets = excluded.can_manage_assets,
      can_view_budgets = excluded.can_view_budgets,
      can_manage_budgets = excluded.can_manage_budgets,
      can_approve_expenses = excluded.can_approve_expenses,
      can_export_data = excluded.can_export_data,
      can_manage_tickets = excluded.can_manage_tickets,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at`
  ).run(
    targetUserId,
    JSON.stringify(Array.isArray(p.allowed_location_ids) ? p.allowed_location_ids.map(Number) : []),
    JSON.stringify(Array.isArray(p.allowed_department_ids) ? p.allowed_department_ids.map(Number) : []),
    JSON.stringify(Array.isArray(p.allowed_moderator_ids) ? p.allowed_moderator_ids.map(Number) : []),
    p.can_view_chats ? 1 : 0,
    p.can_monitor_chats ? 1 : 0,
    p.can_view_reports ? 1 : 0,
    p.can_manage_assets ? 1 : 0,
    p.can_view_budgets ? 1 : 0,
    p.can_manage_budgets ? 1 : 0,
    p.can_approve_expenses ? 1 : 0,
    p.can_export_data ? 1 : 0,
    p.can_manage_tickets ? 1 : 0,
    req.user!.id
  );

  if (p.status === 'Active' || p.status === 'Inactive') {
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(p.status, targetUserId);
  }

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_ADMIN_PERMISSIONS',
    entityType: 'admin_permissions',
    entityId: String(targetUserId),
    details: { target_email: target.email, permissions: p },
    ipAddress: req.ip,
  });

  res.json({ ok: true, policy: getAdminPermissionPolicy({ id: targetUserId, role: 'management' }) });
});

// --- DATA RETENTION POLICIES & DATABASE BACKUPS (SUPER ADMIN ONLY) ---
router.get('/security/retention', requireAuth, requireRole('super_admin'), (_req, res) => {
  const policies = db.prepare('SELECT * FROM retention_policies ORDER BY entity_key ASC').all();
  const counts = {
    chats: (db.prepare('SELECT COUNT(*) as c FROM direct_messages').get() as { c: number }).c,
    reports: (db.prepare('SELECT COUNT(*) as c FROM saved_reports').get() as { c: number }).c,
    media:
      (db.prepare('SELECT COUNT(*) as c FROM ticket_attachments').get() as { c: number }).c +
      (db.prepare('SELECT COUNT(*) as c FROM chat_attachments').get() as { c: number }).c,
    audit_logs: (db.prepare('SELECT COUNT(*) as c FROM audit_logs').get() as { c: number }).c,
  };
  res.json({ policies, counts });
});

router.put('/security/retention', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { policies } = req.body as {
    policies?: Array<{ entity_key: string; retention_days: number; auto_archive?: boolean }>;
  };
  if (!Array.isArray(policies) || policies.length === 0) {
    return res.status(400).json({ error: 'policies array is required' });
  }
  const stmt = db.prepare(
    `UPDATE retention_policies
     SET retention_days = ?, auto_archive = ?, updated_by = ?, updated_at = datetime('now')
     WHERE entity_key = ?`
  );
  db.transaction(() => {
    for (const p of policies) {
      const days = Math.max(30, Math.min(3650, Number(p.retention_days) || 365));
      stmt.run(days, p.auto_archive ? 1 : 0, req.user!.id, p.entity_key);
    }
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_RETENTION_POLICIES',
    entityType: 'retention_policy',
    details: { policies },
    ipAddress: req.ip,
  });

  res.json({ ok: true, policies: db.prepare('SELECT * FROM retention_policies ORDER BY entity_key ASC').all() });
});

router.post('/security/retention/purge', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const { confirm } = req.body as { confirm?: string };
  if (confirm !== 'CONFIRM_RETENTION_ARCHIVE' && confirm !== 'CONFIRM_RETENTION_PURGE') {
    return res.status(400).json({ error: 'Explicit confirmation token CONFIRM_RETENTION_ARCHIVE is required' });
  }

  const policies = db.prepare('SELECT * FROM retention_policies').all() as Array<{
    entity_key: string;
    retention_days: number;
  }>;
  const map = Object.fromEntries(policies.map((p) => [p.entity_key, p.retention_days]));

  let archivedChats = 0;
  let archivedReports = 0;
  const nowIso = new Date().toISOString();

  db.transaction(() => {
    const chatDays = Math.max(30, Number(map.chats || 365));
    const cRes = db
      .prepare(
        `UPDATE direct_messages
         SET is_archived = 1, archived_at = ?, archived_by_user_id = ?
         WHERE COALESCE(is_archived, 0) = 0 AND datetime(created_at) < datetime('now', ?)`
      )
      .run(nowIso, req.user!.id, `-${chatDays} days`);
    archivedChats = cRes.changes;

    const reportDays = Math.max(30, Number(map.reports || 730));
    const rRes = db
      .prepare(
        `UPDATE saved_reports
         SET is_archived = 1, archived_at = ?
         WHERE COALESCE(is_archived, 0) = 0 AND datetime(created_at) < datetime('now', ?)`
      )
      .run(nowIso, `-${reportDays} days`);
    archivedReports = rRes.changes;
  })();

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'ARCHIVE_EXPIRED_RECORDS',
    entityType: 'retention_policy',
    details: {
      archivedChats,
      archivedReports,
      permanentlyDeleted: 0,
      note: 'All historical chats, tickets, reports, and audit logs remain preserved permanently.',
    },
    ipAddress: req.ip,
  });

  res.json({
    ok: true,
    archivedChats,
    archivedReports,
    purgedChats: archivedChats,
    purgedReports: archivedReports,
    note: 'Records were safely archived without deletion. All CRM chats, tickets, and immutable audit logs remain permanently preserved.',
  });
});

router.get('/security/backup', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  const format = req.query.format === 'sqlite' ? 'sqlite' : 'json';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'DOWNLOAD_DB_BACKUP',
    entityType: 'database',
    details: { format },
    ipAddress: req.ip,
  });

  if (format === 'sqlite') {
    const tmpPath = path.join(os.tmpdir(), `sdglobal-it-crm-backup-${stamp}-${crypto.randomBytes(3).toString('hex')}.db`);
    try {
      await db.backup(tmpPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="sdglobal-it-crm-${stamp}.db"`);
      const stream = fs.createReadStream(tmpPath);
      stream.on('close', () => {
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup failure
        }
      });
      stream.pipe(res);
    } catch (err: any) {
      return res.status(500).json({ error: `Backup failed: ${err.message}` });
    }
    return;
  }

  const bundle = {
    exportedAt: new Date().toISOString(),
    exportedBy: req.user!.email,
    system: 'SD Global IT CRM',
    tables: {
      locations: db.prepare('SELECT * FROM locations').all(),
      departments: db.prepare('SELECT * FROM departments').all(),
      employees: db.prepare('SELECT * FROM employees').all(),
      moderators: db.prepare('SELECT * FROM moderators').all(),
      it_assets: db.prepare('SELECT * FROM it_assets').all(),
      asset_maintenance: db.prepare('SELECT * FROM asset_maintenance').all(),
      asset_history: db.prepare('SELECT * FROM asset_history').all(),
      it_budgets: db.prepare('SELECT * FROM it_budgets').all(),
      expenses: db.prepare('SELECT * FROM expenses').all(),
      tickets: db.prepare('SELECT * FROM tickets').all(),
      ticket_activities: db.prepare('SELECT * FROM ticket_activities').all(),
      ticket_comments: db.prepare('SELECT * FROM ticket_comments').all(),
      direct_messages: db.prepare('SELECT * FROM direct_messages').all(),
      saved_reports: db.prepare('SELECT * FROM saved_reports').all(),
      retention_policies: db.prepare('SELECT * FROM retention_policies').all(),
      audit_logs: db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 5000').all(),
    },
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="sdglobal-it-crm-backup-${stamp}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
});

router.get('/security/media-audit', requireAuth, requireRole('super_admin'), (_req, res) => {
  const ticketFiles = db
    .prepare(
      `SELECT ta.id, ta.original_name, ta.mime_type, ta.file_size, ta.file_category, ta.created_at,
              t.ticket_number as ref_code, u.full_name as uploaded_by
       FROM ticket_attachments ta
       JOIN tickets t ON ta.ticket_id = t.id
       LEFT JOIN users u ON ta.uploaded_by_user_id = u.id
       ORDER BY ta.id DESC LIMIT 60`
    )
    .all() as any[];

  const chatFiles = db
    .prepare(
      `SELECT ca.id, ca.original_name, ca.mime_type, ca.file_size, ca.file_category, ca.created_at,
              ('CHAT-' || ca.message_id) as ref_code, u.full_name as uploaded_by
       FROM chat_attachments ca
       LEFT JOIN users u ON ca.uploaded_by_user_id = u.id
       ORDER BY ca.id DESC LIMIT 60`
    )
    .all() as any[];

  let diskFileCount = 0;
  let diskBytes = 0;
  try {
    const entries = fs.readdirSync(UPLOAD_ROOT);
    diskFileCount = entries.length;
    for (const f of entries) {
      const st = fs.statSync(path.join(UPLOAD_ROOT, f));
      if (st.isFile()) diskBytes += st.size;
    }
  } catch {
    // ignore
  }

  res.json({
    diskFileCount,
    diskBytes,
    ticketFiles,
    chatFiles,
  });
});

// --- SUPER ADMIN SECURITY DASHBOARD, SESSION POLICY, BACKUPS & ACTIVITY MONITOR ---

router.get('/security/session-policy', requireAuth, requireRole('super_admin'), (_req, res) => {
  res.json(getSessionSecurityPolicy());
});

router.put('/security/session-policy', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const idleTimeoutMinutes = Number(req.body?.idleTimeoutMinutes);
  if (!Number.isFinite(idleTimeoutMinutes) || idleTimeoutMinutes < 5 || idleTimeoutMinutes > 1440) {
    return res.status(400).json({ error: 'Idle timeout must be between 5 and 1440 minutes.' });
  }
  const saved = setSessionSecurityPolicy({ idleTimeoutMinutes }, req.user!.id);
  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'UPDATE_SESSION_POLICY',
    entityType: 'security_policy',
    details: saved as unknown as Record<string, unknown>,
    ipAddress: req.ip,
  });
  res.json(saved);
});

router.post('/sessions/:id/terminate', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const targetSessionId = Number(req.params.id);
  if (!targetSessionId) {
    return res.status(400).json({ error: 'Valid session ID is required' });
  }
  if (targetSessionId === req.user!.session_id) {
    return res.status(400).json({ error: 'Cannot terminate your own active session; use Logout instead.' });
  }

  const sess = db
    .prepare(
      `SELECT ls.*, u.email, u.full_name
       FROM login_sessions ls
       JOIN users u ON ls.user_id = u.id
       WHERE ls.id = ?`
    )
    .get(targetSessionId) as any;

  if (!sess) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const reason =
    typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 120)
      : 'Terminated by Super Admin';
  const nowIso = new Date().toISOString();

  db.prepare(
    `UPDATE login_sessions
     SET is_active = 0,
         logout_at = COALESCE(logout_at, ?),
         termination_reason = ?,
         terminated_by_user_id = ?,
         duration_minutes = MAX(duration_minutes, CAST(ROUND((julianday(?) - julianday(login_at)) * 1440) AS INTEGER))
     WHERE id = ?`
  ).run(nowIso, reason, req.user!.id, nowIso, targetSessionId);

  disconnectSession(targetSessionId, reason);

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'TERMINATE_SESSION',
    entityType: 'session',
    entityId: String(targetSessionId),
    details: {
      target_user_id: sess.user_id,
      target_user_email: sess.email,
      target_role: sess.role_name,
      reason,
    },
    ipAddress: req.ip,
  });

  sendToSuperAdmins('session:terminated', { sessionId: targetSessionId, userId: sess.user_id });
  res.json({ ok: true, sessionId: targetSessionId, reason });
});

router.get('/backups', requireAuth, requireRole('super_admin'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT b.*, u.full_name as triggered_by_name
       FROM crm_backups b
       LEFT JOIN users u ON b.triggered_by_user_id = u.id
       ORDER BY b.id DESC
       LIMIT 100`
    )
    .all() as any[];

  const backups = rows.map((b) => {
    let recordCounts = {};
    try {
      recordCounts = b.record_counts_json ? JSON.parse(b.record_counts_json) : {};
    } catch {
      recordCounts = {};
    }
    return {
      ...b,
      storage_path: undefined,
      file_exists: b.storage_path ? fs.existsSync(b.storage_path) : false,
      record_counts: recordCounts,
    };
  });

  res.json({ backups });
});

router.post('/backups/run', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  try {
    const backup = await runCrmBackup({
      backupType: 'manual',
      triggeredByUserId: req.user!.id,
      maxRetries: 3,
    });
    res.status(201).json({ backup: { ...backup, storage_path: undefined } });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Backup execution failed' });
  }
});

router.post('/backups/:id/verify', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  try {
    const result = verifyStoredBackup(Number(req.params.id), req.user!);
    res.json({
      ...result,
      backup: result.backup ? { ...(result.backup as any), storage_path: undefined } : null,
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Backup verification failed' });
  }
});

router.post('/backups/:id/restore', requireAuth, requireRole('super_admin'), async (req: AuthRequest, res) => {
  const { confirm } = req.body as { confirm?: string };
  if (confirm !== 'CONFIRM_DATABASE_RESTORE') {
    return res.status(400).json({ error: 'Explicit confirmation token CONFIRM_DATABASE_RESTORE is required.' });
  }
  try {
    const result = await restoreStoredBackup(Number(req.params.id), req.user!);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Database restore failed' });
  }
});

router.get('/backups/:id/download', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  const row = db.prepare('SELECT * FROM crm_backups WHERE id = ?').get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: 'Backup record not found' });

  const resolved = path.resolve(row.storage_path || path.join(BACKUP_ROOT, row.filename));
  if (!resolved.startsWith(path.resolve(BACKUP_ROOT)) || !fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Backup file missing from protected storage' });
  }

  writeAuditLog({
    userId: req.user!.id,
    userEmail: req.user!.email,
    roleName: req.user!.role,
    action: 'DOWNLOAD_STORED_BACKUP',
    entityType: 'database',
    entityId: row.filename,
    details: { backup_id: row.id, checksum_sha256: row.checksum_sha256 },
    ipAddress: req.ip,
  });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(row.filename)}"`);
  fs.createReadStream(resolved).pipe(res);
});

router.get('/security/dashboard', requireAuth, requireRole('super_admin'), (_req, res) => {
  sweepExpiredSessions();

  const lastBackupRaw = db
    .prepare(
      `SELECT b.*, u.full_name as triggered_by_name
       FROM crm_backups b
       LEFT JOIN users u ON b.triggered_by_user_id = u.id
       ORDER BY b.id DESC LIMIT 1`
    )
    .get() as any;

  let lastBackup: any = null;
  if (lastBackupRaw) {
    let recordCounts = {};
    try {
      recordCounts = lastBackupRaw.record_counts_json ? JSON.parse(lastBackupRaw.record_counts_json) : {};
    } catch {
      recordCounts = {};
    }
    lastBackup = { ...lastBackupRaw, storage_path: undefined, record_counts: recordCounts };
  }

  const backupStatsRow = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN integrity_status = 'Verified' THEN 1 ELSE 0 END) as verified,
              SUM(CASE WHEN status = 'Failed' OR integrity_status = 'Corrupted' THEN 1 ELSE 0 END) as failed
       FROM crm_backups`
    )
    .get() as { total: number; verified: number; failed: number };

  const lastDaily = db
    .prepare(
      `SELECT created_at FROM crm_backups
       WHERE status = 'Completed' AND backup_type IN ('daily', 'manual')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get() as { created_at?: string } | undefined;

  const nextScheduledAt = lastDaily?.created_at
    ? new Date(new Date(lastDaily.created_at).getTime() + 24 * 60 * 60 * 1000).toISOString()
    : new Date().toISOString();

  const ticketsTotal = (db.prepare('SELECT COUNT(*) as c FROM tickets').get() as { c: number }).c;
  const ticketsActive = (
    db.prepare('SELECT COUNT(*) as c FROM tickets WHERE COALESCE(is_archived, 0) = 0').get() as { c: number }
  ).c;
  const ticketsArchived = ticketsTotal - ticketsActive;

  const chatsTotal = (db.prepare('SELECT COUNT(*) as c FROM direct_messages').get() as { c: number }).c;
  const ticketCommentsTotal = (db.prepare('SELECT COUNT(*) as c FROM ticket_comments').get() as { c: number }).c;
  const conversationsTotal = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM (
           SELECT MIN(sender_user_id, recipient_user_id) as a, MAX(sender_user_id, recipient_user_id) as b
           FROM direct_messages
           GROUP BY a, b
         )`
      )
      .get() as { c: number }
  ).c;

  const ticketActivitiesTotal = (db.prepare('SELECT COUNT(*) as c FROM ticket_activities').get() as { c: number }).c;
  const auditLogsTotal = (db.prepare('SELECT COUNT(*) as c FROM audit_logs').get() as { c: number }).c;
  const assetHistoryTotal = (db.prepare('SELECT COUNT(*) as c FROM asset_history').get() as { c: number }).c;
  const ticketAssignmentsTotal = (db.prepare('SELECT COUNT(*) as c FROM ticket_assignments').get() as { c: number }).c;
  const assetsTotal = (db.prepare('SELECT COUNT(*) as c FROM it_assets').get() as { c: number }).c;

  const adminsCount = (
    db.prepare("SELECT COUNT(*) as c FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'management'").get() as {
      c: number;
    }
  ).c;
  const activeAdminsCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'management' AND u.status = 'Active'")
      .get() as { c: number }
  ).c;
  const moderatorsCount = (
    db.prepare("SELECT COUNT(*) as c FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'moderator'").get() as {
      c: number;
    }
  ).c;
  const activeModeratorsCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'moderator' AND u.status = 'Active'")
      .get() as { c: number }
  ).c;
  const superAdminsCount = (
    db.prepare("SELECT COUNT(*) as c FROM users u JOIN roles r ON u.role_id = r.id WHERE r.name = 'super_admin'").get() as {
      c: number;
    }
  ).c;

  const activeSessions = db
    .prepare(
      `SELECT ls.*, u.full_name, u.email
       FROM login_sessions ls
       JOIN users u ON ls.user_id = u.id
       WHERE ls.is_active = 1
       ORDER BY COALESCE(ls.last_activity_at, ls.login_at) DESC`
    )
    .all();

  const securityAlerts = db
    .prepare(
      `SELECT a.*, u.full_name as user_full_name
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE a.action IN (
         'LOGIN_FAILED', 'INVITE_LOGIN_FAILED', 'MFA_LOGIN_FAILED',
         'UNAUTHORIZED_ACCESS_ATTEMPT', 'BACKUP_FAILED', 'TERMINATE_SESSION', 'DATABASE_RESTORED'
       )
       ORDER BY a.id DESC
       LIMIT 35`
    )
    .all();

  const recentAdminModActivities = db
    .prepare(
      `SELECT a.*, u.full_name as user_full_name
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE a.role_name IN ('management', 'moderator')
       ORDER BY a.id DESC
       LIMIT 35`
    )
    .all();

  const recentAssetChanges = db
    .prepare(
      `SELECT ah.*, ia.asset_tag, ia.device_name, ia.serial_number
       FROM asset_history ah
       JOIN it_assets ia ON ah.asset_id = ia.id
       ORDER BY ah.id DESC
       LIMIT 25`
    )
    .all();

  res.json({
    lastBackup,
    backupStats: {
      total: backupStatsRow?.total || 0,
      verified: backupStatsRow?.verified || 0,
      failed: backupStatsRow?.failed || 0,
      nextScheduledAt,
    },
    records: {
      ticketsTotal,
      ticketsActive,
      ticketsArchived,
      chatsTotal,
      ticketCommentsTotal,
      conversationsTotal,
      crmHistoryTotal: ticketActivitiesTotal + auditLogsTotal + assetHistoryTotal + ticketAssignmentsTotal,
      auditLogsTotal,
      ticketActivitiesTotal,
      assetHistoryTotal,
      assetsTotal,
    },
    team: {
      adminsCount,
      activeAdminsCount,
      moderatorsCount,
      activeModeratorsCount,
      superAdminsCount,
    },
    sessions: {
      activeCount: activeSessions.length,
      activeSessions,
      idleTimeoutMinutes: getSessionSecurityPolicy().idleTimeoutMinutes,
    },
    securityAlerts,
    recentAdminModActivities,
    recentAssetChanges,
  });
});

router.get('/activity-monitor', requireAuth, requireRole('super_admin'), (req: AuthRequest, res) => {
  sweepExpiredSessions();

  const { user_id, role_name, date_from, date_to, search } = req.query as Record<string, string | undefined>;

  const staff = db
    .prepare(
      `SELECT u.id as user_id, u.full_name, u.email, u.status, u.last_login_at, u.last_login_ip,
              r.name as role_name, r.label as role_label,
              m.id as moderator_id, m.employee_code, m.specialization,
              (SELECT COUNT(*) FROM login_sessions ls WHERE ls.user_id = u.id) as sessions_count,
              (SELECT COUNT(*) FROM login_sessions ls WHERE ls.user_id = u.id AND ls.is_active = 1) as active_sessions_count,
              (SELECT COUNT(*) FROM audit_logs al WHERE al.user_id = u.id) as audit_actions_count,
              (SELECT COUNT(*) FROM ticket_activities ta WHERE ta.actor_user_id = u.id) as ticket_actions_count,
              (SELECT COUNT(*) FROM tickets t WHERE m.id IS NOT NULL AND t.assigned_moderator_id = m.id) as tickets_assigned_count,
              (SELECT COUNT(*) FROM tickets t WHERE m.id IS NOT NULL AND t.assigned_moderator_id = m.id AND t.status IN ('Completed','Resolved','Closed')) as completed_tasks_count,
              (SELECT COUNT(*) FROM direct_messages dm WHERE dm.sender_user_id = u.id) as chat_messages_count,
              (SELECT COUNT(*) FROM asset_history ah WHERE ah.actor_user_id = u.id) as asset_changes_count,
              (SELECT MAX(al.created_at) FROM audit_logs al WHERE al.user_id = u.id) as last_activity_at
       FROM users u
       JOIN roles r ON u.role_id = r.id
       LEFT JOIN moderators m ON m.user_id = u.id
       WHERE r.name IN ('management', 'moderator')
       ORDER BY CASE WHEN r.name = 'management' THEN 0 ELSE 1 END, u.full_name ASC`
    )
    .all() as any[];

  const targetUserId = user_id && user_id !== 'All' ? Number(user_id) : null;
  const targetRole = role_name && role_name !== 'All' ? role_name : null;

  // 1. Audit logs filtered
  const alWhere: string[] = [];
  const alParams: any[] = [];
  if (targetUserId) {
    alWhere.push('a.user_id = ?');
    alParams.push(targetUserId);
  } else if (targetRole) {
    alWhere.push('a.role_name = ?');
    alParams.push(targetRole);
  } else {
    alWhere.push("a.role_name IN ('management', 'moderator')");
  }
  if (date_from) {
    alWhere.push('date(a.created_at) >= date(?)');
    alParams.push(date_from);
  }
  if (date_to) {
    alWhere.push('date(a.created_at) <= date(?)');
    alParams.push(date_to);
  }
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    alWhere.push('(a.action LIKE ? OR a.entity_id LIKE ? OR a.details_json LIKE ? OR u.full_name LIKE ? OR a.user_email LIKE ?)');
    alParams.push(q, q, q, q, q);
  }
  const auditLogs = db
    .prepare(
      `SELECT a.*, u.full_name as user_full_name
       FROM audit_logs a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE ${alWhere.join(' AND ')}
       ORDER BY a.id DESC
       LIMIT 300`
    )
    .all(...alParams);

  // 2. Ticket activities filtered
  const taWhere: string[] = [];
  const taParams: any[] = [];
  if (targetUserId) {
    taWhere.push('ta.actor_user_id = ?');
    taParams.push(targetUserId);
  } else if (targetRole) {
    taWhere.push('ta.actor_role = ?');
    taParams.push(targetRole);
  } else {
    taWhere.push("ta.actor_role IN ('management', 'moderator')");
  }
  if (date_from) {
    taWhere.push('date(ta.created_at) >= date(?)');
    taParams.push(date_from);
  }
  if (date_to) {
    taWhere.push('date(ta.created_at) <= date(?)');
    taParams.push(date_to);
  }
  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    taWhere.push('(ta.action_type LIKE ? OR ta.details LIKE ? OR t.ticket_number LIKE ? OR ta.actor_name LIKE ?)');
    taParams.push(q, q, q, q);
  }
  const ticketActivities = db
    .prepare(
      `SELECT ta.*, t.ticket_number, t.category as ticket_category, t.status as ticket_status
       FROM ticket_activities ta
       JOIN tickets t ON ta.ticket_id = t.id
       WHERE ${taWhere.join(' AND ')}
       ORDER BY ta.id DESC
       LIMIT 200`
    )
    .all(...taParams);

  // 3. Asset history filtered
  const ahWhere: string[] = [];
  const ahParams: any[] = [];
  if (targetUserId) {
    ahWhere.push('ah.actor_user_id = ?');
    ahParams.push(targetUserId);
  } else if (targetRole) {
    ahWhere.push('COALESCE(ah.actor_role, r.name) = ?');
    ahParams.push(targetRole);
  } else {
    ahWhere.push("COALESCE(ah.actor_role, r.name) IN ('management', 'moderator', 'super_admin')");
  }
  if (date_from) {
    ahWhere.push('date(ah.created_at) >= date(?)');
    ahParams.push(date_from);
  }
  if (date_to) {
    ahWhere.push('date(ah.created_at) <= date(?)');
    ahParams.push(date_to);
  }
  const assetHistory = db
    .prepare(
      `SELECT ah.*, ia.asset_tag, ia.device_name, ia.serial_number
       FROM asset_history ah
       JOIN it_assets ia ON ah.asset_id = ia.id
       LEFT JOIN users u ON ah.actor_user_id = u.id
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE ${ahWhere.join(' AND ')}
       ORDER BY ah.id DESC
       LIMIT 150`
    )
    .all(...ahParams);

  // 4. Sessions filtered
  const sWhere: string[] = [];
  const sParams: any[] = [];
  if (targetUserId) {
    sWhere.push('ls.user_id = ?');
    sParams.push(targetUserId);
  } else if (targetRole) {
    sWhere.push('ls.role_name = ?');
    sParams.push(targetRole);
  } else {
    sWhere.push("ls.role_name IN ('management', 'moderator')");
  }
  const sessions = db
    .prepare(
      `SELECT ls.*, u.full_name, u.email
       FROM login_sessions ls
       JOIN users u ON ls.user_id = u.id
       WHERE ${sWhere.join(' AND ')}
       ORDER BY ls.id DESC
       LIMIT 150`
    )
    .all(...sParams);

  res.json({
    staff,
    auditLogs,
    ticketActivities,
    assetHistory,
    sessions,
  });
});

export default router;
