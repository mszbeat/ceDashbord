'use strict';
const { getServices } = require('../../services/container');
const { ROLES, requireRoles } = require('../../services/auth/role-guard');
const { getBody, getParams, BadRequestError, runJsonHandler } = require('../../services/http-adapter');
const { tehranToday, tehranYesterday } = require('../../services/utils/date');
const accessConfig = require('../../configs/adminController.config');

const ALLOWED_ROLES = accessConfig.allowedRoles || [ROLES.ADMIN];
const ADMIN_DENIED_MSG =
  'دسترسی غیرمجاز: ورود به پنل مدیریت و اجرای عملیات مدیریتی فقط برای نقش admin مجاز است.';

async function ensureAdmin(protocolRef) {
  return requireRoles(protocolRef, ALLOWED_ROLES, { message: ADMIN_DENIED_MSG });
}

async function executeDirectDayRun(protocolRef) {
  await ensureAdmin(protocolRef);
  const body = getBody(protocolRef);
  const mode = body.mode === 'intraday' ? 'intraday' : 'nightly';
  const rebuild = body.rebuild === true;
  if (rebuild && !body.day) {
    throw new BadRequestError('rebuild نیاز به day صریح دارد.');
  }
  const day = body.day ?? (mode === 'nightly' ? tehranYesterday() : tehranToday());
  return getServices().ingestion.runDay(body.bank ?? 'tavan_mellat', day, mode, {
    rebuild,
    filters: body.filters,
  });
}

exports.getOverview = function (protocolRef) {
  return runJsonHandler(
    protocolRef,
    async () => {
      await ensureAdmin(protocolRef);
      return getServices().admin.getOverview();
    },
    { noStore: true },
  );
};

exports.getCron = function (protocolRef) {
  return runJsonHandler(
    protocolRef,
    async () => {
      await ensureAdmin(protocolRef);
      return getServices().admin.getCronConfig();
    },
    { noStore: true },
  );
};

exports.updateCron = function (protocolRef) {
  return runJsonHandler(protocolRef, async () => {
    await ensureAdmin(protocolRef);
    const body = getBody(protocolRef);
    return getServices().admin.updateCronConfig(body);
  });
};

exports.runCronNow = function (protocolRef) {
  return runJsonHandler(protocolRef, async () => {
    await ensureAdmin(protocolRef);
    return getServices().admin.triggerCronExecution('cron_manual');
  });
};

exports.checkExisting = function (protocolRef) {
  return runJsonHandler(protocolRef, async () => {
    await ensureAdmin(protocolRef);
    const body = getBody(protocolRef);
    return getServices().admin.checkExistingData(body);
  });
};

exports.startRun = function (protocolRef) {
  return runJsonHandler(protocolRef, async () => {
    await ensureAdmin(protocolRef);
    const body = getBody(protocolRef);
    return getServices().admin.startManualRun(body);
  });
};

exports.listJobs = function (protocolRef) {
  return runJsonHandler(
    protocolRef,
    async () => {
      await ensureAdmin(protocolRef);
      return getServices().admin.listJobs(20);
    },
    { noStore: true },
  );
};

exports.getJob = function (protocolRef) {
  return runJsonHandler(
    protocolRef,
    async () => {
      await ensureAdmin(protocolRef);
      const params = getParams(protocolRef, /\/api\/admin\/jobs\/([^/?#]+)/, 'id');
      return getServices().admin.getJob(String(params.id || ''));
    },
    { noStore: true },
  );
};

exports.runAdminDay = function (protocolRef) {
  return runJsonHandler(protocolRef, () => executeDirectDayRun(protocolRef));
};

exports.run = function (protocolRef) {
  return runJsonHandler(protocolRef, () => executeDirectDayRun(protocolRef));
};
