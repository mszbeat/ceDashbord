#!/usr/bin/env node
'use strict';

/**
 * D4 — اسکن سادهٔ راز در مخزن (بدون وابستگی).
 *
 * دنبال الگوهایی می‌گردد که در این پروژه واقعاً خطرناک‌اند: کلید/توکن هاردکدشده،
 * `postgres://user:pass@`، کد ملی ده‌رقمی در فایل‌های نمونه (PII) و کلید خصوصی.
 * خروجی: کد ۱ اگر چیزی پیدا شود.
 *
 *   node scripts/secret-scan.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', 'logs', 'pgdata']);
const SKIP_FILES = new Set(['package-lock.json', 'secret-scan.js']);
const TEXT_EXT = new Set(['.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.sql', '.sh', '.yml', '.yaml', '.env', '.example', '.txt', '']);

const RULES = [
  {
    id: 'private-key',
    re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    message: 'کلید خصوصی در مخزن',
  },
  {
    // رمز داخل URL فقط وقتی مشکوک است که میزبان محلی/نمونه نباشد
    id: 'db-password-url',
    re: /postgres(?:ql)?:\/\/[^\s:'"]+:(?!\$\{|@|\*)[^\s:@'"]{6,}@(?!(?:localhost|127\.0\.0\.1|db|postgres)[:/])/i,
    message: 'رمز داخل URL دیتابیس (میزبان واقعی)',
    // مستندات و فایل نمونه، «جا‌نگهدار» دارند نه راز — با وجود این، فقط گزارش می‌شوند
    allowIn: [/\.example$/, /README\.md$/, /\.github\//],
  },
  {
    id: 'hardcoded-token',
    re: /\b(?:api[_-]?token|secret|password)\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]/i,
    message: 'توکن/رمز هاردکدشده',
  },
  {
    // کد ملی ده‌رقمی داخل فایل‌های JSON نمونه = دادهٔ شخصی
    id: 'national-id',
    re: /"(?:nationalCode|national_code|nationalId)"\s*:\s*"\d{10}"/,
    message: 'کد ملی در فایل نمونه (PII)',
  },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (!SKIP_FILES.has(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const findings = [];
for (const file of walk(ROOT)) {
  if (!TEXT_EXT.has(path.extname(file))) continue;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.length > 2 * 1024 * 1024) continue;
  for (const rule of RULES) {
    const match = rule.re.exec(text);
    const allowed = (rule.allowIn || []).some((re) => re.test(file));
    if (match && !allowed) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ file: path.relative(ROOT, file), line, rule: rule.id, message: rule.message });
    }
  }
}

if (findings.length) {
  console.error(`❌ ${findings.length} یافتهٔ حساس:`);
  for (const item of findings) console.error(`  ${item.file}:${item.line} — ${item.message}`);
  process.exit(1);
}
console.log('✅ اسکن راز: چیزی پیدا نشد');
