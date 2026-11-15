'use strict';
const { getServices } = require('../../services/container');
const {
  normalizeBody,
  extractRouteParam,
  BadRequestError,
  runJsonHandler,
} = require('../../services/http-adapter');
const { tehranToday, tehranYesterday } = require('../../services/utils/date');

async function executeDirectDayRun(data) {
  const body = normalizeBody(data);
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

exports.getOverview = function (response) {
  return runJsonHandler(response, () => getServices().admin.getOverview(), { noStore: true });
};

exports.getCron = function (response) {
  return runJsonHandler(response, () => getServices().admin.getCronConfig(), { noStore: true });
};

exports.updateCron = function (data, response) {
  return runJsonHandler(response, () => {
    const body = normalizeBody(data);
    return getServices().admin.updateCronConfig(body);
  });
};

exports.runCronNow = function (response) {
  return runJsonHandler(response, () => getServices().admin.triggerCronExecution('cron_manual'));
};

exports.checkExisting = function (data, response) {
  return runJsonHandler(response, () => {
    const body = normalizeBody(data);
    return getServices().admin.checkExistingData(body);
  });
};

exports.startRun = function (data, response) {
  return runJsonHandler(response, () => {
    const body = normalizeBody(data);
    return getServices().admin.startManualRun(body);
  });
};

exports.listJobs = function (response) {
  return runJsonHandler(response, () => getServices().admin.listJobs(20), { noStore: true });
};

exports.getJob = function (request, response, inputData) {
  return runJsonHandler(
    response,
    () => {
      const id = extractRouteParam(request, inputData, 'id', /\/api\/admin\/jobs\/([^/?#]+)/);
      return getServices().admin.getJob(id);
    },
    { noStore: true },
  );
};

exports.runAdminDay = function (data, response) {
  return runJsonHandler(response, () => executeDirectDayRun(data));
};

exports.run = function (data, response) {
  return runJsonHandler(response, () => executeDirectDayRun(data));
};
