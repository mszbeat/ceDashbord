'use strict';

const { getServices } = require('../../services/container');
const { readBody, readRouteParam } = require('../../services/http/request');
const { error: adminError } = require('./config');
const { tehranToday, tehranYesterday } = require('../../services/utils/date');

/**
 * سطح دسترسی ۳ — فقط نقش `admin`:
 * پنل مدیریت، زمان‌بند کران شبانه (Asia/Tehran) و اجرای دریافت گزارش‌ها.
 *
 * همهٔ مسیرهای این کنترلر در `routes.js` با `.checkAccess(true)` محافظت می‌شوند،
 * بنابراین `_session` تزریق می‌شود و نام کاربری ادمین در لاگ اجراها ثبت می‌گردد.
 */

function getAdminService() {
  return getServices().admin;
}

function actorOf(session) {
  return session?.samadUsername || 'unknown';
}

/**
 * اجرای مستقیم یک روز (`POST /api/runs` و `POST /api/admin/runs`).
 */
async function executeDirectDayRun(body) {
  const payload = readBody(body);
  const mode = payload.mode === 'intraday' ? 'intraday' : 'nightly';
  const rebuild = payload.rebuild === true;
  if (rebuild && !payload.day) {
    throw adminError.rebuildRequiresExplicitDay;
  }
  const day = payload.day ?? (mode === 'nightly' ? tehranYesterday() : tehranToday());
  return getServices().ingestion.runDay(payload.bank ?? 'tavan_mellat', day, mode, {
    rebuild,
    filters: payload.filters,
  });
}

exports.getOverview = function (session) {
  return getAdminService().getOverview({ actor: actorOf(session) });
};

exports.getCron = function () {
  return getAdminService().getCronConfig();
};

exports.updateCron = function (body, session) {
  return getAdminService().updateCronConfig(readBody(body), { actor: actorOf(session) });
};

exports.runCronNow = function (session) {
  return getAdminService().triggerCronExecution('cron_manual', undefined, { actor: actorOf(session) });
};

exports.checkExisting = function (body) {
  return getAdminService().checkExistingData(readBody(body));
};

exports.startRun = function (body, session) {
  return getAdminService().startManualRun(readBody(body), { actor: actorOf(session) });
};

exports.listJobs = function () {
  return getAdminService().listJobs(20);
};

exports.getJob = function (request, inputData) {
  const jobId = readRouteParam(request, inputData, 'id', /\/api\/admin\/jobs\/([^/?#]+)/);
  if (!jobId) throw adminError.jobNotFound(jobId);
  return getAdminService().getJob(jobId);
};

exports.runAdminDay = function (body) {
  return executeDirectDayRun(body);
};

exports.run = function (body) {
  return executeDirectDayRun(body);
};
