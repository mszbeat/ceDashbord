/**
 * F4 — اعتبارسنجی مقصد بازگشت بعد از ورود (`?next=…`).
 *
 * چرا فایل جدا و بدون TypeScript: این تابع امنیتی است و باید در تست‌های Node بدون
 * زنجیرهٔ ساخت Next قابل اجرا باشد (همان تابع، همان کد — نه نسخهٔ کپی‌شده در تست).
 *
 * نسخهٔ قبلی فقط رشته را بررسی می‌کرد (`startsWith('/')` و نبود `//`). این شکل با مقادیر
 * کدگذاری‌شده و کاراکترهای کنترلی دور زده می‌شود:
 *   `/%2f%2fevil.com`, `/\evil.com`, `/%09/evil.com`, `///evil.com`
 * چون مرورگر آن‌ها را نرمال می‌کند و در نهایت به میزبان مهاجم می‌رود (open redirect).
 * راه‌حل: مقدار را با یک origin مبنا پارس می‌کنیم و **origin** را مقایسه می‌کنیم.
 *
 * @param {string|null|undefined} raw مقدار خام `next`
 * @param {string} fallback مقصد پیش‌فرض
 * @param {string} origin مبدأ جاری (در کلاینت `window.location.origin`)
 * @returns {string} مسیر امن (همیشه داخلی)
 */
export function sanitizeNextPath(raw, fallback = '/', origin = 'http://localhost') {
  if (!raw || typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  // کاراکتر کنترلی، فاصله و بک‌اسلش در مسیر مجاز نیست
  if (/[\u0000-\u001f\u007f\s\\]/.test(trimmed)) return fallback;
  let parsed;
  try {
    parsed = new URL(trimmed, origin);
  } catch {
    return fallback;
  }
  let base;
  try {
    base = new URL(origin);
  } catch {
    base = new URL('http://localhost');
  }
  if (parsed.origin !== base.origin) return fallback;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
  if (parsed.username || parsed.password) return fallback;
  if (parsed.pathname === '/login' || parsed.pathname.startsWith('/login/')) return fallback;
  if (!parsed.pathname.startsWith('/')) return fallback;
  // `URL` مسیر را کدگذاری‌شده نگه می‌دارد (`/%2f%2fevil.com`). سرورهای مختلف آن را باز
  // می‌کنند و بعضی (پروکسی‌ها/فریم‌ورک‌ها) دوبار رمزگشایی می‌کنند ⇒ همان مسیر یک `/` دوم
  // می‌شود و هاست عوض می‌شود. پس مسیرِ رمزگشایی‌شده هم باید همان قواعد را رعایت کند.
  let decoded = parsed.pathname;
  for (let depth = 0; depth < 3; depth += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return fallback; // درصد معیوب = ورودی مشکوک
    }
    if (next === decoded) break;
    decoded = next;
    if (decoded.startsWith('//') || decoded.includes('\\')) return fallback;
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return fallback;
  if (decoded.startsWith('/login') ) return fallback;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export default sanitizeNextPath;
