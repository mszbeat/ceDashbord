// F9 — بدون تزریق HTML، متن امن، کلیدهای تم متمرکز، اعلان‌های دسترس‌پذیر.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { safeText, looksLikeHtml, toastA11y, pagerA11y } from '../lib/a11y.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git', 'tests'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
};

test('F9: هیچ تزریق HTML در کد کلاینت نیست', () => {
  const files = walk(ROOT);
  assert.ok(files.length > 5, 'فایل‌های سورس پیدا شدند');
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /dangerouslySetInnerHTML/, `تزریق HTML در ${file}`);
    assert.doesNotMatch(src, /\.innerHTML\s*=/, `انتساب innerHTML در ${file}`);
    assert.doesNotMatch(src, /\beval\s*\(/, `eval در ${file}`);
  }
});

test('F9: safeText نویسه‌های کنترلی و جهت‌دهنده را حذف می‌کند', () => {
  assert.equal(safeText('سلام\u202Eدنیا'), 'سلامدنیا');
  assert.equal(safeText('a\u0000b'), 'ab');
  assert.equal(safeText(null), '');
  assert.equal(safeText('<b>x</b>'), '<b>x</b>', 'متن حفظ می‌شود؛ React خودش escape می‌کند');
  assert.equal(safeText('x'.repeat(5000)).length, 2000);
});

test('F9: looksLikeHtml برای ورودی متنی هشدار می‌دهد', () => {
  assert.equal(looksLikeHtml('<script>alert(1)</script>'), true);
  assert.equal(looksLikeHtml('گزارش ۱۴۰۵'), false);
  assert.equal(looksLikeHtml('a < b'), false);
});

test('F9: اعلان‌ها ARIA درست دارند', () => {
  assert.deepEqual(toastA11y('error'), { role: 'alert', 'aria-live': 'assertive', 'aria-atomic': true });
  assert.deepEqual(toastA11y('success'), { role: 'status', 'aria-live': 'polite', 'aria-atomic': true });
  assert.equal(pagerA11y(2, 9).role, 'navigation');
  assert.match(pagerA11y(2, 9)['aria-label'], /۲ از ۹/);
});

test('F9: کلیدهای تم متمرکز شده‌اند و نوشتن در هر دو کلید انجام می‌شود', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'auth-client.ts'), 'utf8');
  assert.match(src, /export const THEME_STORAGE_KEY = 'ce-theme'/);
  assert.match(src, /export const LEGACY_THEME_STORAGE_KEY = 'bank-ce-dashboard-theme'/);
  assert.match(src, /for \(const key of THEME_KEYS\) window\.localStorage\.setItem/);
  // هیچ فایلی نباید رشتهٔ کلید را مستقیم بنویسد
  for (const file of walk(ROOT)) {
    if (file.endsWith(path.join('lib', 'auth-client.ts'))) continue;
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /localStorage\.setItem\('ce-theme'/, `کلید خام در ${file}`);
  }
});

test('F9: اعلان پنل مدیریت ARIA دارد', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'admin', 'AdminClient.tsx'), 'utf8');
  assert.match(src, /\.\.\.toastA11y\(toast\.kind\)/);
  assert.match(src, /safeText\(toast\.text\)/);
  assert.match(src, /aria-label="بستن اعلان"/);
});

test('دسترسی پنل در فرانت از پاسخ مجوز API پیروی می‌کند، نه نام نقش ثابت', () => {
  const page = fs.readFileSync(path.join(ROOT, 'app', 'admin', 'page.tsx'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'app', 'admin', 'AdminClient.tsx'), 'utf8');
  const legacy = fs.readFileSync(path.join(ROOT, '..', 'backend', 'services', 'legacy-report', 'assets', 'client.js'), 'utf8');
  assert.doesNotMatch(page, /hasAdminRole|roles\.includes\(['\"]admin/);
  assert.doesNotMatch(client, /roles\?\.includes\(['\"]admin/);
  assert.doesNotMatch(legacy, /roles\.includes\(['\"]admin/);
  assert.match(page, /api\/admin\/overview/);
});

test('F10: نسخهٔ Next حداقل پچ امنیتی 15.5.29 است و سطح حمله تصویر بسته است', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies.next, /^15\.5\.\d+$/, 'نسخه پین شده است');
  assert.ok(Number(pkg.dependencies.next.split('.')[2]) >= 29, 'حداقل 15.5.29');
  assert.ok(pkg.overrides?.next?.postcss, 'پچ امنیتی postcss داخلی Next');
  const cfgRaw = fs.readFileSync(path.join(ROOT, 'next.config.js'), 'utf8');
  // کامنت‌ها حذف می‌شوند تا فقط پیکربندی واقعی سنجیده شود
  const cfg = cfgRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(cfg, /remotePatterns/, 'الگوی تصویر خارجی تعریف نشده');
  assert.doesNotMatch(cfg, /\bimages\s*:/, 'بهینه‌ساز تصویر پیکربندی نشده');
  assert.match(cfg, /poweredByHeader: false/);
  // هیچ فایلی از next/image استفاده نمی‌کند ⇒ بهینه‌ساز تصویر در دسترس نیست
  for (const file of walk(ROOT)) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /from 'next\/image'/);
  }
});
