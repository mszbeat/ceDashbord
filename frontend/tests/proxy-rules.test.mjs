// F1/F2/F3 — قواعد مسیر پروکسی گزارش: بدون بافر کامل، بدون probe دوباره، بدون متن خام خطا.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../app/route.ts', import.meta.url), 'utf8');
const middleware = fs.readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8');

test('F1: بدنهٔ HTML گزارش به‌صورت جریان پاس داده می‌شود (بدون await text برای HTML)', () => {
  assert.match(route, /CE_REPORT_INLINE_MAX_BYTES/, 'آستانهٔ بافر قابل تنظیم');

  // کامنت‌ها را حذف می‌کنیم تا فقط کدِ واقعی سنجیده شود
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // به‌جای اعتماد به هدر، چند بایت اول بدنه فقط برای «تشخیص پوشش JSON» خوانده می‌شود
  const peekIndex = code.indexOf('await peekStream(');
  assert.ok(peekIndex > -1, 'تشخیص بر اساس محتوا انجام می‌شود');

  // بافر کردن HTML ممنوع است: خواندن کامل بدنه فقط بعد از تشخیص پوشش و در همان شاخه
  const envelopeIndex = code.indexOf('const envelope');
  const textIndex = code.indexOf('await readText(');
  assert.ok(envelopeIndex > peekIndex, 'تشخیص پوشش بعد از peek');
  assert.ok(textIndex > envelopeIndex, 'خواندن متن فقط در شاخهٔ پوشش JSON');
  // بدنهٔ peek‌شده دیگر با response.text() قابل خواندن نیست؛ نباید برگردد
  assert.doesNotMatch(code, /await response\.text\(\)/, 'response.text بعد از peek ممنوع');

  // مسیر HTML سالم: استریم، نه رشتهٔ بافر‌شده
  assert.match(code, /if \(!envelope\) \{[\s\S]*?return new Response\(passthrough/, 'استریم بدنه');
  assert.match(code, /const passthrough = stream \?\? response\.body/, 'استریم بازسازی‌شده');
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
