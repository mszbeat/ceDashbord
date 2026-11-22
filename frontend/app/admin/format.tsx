/**
 * F6 — توابع نمایشی مشترک پنل مدیریت.
 *
 * این‌ها **بدون تغییر رفتار** از `AdminClient.tsx` بیرون کشیده شدند تا:
 *  ۱) فایل اصلی کوچک‌تر شود (۱۵۰۸ خط ⇒ بخش‌های مستقل)،
 *  ۲) مستقل از React قابل تست باشند (`tests/admin-format.test.mjs`).
 *
 * ⚠️ رفتار قالب‌بندی عدد/تاریخ عیناً حفظ شده: رقم‌های لاتین با گروه‌بندی `en-US` و سپس
 * تبدیل به رقم فارسی با جداکنندهٔ `,` — تغییر آن ظاهر جدول‌ها را عوض می‌کند و مجاز نیست.
 */

export function faNum(val: number | string | null | undefined): string {
  if (val === null || val === undefined || val === '') return '—';
  const n = typeof val === 'number' ? val.toLocaleString('en-US') : String(val);
  return n.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

export function formatDateTimeFa(iso?: string | null): string {
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

/**
 * ورودی متنی فرم را به عدد امن تبدیل می‌کند (ارقام فارسی/عربی هم پذیرفته می‌شوند).
 * برای فیلترهای عددی الزامی است؛ رشتهٔ عددی باعث رد شدن در اعتبارسنجی بک‌اند می‌شود.
 */
export function toSafeNumber(raw: string | number | null | undefined): number | null {
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

/** نشان وضعیت اجرا — مشترک بین `AdminClient` و `JobsMonitor` */
export function StatusBadge({ status }: { status?: string | null }) {
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

/** F3/F8: خلاصهٔ فیلترهای جاب — کدملی هرگز در متن بازتولید نمی‌شود */
export function jobFilterSummary(filters?: Record<string, any> | null): string[] {
  if (!filters) return [];
  const parts: string[] = [];
  if (filters.hasNationalCode) parts.push('فیلتر کدملی (حذف‌شده از لاگ)');
  if (filters.requestId) parts.push(`requestId: ${filters.requestId}`);
  if (filters.uniqueKey) parts.push(`uniqueKey: ${filters.uniqueKey}`);
  if (filters.maxCount) parts.push(`سقف: ${faNum(filters.maxCount)}`);
  return parts;
}

/** درصد پیشرفت جاب، همیشه بین ۰ و ۱۰۰ */
export function jobProgressPercent(job: {
  totalSteps?: number | null;
  completedSteps?: number | null;
  failedSteps?: number | null;
}): number {
  const total = Number(job?.totalSteps || 0);
  const done = Number(job?.completedSteps || 0) + Number(job?.failedSteps || 0);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}
