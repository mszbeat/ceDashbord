import React from 'react';
import './admin.css';

export default function AdminLoading() {
  return (
    <div className="adm-root" dir="rtl">
      <div className="adm-gate-wrap">
        <div className="adm-gate-card" role="status" aria-live="polite">
          <div className="adm-spinner" aria-hidden="true" />
          <h1>در حال بررسی سطح دسترسی…</h1>
          <p>شرایط دسترسی و نشست کاربری با سرور در حال بررسی است؛ لطفاً چند لحظه صبر کنید.</p>
        </div>
      </div>
    </div>
  );
}
