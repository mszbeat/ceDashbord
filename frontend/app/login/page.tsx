'use client';

import React, { useEffect, useState } from 'react';
import {
  applyTheme,
  AuthSessionState,
  ensureAuthenticated,
  formatRolesFa,
  getSavedTheme,
  loginWithPassword,
  logoutSession,
  sanitizeNextPath,
} from '@/lib/auth-client';
import './login.css';
import './glass-redesign.css';

async function verifyTargetRouteAccess(target: string): Promise<{
  allowed: boolean;
}> {
  if (!target.startsWith('/admin')) {
    return { allowed: true };
  }
  try {
    const res = await fetch('/api/admin/overview', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      return { allowed: false };
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

export default function LoginPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [checkingSession, setCheckingSession] = useState(true);
  const [navigatingStatus, setNavigatingStatus] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<AuthSessionState | null>(null);

  const [nextPath, setNextPath] = useState('/');
  const [expiredReason, setExpiredReason] = useState(false);

  // فرم ورود
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const enterTargetWithCheck = async (target: string, auth: AuthSessionState) => {
    setNavigatingStatus('در حال بررسی دسترسی…');
    const check = await verifyTargetRouteAccess(target);
    if (!check.allowed) {
      if (typeof window !== 'undefined') {
        window.location.replace('/');
      }
      return false;
    }
    if (typeof window !== 'undefined') {
      window.location.assign(target);
    }
    return true;
  };

  useEffect(() => {
    const initialTheme = getSavedTheme();
    setTheme(initialTheme);
    applyTheme(initialTheme);

    let resolvedNext = '/';
    let hadExpiredParam = false;
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      // F4: مبدأ جاری هم داده می‌شود تا مقایسهٔ origin در sanitizeNextPath واقعی باشد
      resolvedNext = sanitizeNextPath(sp.get('next'), '/', window.location.origin);
      hadExpiredParam = sp.get('reason') === 'expired';
      setNextPath(resolvedNext);
      setExpiredReason(hadExpiredParam);
    }

    let cancelled = false;
    (async () => {
      try {
        const state = await ensureAuthenticated();
        if (!cancelled) {
          if (state?.authenticated && (hadExpiredParam || resolvedNext !== '/')) {
            const check = await verifyTargetRouteAccess(resolvedNext);
            if (!cancelled) {
              window.location.replace(check.allowed ? resolvedNext : '/');
              return;
            }
          }
          setSessionState(state);
        }
      } catch {
        if (!cancelled) {
          setSessionState(null);
        }
      } finally {
        if (!cancelled) {
          setCheckingSession(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    applyTheme(next);
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);

    const trimmedUser = username.trim();
    if (trimmedUser.length < 3) {
      setErrorMsg('نام کاربری باید حداقل ۳ کاراکتر باشد.');
      return;
    }
    if (password.length < 4) {
      setErrorMsg('رمز عبور باید حداقل ۴ کاراکتر باشد.');
      return;
    }

    setSubmitting(true);
    try {
      const auth = await loginWithPassword({
        username: trimmedUser,
        password,
        rememberMe,
      });
      setSessionState(auth);
      setPassword('');
      setExpiredReason(false);

      const target = nextPath !== '/' ? nextPath : '/';
      await enterTargetWithCheck(target, auth);
    } catch (err: any) {
      setNavigatingStatus(null);
      setErrorMsg(err?.message || 'ورود ناموفق بود. لطفاً مشخصات را بررسی کنید.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      await logoutSession();
      setSessionState({
        authenticated: false,
        username: 'visitor',
        samadUsername: 'visitor',
        roles: ['visitor'],
        canRefresh: false,
      });
      setInfoMsg('از حساب کاربری خارج شدید.');
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="lgn-root" dir="rtl">
      <div className="lgn-split">
        <aside className="lgn-visual" aria-label="نمایه داشبورد CreditEvaluation">
          <img
            src="/images/login-hero.webp?v=6"
            alt="CreditEvaluation — داشبورد تحلیل داده‌های سرویس اعتبارسنجی"
            className="lgn-visual-img"
            loading="eager"
            decoding="async"
          />
          <div className="lgn-visual-note" aria-hidden="true">
            <span className="lgn-visual-kicker"><i /> فضای امن تحلیل</span>
            <strong>دادهٔ دقیق، تصمیم مطمئن.</strong>
            <span>پایش یکپارچهٔ کیفیت گزارش‌های اعتبارسنجی</span>
          </div>
        </aside>

        <section className="lgn-form-pane" aria-labelledby="login-heading">
          <header className="lgn-pane-header">
            <a href={sessionState?.authenticated ? '/' : '/login'} className="lgn-brand">
              <span className="lgn-brand-mark" aria-hidden="true">
                <svg viewBox="0 0 40 40" fill="none">
                  <path d="M20 3 37 20 20 37 3 20 20 3Z" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M20 10 30 20 20 30 10 20 20 10Z" fill="currentColor" />
                </svg>
              </span>
              <span>
                <strong><bdi dir="ltr">CreditEvaluation</bdi></strong>
                <small>داشبورد تحلیل گزارش‌های اعتبارسنجی</small>
              </span>
            </a>

            <div className="lgn-actions">
              <button type="button" className="lgn-btn" onClick={toggleTheme}>
                {theme === 'light' ? '☾ حالت تیره' : '☀ حالت روشن'}
              </button>
            </div>
          </header>

          <div className="lgn-pane-body">
            {checkingSession || navigatingStatus ? (
              <div className="lgn-gate-box" role="status" aria-live="polite">
                <div className="lgn-spinner" aria-hidden="true" />
                <span>{navigatingStatus || 'در حال بررسی نشست و سطح دسترسی…'}</span>
              </div>
            ) : sessionState?.authenticated ? (
              <div>
                <div className="lgn-card-head">
                  <span className="lgn-badge ok" style={{ marginBottom: 10 }}>
                    ● نشست فعال
                  </span>
                  <h1 id="login-heading">خوش آمدید، {sessionState.username}</h1>
                </div>

                {errorMsg && (
                  <div className="lgn-alert error" role="alert">
                    {errorMsg}
                  </div>
                )}
                {infoMsg && (
                  <div className="lgn-alert ok" role="status">
                    {infoMsg}
                  </div>
                )}

                <div className="lgn-session-box">
                  <div className="lgn-session-row">
                    <span style={{ color: 'var(--login-muted)' }}>نام کاربری</span>
                    <strong dir="ltr">{sessionState.username}</strong>
                  </div>
                  <div className="lgn-session-row">
                    <span style={{ color: 'var(--login-muted)' }}>سطح دسترسی</span>
                    <span className="lgn-badge accent">{formatRolesFa(sessionState.roles)}</span>
                  </div>
                </div>

                <div className="lgn-stack-actions">
                  {nextPath !== '/' && (
                    <button
                      type="button"
                      className="lgn-btn lgn-btn-primary"
                      onClick={() => void enterTargetWithCheck(nextPath, sessionState)}
                    >
                      ادامه به صفحهٔ درخواستی ↗
                    </button>
                  )}
                  <button
                    type="button"
                    className={`lgn-btn ${nextPath === '/' ? 'lgn-btn-primary' : ''}`}
                    onClick={() => void enterTargetWithCheck('/', sessionState)}
                  >
                    مشاهدهٔ داشبورد
                  </button>
                  <button
                    type="button"
                    className="lgn-btn lgn-btn-danger"
                    onClick={handleLogout}
                    disabled={loggingOut}
                  >
                    {loggingOut ? 'در حال خروج…' : 'خروج از حساب کاربری'}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="lgn-card-head">
                  <h1 id="login-heading">ورود به سامانه</h1>
                </div>

                {expiredReason && !errorMsg && (
                  <div className="lgn-alert warn" role="status">
                    نشست شما منقضی شده است؛ لطفاً دوباره وارد شوید.
                  </div>
                )}
                {infoMsg && (
                  <div className="lgn-alert ok" role="status">
                    {infoMsg}
                  </div>
                )}
                {errorMsg && (
                  <div className="lgn-alert error" role="alert">
                    {errorMsg}
                  </div>
                )}

                <form onSubmit={handleLoginSubmit} noValidate>
                  <div className="lgn-field">
                    <label className="lgn-label" htmlFor="login-username">
                      نام کاربری
                    </label>
                    <input
                      id="login-username"
                      name="username"
                      type="text"
                      className="lgn-input"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="username"
                      autoComplete="username"
                      autoFocus
                      required
                    />
                  </div>

                  <div className="lgn-field">
                    <label className="lgn-label" htmlFor="login-password">
                      رمز عبور
                    </label>
                    <div className="lgn-input-wrap">
                      <input
                        id="login-password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        className="lgn-input has-toggle"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        autoComplete="current-password"
                        required
                      />
                      <button
                        type="button"
                        className="lgn-toggle-pass"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? 'مخفی کردن رمز عبور' : 'نمایش رمز عبور'}
                      >
                        {showPassword ? 'مخفی' : 'نمایش'}
                      </button>
                    </div>
                  </div>

                  <label className="lgn-check-row">
                    <input
                      type="checkbox"
                      checked={rememberMe}
                      onChange={(e) => setRememberMe(e.target.checked)}
                    />
                    <span>مرا به خاطر بسپار</span>
                  </label>

                  <button
                    type="submit"
                    className="lgn-btn lgn-btn-primary lgn-submit"
                    disabled={submitting}
                  >
                    {submitting ? 'در حال بررسی…' : 'ورود'}
                  </button>
                </form>
                <p className="lgn-registration-note">
                  حساب کاربری توسط مدیر سامانه ایجاد می‌شود. برای دریافت دسترسی با مدیر سیستم تماس بگیرید.
                </p>
              </div>
            )}
          </div>

          <footer className="lgn-pane-footer">
            سامانه پایش و تحلیل گزارش‌های اعتبارسنجی · پردازش اطلاعات مالی پارت
          </footer>
        </section>
      </div>
    </div>
  );
}
