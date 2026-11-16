'use strict';
const { getServices } = require('../../services/container');
const {
  normalizeBody,
  extractRouteParam,
  runJsonHandler,
} = require('../../services/http-adapter');
const { error: adminError } = require('./config');
const { tehranToday, tehranYesterday } = require('../../services/utils/date');

async function executeDirectDayRun(requestOrBody) {
  const body = normalizeBody(requestOrBody);
  const mode = body.mode === 'intraday' ? 'intraday' : 'nightly';
  const rebuild = body.rebuild === true;
  if (rebuild && !body.day) {
    throw adminError.rebuildRequiresExplicitDay;
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

exports.updateCron = function (request, response) {
  return runJsonHandler(response, () => {
    const body = normalizeBody(request);
    return getServices().admin.updateCronConfig(body);
  });
};

exports.runCronNow = function (response) {
  return runJsonHandler(response, () => getServices().admin.triggerCronExecution('cron_manual'));
};

exports.checkExisting = function (request, response) {
  return runJsonHandler(response, () => {
    const body = normalizeBody(request);
    return getServices().admin.checkExistingData(body);
  });
};

exports.startRun = function (request, response) {
  return runJsonHandler(response, () => {
    const body = normalizeBody(request);
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

exports.runAdminDay = function (request, response) {
  return runJsonHandler(response, () => executeDirectDayRun(request));
};

exports.run = function (request, response) {
  return runJsonHandler(response, () => executeDirectDayRun(request));
};
