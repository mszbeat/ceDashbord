'use strict';

const { getServices } = require('../../services/container');
const { reportCache } = require('../../services/report/report-cache');
const { sendHtml, sendJson } = require('../../services/http/result');
const { readQuery } = require('../../services/http/request');
const { normalizeDay } = require('../../services/utils/date');
const { requireAuthenticatedSession, requireAdminSession } = require('../../services/http/session-guard');
const { getActionLogger } = require('../../services/logger/action-logger.service');
const { error: summaryError } = require('./config');
const { ConcurrencyGate } = require('../../services/http/concurrency-gate');

/** گیت هم‌زمانی مشترک برای مسیرهای سنگین (۴۲۹ بالاتر از سقف) */
const heavyReads = new ConcurrencyGate();

/**
 * سطح دسترسی ۱ — کاربر دارای سشن احرازشده:
 * صفحهٔ اول داشبورد، تحلیل‌های کلی، متادیتای بانک‌ها و گزارش HTML زنده.
 */

function getSummaryService() {
  return getServices().summary;
}

exports.health = async function () {
  // `/api/health` سازگار با نسخهٔ قبل می‌مانَد؛ اطلاعات سلامت/آمادگی تفکیک‌شده‌اند
  const { healthz } = require('../../services/health');
  const live = await healthz();
  return {
    ok: true,
    service: 'ce-dashboard-backend',
    framework: 'partFramework',
    time: new Date().toISOString(),
    uptimeSeconds: live.uptimeSeconds,
    version: live.version,
  };
};

/** GET /api/healthz — liveness بدون احراز هویت و بدون وابستگی */
exports.healthz = async function () {
  const { healthz } = require('../../services/health');
  return healthz();
};

/** GET /api/readyz — readiness با اتصال دیتابیس، جداول و روزهای ناقص (۵۰۳ در حالت ناسالم) */
exports.readyz = async function (response) {
  const { readyz } = require('../../services/health');
  const { config } = require('../../services/config');
  const result = await readyz(getServices().db, { schema: config.dbSchema });
  return sendJson(result, result.ok ? 200 : 503, response);
};

exports.banks = async function (session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  return getSummaryService().banks();
};

exports.specs = async function (queryString, session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  const query = readQuery(queryString);
  return getSummaryService().specs(query.bank || 'tavan_mellat');
};

/** صفحهٔ «گزارش در حال آماده‌سازی» برای پاسخ ۲۰۲ */
function buildInProgressHtml(bank, from, to) {
  const retryAfter = Number(process.env.CE_REPORT_RETRY_AFTER_SECONDS || 5);
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>گزارش در حال آماده‌سازی</title><style>
  body{margin:0;background:#eef4fb;color:#0c1e3e;font:14px/1.9 'Vazirmatn',Tahoma,"Segoe UI",sans-serif;padding:40px}
  main{max-width:640px;margin:auto;background:#fff;border:1px solid #d4e2f4;border-radius:16px;padding:28px 32px;box-shadow:0 14px 36px rgba(0,28,88,.08)}
  h1{color:#002878;font-size:20px;margin:0 0 12px}p{color:#4e6788}
  .spinner{display:inline-block;width:32px;height:32px;border:4px solid #e3e3e3;border-top-color:#002878;border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}} a{color:#0b5ed7;font-weight:700}
  form{margin-top:16px}
  button{border:1px solid #002878;border-radius:8px;background:#002878;color:#fff;padding:6px 12px;font:inherit;font-weight:700;cursor:pointer}
</style></head><body><main><div class="spinner" style="margin-bottom:12px"></div><h1>گزارش در حال آماده‌سازی است</h1><p>ساخت گزارش برای <bdi>${bank}</bdi> از <bdi>${from || '—'}</bdi> تا <bdi>${to || '—'}</bdi> در حال اجرا است. لطفاً کمی صبر کنید.</p><p>صفحه به‌صورت خودکار بعد از <span id="sec">${retryAfter}</span> ثانیه دوباره تلاش می‌کند.</p><form><button type="submit">تلاش دوباره</button></form><script>
  (function(){
    var sec = ${retryAfter};
    var el = document.getElementById('sec');
    var timer = setInterval(function(){
      sec--;
      if(el) el.textContent = sec;
      if(sec <= 0){ clearInterval(timer); window.location.reload(); }
    }, 1000);
  })();
</script></body></html>`;
}

exports.report = async function (queryString, response, session) {
  const actor = await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  const query = readQuery(queryString);
  const bank = query.bank || 'tavan_mellat';
  const rowsCap = query.rowsCap ? Number(query.rowsCap) : 100;
  try {
    /**
     * اندازه‌گیری زمان ساخت گزارش.
     * بدون این عدد، «گزارش لود نشد» فقط یک علامت است؛ با آن مشخص می‌شود کندی از
     * تولید گزارش است یا از شبکه/پروکسی (مقایسه با `durationMs` در لاگ فرانت).
     *
     * خروجی HTML به نقش کاربر وابسته نیست، پس پشت کش تکی‌پرواز می‌رود:
     * پیمایش کامل ۳۰ روزه‌ی ردیف‌ها فقط یک‌بار انجام می‌شود و کاربران بعدی
     * (تا انقضای کش) همان لحظه پاسخ می‌گیرند — رفع تام‌اوت داشبورد در تولید.
     */
    const startedAt = Date.now();
    const summaryService = getSummaryService();
    const from = query.from ? normalizeDay(query.from) : undefined;
    const to = query.to ? normalizeDay(query.to) : undefined;
    // P6: سقف بازه برای گزارش — جلوگیری از اسکن کل تاریخچه و اشباع استخر
    if (summaryService.maxRangeDays && summaryService.rangeLengthDays(from, to) > summaryService.maxRangeDays) {
      const err = new Error(`بازهٔ درخواستی ${summaryService.rangeLengthDays(from, to)} روز است؛ سقف ${summaryService.maxRangeDays} روز`);
      err.statusCode = 413;
      err.code = 'rangeTooLarge';
      err.data = { code: 'rangeTooLarge', message: { fa: err.message, en: 'range too large' } };
      throw err;
    }
    const cacheKey = require('../../services/report/report-cache').ReportCache.keyOf(bank, from, to, rowsCap);
    const frontendTimeoutMs = Number(process.env.CE_REPORT_HEADERS_TIMEOUT_MS || 30000);

    /**
     * سیگنال ابort فقط برای قطع انتظار فرانت استفاده می‌شود، نه برای لغو ساخت.
     * ساخت از طریق reportCache مستقل از اتصال کلاینت تا پایان می‌رود و در کش ثبت می‌گردد.
     */
    const controller = new AbortController();
    const { signal } = controller;
    if (typeof response.on === 'function') {
      response.on('close', () => controller.abort());
    }

    // دواندمایی بین ساخت گزارش و مهلت پاسخ فرانت
    const buildPromise = reportCache.getOrBuild(cacheKey, () =>
      heavyReads.run(() => summaryService.report(bank, from, to, rowsCap), { route: 'report', bank }),
      { signal },
    );

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('FRONTEND_TIMEOUT')), frontendTimeoutMs);
    });

    let result;
    try {
      result = await Promise.race([buildPromise, timeoutPromise]);
    } catch (err) {
      if (err.message === 'FRONTEND_TIMEOUT') {
        // ساخت در پس‌زمینه ادامه می‌یابد؛ ۲۰۲ + Retry-After برای فرانت
        response.statusCode = 202;
        response.setHeader('Retry-After', String(process.env.CE_REPORT_RETRY_AFTER_SECONDS || 5));
        return sendHtml(buildInProgressHtml(bank, from, to), 202, response);
      }
      throw err;
    }

    // اگر کلاینت قطع شده است (detached)، چیزی ارسال نمی‌کنیم
    if (result.detached || !result.html) {
      try {
        getActionLogger().warn({
          category: 'summary',
          action: 'summary.report.client_detached',
          actor: actor.username,
          roles: actor.roles,
          statusCode: 0,
          errorCode: 'REPORT_CLIENT_DETACHED',
          meta: { bank, from: query.from || null, to: query.to || null },
        });
      } catch { /* لاگر در دسترس نیست */ }
      return;
    }

    const { html, fromCache } = result;
    const durationMs = Date.now() - startedAt;
    getActionLogger().info({
      category: 'summary',
      action: 'summary.report.rendered',
      actor: actor.username,
      roles: actor.roles,
      statusCode: 200,
      meta: { bank, from: query.from || null, to: query.to || null, rowsCap, durationMs, bytes: html?.length ?? null, cache: fromCache },
    });
    return sendHtml(html, 200, response);
  } catch (err) {
    // اگر کلاینت قطع شده است، پاسخ ۵۰۳ ارسال نمی‌کنیم (کلاینت دیگر منتظر نیست)
    if (err?.name === 'AbortError' || err?.code === 'ABORTED' || err?.message === 'CLIENT_ABORTED') {
      try {
        getActionLogger().warn({
          category: 'summary',
          action: 'summary.report.aborted',
          actor: actor.username,
          roles: actor.roles,
          statusCode: 0,
          errorCode: 'REPORT_CLIENT_ABORTED',
          meta: { bank, from: query.from || null, to: query.to || null },
        });
      } catch { /* لاگر در دسترس نیست */ }
      return;
    }
    getActionLogger().error({
      category: 'summary',
      action: 'summary.report.failed',
      actor: actor.username,
      roles: actor.roles,
      statusCode: 503,
      errorCode: err?.meta?.code || err?.code || 'REPORT_RENDER_FAILED',
      message: err?.data?.message?.fa || err?.message || 'Report build failed',
      meta: { bank, from: query.from || null, to: query.to || null },
      stack: err?.stack,
    });
    return sendHtml(getSummaryService().errorHtml(err), 503, response);
  }
};

exports.diagnostics = async function (session) {
  // D1: تشخیص‌ها اطلاعات عملیاتی/ساختاری‌اند و فقط برای ادمین‌اند (نه هر کاربر وارد‌شده)
  await requireAdminSession(session, () => summaryError.sessionRequired);
  return getSummaryService().diagnostics();
};

exports.summary = async function (queryString, session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  const query = readQuery(queryString);
  const bank = query.bank || 'tavan_mellat';
  return heavyReads.run(
    () => getSummaryService().summary(bank, query.from || undefined, query.to || undefined),
    { route: 'summary', bank },
  );
};

exports.list = async function (queryString, session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  const query = readQuery(queryString);
  // فهرست ارزان است (۱۰۰ ردیف) ولی برای محافظت از استخر، همان گیت با سقف بالاتر لازم است
  return heavyReads.run(() => getSummaryService().list({
    bank: query.bank || 'tavan_mellat',
    from: query.from || undefined,
    to: query.to || undefined,
    indicator: query.indicator || undefined,
    type: query.type || undefined,
    id: query.id || undefined,
    value: query.value || undefined,
    status: query.status || undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
    cursor: query.cursor ? String(query.cursor) : undefined,
  }), { route: 'list', bank: query.bank || 'tavan_mellat' });
};

exports.runs = async function (session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  return getSummaryService().runs();
};
