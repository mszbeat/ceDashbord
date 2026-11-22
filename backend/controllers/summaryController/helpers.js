'use strict';

const { getServices } = require('../../services/container');
const { sendHtml, sendJson } = require('../../services/http/result');
const { readQuery } = require('../../services/http/request');
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

exports.report = async function (queryString, response, session) {
  const actor = await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  const query = readQuery(queryString);
  const bank = query.bank || 'tavan_mellat';
  const rowsCap = query.rowsCap ? Number(query.rowsCap) : 100;
  try {
    const html = await getSummaryService().report(bank, query.from || undefined, query.to || undefined, rowsCap);
    getActionLogger().info({
      category: 'summary',
      action: 'summary.report.rendered',
      actor: actor.username,
      roles: actor.roles,
      statusCode: 200,
      meta: { bank, from: query.from || null, to: query.to || null, rowsCap },
    });
    return sendHtml(html, 200, response);
  } catch (err) {
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
