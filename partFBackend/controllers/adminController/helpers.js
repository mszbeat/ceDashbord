'use strict';
const { getServices } = require('../../services/container');
const { getBody, getParams, runJsonHandler } = require('../../services/http-adapter');

exports.getOverview = function (protocolRef) {
  return runJsonHandler(protocolRef, () => getServices().admin.getOverview(), { noStore: true });
};

exports.getCron = function (protocolRef) {
  return runJsonHandler(protocolRef, () => getServices().admin.getCronConfig(), { noStore: true });
};

exports.updateCron = function (protocolRef) {
  return runJsonHandler(protocolRef, () => {
    const body = getBody(protocolRef);
    return getServices().admin.updateCronConfig(body);
  });
};

exports.runCronNow = function (protocolRef) {
  return runJsonHandler(protocolRef, () => getServices().admin.triggerCronExecution('cron_manual'));
};

exports.checkExisting = function (protocolRef) {
  return runJsonHandler(protocolRef, () => {
    const body = getBody(protocolRef);
    return getServices().admin.checkExistingData(body);
  });
};

exports.startRun = function (protocolRef) {
  return runJsonHandler(protocolRef, () => {
    const body = getBody(protocolRef);
    return getServices().admin.startManualRun(body);
  });
};

exports.listJobs = function (protocolRef) {
  return runJsonHandler(protocolRef, () => getServices().admin.listJobs(20), { noStore: true });
};

exports.getJob = function (protocolRef) {
  return runJsonHandler(
    protocolRef,
    () => {
      const params = getParams(protocolRef, /\/api\/admin\/jobs\/([^/?#]+)/, 'id');
      return getServices().admin.getJob(String(params.id || ''));
    },
    { noStore: true },
  );
};
