'use client';

import React, { useEffect, useState } from 'react';
import {
  applyTheme,
  AuthSessionState,
  formatRolesFa,
  getSavedTheme,
  logoutSession,
} from '@/lib/auth-client';
import './admin.css';

interface AdminAccessDeniedProps {
  authUser: AuthSessionState | null;
  reason?: string | null;
}

export default function AdminAccessDenied({ authUser, reason }: AdminAccessDeniedProps) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const saved = getSavedTheme();
    setTheme(saved);
    applyTheme(saved);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    applyTheme(next);
  };

  const handleLogout = async () => {
    await logoutSession();
    if (typeof window !== 'undefined') {
      window.location.assign('/login?next=%2Fadmin');
    }
  };

  return (
    <div className="adm-root" dir="rtl">
      <div className="adm-container" style={{ maxWidth: 680, paddingTop: 68 }}>
        <section className="adm-card" style={{ padding: '34px 36px' }}>
          <div style={{ marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="adm-badge err">HTTP ۴۰۳ · عدم دسترسی</span>
            {authUser?.authenticated && (
              <span className="adm-badge muted">
                کاربر فعلی: {authUser.username} ({formatRolesFa(authUser.roles)})
              </span>
            )}
          </div>
          <h1 style={{ fontSize: 22, margin: '0 0 12px', fontWeight: 800 }}>
            عدم مجوز ورود به پنل مدیریت
          </h1>
          <p style={{ lineHeight: 1.9, margin: '0 0 24px', color: 'var(--adm-muted)' }}>
            {reason ||
              'شما با حساب کاربری عادی وارد شده‌اید؛ ورود به پنل مدیریت فقط برای کاربران دارای نقش مدیر سیستم (admin) مجاز است.'}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a className="adm-btn adm-btn-primary" href="/">
              ← بازگشت به صفحهٔ اول داشبورد
            </a>
            <a className="adm-btn" href="/login?next=%2Fadmin">
              ورود با حساب مدیر دیگر
            </a>
            {authUser?.authenticated && (
              <button type="button" className="adm-btn" onClick={() => void handleLogout()}>
                خروج از این حساب
              </button>
            )}
            <button type="button" className="adm-btn" onClick={toggleTheme}>
              {theme === 'light' ? '☾ حالت تیره' : '☀ حالت روشن'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
