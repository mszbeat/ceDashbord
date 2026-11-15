'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeJson } = require('./common');

/**
 * دادهٔ کامل هر گزارش در فایل همراهی داخل همان پوشهٔ ورودی قرار می‌گیرد.
 * فایل HTML عمومی فقط مسیر نسبی و شناسهٔ نسخهٔ همین فایل را نگه می‌دارد.
 * این جداسازی برای توزیع آفلاین است؛ احراز هویت یا رمزنگاری نیست.
 */
function savePrivateDetails(root, output, details) {
  // فقط پوشهٔ «reports» کنار HTML برای بارگذاری جزئیات مجاز است.
  const folder = 'reports';
  const isAdjacent = path.basename(root) === folder && path.dirname(root) === path.dirname(output);
  if (!isAdjacent || !Object.keys(details).length) return null;
  const token = crypto.randomBytes(16).toString('hex');
  const directory = path.join(root, '_ce-dashboard-private');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = `details-${token}.js`;
  const destination = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.tmp`);
  const script = `window.__CE_DASHBOARD_PRIVATE__=${safeJson({ token, details })};\n`;
  try {
    fs.writeFileSync(temporary, script, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* فایل موقت ممکن است ایجاد نشده باشد. */ }
    throw error;
  }
  return { token, url: `./reports/_ce-dashboard-private/${filename}`, folder, destination };
}
module.exports = { savePrivateDetails };
