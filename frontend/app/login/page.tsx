'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  applyTheme,
  AuthSessionState,
  ensureAuthenticated,
  formatRolesFa,
  getSavedTheme,
  loginWithPassword,
  logoutSession,
  refreshSession,
  sanitizeNextPath,
} from '@/lib/auth-client';
import './login.css';

function formatExpiresAtFa(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function LoginPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionState, setSessionState] = useState<AuthSessionState | null>(null);

  const [nextPath, setNextPath] = useState('/');
  const [expiredReason, setExpiredReason] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshingNow, setRefreshingNow] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  useEffect(() => {
    const initialTheme = getSavedTheme();
    setTheme(initialTheme);
    applyTheme(initialTheme);

    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      setNextPath(sanitizeNextPath(sp.get('next'), '/'));
      setExpiredReason(sp.get('reason') === 'expired');
    }

    let cancelled = false;
    (async () => {
      try {
        const state = await ensureAuthenticated();
        if (!cancelled) {
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

  const isAdmin = useMemo(
    () => Boolean(sessionState?.authenticated && sessionState.roles.includes('admin')),
    [sessionState],
  );

  const handleSubmit = async (e: React.FormEvent) => {
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

      if (typeof window !== 'undefined') {
        const target =
          nextPath !== '/'
            ? nextPath
            : '/';
        window.location.assign(target);
      }
    } catch (err: any) {
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
      setInfoMsg('با موفقیت از حساب کاربری خارج شدید.');
    } finally {
      setLoggingOut(false);
    }
  };

  const handleManualRefresh = async () => {
    setRefreshingNow(true);
    setErrorMsg(null);
    setInfoMsg(null);
    try {
      const refreshed = await refreshSession();
      if (refreshed && refreshed.authenticated) {
        setSessionState(refreshed);
        setInfoMsg('توکن نشست با موفقیت تمدید شد.');
      } else {
        setSessionState({
          authenticated: false,
          username: 'visitor',
          samadUsername: 'visitor',
          roles: ['visitor'],
          canRefresh: false,
        });
        setErrorMsg('امکان تمدید نشست وجود ندارد؛ لطفاً دوباره وارد شوید.');
      }
    } finally {
      setRefreshingNow(false);
    }
  };

  return (
    <div className="lgn-root" dir="rtl">
      <div className="lgn-container">
        <header className="lgn-topbar">
          <a href={sessionState?.authenticated ? '/' : '/login'} className="lgn-brand">
            <span className="lgn-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 40 40" fill="none">
                <path d="M20 3 37 20 20 37 3 20 20 3Z" stroke="currentColor" strokeWidth="1.5" />
                <path d="M20 10 30 20 20 30 10 20 20 10Z" fill="currentColor" />
              </svg>
            </span>
            <span>
              <strong>نــمـا</strong>
              <small>داشبورد پایش داده‌های اعتبارسنجی بانکی</small>
            </span>
          </a>

          <div className="lgn-actions">
            {sessionState?.authenticated && (
              <a className="lgn-btn" href="/">
                ← بازگشت به داشبورد زنده
              </a>
            )}
            <button type="button" className="lgn-btn" onClick={toggleTheme}>
              {theme === 'light' ? '☾ حالت تیره' : '☀ حالت روشن'}
            </button>
          </div>
        </header>

        <main className="lgn-stage">
          <section className="lgn-card" aria-labelledby="login-heading">
            {checkingSession ? (
              <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--login-muted)' }}>
                در حال بررسی وضعیت نشست کاربری…
              </div>
            ) : sessionState?.authenticated ? (
              <div>
                <div className="lgn-card-head">
                  <span className="lgn-badge ok" style={{ marginBottom: 10 }}>
                    ● نشست فعال
                  </span>
                  <h1 id="login-heading">خوش آمدید، {sessionState.username}</h1>
                  <p>شما هم‌اکنون وارد سامانه شده‌اید و تمدید خودکار نشست فعال است.</p>
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
                    <span style={{ color: 'var(--login-muted)' }}>سطح دسترسی (نقش)</span>
                    <span className="lgn-badge accent">{formatRolesFa(sessionState.roles)}</span>
                  </div>
                  <div className="lgn-session-row">
                    <span style={{ color: 'var(--login-muted)' }}>اعتبار تمدید نشست (Refresh)</span>
                    <span dir="ltr">{formatExpiresAtFa(sessionState.refreshExpiresAt)}</span>
                  </div>
                </div>

                <div className="lgn-stack-actions">
                  {nextPath !== '/' && (
                    <a className="lgn-btn lgn-btn-primary" href={nextPath}>
                      ادامه به صفحهٔ درخواستی ↗
                    </a>
                  )}
                  <a className={`lgn-btn ${nextPath === '/' ? 'lgn-btn-primary' : ''}`} href="/">
                    مشاهدهٔ داشبورد زنده
                  </a>
                  {isAdmin && (
                    <a className="lgn-btn" href="/admin">
                      ⚙ ورود به پنل مدیریت و زمان‌بندی
                    </a>
                  )}
                  <button
                    type="button"
                    className="lgn-btn"
                    onClick={handleManualRefresh}
                    disabled={refreshingNow || loggingOut}
                  >
                    {refreshingNow ? 'در حال تمدید نشست…' : '⟳ تمدید دستی توکن نشست'}
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
                  <h1 id="login-heading">ورود به پنل کاربری</h1>
                  <p>
                    نام کاربری و رمز عبور سازمانی خود را وارد کنید
                    {nextPath !== '/' ? ` (پس از ورود به ${nextPath} منتقل می‌شوید)` : ''}.
                  </p>
                </div>

                {expiredReason && !errorMsg && (
                  <div className="lgn-alert warn" role="status">
                    نشست شما منقضی شده است؛ برای ادامه لطفاً دوباره وارد شوید.
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

                <form onSubmit={handleSubmit} noValidate>
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
                    <span>مرا به خاطر بسپار (تمدید خودکار نشست تا ۱۴ روز)</span>
                  </label>

                  <button
                    type="submit"
                    className="lgn-btn lgn-btn-primary lgn-submit"
                    disabled={submitting}
                  >
                    {submitting ? 'در حال بررسی اعتبار…' : 'ورود به سامانه'}
                  </button>
                </form>

                <div className="lgn-foot-links">
                  <span>احراز هویت یکپارچه با سرویس اصالت‌سنجی و سمد</span>
                  <span>مشاهدهٔ داشبورد نیازمند ورود است</span>
                </div>
              </div>
            )}
          </section>

          <aside className="lgn-hero" aria-label="راهنمای سطوح دسترسی و امنیت نشست">
            <div>
              <div className="lgn-eyebrow">
                <span className="lgn-dot" /> کنترل دسترسی مبتنی بر نقش (RBAC)
              </div>
              <h2>دسترسی امن و یکپارچه به گزارش‌های اعتبارسنجی بانکی</h2>
              <p>
                پس از ورود، نقش کاربری شما به‌صورت خودکار از سامانه سمد دریافت و در نشست سرور اعمال می‌شود.
              </p>

              <div className="lgn-tier-list">
                <div className="lgn-tier">
                  <strong>سطح ۱ · داشبورد تحلیلی و نمودارها</strong>
                  <span>مشاهدهٔ آمار تجمیعی، شاخص‌های کیفی و روند روزانه بانک‌ها</span>
                </div>
                <div className="lgn-tier">
                  <strong>سطح ۲ · جزئیات کامل گزارش‌ها (creditEvaluation / admin)</strong>
                  <span>مشاهدهٔ پروندهٔ کامل هر درخواست با کلیک روی ردیف‌ها و ثبت لاگ ممیزی</span>
                </div>
                <div className="lgn-tier">
                  <strong>سطح ۳ · پنل مدیریت و زمان‌بندی (admin)</strong>
                  <span>اجرای تحلیل دستی، بازسازی اتمیک روزها و پیکربندی کران شبانه تهران</span>
                </div>
              </div>
            </div>

            <div className="lgn-refresh-note">
              <strong>↻ تمدید خودکار توکن (Refresh Token)</strong>
              <br />
              به‌دلیل کوتاه‌بودن مدت اعتبار Access Token، سیستم از Refresh Token امن (کوکی HttpOnly با چرخش یکبارمصرف) استفاده می‌کند تا نشست شما در پس‌زمینه بدون وقفه تمدید شود.
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}
