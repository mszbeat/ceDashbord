'use client';

/**
 * F6 — بلوک «وضعیت اجراهای تحلیل» از `AdminClient.tsx` جدا شد.
 *
 * بخش stateful قبلی ۱۵۰۸ خط بود؛ حالا این بخش ارائه‌ای (presentational) مستقل است:
 * فقط داده می‌گیرد و رندر می‌کند ⇒ قابل تست، قابل بازاستفاده در صفحهٔ جزئیات جاب.
 */
import React from 'react';
import { faNum, formatDateTimeFa, jobFilterSummary, jobProgressPercent, StatusBadge } from './format';

export type AdminJobStep = {
  bank?: string;
  bankLabel?: string;
  day?: string | number;
  status?: string | null;
  error?: string | null;
  liveProgress?: {
    checkpoint?: number;
    source_total?: number | null;
    success_count?: number;
    fail_count?: number;
  } | null;
  result?: {
    source_total?: number;
    processed?: number;
    success?: number;
    fail?: number;
    rebuild?: boolean;
    deleted?: number;
  } | null;
};

export type AdminJob = {
  id: string | number;
  source?: string;
  status?: string | null;
  createdAt?: string;
  conflictStrategy?: string;
  totalSteps?: number;
  completedSteps?: number;
  failedSteps?: number;
  filters?: Record<string, any> | null;
  steps?: AdminJobStep[];
};

export default function JobsMonitor({ jobs }: { jobs?: AdminJob[] | null }) {
  return (
    <section className="adm-card" style={{ marginBottom: 22 }} aria-label="وضعیت اجراهای تحلیل">
      <div className="adm-section-head">
        <div>
          <h2>وضعیت اجراهای تحلیل</h2>
        </div>
        {Boolean(jobs?.some((j) => j.status === 'running')) && (
          <span className="adm-badge run">⟳ در حال تحلیل...</span>
        )}
      </div>

      {!jobs?.length ? (
        <p style={{ color: 'var(--adm-muted)', margin: 0, fontSize: 13 }}>اجرایی ثبت نشده است.</p>
      ) : (
        jobs.map((job) => {
          const finishedSteps = Number(job.completedSteps || 0) + Number(job.failedSteps || 0);
          const pct = jobProgressPercent(job);
          return (
            <div className="adm-job-card" key={job.id}>
              <div className="adm-job-head">
                <div>
                  <strong>
                    {job.source === 'cron'
                      ? '⏰ اجرای خودکار کران شبانه'
                      : job.source === 'cron_manual'
                        ? '▶ اجرای فوری تنظیمات کران'
                        : '🛠 اجرای دستی ادمین'}
                  </strong>{' '}
                  <small className="adm-ltr" style={{ color: 'var(--adm-muted)' }}>
                    ({job.id})
                  </small>
                  <div style={{ fontSize: 11.5, color: 'var(--adm-muted)', marginTop: 2 }}>
                    شروع: {formatDateTimeFa(job.createdAt)} · استراتژی:{' '}
                    <b>{job.conflictStrategy === 'rebuild' ? 'بازسازی کامل (Rebuild)' : 'بروزرسانی (Upsert)'}</b>
                    {jobFilterSummary(job.filters).map((part) => ` · ${part}`).join('')}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>
                    {faNum(finishedSteps)} از {faNum(job.totalSteps)} گام
                  </span>
                  <StatusBadge status={job.status} />
                </div>
              </div>

              <div className="adm-progress-track">
                <div
                  className="adm-progress-bar"
                  style={{ width: `${job.status === 'running' ? Math.max(pct, 8) : pct}%` }}
                />
              </div>

              <div className="adm-step-list">
                {(job.steps ?? []).map((st, idx) => (
                  <div className="adm-step-item" key={`${st.bank}-${st.day}-${idx}`}>
                    <div>
                      <strong>{st.bankLabel}</strong> — روز <b className="adm-ltr">{faNum(st.day)}</b>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                      {st.status === 'running' && st.liveProgress && (
                        <span style={{ color: 'var(--adm-accent-strong)' }}>
                          چک‌پوینت: {faNum(st.liveProgress.checkpoint)} /{' '}
                          {faNum(st.liveProgress.source_total ?? '؟')} (موفق:{' '}
                          {faNum(st.liveProgress.success_count)} · ناموفق:{' '}
                          {faNum(st.liveProgress.fail_count)})
                        </span>
                      )}
                      {st.result && (
                        <span>
                          کل منبع: <b>{faNum(st.result.source_total)}</b> · پردازش‌شده:{' '}
                          <b>{faNum(st.result.processed)}</b> · موفق:{' '}
                          <b style={{ color: 'var(--adm-green)' }}>{faNum(st.result.success)}</b> · ناموفق:{' '}
                          <b style={{ color: 'var(--adm-amber)' }}>{faNum(st.result.fail)}</b>
                          {st.result.rebuild ? ` · حذف قبلی: ${faNum(st.result.deleted)}` : ''}
                        </span>
                      )}
                      {st.error && <span style={{ color: 'var(--adm-red)', fontWeight: 700 }}>{st.error}</span>}
                      <StatusBadge status={st.status} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
