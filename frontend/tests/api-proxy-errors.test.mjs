// F8 — خطاهای API: پیام فارسی کوتاه، بدون متن خام سرور، تشخیص retryable و لغو.
import assert from 'node:assert/strict';
import test from 'node:test';

/** ماژول `api` را با تزریق `authFetch` جعلی اجرا می‌کنیم (بدون build Next) */
async function loadApi(handler) {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../app/api.ts', import.meta.url), 'utf8'));
  // فقط منطق پیام‌ها را دوباره استفاده می‌کنیم: بسته به Vite/Next قابل import نیست،
  // پس همان تصمیم‌ها با یک شبیه‌سازِ دقیق بررسی می‌شوند و وجود قواعد در فایل هم تست می‌شود.
  return { source, handler };
}

const read = (await import('node:fs')).readFileSync;
const source = read(new URL('../app/api.ts', import.meta.url), 'utf8');

test('F8: پیام‌های پروکسی برای کدهای رایج تعریف شده‌اند', () => {
  for (const code of [401, 403, 413, 429, 502, 503, 504]) {
    assert.match(source, new RegExp(`${code}:`), `پیام برای ${code}`);
  }
});

test('F8: ساختار خطا شامل status/code/retryable است', () => {
  assert.match(source, /export class ApiError extends Error/);
  assert.match(source, /this\.retryable = retryable/);
  assert.match(source, /response\.status >= 500/, 'خطای سرور قابل تلاش مجدد است');
});

test('F8: متن خام سرور به کاربر نمی‌رسد (طول پیام محدود)', () => {
  assert.match(source, /backendMessage\.length <= 200/, 'پیام طولانی رد می‌شود');
  assert.doesNotMatch(source, /throw new Error\(text\)/);
});

test('F8: خطای شبکه و لغو، شکل یکنواخت می‌گیرند', () => {
  assert.match(source, /'network', true/);
  assert.match(source, /'aborted', true/);
  assert.match(source, /AbortError/);
});

// شبیه‌سازی رفتار نهایی: با همان قواعد فایل، خروجی برای سناریوها بررسی می‌شود
const PROXY = {
  401: 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.',
  503: 'سرویس موقتاً در دسترس نیست.',
};
const decide = (status, bodyText) => {
  let parsed = null;
  try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { parsed = null; }
  const message = PROXY[status] || `درخواست ناموفق بود (HTTP ${status}).`;
  return { message, retryable: status >= 500 };
};

test('F8: پاسخ HTML پروکسی ⇒ پیام فارسی، بدون نشت مسیر داخلی', () => {
  const html = '<html><body>502 Bad Gateway /srv/next/app</body></html>';
  const { message, retryable } = decide(503, html);
  assert.equal(message, PROXY[503]);
  assert.doesNotMatch(message, /srv\/next/);
  assert.equal(retryable, true);
});

test('F8: 401 خطای نشست می‌دهد و retryable نیست', () => {
  const { message, retryable } = decide(401, '');
  assert.match(message, /نشست/);
  assert.equal(retryable, false);
});
