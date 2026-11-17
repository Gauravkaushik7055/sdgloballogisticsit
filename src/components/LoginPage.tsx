import React, { useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Lock,
  Mail,
  Phone,
  ShieldCheck,
  Smartphone,
  UserCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.tsx';
import { useTheme } from '../context/ThemeContext.tsx';
import { apiFetch } from '../utils/api.ts';
import { resolvePublicPagePath, sendVisitHeartbeat, trackPublicVisit } from '../utils/visitTracker.ts';
import heroImage from '../assets/images/logistics_hub_hero_1794807790640.jpg';
import SdGlobalLogo from './SdGlobalLogo.tsx';

interface InviteDetails {
  email: string;
  full_name: string;
  role_name: string;
  role_label: string;
  requires_password_setup: boolean;
}

interface LoginPageProps {
  initialAuthTab?: 'employee_otp' | 'staff_email';
  initialModeratorPortal?: boolean;
  onBackToLive?: () => void;
}

export default function LoginPage({
  initialAuthTab,
  initialModeratorPortal = false,
  onBackToLive,
}: LoginPageProps) {
  const { login, completeMfaLogin, loginWithInvite, loginWithMobileOtp, sessionNotice, clearSessionNotice } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const initialSearchParams = new URLSearchParams(window.location.search);
  const initialPanelParam = initialSearchParams.get('panel');
  const initialModAccess = initialSearchParams.get('mod_access') || '';
  const isModeratorCommonMode = initialPanelParam === 'moderator-login' || initialModeratorPortal;

  const [moderatorPortalActive, setModeratorPortalActive] = useState(isModeratorCommonMode);
  const [modAccessKey, setModAccessKey] = useState(initialModAccess);
  const [modPortalError, setModPortalError] = useState('');

  const [authTab, setAuthTab] = useState<'employee_otp' | 'staff_email'>(
    initialAuthTab || (initialPanelParam === 'employee-login' ? 'employee_otp' : 'staff_email')
  );

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState<{
    token: string;
    email: string;
    full_name: string;
    role_label: string;
  } | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  const [imgFailed, setImgFailed] = useState(false);
  const [resetMode, setResetMode] = useState<'none' | 'request' | 'confirm'>('none');
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetMessage, setResetMessage] = useState('');

  // Mobile + OTP Employee Login state
  const [mobile, setMobile] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpHint, setOtpHint] = useState('');
  const [otpMessage, setOtpMessage] = useState('');
  const [otpError, setOtpError] = useState('');
  const [existingEmpName, setExistingEmpName] = useState<string | null>(null);
  const [empFullName, setEmpFullName] = useState('');
  const [empLocationId, setEmpLocationId] = useState('');
  const [empDeptId, setEmpDeptId] = useState('');
  const [portalLocations, setPortalLocations] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [portalDepts, setPortalDepts] = useState<Array<{ id: number; name: string }>>([]);

  // Invite-link login state
  const [inviteToken, setInviteToken] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('invite') || '';
  });
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteDetails, setInviteDetails] = useState<InviteDetails | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  const [inviteConfirmPassword, setInviteConfirmPassword] = useState('');

  useEffect(() => {
    if (authTab !== 'employee_otp' || portalLocations.length > 0) return;
    apiFetch<{
      locations: Array<{ id: number; name: string; code: string }>;
      departments: Array<{ id: number; name: string }>;
    }>('/api/auth/employee-portal-meta')
      .then((res) => {
        setPortalLocations(res.locations);
        setPortalDepts(res.departments);
      })
      .catch(() => {});
  }, [authTab, portalLocations.length]);

  useEffect(() => {
    if (!inviteToken) return;
    setInviteLoading(true);
    setInviteError('');
    apiFetch<{ valid: boolean; invite: InviteDetails }>(`/api/auth/invite/${encodeURIComponent(inviteToken)}`)
      .then((res) => {
        setInviteDetails(res.invite);
      })
      .catch((err: any) => {
        setInviteError(err.message || 'Invalid or expired login link.');
        setInviteDetails(null);
      })
      .finally(() => setInviteLoading(false));
  }, [inviteToken]);

  const clearInviteMode = () => {
    setInviteToken('');
    setInviteDetails(null);
    setInviteError('');
    setInvitePassword('');
    setInviteConfirmPassword('');
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url.pathname + url.search);
  };

  useEffect(() => {
    const publicPath = moderatorPortalActive
      ? '/portal/moderator-login'
      : authTab === 'employee_otp'
      ? '/portal/employee-login'
      : resolvePublicPagePath('/portal/login');
    trackPublicVisit(publicPath);
    const hb = window.setInterval(() => {
      sendVisitHeartbeat(publicPath);
    }, 60000);
    return () => window.clearInterval(hb);
  }, [moderatorPortalActive, authTab]);

  useEffect(() => {
    if (!moderatorPortalActive) return;
    setModPortalError('');
    const qs = modAccessKey ? `?mod_access=${encodeURIComponent(modAccessKey)}` : '';
    apiFetch<{ valid: boolean }>(`/api/auth/moderator-portal-check${qs}`).catch((err: any) => {
      setModPortalError(err.message || 'This common moderator access link is no longer valid.');
    });
  }, [moderatorPortalActive, modAccessKey]);

  const exitModeratorCommonMode = () => {
    setModeratorPortalActive(false);
    setModAccessKey('');
    setModPortalError('');
    setEmail('');
    setPassword('');
    const url = new URL(window.location.href);
    url.searchParams.delete('panel');
    url.searchParams.delete('mod_access');
    window.history.replaceState({}, '', url.pathname + url.search);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await login(
        email.trim(),
        password,
        moderatorPortalActive
          ? { portal_mode: 'moderator_common', mod_access: modAccessKey || undefined }
          : undefined
      );
      if (res && res.mfa_required) {
        setMfaChallenge({
          token: res.mfa_challenge_token,
          email: res.user_preview?.email || email.trim(),
          full_name: res.user_preview?.full_name || email.trim(),
          role_label: res.user_preview?.role_label || 'Staff',
        });
        setMfaCode('');
        return;
      }
      if (moderatorPortalActive) {
        const url = new URL(window.location.href);
        url.searchParams.delete('panel');
        url.searchParams.delete('mod_access');
        window.history.replaceState({}, '', url.pathname + url.search);
      }
    } catch (err: any) {
      setError(err.message || 'Sign in failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaChallenge) return;
    setError('');
    setSubmitting(true);
    try {
      await completeMfaLogin(mfaChallenge.token, mfaCode.trim());
      setMfaChallenge(null);
      setMfaCode('');
    } catch (err: any) {
      setError(err.message || 'Invalid MFA verification code');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRequestEmployeeOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError('');
    setOtpMessage('');
    setOtpHint('');
    setSubmitting(true);
    try {
      const res = await apiFetch<{
        message: string;
        existing_employee: boolean;
        full_name: string | null;
        otp_preview?: string;
      }>('/api/auth/employee-otp/request', {
        method: 'POST',
        body: JSON.stringify({ mobile: mobile.trim() }),
      });
      setOtpSent(true);
      setOtpMessage(res.message);
      setExistingEmpName(res.existing_employee ? res.full_name : null);
      if (res.otp_preview) {
        setOtpHint(res.otp_preview);
      }
    } catch (err: any) {
      setOtpError(err.message || 'Failed to send OTP');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyEmployeeOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setOtpError('');
    setSubmitting(true);
    try {
      await loginWithMobileOtp({
        mobile: mobile.trim(),
        otp: otpCode.trim(),
        full_name: empFullName.trim() || undefined,
        location_id: empLocationId ? Number(empLocationId) : undefined,
        department_id: empDeptId ? Number(empDeptId) : undefined,
      });
      const url = new URL(window.location.href);
      url.searchParams.delete('panel');
      window.history.replaceState({}, '', url.pathname + url.search);
    } catch (err: any) {
      setOtpError(err.message || 'OTP verification failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteDetails) return;
    setInviteError('');

    if (inviteDetails.requires_password_setup) {
      if (invitePassword.length < 8) {
        setInviteError('Password must be at least 8 characters long.');
        return;
      }
      if (invitePassword !== inviteConfirmPassword) {
        setInviteError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      await loginWithInvite({
        token: inviteToken,
        password: inviteDetails.requires_password_setup ? undefined : invitePassword,
        new_password: inviteDetails.requires_password_setup ? invitePassword : undefined,
      });
      const url = new URL(window.location.href);
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', url.pathname + url.search);
    } catch (err: any) {
      setInviteError(err.message || 'Invite link sign in failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResetMessage('');
    try {
      const res = await apiFetch<{ message: string; dev_reset_code_hint?: string }>('/api/auth/request-reset', {
        method: 'POST',
        body: JSON.stringify({ email: resetEmail.trim() }),
      });
      setResetMessage(
        res.dev_reset_code_hint
          ? `${res.message} Development reset code: ${res.dev_reset_code_hint}`
          : res.message
      );
      setResetMode('confirm');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          email: resetEmail.trim(),
          reset_code: resetCode.trim(),
          new_password: newPassword,
        }),
      });
      setResetMessage(res.message);
      setResetMode('none');
      setEmail(resetEmail.trim());
      setPassword('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-12 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Left Visual Column */}
      <div className="hidden lg:flex lg:col-span-7 relative overflow-hidden bg-slate-900">
        {!imgFailed ? (
          <img
            src={heroImage}
            alt="SD Global multi-location logistics fulfillment hub"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-blue-950 to-slate-950" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/95 via-slate-950/55 to-slate-950/35" />

        <div className="relative z-10 flex flex-col justify-between p-12 w-full text-white">
          <div className="flex items-center gap-3.5">
            <SdGlobalLogo size={48} withWhiteSurface />
            <div>
              <div className="text-xl font-display font-bold tracking-tight">SD Global</div>
              <p className="text-xs text-slate-300 mt-0.5">Centralized IT Service Management & Helpdesk</p>
            </div>
          </div>

          <div className="max-w-xl">
            <h1 className="text-4xl font-display font-bold leading-tight tracking-tight">
              Unified IT support across every warehouse, hub, and fleet terminal.
            </h1>
            <p className="mt-4 text-base text-slate-200 leading-relaxed">
              Employees can sign in instantly using their mobile number and OTP to raise IT support tickets—no pre-registration needed.
            </p>

            <div className="mt-8 pt-6 border-t border-white/15 grid grid-cols-3 gap-6 text-sm">
              <div>
                <div className="font-mono text-xl font-semibold tabular-nums">6 Hubs</div>
                <div className="text-slate-300 text-xs mt-1">Warehouses & Branches</div>
              </div>
              <div>
                <div className="font-mono text-xl font-semibold tabular-nums">Mobile OTP</div>
                <div className="text-slate-300 text-xs mt-1">Zero-Setup Staff Login</div>
              </div>
              <div>
                <div className="font-mono text-xl font-semibold tabular-nums">100%</div>
                <div className="text-slate-300 text-xs mt-1">Auditable History</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right Authentication Panel */}
      <div className="lg:col-span-5 flex flex-col justify-between p-6 sm:p-10 lg:p-14 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <div className="lg:hidden flex items-center gap-2.5 font-display font-bold text-lg text-slate-900 dark:text-white">
            <SdGlobalLogo size={34} withWhiteSurface />
            <span>SD Global</span>
          </div>
          <div className="hidden lg:flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <SdGlobalLogo size={24} withWhiteSurface />
            <span>SD Global IT Operations Portal</span>
          </div>
          <div className="flex items-center gap-2">
            {onBackToLive && (
              <button
                type="button"
                onClick={onBackToLive}
                className="text-xs font-medium px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                Live Portal
              </button>
            )}
            <button
              type="button"
              onClick={toggleTheme}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
            </button>
          </div>
        </div>

        <div className="w-full max-w-md mx-auto my-auto py-6">
          {inviteToken ? (
            <div className="space-y-5">
              <div className="mb-4">
                <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400 mb-2">
                  <Link2 className="w-4 h-4" />
                  <span>Provisioned Access Link</span>
                </div>
                <h2 className="text-2xl font-display font-bold text-slate-900 dark:text-white">
                  {inviteDetails ? `Welcome, ${inviteDetails.full_name}` : 'Verifying Access Link'}
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  {inviteDetails
                    ? inviteDetails.requires_password_setup
                      ? 'Set your account password to activate your Super Admin-issued link and enter your workspace.'
                      : 'Confirm your password to sign in through your assigned access link.'
                    : 'Validating your invitation token with the IT security server...'}
                </p>
              </div>

              {inviteLoading ? (
                <div className="p-4 text-sm rounded-lg border border-slate-200 dark:border-slate-800 text-slate-500">
                  Checking invitation credentials...
                </div>
              ) : inviteDetails ? (
                <>
                  <div className="p-3.5 rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/70 dark:bg-blue-950/30 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Assigned Role</span>
                      <span className="font-semibold text-blue-800 dark:text-blue-300">{inviteDetails.role_label}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Account Email</span>
                      <span className="font-mono text-slate-900 dark:text-white">{inviteDetails.email}</span>
                    </div>
                  </div>

                  {inviteError && (
                    <div className="p-3.5 text-sm rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
                      {inviteError}
                    </div>
                  )}

                  <form onSubmit={handleInviteSubmit} className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        {inviteDetails.requires_password_setup ? 'Create Password (min 8 characters)' : 'Account Password'}
                      </label>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type={showPassword ? 'text' : 'password'}
                          required
                          minLength={inviteDetails.requires_password_setup ? 8 : 1}
                          value={invitePassword}
                          onChange={(e) => setInvitePassword(e.target.value)}
                          placeholder={
                            inviteDetails.requires_password_setup
                              ? 'Choose a strong password'
                              : 'Enter your assigned password'
                          }
                          className="w-full pl-10 pr-10 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {inviteDetails.requires_password_setup && (
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Confirm Password
                        </label>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          required
                          minLength={8}
                          value={inviteConfirmPassword}
                          onChange={(e) => setInviteConfirmPassword(e.target.value)}
                          placeholder="Re-enter password"
                          className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={submitting}
                      className="w-full py-2.5 px-4 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors disabled:opacity-60 cursor-pointer inline-flex items-center justify-center gap-2"
                    >
                      <UserCheck className="w-4 h-4" />
                      <span>
                        {submitting
                          ? 'Authenticating...'
                          : inviteDetails.requires_password_setup
                          ? 'Activate Account & Sign In'
                          : 'Sign In via Link'}
                      </span>
                    </button>
                  </form>
                </>
              ) : (
                <div className="p-4 text-sm rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
                  {inviteError || 'This invite link is not valid.'}
                </div>
              )}

              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={clearInviteMode}
                  className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer"
                >
                  Use standard sign in instead
                </button>
              </div>
            </div>
          ) : resetMode === 'none' ? (
            <>
              {sessionNotice && (
                <div className="mb-4 p-3.5 text-xs rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 flex items-start justify-between gap-2">
                  <span>{sessionNotice}</span>
                  <button
                    type="button"
                    onClick={clearSessionNotice}
                    className="font-semibold underline shrink-0 cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {moderatorPortalActive ? (
                <div className="mb-6">
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400 mb-2">
                    <Link2 className="w-4 h-4" />
                    <span>Shared Moderator Access Portal</span>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg mb-6">
                  <button
                    type="button"
                    onClick={() => {
                      setAuthTab('employee_otp');
                      setError('');
                      setOtpError('');
                    }}
                    className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                      authTab === 'employee_otp'
                        ? 'bg-white dark:bg-slate-900 shadow-sm text-blue-700 dark:text-blue-400'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                    }`}
                  >
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>Employee Mobile + OTP</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthTab('staff_email');
                      setError('');
                      setOtpError('');
                    }}
                    className={`py-2 px-3 text-xs font-semibold rounded-md transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                      authTab === 'staff_email'
                        ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                    }`}
                  >
                    <Lock className="w-3.5 h-3.5" />
                    <span>Admin / Moderator</span>
                  </button>
                </div>
              )}

              {!moderatorPortalActive && authTab === 'employee_otp' ? (
                <div>
                  <div className="mb-6">
                    <h2 className="text-2xl font-display font-bold text-slate-900 dark:text-white">
                      Employee & HR Support Login
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">
                      Log in directly with your mobile number and OTP to raise IT support tickets—no pre-registration required.
                    </p>
                  </div>

                  {otpError && (
                    <div className="mb-4 p-3.5 text-sm rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
                      {otpError}
                    </div>
                  )}

                  {otpMessage && (
                    <div className="mb-4 p-3.5 text-xs rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 space-y-1">
                      <div className="font-semibold">{otpMessage}</div>
                      {otpHint && (
                        <div className="font-mono text-sm font-bold text-emerald-900 dark:text-emerald-200">
                          Verification OTP: {otpHint}
                        </div>
                      )}
                    </div>
                  )}

                  {!otpSent ? (
                    <form onSubmit={handleRequestEmployeeOtp} className="space-y-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          Mobile Number *
                        </label>
                        <div className="relative">
                          <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="tel"
                            required
                            value={mobile}
                            onChange={(e) => setMobile(e.target.value)}
                            placeholder="+91 98205 11021"
                            className="w-full pl-10 pr-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                          />
                        </div>
                      </div>

                      <button
                        type="submit"
                        disabled={submitting}
                        className="w-full py-2.5 px-4 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors disabled:opacity-60 cursor-pointer"
                      >
                        {submitting ? 'Generating OTP...' : 'Send Login OTP'}
                      </button>
                    </form>
                  ) : (
                    <form onSubmit={handleVerifyEmployeeOtp} className="space-y-4">
                      <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800">
                        <span className="font-mono">{mobile}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setOtpSent(false);
                            setOtpCode('');
                            setOtpHint('');
                            setOtpMessage('');
                          }}
                          className="text-blue-600 dark:text-blue-400 font-medium hover:underline cursor-pointer"
                        >
                          Change Number
                        </button>
                      </div>

                      {existingEmpName ? (
                        <div className="text-xs text-slate-600 dark:text-slate-300">
                          Signing in as <span className="font-semibold text-slate-900 dark:text-white">{existingEmpName}</span>
                        </div>
                      ) : (
                        <div className="space-y-3 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/60">
                          <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                            First-Time Employee Details (Optional — auto-captured)
                          </div>
                          <input
                            type="text"
                            value={empFullName}
                            onChange={(e) => setEmpFullName(e.target.value)}
                            placeholder="Your Full Name (e.g. Rajesh Verma)"
                            className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <select
                              value={empLocationId}
                              onChange={(e) => setEmpLocationId(e.target.value)}
                              className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                            >
                              <option value="">Hub / Branch...</option>
                              {portalLocations.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.name}
                                </option>
                              ))}
                            </select>
                            <select
                              value={empDeptId}
                              onChange={(e) => setEmpDeptId(e.target.value)}
                              className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                            >
                              <option value="">Department...</option>
                              {portalDepts.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      )}

                      <div>
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                          6-Digit OTP *
                        </label>
                        <input
                          type="text"
                          required
                          inputMode="numeric"
                          maxLength={6}
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value)}
                          placeholder="Enter 6-digit OTP"
                          className="w-full px-3.5 py-2.5 text-base font-mono tracking-widest rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={submitting}
                          className="flex-1 py-2.5 px-4 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors disabled:opacity-60 cursor-pointer"
                        >
                          {submitting ? 'Verifying...' : 'Verify OTP & Open Panel'}
                        </button>
                        <button
                          type="button"
                          onClick={handleRequestEmployeeOtp}
                          disabled={submitting}
                          className="py-2.5 px-3 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                        >
                          Resend
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              ) : mfaChallenge ? (
                <form onSubmit={handleVerifyMfa} className="space-y-4">
                  <div className="mb-4">
                    <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-400 mb-2">
                      <ShieldCheck className="w-4 h-4" />
                      <span>Two-Factor Authentication Required</span>
                    </div>
                    <h2 className="text-2xl font-display font-bold text-slate-900 dark:text-white">
                      Verify Security Code
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                      Signing in as <strong className="text-slate-900 dark:text-white">{mfaChallenge.full_name}</strong> ({mfaChallenge.role_label}). Enter your 6-digit authenticator code or an 8-character recovery code.
                    </p>
                  </div>

                  {error && (
                    <div className="p-3.5 text-sm rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
                      {error}
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Authenticator OTP or Recovery Code
                    </label>
                    <input
                      type="text"
                      required
                      autoFocus
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value)}
                      placeholder="123456 or ABCD-EF12"
                      className="w-full px-3.5 py-2.5 text-base font-mono tracking-widest rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={submitting}
                      className="flex-1 py-2.5 px-4 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors disabled:opacity-60 cursor-pointer"
                    >
                      {submitting ? 'Verifying...' : 'Verify & Sign In'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMfaChallenge(null);
                        setMfaCode('');
                        setError('');
                      }}
                      className="py-2.5 px-4 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      Back
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="mb-6">
                    <h2 className="text-2xl font-display font-bold text-slate-900 dark:text-white">
                      {moderatorPortalActive ? 'IT Moderator Portal Login' : 'Sign in to Service Desk'}
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">
                      {moderatorPortalActive
                        ? 'Sign in with the unique Email ID and Password created for you by the Super Admin.'
                        : 'Use your Super Admin credentials or moderator email & password issued by the Super Admin.'}
                    </p>
                  </div>

                  {modPortalError && (
                    <div className="mb-5 p-3.5 text-sm rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
                      {modPortalError}
                    </div>
                  )}

                  {error && (
                    <div className="mb-5 p-3.5 text-sm rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
                      {error}
                    </div>
                  )}

                  {resetMessage && (
                    <div className="mb-5 p-3.5 text-sm rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300">
                      {resetMessage}
                    </div>
                  )}

                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        Company Email Address
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="email"
                          required
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="name@company.com"
                          className="w-full pl-10 pr-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                          Password
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            setResetMode('request');
                            setResetEmail(email);
                            setError('');
                            setResetMessage('');
                          }}
                          className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                        >
                          Forgot password?
                        </button>
                      </div>
                      <div className="relative">
                        <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type={showPassword ? 'text' : 'password'}
                          required
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Enter your password"
                          className="w-full pl-10 pr-10 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={submitting || Boolean(modPortalError)}
                      className="w-full py-2.5 px-4 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white transition-colors disabled:opacity-60 cursor-pointer"
                    >
                      {submitting ? 'Authenticating...' : moderatorPortalActive ? 'Sign In as Moderator' : 'Sign In'}
                    </button>
                  </form>

                  {moderatorPortalActive ? (
                    <div className="mt-5 text-center">
                      <button
                        type="button"
                        onClick={exitModeratorCommonMode}
                        className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer"
                      >
                        Switch to main portal login
                      </button>
                    </div>
                  ) : (
                    <div className="mt-7 pt-5 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 space-y-1">
                      <div className="font-semibold text-slate-700 dark:text-slate-300">
                        Role-Based Staff Sign In
                      </div>
                      <p className="leading-relaxed">
                        Sign in using your assigned Super Admin or Moderator company email ID and password. Employees can switch to the Mobile + OTP tab above.
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          ) : resetMode === 'request' ? (
            <form onSubmit={handleRequestReset} className="space-y-4">
              <div className="mb-4">
                <h2 className="text-xl font-display font-bold">Reset Account Password</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  Enter your company email to generate a password reset verification code.
                </p>
              </div>
              {error && <div className="p-3 text-sm rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">{error}</div>}
              <div>
                <label className="block text-xs font-medium mb-1.5">Company Email</label>
                <input
                  type="email"
                  required
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="submit"
                  className="flex-1 py-2.5 px-4 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white"
                >
                  Generate Reset Code
                </button>
                <button
                  type="button"
                  onClick={() => setResetMode('none')}
                  className="py-2.5 px-4 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  Back
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleConfirmReset} className="space-y-4">
              <div className="mb-4">
                <h2 className="text-xl font-display font-bold">Confirm Password Reset</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  Enter the verification code and choose a new password (min 8 characters).
                </p>
              </div>
              {resetMessage && (
                <div className="p-3 text-xs font-mono rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200">
                  {resetMessage}
                </div>
              )}
              {error && <div className="p-3 text-sm rounded-lg bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">{error}</div>}
              <div>
                <label className="block text-xs font-medium mb-1.5">Verification Code</label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value)}
                    placeholder="8-character code"
                    className="w-full pl-10 pr-3.5 py-2.5 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5">New Password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="submit"
                  className="flex-1 py-2.5 px-4 text-sm font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white"
                >
                  Update Password
                </button>
                <button
                  type="button"
                  onClick={() => setResetMode('none')}
                  className="py-2.5 px-4 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-4 border-t border-slate-100 dark:border-slate-800">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
            Role-Based Access Control Active
          </span>
          <span>SD Global IT Operations</span>
        </div>
      </div>
    </div>
  );
}
