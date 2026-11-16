'use strict';

const { getServices } = require('../../services/container');
const { readBody, readRouteParam } = require('../../services/http/request');
const { requireAuthenticatedSession } = require('../../services/http/session-guard');
const { error: adminError } = require('./config');
const { tehranToday, tehranYesterday } = require('../../services/utils/date');

/**
 * سطح دسترسی ۳ — فقط نقش `admin` (با الزام سشن معتبر):
 * پنل مدیریت، زمان‌بند کران شبانه (Asia/Tehran) و اجرای دریافت گزارش‌ها.
 *
 * همهٔ مسیرهای این کنترلر در `routes.js` با `.checkAccess(true)` محافظت می‌شوند،
 * بنابراین `_session` تزریق می‌شود و نام کاربری ادمین در لاگ اجراها ثبت می‌گردد.
 */

function getAdminService() {
  return getServices().admin;
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

exports.getOverview = async function (session) {
  const actor = await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return getAdminService().getOverview({ actor: actor.username });
};

exports.getCron = async function (session) {
  await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return getAdminService().getCronConfig();
};

exports.updateCron = async function (body, session) {
  const actor = await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return getAdminService().updateCronConfig(readBody(body), { actor: actor.username });
};

exports.runCronNow = async function (session) {
  const actor = await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return getAdminService().triggerCronExecution('cron_manual', undefined, { actor: actor.username });
};

exports.checkExisting = async function (body, session) {
  await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return getAdminService().checkExistingData(readBody(body));
};

exports.startRun = async function (body, session) {
  const actor = await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return getAdminService().startManualRun(readBody(body), { actor: actor.username });
};

exports.listJobs = async function (session) {
  await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return getAdminService().listJobs(20);
};

exports.getJob = async function (request, inputData, session) {
  await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  const jobId = readRouteParam(request, inputData, 'id', /\/api\/admin\/jobs\/([^/?#]+)/);
  if (!jobId) throw adminError.jobNotFound(jobId);
  return getAdminService().getJob(jobId);
};

exports.runAdminDay = async function (body, session) {
  await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return executeDirectDayRun(body);
};

exports.run = async function (body, session) {
  await requireAuthenticatedSession(session, () => adminError.sessionRequired);
  return executeDirectDayRun(body);
};
