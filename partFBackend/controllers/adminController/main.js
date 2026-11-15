const BaseController = require('@partFramework/baseController');
const helpers = require('./helpers');

class AdminController extends BaseController {
  @Route('/api/admin/overview')
  @HTTP('GET')
  getOverview(protocolRef) {
    return helpers.getOverview(protocolRef);
  }

  @Route('/api/admin/cron')
  @HTTP('GET')
  getCron(protocolRef) {
    return helpers.getCron(protocolRef);
  }

  @Route('/api/admin/cron')
  @HTTP('PUT')
  updateCron(protocolRef) {
    return helpers.updateCron(protocolRef);
  }

  @Route('/api/admin/cron/run-now')
  @HTTP('POST')
  runCronNow(protocolRef) {
    return helpers.runCronNow(protocolRef);
  }

  @Route('/api/admin/runs/check')
  @HTTP('POST')
  checkExisting(protocolRef) {
    return helpers.checkExisting(protocolRef);
  }

  @Route('/api/admin/runs/start')
  @HTTP('POST')
  startRun(protocolRef) {
    return helpers.startRun(protocolRef);
  }

  @Route('/api/admin/jobs')
  @HTTP('GET')
  listJobs(protocolRef) {
    return helpers.listJobs(protocolRef);
  }

  @Route('/api/admin/jobs/:id')
  @HTTP('GET')
  getJob(protocolRef) {
    return helpers.getJob(protocolRef);
  }
}

module.exports = {
  controller: AdminController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
