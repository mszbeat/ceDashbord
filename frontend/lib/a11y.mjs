/**
 * F9 — ابزارهای دسترس‌پذیری و بررسی XSS.
 *
 * قاعده‌های اعمال‌شده:
 *  * هیچ‌جا `dangerouslySetInnerHTML`/`innerHTML` نداریم؛ گزارش خام HTML **از مسیر پروکسی**
 *    می‌آید (iframe/جریان)، نه تزریق در DOM پنل.
 *  * اعلان‌ها با `role="alert"` و `aria-live` اعلام می‌شوند تا اسکرین‌ریدر خبردار شود.
 *  * متن‌های پویا (نام بانک، پیام خطای سرور) همیشه به‌صورت متن رندر می‌شوند، نه HTML.
 */

/** پاک‌سازی رشته برای نمایش در متن (حذف کاراکترهای کنترلی و نویسه‌های جهت‌دهندهٔ مرموز) */
export function safeText(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  // U+202A..U+202E و U+2066..U+2069 می‌توانند متن را وارونه/گیج‌کننده نمایش دهند
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .slice(0, 2000);
}

/** آیا رشته شبیه HTML است؟ (برای جلوگیری از رندر تصادفی به‌عنوان محتوا) */
export function looksLikeHtml(value) {
  return typeof value === 'string' && /<\s*\/?\s*[a-z][^>]*>/i.test(value);
}

/** خواص ARIA استاندارد برای یک اعلان */
export function toastA11y(kind) {
  const polite = kind === 'success' || kind === 'info';
  return {
    role: polite ? 'status' : 'alert',
    'aria-live': polite ? 'polite' : 'assertive',
    'aria-atomic': true,
  };
}

/** برچسب دکمهٔ صفحه‌بندی برای اسکرین‌ریدر */
export function pagerA11y(page, totalPages) {
  const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  return {
    'aria-label': `صفحه‌بندی فهرست، صفحهٔ ${fa(page)} از ${fa(totalPages)}`,
    role: 'navigation',
  };
}
