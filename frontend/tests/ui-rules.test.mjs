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
