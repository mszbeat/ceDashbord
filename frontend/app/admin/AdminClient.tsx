'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyTheme,
  authFetch,
  AuthSessionState,
  ensureAuthenticated,
  formatRolesFa,
  getSavedTheme,
  logoutSession,
  startSessionKeepalive,
} from '@/lib/auth-client';
import './admin.css';

export type BankKey = 'tavan_mellat' | 'tavan_resalat' | 'tavan_postbank';
type DateScope = 'single' | 'range' | 'filter_only';

export interface BankOverview {
  bank: BankKey;
  faName: string;
  enName: string;
  totalRows: number;
  daysCount: number;
  minDay: string | null;
  maxDay: string | null;
  successRows: number;
  failRows: number;
  lastUpdatedAt: string | null;
  latestRun: any | null;
}

export interface CronState {
  id: string;
  enabled: boolean;
  schedule_mode: 'daily' | 'cron';
  hour: number;
  minute: number;
  cron_expr: string;
  effective_cron_expr: string;
  timezone: string;
  banks: BankKey[];
  target_offset_days: number;
  target_day_preview: string;
  rebuild: boolean;
  last_slot: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_summary: any | null;
  next_run: { iso: string; jalaliDay: string; time: string } | null;
}

export interface OverviewPayload {
  serverClock: {
    iso: string;
    timezone: string;
    jalaliToday: string;
    jalaliYesterday: string;
    tehranTime: string;
  };
  banks: BankOverview[];
  cron: CronState;
  jobs: any[];
  recentDayRuns: any[];
}

const BANK_OPTIONS: { key: BankKey; label: string; reportParam: string }[] = [
  { key: 'tavan_mellat', label: 'بانک ملت', reportParam: 'tavan_mellat' },
  { key: 'tavan_resalat', label: 'بانک رسالت', reportParam: 'tavan_resalat' },
  { key: 'tavan_postbank', label: 'پست‌بانک', reportParam: 'tavan_postbank' },
];

function faNum(val: number | string | null | undefined): string {
  if (val === null || val === undefined || val === '') return '—';
  const n = typeof val === 'number' ? val.toLocaleString('en-US') : String(val);
  return n.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

function formatDateTimeFa(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function statusBadge(status?: string | null) {
  switch (status) {
    case 'complete':
    case 'completed':
    case 'done':
      return <span className="adm-badge ok">تکمیل‌شده</span>;
    case 'partial':
      return <span className="adm-badge run">میانی / جزئی</span>;
    case 'running':
      return <span className="adm-badge run">⟳ در حال اجرا</span>;
    case 'needs_review':
    case 'partial_error':
      return <span className="adm-badge warn">نیازمند بررسی</span>;
    case 'failed':
      return <span className="adm-badge err">ناموفق</span>;
    case 'pending':
      return <span className="adm-badge muted">در نوبت</span>;
    default:
      return <span className="adm-badge muted">{status || 'ثبت‌نشده'}</span>;
  }
}

/**
 * ورودی متنی فرم را به عدد امن تبدیل می‌کند (ارقام فارسی/عربی هم پذیرفته می‌شوند).
 * برای فیلترهای عددی الزامی است؛ رشتهٔ عددی باعث رد شدن در اعتبارسنجی بک‌اند می‌شود.
 */
function toSafeNumber(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const normalized = String(raw)
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[,٬،\s]/g, '');
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function unwrapPartEnvelope(raw: any): any {
  let cur = raw;
  if (
    cur &&
    typeof cur === 'object' &&
    !Array.isArray(cur) &&
    'data' in cur &&
    cur.data !== undefined &&
    !('serverClock' in cur) &&
    !('hasExistingData' in cur) &&
    !('schedule_mode' in cur) &&
    !('totalSteps' in cur)
  ) {
    cur = cur.data;
    if (typeof cur === 'string') {
      try {
        cur = JSON.parse(cur);
      } catch {
        // متن ساده خطا
      }
    }
  }
  return cur;
}

async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(path, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? unwrapPartEnvelope(JSON.parse(text)) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const rawMessage = data?.message ?? data?.data?.message ?? data?.error?.message;
    const msg = Array.isArray(rawMessage)
      ? rawMessage.join(' | ')
      : typeof rawMessage === 'string'
        ? rawMessage
        : typeof rawMessage === 'object' && rawMessage !== null
          ? rawMessage.fa || rawMessage.en || `خطای سرور (HTTP ${res.status})`
          : `خطای سرور (HTTP ${res.status})`;
    const err: any = new Error(msg);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data as T;
}

interface AdminClientProps {
  initialAuth: AuthSessionState | null;
  initialOverview: OverviewPayload | null;
}

export default function AdminClient({ initialAuth, initialOverview }: AdminClientProps) {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [authUser, setAuthUser] = useState<AuthSessionState | null>(initialAuth);
  const [redirectingToLogin, setRedirectingToLogin] = useState(false);
  const [redirectingToDashboard, setRedirectingToDashboard] = useState(false);
  const [overview, setOverview] = useState<OverviewPayload | null>(initialOverview);
  const [loadingOverview, setLoadingOverview] = useState(!initialOverview);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  // Manual run form state
  const [selectedBanks, setSelectedBanks] = useState<BankKey[]>(['tavan_mellat', 'tavan_resalat', 'tavan_postbank']);
  const [dateScope, setDateScope] = useState<DateScope>('single');
  const [singleDay, setSingleDay] = useState(initialOverview?.serverClock?.jalaliYesterday || '');
  const [fromDay, setFromDay] = useState(initialOverview?.serverClock?.jalaliYesterday || '');
  const [toDay, setToDay] = useState(initialOverview?.serverClock?.jalaliToday || '');
  const [runMode, setRunMode] = useState<'nightly' | 'intraday'>('nightly');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterRequestId, setFilterRequestId] = useState('');
  const [filterUniqueKey, setFilterUniqueKey] = useState('');
  const [filterNationalCode, setFilterNationalCode] = useState('');
  const [filterMaxCount, setFilterMaxCount] = useState('');
  const [filterPageSize, setFilterPageSize] = useState('');
  const [checkingRun, setCheckingRun] = useState(false);

  // Pre-check conflict modal state
  const [conflictCheck, setConflictCheck] = useState<any | null>(null);
  const [pendingPayload, setPendingPayload] = useState<any | null>(null);
  const [startingConfirmed, setStartingConfirmed] = useState(false);

  // Cron form state
  const [cronDirty, setCronDirty] = useState(false);
  const [cronEnabled, setCronEnabled] = useState(initialOverview?.cron?.enabled ?? false);
  const [cronMode, setCronMode] = useState<'daily' | 'cron'>(initialOverview?.cron?.schedule_mode ?? 'daily');
  const [cronHour, setCronHour] = useState(initialOverview?.cron?.hour ?? 2);
  const [cronMinute, setCronMinute] = useState(initialOverview?.cron?.minute ?? 0);
  const [cronExpr, setCronExpr] = useState(initialOverview?.cron?.cron_expr ?? '0 2 * * *');
  const [cronBanks, setCronBanks] = useState<BankKey[]>(
    initialOverview?.cron?.banks?.length
      ? initialOverview.cron.banks
      : ['tavan_mellat', 'tavan_resalat', 'tavan_postbank'],
  );
  const [cronOffsetDays, setCronOffsetDays] = useState(initialOverview?.cron?.target_offset_days ?? 1);
  const [cronRebuild, setCronRebuild] = useState(initialOverview?.cron?.rebuild ?? false);
  const [savingCron, setSavingCron] = useState(false);
  const [triggeringCron, setTriggeringCron] = useState(false);

  const jobsSectionRef = useRef<HTMLDivElement | null>(null);
  const initializedDatesRef = useRef(Boolean(initialOverview?.serverClock));

  useEffect(() => {
    const saved = getSavedTheme();
    setTheme(saved);
    applyTheme(saved);

    return startSessionKeepalive(
      (state) => {
        setAuthUser(state);
        if (state.authenticated && !state.roles?.includes('admin')) {
          setRedirectingToDashboard(true);
          if (typeof window !== 'undefined') {
            window.location.replace('/');
          }
        }
      },
      () => {
        setRedirectingToLogin(true);
        if (typeof window !== 'undefined') {
          window.location.replace('/login?next=%2Fadmin&reason=expired');
        }
      },
      { requireSession: true },
    );
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

  const syncCronFormFromServer = useCallback((c: CronState) => {
    setCronEnabled(c.enabled);
    setCronMode(c.schedule_mode);
    setCronHour(c.hour);
    setCronMinute(c.minute);
    setCronExpr(c.cron_expr);
    setCronBanks(c.banks.length ? c.banks : ['tavan_mellat', 'tavan_resalat', 'tavan_postbank']);
    setCronOffsetDays(c.target_offset_days);
    setCronRebuild(c.rebuild);
    setCronDirty(false);
  }, []);

  const fetchOverview = useCallback(
    async (silent = false) => {
      if (!silent) setLoadingOverview(true);
      try {
        const authCheck = await ensureAuthenticated().catch(() => null);
        if (authCheck) setAuthUser(authCheck);
        if (!authCheck?.authenticated) {
          setRedirectingToLogin(true);
          if (typeof window !== 'undefined') {
            window.location.replace('/login?next=%2Fadmin');
          }
          return;
        }
        if (!authCheck.roles?.includes('admin')) {
          setRedirectingToDashboard(true);
          if (typeof window !== 'undefined') {
            window.location.replace('/');
          }
          return;
        }

        const data = await apiFetch<OverviewPayload>('/api/admin/overview');
        setOverview(data);
        if (!initializedDatesRef.current && data.serverClock) {
          initializedDatesRef.current = true;
          setSingleDay(data.serverClock.jalaliYesterday);
          setFromDay(data.serverClock.jalaliYesterday);
          setToDay(data.serverClock.jalaliToday);
          syncCronFormFromServer(data.cron);
        } else if (!cronDirty && data.cron) {
          syncCronFormFromServer(data.cron);
        }
      } catch (err: any) {
        if (err?.status === 401 || err?.status === 403) {
          const authState = await ensureAuthenticated().catch(() => null);
          if (authState) setAuthUser(authState);
          if (!authState || !authState.authenticated) {
            setRedirectingToLogin(true);
            if (typeof window !== 'undefined') {
              window.location.replace('/login?next=%2Fadmin');
            }
            return;
          }
          setRedirectingToDashboard(true);
          if (typeof window !== 'undefined') {
            window.location.replace('/');
          }
          return;
        }
        if (!silent) {
          setToast({ kind: 'error', text: err?.message || 'خطا در دریافت وضعیت پنل مدیریت' });
        }
      } finally {
        if (!silent) setLoadingOverview(false);
      }
    },
    [cronDirty, syncCronFormFromServer],
  );

  useEffect(() => {
    // اگر SSR قبلاً داده را بررسی و دریافت کرده، نیازی به لودینگ مجدد نیست؛
    // در غیر این صورت قبل از نمایش فرم‌ها، وضعیت دسترسی و داده را از سرور بررسی می‌کنیم.
    if (!initialOverview) {
      void fetchOverview(false);
    }
  }, [fetchOverview, initialOverview]);

  const hasRunningJobs = useMemo(
    () => Boolean(overview?.jobs?.some((j) => j.status === 'running')),
    [overview],
  );

  // رفرش خودکار سریع هنگام اجرای جابها (هر ۲ ثانیه) و معمولی در حالت سکون (هر ۱۵ ثانیه)
  useEffect(() => {
    if (redirectingToDashboard || !overview) return;
    const intervalMs = hasRunningJobs ? 2000 : 15000;
    const id = window.setInterval(() => {
      void fetchOverview(true);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [hasRunningJobs, fetchOverview, redirectingToDashboard, overview]);

  // بستن مودال با کلید Escape
  useEffect(() => {
    if (!conflictCheck) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !startingConfirmed) {
        setConflictCheck(null);
        setPendingPayload(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [conflictCheck, startingConfirmed]);

  const toggleManualBank = (bank: BankKey) => {
    setSelectedBanks((prev) =>
      prev.includes(bank) ? (prev.length > 1 ? prev.filter((b) => b !== bank) : prev) : [...prev, bank],
    );
  };

  const toggleCronBank = (bank: BankKey) => {
    setCronDirty(true);
    setCronBanks((prev) =>
      prev.includes(bank) ? (prev.length > 1 ? prev.filter((b) => b !== bank) : prev) : [...prev, bank],
    );
  };

  const buildManualPayload = () => {
    const filters: Record<string, any> = {};
    if (filterStatus.trim()) filters.status = filterStatus.trim();
    if (filterRequestId.trim()) filters.requestId = filterRequestId.trim();
    if (filterUniqueKey.trim()) filters.uniqueKey = filterUniqueKey.trim();
    if (filterNationalCode.trim()) filters.nationalCode = filterNationalCode.trim();
    // این دو فیلتر در اسکیمای بک‌اند عددی‌اند؛ ارسال رشته باعث خطای اعتبارسنجی (۴۰۰) می‌شد.
    const maxCountNum = toSafeNumber(filterMaxCount);
    if (maxCountNum !== null) filters.maxCount = maxCountNum;
    const pageSizeNum = toSafeNumber(filterPageSize);
    if (pageSizeNum !== null) filters.pageSize = pageSizeNum;

    return {
      banks: selectedBanks,
      dateScope,
      day: dateScope === 'single' ? singleDay.trim() : undefined,
      fromDay: dateScope === 'range' ? fromDay.trim() : undefined,
      toDay: dateScope === 'range' ? toDay.trim() : undefined,
      mode: runMode,
      filters,
    };
  };

  const launchManualRun = async (basePayload: any, strategy: 'upsert' | 'rebuild', confirmed: boolean) => {
    setStartingConfirmed(true);
    try {
      const job = await apiFetch('/api/admin/runs/start', {
        method: 'POST',
        body: JSON.stringify({
          ...basePayload,
          conflictStrategy: strategy,
          confirmedConflict: confirmed,
        }),
      });
      setConflictCheck(null);
      setPendingPayload(null);
      if (filterNationalCode) setFilterNationalCode('');
      setToast({
        kind: 'success',
        text: `فرآیند تحلیل آغاز شد (${faNum(job.totalSteps)} گام در پس‌زمینه — شناسه: ${job.id}).`,
      });
      await fetchOverview(true);
      jobsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err: any) {
      setToast({ kind: 'error', text: err?.message || 'خطا در شروع فرآیند تحلیل' });
    } finally {
      setStartingConfirmed(false);
    }
  };

  const handleCheckAndStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setToast(null);
    const payload = buildManualPayload();
    setCheckingRun(true);
    try {
      const check = await apiFetch('/api/admin/runs/check', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (check.hasExistingData) {
        setPendingPayload(payload);
        setConflictCheck(check);
      } else {
        await launchManualRun(payload, 'upsert', true);
      }
    } catch (err: any) {
      setToast({ kind: 'error', text: err?.message || 'خطا در بررسی پیش از اجرای دیتابیس' });
    } finally {
      setCheckingRun(false);
    }
  };

  const handleSaveCron = async (e: React.FormEvent) => {
    e.preventDefault();
    setToast(null);
    setSavingCron(true);
    try {
      const saved = await apiFetch<CronState>('/api/admin/cron', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: cronEnabled,
          schedule_mode: cronMode,
          hour: Number(cronHour),
          minute: Number(cronMinute),
          cron_expr: cronExpr,
          banks: cronBanks,
          target_offset_days: Number(cronOffsetDays),
          rebuild: cronRebuild,
        }),
      });
      syncCronFormFromServer(saved);
      await fetchOverview(true);
      setToast({
        kind: 'success',
        text: saved.enabled
          ? `تنظیمات کران شبانه ذخیره و فعال شد (اجرای بعدی: ${saved.next_run ? `${faNum(saved.next_run.jalaliDay)} ساعت ${faNum(saved.next_run.time)}` : 'نامشخص'}).`
          : 'تنظیمات کران شبانه ذخیره شد (وضعیت فعلی: غیرفعال).',
      });
    } catch (err: any) {
      setToast({ kind: 'error', text: err?.message || 'خطا در ذخیره تنظیمات کران' });
    } finally {
      setSavingCron(false);
    }
  };

  const handleRunCronNow = async () => {
    setToast(null);
    setTriggeringCron(true);
    try {
      const job = await apiFetch('/api/admin/cron/run-now', { method: 'POST', body: '{}' });
      setToast({
        kind: 'success',
        text: `اجرای فوری کران شبانه آغاز شد (${faNum(job.days?.join('، '))} — شناسه: ${job.id}).`,
      });
      await fetchOverview(true);
      jobsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err: any) {
      setToast({ kind: 'error', text: err?.message || 'خطا در اجرای فوری کران' });
    } finally {
      setTriggeringCron(false);
    }
  };

  const prefillDayFromHistory = (bank: BankKey, day: string) => {
    setSelectedBanks([bank]);
    setDateScope('single');
    setSingleDay(day);
    window.scrollTo({ top: 240, behavior: 'smooth' });
  };

  if (redirectingToLogin) {
    return (
      <div className="adm-root" dir="rtl">
        <div className="adm-gate-wrap">
          <div className="adm-gate-card">
            <div className="adm-spinner" aria-hidden="true" />
            <h1>نیاز به ورود به حساب کاربری</h1>
            <p>در حال انتقال به صفحهٔ ورود به سامانه…</p>
          </div>
        </div>
      </div>
    );
  }

  if (redirectingToDashboard) {
    return (
      <div className="adm-root" dir="rtl">
        <div className="adm-gate-wrap">
          <div className="adm-gate-card">
            <div className="adm-spinner" aria-hidden="true" />
            <h1>در حال انتقال به داشبورد…</h1>
            <p>در حال هدایت به صفحهٔ اصلی داشبورد…</p>
          </div>
        </div>
      </div>
    );
  }

  // گیت اجباری: پیش از تأیید دسترسی و دریافت داده از بک‌اند، محتوای پنل مدیریت نمایش داده نمی‌شود
  if (!overview) {
    return (
      <div className="adm-root" dir="rtl">
        <div className="adm-gate-wrap">
          <div className="adm-gate-card" role="status" aria-live="polite">
            <div className="adm-spinner" aria-hidden="true" />
            <h1>در حال بررسی سطح دسترسی…</h1>
            <p>شرایط دسترسی و اطلاعات پنل مدیریت از سرور در حال بررسی است؛ لطفاً چند لحظه صبر کنید.</p>
            {toast && (
              <div style={{ marginTop: 18 }}>
                <div className={`adm-toast ${toast.kind}`} role="alert" style={{ textAlign: 'right' }}>
                  <span>{toast.text}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
                  <button type="button" className="adm-btn adm-btn-primary" onClick={() => void fetchOverview(false)}>
                    تلاش مجدد
                  </button>
                  <a className="adm-btn" href="/">
                    ← بازگشت به داشبورد
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="adm-root" dir="rtl">
      <div className="adm-container">
        {/* Topbar */}
        <header className="adm-topbar">
          <div className="adm-brand">
            <span className="adm-brand-mark" aria-hidden="true">⚙</span>
            <div>
              <strong>پنل مدیریت و زمان‌بندی تحلیل</strong>
              <small>اجرای تحلیل دستی و زمان‌بندی روزانهٔ بانک‌ها</small>
            </div>
          </div>

          <div className="adm-top-actions">
            {authUser?.authenticated && (
              <span className="adm-user-chip" title={formatRolesFa(authUser.roles)}>
                <span>👤 {authUser.username}</span>
                <small>· {formatRolesFa(authUser.roles)}</small>
              </span>
            )}
            <a className="adm-btn" href="/">
              ← بازگشت به داشبورد زنده
            </a>
            <button
              type="button"
              className="adm-btn"
              onClick={() => void fetchOverview(false)}
              disabled={loadingOverview}
            >
              {loadingOverview ? 'در حال بروزرسانی...' : '⟳ بروزرسانی وضعیت'}
            </button>
            {authUser?.authenticated ? (
              <button type="button" className="adm-btn" onClick={() => void handleLogout()}>
                خروج
              </button>
            ) : (
              <a className="adm-btn" href="/login?next=%2Fadmin">
                ورود
              </a>
            )}
            <button type="button" className="adm-btn" onClick={toggleTheme}>
              {theme === 'light' ? '☾ حالت تیره' : '☀ حالت روشن'}
            </button>
          </div>
        </header>

        {/* Hero Banner */}
        <section className="adm-hero">
          <div>
            <h1>مدیریت و زمان‌بندی تحلیل بانک‌ها</h1>
            <p>
              اجرای دستی تحلیل بر اساس بانک، تاریخ و فیلترهای گزارش یا تنظیم اجرای خودکار روزانه.
            </p>
          </div>
          <div className="adm-clock-strip">
            <div className="adm-clock-chip">
              <span>ساعت سرور (تهران)</span>
              <strong className="adm-ltr">{faNum(overview?.serverClock?.tehranTime || '--:--')}</strong>
            </div>
            <div className="adm-clock-chip">
              <span>امروز شمسی</span>
              <strong className="adm-ltr">{faNum(overview?.serverClock?.jalaliToday || '----')}</strong>
            </div>
            <div className="adm-clock-chip">
              <span>دیروز (هدف شبانه)</span>
              <strong className="adm-ltr">{faNum(overview?.serverClock?.jalaliYesterday || '----')}</strong>
            </div>
          </div>
        </section>

        {/* Toast Notification */}
        {toast && (
          <div className={`adm-toast ${toast.kind}`} role="alert">
            <span>{toast.text}</span>
            <button type="button" className="adm-btn adm-btn-sm" onClick={() => setToast(null)}>
              بستن
            </button>
          </div>
        )}

        {/* Per-Bank Database Cards */}
        <section className="adm-bank-grid" aria-label="وضعیت بانک‌ها در دیتابیس">
          {(overview?.banks ?? []).map((b) => {
            const opt = BANK_OPTIONS.find((o) => o.key === b.bank);
            return (
              <div className="adm-card" key={b.bank}>
                <div className="adm-bank-head">
                  <div>
                    <h3>{b.faName}</h3>
                    <small style={{ color: 'var(--adm-muted)', fontSize: 11 }}>
                      بازهٔ موجود:{' '}
                      {b.minDay ? (
                        <span className="adm-ltr">
                          {faNum(b.minDay)} → {faNum(b.maxDay)}
                        </span>
                      ) : (
                        'بدون داده'
                      )}
                    </small>
                  </div>
                  {statusBadge(b.latestRun?.status)}
                </div>

                <div className="adm-bank-metrics">
                  <div className="adm-metric-box">
                    <small>کل رکوردها</small>
                    <strong>{faNum(b.totalRows)}</strong>
                  </div>
                  <div className="adm-metric-box">
                    <small>تعداد روزها</small>
                    <strong>{faNum(b.daysCount)}</strong>
                  </div>
                  <div className="adm-metric-box">
                    <small>موفق / ناموفق</small>
                    <strong>
                      <span style={{ color: 'var(--adm-green)' }}>{faNum(b.successRows)}</span>
                      {' / '}
                      <span style={{ color: 'var(--adm-amber)' }}>{faNum(b.failRows)}</span>
                    </strong>
                  </div>
                </div>

                <div className="adm-bank-foot">
                  <span>
                    آخرین اجرای ثبت‌شده:{' '}
                    <b>{b.latestRun?.day ? faNum(b.latestRun.day) : '—'}</b>
                  </span>
                  <a
                    className="adm-btn adm-btn-sm"
                    href={`/?bank=${encodeURIComponent(opt?.reportParam || b.bank)}`}
                  >
                    مشاهده داشبورد ↗
                  </a>
                </div>
              </div>
            );
          })}
        </section>

        {/* Main 2-Column Workspace: Manual Analysis + Nightly Cron */}
        <div className="adm-main-grid">
          {/* Column 1: Manual Analysis Runner */}
          <section className="adm-card">
            <div className="adm-section-head">
              <div>
                <h2>اجرای دستی تحلیل</h2>
                <p>
                  انتخاب بانک، بازهٔ زمانی و فیلترها برای اجرای تحلیل.
                </p>
              </div>
            </div>

            <form onSubmit={handleCheckAndStart}>
              {/* Bank selector */}
              <div className="adm-field-group">
                <span className="adm-label">۱. انتخاب بانک‌های هدف</span>
                <div className="adm-pill-group">
                  <button
                    type="button"
                    className={`adm-pill ${selectedBanks.length === BANK_OPTIONS.length ? 'active' : ''}`}
                    onClick={() => setSelectedBanks(BANK_OPTIONS.map((b) => b.key))}
                  >
                    همه بانک‌ها (۳ بانک)
                  </button>
                  {BANK_OPTIONS.map((b) => (
                    <button
                      key={b.key}
                      type="button"
                      className={`adm-pill ${selectedBanks.includes(b.key) ? 'active' : ''}`}
                      onClick={() => toggleManualBank(b.key)}
                    >
                      {selectedBanks.includes(b.key) ? '✓ ' : ''}
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Date scope selector */}
              <div className="adm-field-group">
                <span className="adm-label">۲. دامنهٔ زمانی واکشی</span>
                <div className="adm-pill-group" style={{ marginBottom: 12 }}>
                  <button
                    type="button"
                    className={`adm-pill ${dateScope === 'single' ? 'active' : ''}`}
                    onClick={() => setDateScope('single')}
                  >
                    یک روز مشخص
                  </button>
                  <button
                    type="button"
                    className={`adm-pill ${dateScope === 'range' ? 'active' : ''}`}
                    onClick={() => setDateScope('range')}
                  >
                    بازهٔ تاریخ شمسی
                  </button>
                  <button
                    type="button"
                    className={`adm-pill ${dateScope === 'filter_only' ? 'active' : ''}`}
                    onClick={() => setDateScope('filter_only')}
                  >
                    فقط بر اساس شناسه / کدملی (بدون قید روز)
                  </button>
                </div>

                {dateScope === 'single' && (
                  <div>
                    <label className="adm-label" htmlFor="adm-single-day">
                      تاریخ روز شمسی (فرمت YYYY-MM-DD)
                    </label>
                    <input
                      id="adm-single-day"
                      className="adm-input adm-ltr"
                      value={singleDay}
                      onChange={(e) => setSingleDay(e.target.value)}
                      placeholder="1405-08-22"
                      required
                    />
                    {overview?.serverClock && (
                      <div className="adm-quick-days">
                        <button
                          type="button"
                          className="adm-btn adm-btn-sm"
                          onClick={() => setSingleDay(overview.serverClock.jalaliYesterday)}
                        >
                          دیروز ({faNum(overview.serverClock.jalaliYesterday)})
                        </button>
                        <button
                          type="button"
                          className="adm-btn adm-btn-sm"
                          onClick={() => setSingleDay(overview.serverClock.jalaliToday)}
                        >
                          امروز ({faNum(overview.serverClock.jalaliToday)})
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {dateScope === 'range' && (
                  <div className="adm-row-2">
                    <div>
                      <label className="adm-label" htmlFor="adm-from-day">
                        از تاریخ شمسی
                      </label>
                      <input
                        id="adm-from-day"
                        className="adm-input adm-ltr"
                        value={fromDay}
                        onChange={(e) => setFromDay(e.target.value)}
                        placeholder="1405-08-01"
                        required
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="adm-to-day">
                        تا تاریخ شمسی (حداکثر ۶۲ روز)
                      </label>
                      <input
                        id="adm-to-day"
                        className="adm-input adm-ltr"
                        value={toDay}
                        onChange={(e) => setToDay(e.target.value)}
                        placeholder="1405-08-22"
                        required
                      />
                    </div>
                  </div>
                )}

                {dateScope === 'filter_only' && (
                  <div className="adm-privacy-note">
                    حداقل یکی از فیلترهای <b>شناسهٔ درخواست (requestId)</b>، <b>کلید یکتا (uniqueKey)</b> یا <b>کد ملی</b> را وارد کنید.
                  </div>
                )}
              </div>

              {/* Run mode */}
              {dateScope !== 'filter_only' && (
                <div className="adm-field-group">
                  <label className="adm-label" htmlFor="adm-run-mode">
                    ۳. نوع اجرای تحلیل
                  </label>
                  <select
                    id="adm-run-mode"
                    className="adm-select"
                    value={runMode}
                    onChange={(e) => setRunMode(e.target.value as 'nightly' | 'intraday')}
                  >
                    <option value="nightly">کامل / نهایی (nightly)</option>
                    <option value="intraday">میانی / روز جاری (intraday)</option>
                  </select>
                </div>
              )}

              {/* Upstream API Filters */}
              <details className="adm-details" open={dateScope === 'filter_only'}>
                <summary>
                  فیلترهای تحلیل (وضعیت، شناسه درخواست، کلید یکتا، کد ملی، سقف تعداد)
                </summary>
                <div className="adm-details-body">
                  <div className="adm-row-2" style={{ marginBottom: 12 }}>
                    <div>
                      <label className="adm-label" htmlFor="adm-f-request-id">
                        شناسهٔ درخواست (requestId)
                      </label>
                      <input
                        id="adm-f-request-id"
                        className="adm-input adm-ltr"
                        value={filterRequestId}
                        onChange={(e) => setFilterRequestId(e.target.value)}
                        placeholder="مثال: 673a91f0..."
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="adm-f-unique-key">
                        کلید یکتا (uniqueKey)
                      </label>
                      <input
                        id="adm-f-unique-key"
                        className="adm-input adm-ltr"
                        value={filterUniqueKey}
                        onChange={(e) => setFilterUniqueKey(e.target.value)}
                        placeholder="مثال: UK-..."
                      />
                    </div>
                  </div>

                  <div className="adm-row-2" style={{ marginBottom: 12 }}>
                    <div>
                      <label className="adm-label" htmlFor="adm-f-national-code">
                        کد ملی
                      </label>
                      <input
                        id="adm-f-national-code"
                        className="adm-input adm-ltr"
                        value={filterNationalCode}
                        onChange={(e) => setFilterNationalCode(e.target.value)}
                        placeholder="۱۰ رقم کد ملی"
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="adm-f-status">
                        وضعیت گزارش (status)
                      </label>
                      <input
                        id="adm-f-status"
                        className="adm-input adm-ltr"
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value)}
                        placeholder="خالی = همه"
                      />
                    </div>
                  </div>

                  <div className="adm-row-2">
                    <div>
                      <label className="adm-label" htmlFor="adm-f-max-count">
                        سقف تعداد رکورد
                      </label>
                      <input
                        id="adm-f-max-count"
                        className="adm-input adm-ltr"
                        value={filterMaxCount}
                        onChange={(e) => setFilterMaxCount(e.target.value)}
                        placeholder="خالی = کل روز"
                        inputMode="numeric"
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="adm-f-page-size">
                        اندازه صفحه (۱ تا ۲۰۰)
                      </label>
                      <input
                        id="adm-f-page-size"
                        className="adm-input adm-ltr"
                        value={filterPageSize}
                        onChange={(e) => setFilterPageSize(e.target.value)}
                        placeholder="۱۰۰"
                        inputMode="numeric"
                      />
                    </div>
                  </div>
                </div>
              </details>

              <button
                type="submit"
                className="adm-btn adm-btn-primary"
                style={{ width: '100%', minHeight: 44, fontSize: 14 }}
                disabled={checkingRun || startingConfirmed}
              >
                {checkingRun ? 'در حال بررسی...' : 'بررسی و شروع تحلیل'}
              </button>
            </form>
          </section>

          {/* Column 2: Nightly Cron Configuration */}
          <section className="adm-card">
            <div className="adm-section-head">
              <div>
                <h2>زمان‌بند خودکار شبانه (Cron)</h2>
                <p>زمان‌بندی تحلیل خودکار روزانهٔ بانک‌ها</p>
              </div>
              {overview?.cron?.enabled ? (
                <span className="adm-badge ok">● فعال</span>
              ) : (
                <span className="adm-badge muted">○ غیرفعال</span>
              )}
            </div>

            {overview?.cron && (
              <div className="adm-cron-status-box">
                <div>
                  <span style={{ color: 'var(--adm-muted)' }}>زمان اجرای بعدی (تهران): </span>
                  {overview.cron.enabled && overview.cron.next_run ? (
                    <strong>
                      <span className="adm-ltr">{faNum(overview.cron.next_run.jalaliDay)}</span> — ساعت{' '}
                      <span className="adm-ltr">{faNum(overview.cron.next_run.time)}</span>
                    </strong>
                  ) : (
                    <span>غیرفعال (در صورت فعال‌سازی: ساعت {faNum(overview.cron.next_run?.time || '02:00')})</span>
                  )}
                </div>
                <div>
                  <span style={{ color: 'var(--adm-muted)' }}>روز هدف در اجرای امشب: </span>
                  <strong className="adm-ltr">{faNum(overview.cron.target_day_preview)}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--adm-muted)' }}>آخرین اجرای خودکار/فوری: </span>
                  <span>{formatDateTimeFa(overview.cron.last_run_at)}</span>{' '}
                  {overview.cron.last_status ? statusBadge(overview.cron.last_status) : null}
                </div>
                {overview.cron.last_error && (
                  <div style={{ color: 'var(--adm-red)' }}>
                    آخرین خطا: {overview.cron.last_error}
                  </div>
                )}
              </div>
            )}

            <form onSubmit={handleSaveCron}>
              <div className="adm-switch-row">
                <div>
                  <strong style={{ display: 'block', fontSize: 13.5 }}>فعال‌سازی اجرای خودکار شبانه</strong>
                </div>
                <input
                  type="checkbox"
                  checked={cronEnabled}
                  onChange={(e) => {
                    setCronDirty(true);
                    setCronEnabled(e.target.checked);
                  }}
                  style={{ width: 20, height: 20, accentColor: 'var(--adm-accent)' }}
                />
              </div>

              <div className="adm-field-group">
                <span className="adm-label">نحوهٔ تعریف زمان‌بندی</span>
                <div className="adm-pill-group" style={{ marginBottom: 10 }}>
                  <button
                    type="button"
                    className={`adm-pill ${cronMode === 'daily' ? 'active' : ''}`}
                    onClick={() => {
                      setCronDirty(true);
                      setCronMode('daily');
                    }}
                  >
                    ساعت روزانه ثابت
                  </button>
                  <button
                    type="button"
                    className={`adm-pill ${cronMode === 'cron' ? 'active' : ''}`}
                    onClick={() => {
                      setCronDirty(true);
                      setCronMode('cron');
                    }}
                  >
                    عبارت پیشرفته Cron
                  </button>
                </div>

                {cronMode === 'daily' ? (
                  <div className="adm-row-2">
                    <div>
                      <label className="adm-label" htmlFor="adm-cron-hour">
                        ساعت (۰ تا ۲۳ — تهران)
                      </label>
                      <input
                        id="adm-cron-hour"
                        type="number"
                        min={0}
                        max={23}
                        className="adm-input adm-ltr"
                        value={cronHour}
                        onChange={(e) => {
                          setCronDirty(true);
                          setCronHour(Number(e.target.value));
                        }}
                      />
                    </div>
                    <div>
                      <label className="adm-label" htmlFor="adm-cron-minute">
                        دقیقه (۰ تا ۵۹)
                      </label>
                      <input
                        id="adm-cron-minute"
                        type="number"
                        min={0}
                        max={59}
                        className="adm-input adm-ltr"
                        value={cronMinute}
                        onChange={(e) => {
                          setCronDirty(true);
                          setCronMinute(Number(e.target.value));
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="adm-label" htmlFor="adm-cron-expr">
                      عبارت ۵فیلدی Cron (دقیقه ساعت روزماه ماه روزهفته — منطقه زمانی تهران)
                    </label>
                    <input
                      id="adm-cron-expr"
                      className="adm-input adm-ltr"
                      value={cronExpr}
                      onChange={(e) => {
                        setCronDirty(true);
                        setCronExpr(e.target.value);
                      }}
                      placeholder="0 2 * * *"
                    />
                    <span className="adm-hint">
                      مثال‌ها: <code className="adm-ltr">0 2 * * *</code> (هر شب ۲ بامداد) ·{' '}
                      <code className="adm-ltr">30 1,13 * * *</code> (ساعت ۱:۳۰ و ۱۳:۳۰)
                    </span>
                  </div>
                )}
              </div>

              <div className="adm-field-group">
                <span className="adm-label">بانک‌های تحت پوشش کران شبانه</span>
                <div className="adm-pill-group">
                  {BANK_OPTIONS.map((b) => (
                    <button
                      key={b.key}
                      type="button"
                      className={`adm-pill ${cronBanks.includes(b.key) ? 'active' : ''}`}
                      onClick={() => toggleCronBank(b.key)}
                    >
                      {cronBanks.includes(b.key) ? '✓ ' : ''}
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="adm-row-2" style={{ marginBottom: 16 }}>
                <div>
                  <label className="adm-label" htmlFor="adm-cron-offset">
                    روز هدف نسبت به زمان اجرا
                  </label>
                  <select
                    id="adm-cron-offset"
                    className="adm-select"
                    value={cronOffsetDays}
                    onChange={(e) => {
                      setCronDirty(true);
                      setCronOffsetDays(Number(e.target.value));
                    }}
                  >
                    <option value={1}>۱ روز قبل (دیروز — پیش‌فرض شبانه)</option>
                    <option value={0}>۰ (همان روز جاری)</option>
                    <option value={2}>۲ روز قبل</option>
                    <option value={3}>۳ روز قبل</option>
                  </select>
                </div>

                <div>
                  <label className="adm-label" htmlFor="adm-cron-rebuild">
                    رفتار در برابر داده‌های موجود
                  </label>
                  <select
                    id="adm-cron-rebuild"
                    className="adm-select"
                    value={cronRebuild ? 'rebuild' : 'upsert'}
                    onChange={(e) => {
                      setCronDirty(true);
                      setCronRebuild(e.target.value === 'rebuild');
                    }}
                  >
                    <option value="upsert">ادامه از چک‌پوینت / Upsert ایمن</option>
                    <option value="rebuild">بازسازی کامل روز (Rebuild اتمیک)</option>
                  </select>
                </div>
              </div>

              <div className="adm-row-2">
                <button
                  type="submit"
                  className="adm-btn adm-btn-primary"
                  disabled={savingCron}
                >
                  {savingCron ? 'در حال ذخیره...' : 'ذخیره تنظیمات کران'}
                </button>
                <button
                  type="button"
                  className="adm-btn"
                  onClick={handleRunCronNow}
                  disabled={triggeringCron}
                >
                  {triggeringCron ? 'در حال راه‌اندازی...' : '▶ اجرای فوری کران همین الان'}
                </button>
              </div>
            </form>
          </section>
        </div>

        {/* Live Jobs Monitor */}
        <section className="adm-card" style={{ marginBottom: 22 }} ref={jobsSectionRef}>
          <div className="adm-section-head">
            <div>
              <h2>وضعیت اجراهای تحلیل</h2>
            </div>
            {hasRunningJobs && <span className="adm-badge run">⟳ در حال تحلیل...</span>}
          </div>

          {!overview?.jobs?.length ? (
            <p style={{ color: 'var(--adm-muted)', margin: 0, fontSize: 13 }}>
              اجرایی ثبت نشده است.
            </p>
          ) : (
            overview.jobs.map((job) => {
              const finishedSteps = Number(job.completedSteps || 0) + Number(job.failedSteps || 0);
              const pct = job.totalSteps > 0 ? Math.round((finishedSteps / job.totalSteps) * 100) : 0;
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
                        {job.filters?.hasNationalCode && ' · فیلتر کدملی (حذف‌شده از لاگ)'}
                        {job.filters?.requestId && ` · requestId: ${job.filters.requestId}`}
                        {job.filters?.uniqueKey && ` · uniqueKey: ${job.filters.uniqueKey}`}
                        {job.filters?.maxCount && ` · سقف: ${faNum(job.filters.maxCount)}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>
                        {faNum(finishedSteps)} از {faNum(job.totalSteps)} گام
                      </span>
                      {statusBadge(job.status)}
                    </div>
                  </div>

                  <div className="adm-progress-track">
                    <div
                      className="adm-progress-bar"
                      style={{ width: `${job.status === 'running' ? Math.max(pct, 8) : pct}%` }}
                    />
                  </div>

                  <div className="adm-step-list">
                    {(job.steps ?? []).map((st: any, idx: number) => (
                      <div className="adm-step-item" key={`${st.bank}-${st.day}-${idx}`}>
                        <div>
                          <strong>{st.bankLabel}</strong> — روز{' '}
                          <b className="adm-ltr">{faNum(st.day)}</b>
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
                          {st.error && (
                            <span style={{ color: 'var(--adm-red)', fontWeight: 700 }}>{st.error}</span>
                          )}
                          {statusBadge(st.status)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </section>

        {/* Recent day_runs Table */}
        <section className="adm-card">
          <div className="adm-section-head">
            <div>
              <h2>تاریخچهٔ آخرین اجراهای تحلیل</h2>
            </div>
          </div>

          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>بانک</th>
                  <th>روز شمسی</th>
                  <th>حالت</th>
                  <th>وضعیت</th>
                  <th>تعداد منبع</th>
                  <th>چک‌پوینت</th>
                  <th>موفق / ناموفق / ردشده</th>
                  <th>آخرین بروزرسانی</th>
                  <th>عملیات سریع</th>
                </tr>
              </thead>
              <tbody>
                {!(overview?.recentDayRuns?.length) ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', color: 'var(--adm-muted)', padding: 24 }}>
                      سابقه‌ای ثبت نشده است.
                    </td>
                  </tr>
                ) : (
                  overview.recentDayRuns.map((r: any) => {
                    const opt = BANK_OPTIONS.find((o) => o.key === r.bank);
                    return (
                      <tr key={`${r.bank}-${r.day}`}>
                        <td>
                          <strong>{r.bankLabel}</strong>
                        </td>
                        <td className="adm-ltr">
                          <strong>{faNum(r.day)}</strong>
                        </td>
                        <td>{r.mode === 'intraday' ? 'میانی (intraday)' : 'شبانه (nightly)'}</td>
                        <td>
                          {statusBadge(r.status)}
                          {r.error && (
                            <div style={{ color: 'var(--adm-red)', fontSize: 11, marginTop: 3 }}>
                              {r.error}
                            </div>
                          )}
                        </td>
                        <td>{faNum(r.source_total)}</td>
                        <td>{faNum(r.checkpoint)}</td>
                        <td>
                          <span style={{ color: 'var(--adm-green)', fontWeight: 700 }}>
                            {faNum(r.success_count)}
                          </span>
                          {' / '}
                          <span style={{ color: 'var(--adm-amber)', fontWeight: 700 }}>
                            {faNum(r.fail_count)}
                          </span>
                          {' / '}
                          <span>{faNum(r.skipped_count)}</span>
                        </td>
                        <td>{formatDateTimeFa(r.updated_at)}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="adm-btn adm-btn-sm"
                              onClick={() => prefillDayFromHistory(r.bank as BankKey, r.day)}
                            >
                              انتخاب در فرم ↑
                            </button>
                            <a
                              className="adm-btn adm-btn-sm"
                              href={`/?bank=${encodeURIComponent(opt?.reportParam || r.bank)}&from=${encodeURIComponent(r.day)}&to=${encodeURIComponent(r.day)}`}
                            >
                              گزارش روز ↗
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Pre-Analysis Existing Data Confirmation Modal (3 Choices: Upsert / Rebuild / Cancel) */}
      {conflictCheck && pendingPayload && (
        <div
          className="adm-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="adm-conflict-title"
        >
          <div className="adm-modal">
            <h3 id="adm-conflict-title">
              ⚠ دادهٔ قبلی برای {faNum(conflictCheck.existingCount)} مورد از {faNum(conflictCheck.totalTargets)} هدف انتخاب‌شده وجود دارد
            </h3>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--adm-muted)' }}>
              نحوهٔ برخورد با داده‌های قبلی را انتخاب کنید:
            </p>

            <div className="adm-table-wrap" style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--adm-line)', borderRadius: 10 }}>
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>بانک</th>
                    <th>روز</th>
                    <th>رکوردهای موجود در DB</th>
                    <th>وضعیت آخرین اجرا</th>
                  </tr>
                </thead>
                <tbody>
                  {(conflictCheck.items ?? []).map((item: any, idx: number) => (
                    <tr key={`${item.bank}-${item.day}-${idx}`}>
                      <td>
                        <strong>{item.bankLabel}</strong>
                      </td>
                      <td className="adm-ltr">{faNum(item.day)}</td>
                      <td>
                        {item.exists ? (
                          <span>
                            <b>{faNum(item.rowCount)}</b> رکورد
                            {item.successCount !== null && (
                              <small style={{ color: 'var(--adm-muted)' }}>
                                {' '}
                                ({faNum(item.successCount)} موفق / {faNum(item.failCount)} ناموفق)
                              </small>
                            )}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--adm-muted)' }}>فاقد دادهٔ قبلی</span>
                        )}
                      </td>
                      <td>{item.dayRun ? statusBadge(item.dayRun.status) : <span className="adm-badge muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {conflictCheck.narrowingFilters && conflictCheck.canRebuild && (
              <div className="adm-modal-warn">
                <strong>توجه مهم:</strong> شما فیلتر محدودکننده (شناسه، کد ملی، وضعیت یا سقف تعداد) فعال کرده‌اید. اگر گزینهٔ{' '}
                <b>بازسازی کامل (Rebuild)</b> را انتخاب کنید، ابتدا تمام رکوردهای قبلی آن روز حذف شده و فقط رکوردهای منطبق با فیلتر شما جایگزین می‌شوند! برای تحلیل موردی، گزینهٔ{' '}
                <b>بروزرسانی بدون حذف (Upsert)</b> پیشنهاد می‌شود.
              </div>
            )}

            <div className="adm-choice-stack">
              <button
                type="button"
                className="adm-choice-btn"
                disabled={startingConfirmed}
                onClick={() => void launchManualRun(pendingPayload, 'upsert', true)}
              >
                <strong>۱. بروزرسانی بدون حذف داده‌های قبلی (Upsert)</strong>
                <span>رکوردهای موجود حفظ و موارد جدید اضافه یا بروزرسانی می‌شوند.</span>
              </button>

              <button
                type="button"
                className="adm-choice-btn rebuild"
                disabled={startingConfirmed || !conflictCheck.canRebuild}
                onClick={() => void launchManualRun(pendingPayload, 'rebuild', true)}
              >
                <strong>۲. بازسازی کامل روز (Rebuild)</strong>
                <span>
                  {conflictCheck.canRebuild
                    ? 'داده‌های قبلی آن روز حذف و تحلیل از ابتدا انجام می‌شود.'
                    : 'در حالت بدون قید تاریخ امکان حذف کل روز وجود ندارد.'}
                </span>
              </button>

              <button
                type="button"
                className="adm-btn"
                style={{ width: '100%', minHeight: 42 }}
                disabled={startingConfirmed}
                onClick={() => {
                  setConflictCheck(null);
                  setPendingPayload(null);
                }}
              >
                ۳. انصراف
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
