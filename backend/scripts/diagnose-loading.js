#!/usr/bin/env node
'use strict';

/**
 * عیب‌یابی «صفحه لود نمی‌شود» — یک اجرا، جواب مشخص.
 *
 * این اسکریپت به ترتیب لایه‌ها را می‌سنجد تا معلوم شود گلوگاه دقیقاً کجاست:
 *   ۱) آیا بک‌اند زنده است؟            → /api/healthz
 *   ۲) آیا دیتابیس و جداول آماده‌اند؟   → /api/readyz
 *   ۳) آیا پرس‌وجوی نشست پاسخ می‌دهد؟   → /api/auth/me
 *   ۴) آیا گزارش ساخته می‌شود و چقدر طول می‌کشد؟ → /api/report
 *
 * هر مرحله با مهلت اجرا می‌شود؛ اگر مرحله‌ای معلق بمانَد، همان‌جا با «TIMEOUT»
 * گزارش می‌شود و مراحل بعدی آزمایش نمی‌شوند (چون علت همان است).
 *
 * استفاده:
 *   node scripts/diagnose-loading.js
 *   BACKEND_URL=http://127.0.0.1:3000 COOKIE="token=..." node scripts/diagnose-loading.js
 *
 * کوکی را از مرورگر بگیرید: DevTools → Application → Cookies → `token`.
 * (اگر کوکی ندهید، مرحلهٔ ۳ و ۴ با پیام «نیاز به کوکی» رد می‌شوند.)
 */

const http = require('node:http');
const https = require('node:https');

const BACKEND_URL = (process.env.BACKEND_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const COOKIE = process.env.COOKIE || '';
const TIMEOUT_MS = Number(process.env.DIAG_TIMEOUT_MS || 35000);

/** درخواست با مهلت واقعی (بدون کتابخانه) و اندازه‌گیری TTFB/کل */
function request(path, { method = 'GET', cookie = COOKIE, body = null } = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, BACKEND_URL);
    const client = url.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const headers = { 'user-agent': 'ce-diagnose/1' };
    if (cookie) headers.cookie = cookie;
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({
        ok: false,
        timeout: true,
        status: 0,
        bytes: 0,
        ttfbMs: null,
        totalMs: Date.now() - startedAt,
        note: `هیچ پاسخی در ${TIMEOUT_MS}ms نیامد`,
      });
    }, TIMEOUT_MS);

    const req = client.request(url, { method, headers }, (res) => {
      const ttfbMs = Date.now() - startedAt;
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          timeout: false,
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          bytes,
          ttfbMs,
          totalMs: Date.now() - startedAt,
          note: '',
        });
      });
    });

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        timeout: false,
        status: 0,
        bytes: 0,
        ttfbMs: null,
        totalMs: Date.now() - startedAt,
        note: `${error.code || error.message} — احتمالاً بک‌اند بالا نیست یا پورت/آدرس اشتباه است`,
      });
    });

    if (body) req.write(body);
    req.end();
  });
}

function line(label, result) {
  const status = result.timeout ? 'TIMEOUT' : result.status || 'ERR';
  const timing = result.ttfbMs === null
    ? `کل ${result.totalMs}ms`
    : `TTFB ${result.ttfbMs}ms · کل ${result.totalMs}ms`;
  const size = result.bytes ? `${result.bytes} بایت` : '—';
  const flag = result.ok ? '✅' : '❌';
  console.log(`${flag} ${label.padEnd(38)} ${String(status).padEnd(8)} ${timing.padEnd(30)} ${size}`);
  if (result.note) console.log(`   ↳ ${result.note}`);
}

(async () => {
  console.log(`\n🔍 عیب‌یابی بارگذاری — بک‌اند: ${BACKEND_URL}  (مهلت هر مرحله: ${TIMEOUT_MS}ms)\n`);

  const healthz = await request('/api/healthz');
  line('۱) بک‌اند زنده است؟ (/api/healthz)', healthz);
  if (!healthz.ok) {
    console.log('\n⛔ بک‌اند پاسخ نمی‌دهد. اینجا متوقف شد.');
    console.log('   • سرویس بک‌اند را ری‌استارت کنید و لاگ استارتاپ را ببینید.');
    console.log('   • اگر لاگ «V2_SCHEMA_NOT_READY» دارد: یک‌بار `npm run migrate:v2` را اجرا کنید.');
    console.log('   • اگر لاگ «MIGRATION_LOCK_TIMEOUT» دارد: نمونهٔ دیگری در حال مهاجرت است یا اجرای قبلی نیمه‌کاره مانده.');
    process.exit(1);
  }

  const readyz = await request('/api/readyz');
  line('۲) دیتابیس/جداول آماده‌اند؟ (/api/readyz)', readyz);
  if (readyz.status === 503) {
    console.log('   ↳ آماده نیست: خروجی کامل /api/readyz را ببینید (database/tables/incompleteDays).');
  }

  if (!COOKIE) {
    console.log('\nℹ️ برای مراحل ۳ و ۴ کوکی لازم است:');
    console.log('   COOKIE="token=<مقدار کوکی از DevTools>" node scripts/diagnose-loading.js');
    return;
  }

  const me = await request('/api/auth/me');
  line('۳) نشست پاسخ می‌دهد؟ (/api/auth/me)', me);

  const report = await request('/api/report?bank=tavan_mellat');
  line('۴) گزارش ساخته می‌شود؟ (/api/report)', report);

  console.log('\n📋 تفسیر:');
  if (report.timeout && me.ok) {
    console.log('   نشست سالم است ولی تولید گزارش پاسخ نمی‌دهد ⇒ گلوگاه در تولید گزارش/دیتابیس است.');
    console.log('   لاگ بک‌اند را ببینید: مقدار `durationMs` در رویداد summary.report.rendered.');
  } else if (report.timeout && !me.ok) {
    console.log('   حتی /api/auth/me هم پاسخ نمی‌دهد ⇒ بک‌اند در سطح کلی مشغول/قفل است.');
    console.log('   بررسی کنید: SELECT * FROM pg_stat_activity WHERE state <> \'idle\';');
    console.log('   اگر همهٔ اتصال‌ها busy بودند، احتمالاً یک import طولانی در جریان است.');
  } else if (report.ok && /json/.test(report.contentType || '')) {
    console.log('   پاسخ گزارش JSON است، نه HTML ⇒ نسخهٔ فرانت قدیمی است (باید HTML خام بفرستد).');
  } else if (report.ok) {
    console.log('   ✅ تولید گزارش سالم است. اگر مرورگر باز هم صفحه را نشان نمی‌دهد،');
    console.log('   مشکل در فرانت/پروکسی است: لاگ فرانت را برای [report] ببینید.');
  } else {
    console.log('   گزارش با خطا برگشت؛ کد وضعیت و لاگ بک‌اند را بررسی کنید.');
  }
})();
