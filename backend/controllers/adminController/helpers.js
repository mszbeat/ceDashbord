'use strict';

const { getServices } = require('../../services/container');
const { readBody, readRouteParam, readQuery, readQueryParam } = require('../../services/http/request');
const { requireAdminSession } = require('../../services/http/session-guard');
const { getActionLogger } = require('../../services/logger/action-logger.service');
const { error: adminError } = require('./config');
const { tehranToday, tehranYesterday } = require('../../services/utils/date');
const { reportCache } = require('../../services/report/report-cache');

/**
 * سطح دسترسی ۳ — فقط نقش `admin` (با الزام سشن معتبر):
 * پنل مدیریت، زمان‌بند کران شبانه (Asia/Tehran) و اجرای دریافت گزارش‌ها.
 *
 * همهٔ مسیرهای این کنترلر در `routes.js` با `.checkAccess(true)` محافظت می‌شوند،
 * بنابراین `_session` تزریق می‌شود و نام کاربری ادمین در لاگ اجراها ثبت می‌گردد.
 *
 * ⚠️ نکتهٔ امنیتی (اصلاح‌شده): `.checkAccess(true)` فقط «سشن معتبر بودن» را تضمین می‌کند،
 * نه نقش. پیش‌تر همهٔ هندلرهای این کنترلر از `requireAuthenticatedSession` استفاده
 * می‌کردند؛ یعنی هر کاربر **ثبت‌نام‌شدهٔ عادی** (نقش `visitor`) می‌توانست زمان‌بند کران را
 * عوض کند، دریافت گزارش را اجرا کند و تاریخچهٔ jobها را ببیند. حالا همهٔ هندلرها
 * `requireAdminSession` هستند تا مرز «کاربر» و «ادمین» با خودِ کد هم‌خوان باشد.
 */

function getAdminService() {
  return getServices().admin;
}

/**
 * اجرای مستقیم یک روز (`POST /api/runs` و `POST /api/admin/runs`).
 */
async function executeDirectDayRun(body, actor) {
  const payload = readBody(body);
  const mode = payload.mode === 'intraday' ? 'intraday' : 'nightly';
  const rebuild = payload.rebuild === true;
  if (rebuild && !payload.day) {
    throw adminError.rebuildRequiresExplicitDay;
  }
  const day = payload.day ?? (mode === 'nightly' ? tehranYesterday() : tehranToday());
  const bank = payload.bank ?? 'tavan_mellat';
  getActionLogger().info({
    category: 'admin',
    action: 'admin.run.direct',
    actor: actor?.username || null,
    roles: actor?.roles || [],
    meta: { bank, day, mode, rebuild },
  });
  return getServices().ingestion.runDay(bank, day, mode, {
    rebuild,
    filters: payload.filters,
  });
}

exports.getOverview = async function (session) {
  const actor = await requireAdminSession(session, () => adminError.sessionRequired);
  getActionLogger().info({
    category: 'admin',
    action: 'admin.overview.viewed',
    actor: actor.username,
    roles: actor.roles,
  });
  return getAdminService().getOverview({ actor: actor.username });
};

exports.getCron = async function (session) {
  await requireAdminSession(session, () => adminError.sessionRequired);
  return getAdminService().getCronConfig();
};

exports.updateCron = async function (body, session) {
  const actor = await requireAdminSession(session, () => adminError.sessionRequired);
  const updated = await getAdminService().updateCronConfig(readBody(body), { actor: actor.username });
  getActionLogger().info({
    category: 'admin',
    action: 'admin.cron.updated',
    actor: actor.username,
    roles: actor.roles,
    statusCode: 200,
    meta: {
      enabled: updated?.enabled,
      schedule_mode: updated?.schedule_mode,
      effective_cron_expr: updated?.effective_cron_expr,
      banks: updated?.banks,
      target_offset_days: updated?.target_offset_days,
      rebuild: updated?.rebuild,
    },
  });
  return updated;
};

exports.runCronNow = async function (session) {
  const actor = await requireAdminSession(session, () => adminError.sessionRequired);
  const job = await getAdminService().triggerCronExecution('cron_manual', undefined, { actor: actor.username });
  //_INVALIDATE CACHE: analyze دستی داده جدید تولید می‌کند — کش گزارش قبلی منسوخ شود
  reportCache.clear();
  getActionLogger().info({
    category: 'admin',
    action: 'admin.cron.run_now',
    actor: actor.username,
    roles: actor.roles,
    statusCode: 200,
    meta: { jobId: job?.id, banks: job?.banks, days: job?.days },
  });
  return job;
};

exports.checkExisting = async function (body, session) {
  const actor = await requireAdminSession(session, () => adminError.sessionRequired);
  const payload = readBody(body);
  const res = await getAdminService().checkExistingData(payload);
  getActionLogger().info({
    category: 'admin',
    action: 'admin.run.checked',
    actor: actor.username,
    roles: actor.roles,
    statusCode: 200,
    meta: {
      banks: res?.banks,
      days: res?.days,
      dateScope: res?.dateScope,
      hasExistingData: res?.hasExistingData,
      existingCount: res?.existingCount,
    },
  });
  return res;
};

exports.startRun = async function (body, session) {
  const actor = await requireAdminSession(session, () => adminError.sessionRequired);
  const job = await getAdminService().startManualRun(readBody(body), { actor: actor.username });
  //_INVALIDATE CACHE: analyze دستی داده جدید تولید می‌کند — کش گزارش قبلی منسوخ شود
  reportCache.clear();
  getActionLogger().info({
    category: 'admin',
    action: 'admin.run.started',
    actor: actor.username,
    roles: actor.roles,
    statusCode: 200,
    meta: {
      jobId: job?.id,
      banks: job?.banks,
      days: job?.days,
      dateScope: job?.dateScope,
      mode: job?.mode,
      conflictStrategy: job?.conflictStrategy,
    },
  });
  return job;
};

exports.listJobs = async function (session) {
  await requireAdminSession(session, () => adminError.sessionRequired);
  return getAdminService().listJobs(20);
};

exports.getJob = async function (request, inputData, session) {
  await requireAdminSession(session, () => adminError.sessionRequired);
  // مسیر استاتیک است: GET /api/admin/jobs?id=…
  const query = readQuery(request, inputData);
  const jobId =
    readQueryParam(query, 'id') ||
    readQueryParam(query, 'jobId') ||
    readRouteParam(request, inputData, 'id', /\/api\/admin\/jobs\/([^/?#]+)/);
  if (!jobId) throw adminError.jobNotFound(jobId);
  return getAdminService().getJob(jobId);
};

exports.runAdminDay = async function (body, session) {
  const actor = await requireAdminSession(session, () => adminError.sessionRequired);
  return executeDirectDayRun(body, actor);
};

exports.run = async function (body, session) {
  const actor = await requireAdminSession(session, () => adminError.sessionRequired);
  return executeDirectDayRun(body, actor);
};
