import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('فقط نقش برتر نمایش داده می‌شود: admin > CE > بازدیدکننده', async () => {
  const source = read('lib/auth-client.ts');
  assert.match(source, /export function pickPrimaryRole/);
  assert.match(source, /admin: 3/);
  assert.match(source, /creditEvaluation: 2/);
  assert.match(source, /creditEvaluation: 'CE'/);
  assert.match(source, /return formatRoleShortFa\(pickPrimaryRole\(roles\)\)/);
});

test('کلاینت گزارش هم فقط برترین نقش را نشان می‌دهد', () => {
  const report = read('../backend/services/legacy-report/assets/client.js');
  assert.match(report, /function primaryRoleLabel\(roles\)/);
  assert.match(report, /badge\.textContent = primaryRoleLabel\(roles\)/);
  assert.doesNotMatch(report, /roles\.map\(\(r\) => ROLE_FA\[r\] \|\| r\)\.join/);
});

test('هاور دکمهٔ اصلی ورود روشن/سفید نمی‌شود', () => {
  const css = read('app/login/login.css');
  assert.match(css, /\.lgn-btn\.lgn-btn-primary:hover:not\(:disabled\)[\s\S]{0,220}color: #ffffff/);
  assert.match(css, /--glass-accent-hover/);
});

test('blوک‌های adm-bank-foot و adm-bank-metrics پس‌زمینه را ارث می‌برند', () => {
  const css = read('app/admin/admin.css');
  assert.match(css, /\.adm-bank-metrics,\n\.adm-bank-foot \{\n  background: inherit;/);
});

test('دکمهٔ اصلی پنل ادمین در حالت عادی هم آبی می‌ماند (قواعد پایانی بر بلوک شیشه‌ای اولویت دارند)', () => {
  const css = read('app/admin/admin.css');

  // بلوک شیشه‌ای و قاعدهٔ روشن‌کردن دکمه‌ها در حالت لایت
  const glassBtn = css.indexOf('-webkit-backdrop-filter: blur(16px) saturate(150%);');
  const lightBtn = css.indexOf(':root[data-theme="light"] .adm-btn,');
  // قاعدهٔ نهاییِ دکمهٔ اصلی
  const finalPrimary = css.indexOf('.adm-btn.adm-btn-primary,\n.adm-btn.adm-btn-primary:link,');

  assert.ok(glassBtn > 0 && lightBtn > 0 && finalPrimary > 0, 'همهٔ بلوک‌های مربوط باید موجود باشند');
  assert.ok(
    finalPrimary > glassBtn && finalPrimary > lightBtn,
    'قاعدهٔ دکمهٔ اصلی باید بعد از بلوک شیشه‌ای/لایت بیاید تا پس‌زمینهٔ آبی در حالت عادی بازنویسی نشود',
  );

  const tail = css.slice(finalPrimary);
  assert.match(tail, /:root\[data-theme="light"\] \.adm-btn\.adm-btn-primary/);
  assert.match(tail, /background-image: linear-gradient\(135deg, #003ea4 0%, #0b5ed7 58%, #0ea5e9 100%\)/);
  // هاور و حالت غیرفعال هم پوشش داده شده‌اند
  assert.match(tail, /\.adm-btn\.adm-btn-primary:hover:not\(:disabled\)/);
  assert.match(tail, /\.adm-btn\.adm-btn-primary:disabled/);
});

test('نام CreditEvaluation در داشبورد و جزئیات گزارش یکپارچه است و هدر جزئیات تمام‌عرض می‌ماند', () => {
  const login = read('app/login/page.tsx');
  const report = read('../backend/services/legacy-report/render.js');
  const viewer = read('../backend/services/legacy-report/assets/viewer.js');
  const viewerCss = read('../backend/services/legacy-report/assets/viewer.css');
  assert.match(login, /CreditEvaluation/);
  assert.match(report, /CreditEvaluation/);
  assert.match(viewer, /CreditEvaluation/);
  assert.match(viewerCss, /\.viewer > :not\(\.detail-topbar\)/);
  assert.match(viewerCss, /\.detail-topbar\s*\{[^}]*width:\s*100%/s);
  assert.match(viewerCss, /font-family:\s*Inter,\s*"Segoe UI",\s*system-ui/);
});
