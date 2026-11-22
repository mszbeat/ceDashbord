// F1/F2/F3 — قواعد مسیر پروکسی گزارش: بدون بافر کامل، بدون probe دوباره، بدون متن خام خطا.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../app/route.ts', import.meta.url), 'utf8');
const middleware = fs.readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8');

test('F1: بدنهٔ HTML گزارش به‌صورت جریان پاس داده می‌شود (بدون await text برای HTML)', () => {
  assert.match(route, /return new Response\(response\.body/, 'جریان بدنه');
  assert.match(route, /CE_REPORT_INLINE_MAX_BYTES/, 'آستانهٔ بافر قابل تنظیم');
  // بافر کردن HTML ممنوع است: `await response.text()` فقط در شاخهٔ JSON مجاز است
  // کامنت‌ها را حذف می‌کنیم تا فقط کدِ واقعی سنجیده شود
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const jsonIndex = code.indexOf('const looksJson');
  const textIndex = code.indexOf('await response.text()');
  assert.ok(textIndex > jsonIndex, 'خواندن متن فقط بعد از تشخیص JSON');
  assert.match(route, /if \(!looksJson\) \{[\s\S]*?return new Response\(response\.body/);
});

test('F2: middleware برای مسیر گزارش اجرا نمی‌شود (probe اضافه ندارد)', () => {
  // واقعیتِ کد: matcher وابسته به api/ را حذف می‌کند، پس /api/report هرگز به middleware نمی‌رسد.
  // (این تست جای تغییر بی‌اثر را می‌بندد: ما F2 را در سمت کلاینت/صفحه حل کردیم.)
  assert.match(middleware, /matcher: \[/);
  assert.match(middleware, /\(\?!api\//, 'وسیلهٔ تطبیق، api/ را بیرون می‌گذارد');
});

test('F3: متن خام خطا در پاسخ به کاربر نیست و شناسهٔ پیگیری می‌دهد', () => {
  assert.doesNotMatch(route, /errorPage\('ارتباط با سرور برقرار نشد', message\)/);
  assert.match(route, /console\.error\('\[report\] upstream failure'/);
  assert.match(route, /شناسهٔ پیگیری/);
  assert.match(route, /'x-request-id'/);
});
