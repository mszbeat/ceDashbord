'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { table } = require(path.join(ROOT, 'services', 'legacy-report', 'render'));

test('legacy report message tables clamp long cells while retaining full text in tooltips', () => {
  const details = 'شرح فنی طولانی '.repeat(18);
  const errorKey = 'rotbebandiStandardError';
  const html = table([{
    'دسته / مقدار': 'خطای سرویس رتبه‌بندی',
    'تعداد گزارش': 1,
    'درصد': '100٪',
    'پیام سرویس': `خطای سرویس\nservice failed: ${details}`,
    'جزئیات فنی': details,
    'کلید خطا': errorKey,
  }], {
    multiline: ['دسته / مقدار', 'پیام سرویس'],
    code: ['کلید خطا'],
    className: 'message-table',
  });

  assert.match(html, /class="cell-preview" title="شرح فنی طولانی/);
  assert.match(html, /class="message-stack" title="خطای سرویس/);
  assert.match(html, new RegExp(`title="${errorKey}"`));

  const css = fs.readFileSync(path.join(ROOT, 'services', 'legacy-report', 'assets', 'style.css'), 'utf8');
  assert.match(css, /table\.message-table\s*\{[^}]*min-width:\s*1320px/s);
  assert.match(css, /\.message-table \.cell-preview,[\s\S]*?-webkit-line-clamp:\s*2/);
  assert.match(css, /\.message-table \.cell-code code\s*\{[^}]*text-overflow:\s*ellipsis/s);
});
