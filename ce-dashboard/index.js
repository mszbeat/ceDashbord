#!/usr/bin/env node
'use strict';
/**
 * اجرا: node index.js ./reports ./report.html [MAX_ROWS=100]
 * فقط بانک دارای بیشترین گزارش معتبر تحلیل می‌شود؛ متدهای دیگر در هشدار گزارش می‌آیند.
 */
const fs = require('node:fs');
const path = require('node:path');
const { RANKING_NULL_THRESHOLD } = require('./src/config');
const { loadBanks } = require('./src/banks');
const { scan } = require('./src/scan');
const { analyze } = require('./src/analyze');
const { buildHtml } = require('./src/render');
const { savePrivateDetails } = require('./src/private');

function integerArg(value, fallback, label, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${label} باید عدد صحیحی بین ۱ و ${max} باشد (مقدار دریافتی: ${value}).`);
  }
  return number;
}
function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('متد اجرا: node index.js [پوشهٔ گزارش‌ها] [فایل خروجی.html] [MAX_ROWS=100]');
    return;
  }
  if (args.length > 3) throw new Error('پارامتر MIN_NULL از فرمان حذف شده است. متد جدید: node ce-dashboard ./reports ./report.html [MAX_ROWS=100]');
  console.log(`نسخهٔ ابزار: ${require('./package.json').version} | فایل اجرایی: ${__filename}`);
  const root = path.resolve(args[0] || './reports'), output = path.resolve(args[1] || './report.html');
  const options = { minNull: RANKING_NULL_THRESHOLD, rowsCap: integerArg(args[2], 100, 'MAX_ROWS', 10000) };
  const banks = loadBanks(options);
  const scanned = scan(root, banks);
  const data = analyze(scanned, options);
  const privateAsset = savePrivateDetails(root, output, data.details);
  const asset = (filename) => fs.readFileSync(path.join(__dirname, 'assets', filename), 'utf8');
  const html = buildHtml(scanned, data, { ...options, privateAsset }, { css: asset('style.css'), client: asset('client.js'),
    viewerJs: asset('viewer.js'), viewerCss: asset('viewer.css') });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html, 'utf8');
  console.log(`روزهای ورودی: ${scanned.days.length} | فایل‌های خوانده‌شده: ${scanned.files.length} | گزارش‌های ورودی: ${scanned.totalSamples} | خطای فایل: ${scanned.errors.length + data.runtimeErrors.length}`);
  if (scanned.bank) console.log(`بانک انتخاب‌شده: ${scanned.bank.label} (${scanned.bank.id}) | گزارش‌های تحلیل‌شده: ${data.processedSamples}${scanned.bank.auto ? ' | گزارش عمومی' : ''}`);
  if (scanned.ignoredRows.length) console.log(`متدهای کنارگذاشته‌شده: ${JSON.stringify(scanned.ignoredRows)}`);
  console.log(privateAsset
    ? `جزئیات ${Object.keys(data.details).length} گزارش فقط در ${privateAsset.destination} ذخیره شد.`
    : 'جزئیات کامل ذخیره نشد: پوشهٔ ورودی باید reports باشد و HTML دقیقاً کنار همان پوشه تولید شود.');
  console.log(`حجم HTML عمومی: ${(Buffer.byteLength(html) / 1048576).toFixed(2)} MB | فایل گزارش: ${output}`);
  return { scanned, data, output, privateAsset };
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`خطا: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main, integerArg };
