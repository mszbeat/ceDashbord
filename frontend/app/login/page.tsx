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
  registerAccount,
  sanitizeNextPath,
} from '@/lib/auth-client';
import './login.css';

type AuthMode = 'login' | 'register';

export default function LoginPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionState, setSessionState] = useState<AuthSessionState | null>(null);

  const [mode, setMode] = useState<AuthMode>('login');

  const [nextPath, setNextPath] = useState('/');
  const [expiredReason, setExpiredReason] = useState(false);

  // فرم ورود
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // فرم ثبت‌نام AJAX (نقش همواره visitor است)
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [regAutoLogin, setRegAutoLogin] = useState(true);
  const [regRememberMe, setRegRememberMe] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  useEffect(() => {
    const initialTheme = getSavedTheme();
    setTheme(initialTheme);
    applyTheme(initialTheme);

    let resolvedNext = '/';
    let hadExpiredParam = false;
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      resolvedNext = sanitizeNextPath(sp.get('next'), '/');
      hadExpiredParam = sp.get('reason') === 'expired';
      setNextPath(resolvedNext);
      setExpiredReason(hadExpiredParam);
      if (sp.get('mode') === 'register') {
        setMode('register');
      }
    }

    let cancelled = false;
    (async () => {
      try {
        const state = await ensureAuthenticated();
        if (!cancelled) {
          if (state?.authenticated && (hadExpiredParam || resolvedNext !== '/')) {
            window.location.replace(resolvedNext);
            return;
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

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setErrorMsg(null);
    setInfoMsg(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (nextMode === 'register') {
        url.searchParams.set('mode', 'register');
      } else {
        url.searchParams.delete('mode');
      }
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
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

      if (typeof window !== 'undefined') {
        window.location.assign(nextPath !== '/' ? nextPath : '/');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'ورود ناموفق بود. لطفاً مشخصات را بررسی کنید.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);

    const trimmedUser = regUsername.trim();
    if (trimmedUser.length < 3) {
      setErrorMsg('نام کاربری باید حداقل ۳ کاراکتر باشد.');
      return;
    }
    if (regPassword.length < 4) {
      setErrorMsg('رمز عبور باید حداقل ۴ کاراکتر باشد.');
      return;
    }
    if (regPassword !== regConfirmPassword) {
      setErrorMsg('رمز عبور و تکرار آن یکسان نیستند.');
      return;
    }

    setRegSubmitting(true);
    try {
      const result = await registerAccount({
        username: trimmedUser,
        password: regPassword,
        rememberMe: regRememberMe,
        autoLogin: regAutoLogin,
      });

      setRegPassword('');
      setRegConfirmPassword('');
      setExpiredReason(false);

      if (result.autoLoggedIn && result.sessionState) {
        setSessionState(result.sessionState);
        setInfoMsg(`ثبت‌نام «${result.username}» انجام شد؛ در حال انتقال…`);
        if (typeof window !== 'undefined') {
          window.location.assign(nextPath !== '/' ? nextPath : '/');
        }
        return;
      }

      setRegUsername('');
      setUsername(result.username);
      switchMode('login');
      setInfoMsg(`حساب «${result.username}» ایجاد شد. اکنون می‌توانید وارد شوید.`);
    } catch (err: any) {
      setErrorMsg(err?.message || 'ثبت‌نام انجام نشد.');
    } finally {
      setRegSubmitting(false);
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
              <small>داشبورد تحلیل گزارش‌های اعتبارسنجی</small>
            </span>
          </a>

          <div className="lgn-actions">
            {sessionState?.authenticated && (
              <a className="lgn-btn" href="/">
                ← بازگشت به داشبورد
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
                در حال بررسی نشست کاربری…
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
                    <a className="lgn-btn lgn-btn-primary" href={nextPath}>
                      ادامه به صفحهٔ درخواستی ↗
                    </a>
                  )}
                  <a className={`lgn-btn ${nextPath === '/' ? 'lgn-btn-primary' : ''}`} href="/">
                    مشاهدهٔ داشبورد
                  </a>
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
                <div className="lgn-tabs" role="tablist" aria-label="حالت احراز هویت">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'login'}
                    className={`lgn-tab ${mode === 'login' ? 'active' : ''}`}
                    onClick={() => switchMode('login')}
                  >
                    ورود به سامانه
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'register'}
                    className={`lgn-tab ${mode === 'register' ? 'active' : ''}`}
                    onClick={() => switchMode('register')}
                  >
                    ثبت‌نام کاربر جدید
                  </button>
                </div>

                <div className="lgn-card-head">
                  <h1 id="login-heading">
                    {mode === 'login' ? 'ورود به سامانه' : 'ایجاد حساب کاربری'}
                  </h1>
                </div>

                {expiredReason && !errorMsg && mode === 'login' && (
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

                {mode === 'login' ? (
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

                    <div className="lgn-foot-links">
                      <span>حساب کاربری ندارید؟</span>
                      <button
                        type="button"
                        className="lgn-inline-link"
                        onClick={() => switchMode('register')}
                      >
                        ثبت‌نام کاربر جدید ←
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <form onSubmit={handleRegisterSubmit} noValidate>
                      <div className="lgn-field">
                        <label className="lgn-label" htmlFor="reg-username">
                          نام کاربری
                        </label>
                        <input
                          id="reg-username"
                          name="regUsername"
                          type="text"
                          className="lgn-input"
                          value={regUsername}
                          onChange={(e) => setRegUsername(e.target.value)}
                          placeholder="username"
                          autoComplete="username"
                          minLength={3}
                          required
                        />
                      </div>

                      <div className="lgn-field">
                        <label className="lgn-label" htmlFor="reg-password">
                          رمز عبور
                        </label>
                        <div className="lgn-input-wrap">
                          <input
                            id="reg-password"
                            name="regPassword"
                            type={showRegPassword ? 'text' : 'password'}
                            className="lgn-input has-toggle"
                            value={regPassword}
                            onChange={(e) => setRegPassword(e.target.value)}
                            placeholder="حداقل ۴ کاراکتر"
                            autoComplete="new-password"
                            minLength={4}
                            required
                          />
                          <button
                            type="button"
                            className="lgn-toggle-pass"
                            onClick={() => setShowRegPassword((prev) => !prev)}
                            aria-label={showRegPassword ? 'مخفی کردن رمز عبور' : 'نمایش رمز عبور'}
                          >
                            {showRegPassword ? 'مخفی' : 'نمایش'}
                          </button>
                        </div>
                      </div>

                      <div className="lgn-field">
                        <label className="lgn-label" htmlFor="reg-confirm-password">
                          تکرار رمز عبور
                        </label>
                        <input
                          id="reg-confirm-password"
                          name="regConfirmPassword"
                          type={showRegPassword ? 'text' : 'password'}
                          className="lgn-input"
                          value={regConfirmPassword}
                          onChange={(e) => setRegConfirmPassword(e.target.value)}
                          placeholder="تکرار رمز عبور"
                          autoComplete="new-password"
                          minLength={4}
                          required
                        />
                      </div>

                      <label className="lgn-check-row" style={{ marginBottom: 10 }}>
                        <input
                          type="checkbox"
                          checked={regAutoLogin}
                          onChange={(e) => setRegAutoLogin(e.target.checked)}
                        />
                        <span>ورود خودکار پس از ثبت‌نام</span>
                      </label>

                      {regAutoLogin && (
                        <label className="lgn-check-row">
                          <input
                            type="checkbox"
                            checked={regRememberMe}
                            onChange={(e) => setRegRememberMe(e.target.checked)}
                          />
                          <span>مرا به خاطر بسپار</span>
                        </label>
                      )}

                      <button
                        type="submit"
                        className="lgn-btn lgn-btn-primary lgn-submit"
                        disabled={regSubmitting}
                      >
                        {regSubmitting ? 'در حال ثبت‌نام…' : 'ثبت‌نام'}
                      </button>
                    </form>

                    <div className="lgn-foot-links">
                      <span>قبلاً ثبت‌نام کرده‌اید؟</span>
                      <button
                        type="button"
                        className="lgn-inline-link"
                        onClick={() => switchMode('login')}
                      >
                        بازگشت به ورود ←
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
