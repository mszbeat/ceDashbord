const BaseController = require('@partFramework/baseController');
const { registerFrameworkGlobals } = require('../../services/http-adapter');
const helpers = require('./helpers');

registerFrameworkGlobals({
  HttpResult: typeof HttpResult !== 'undefined' ? HttpResult : undefined,
  Result: typeof Result !== 'undefined' ? Result : undefined,
  BaseController,
});

/**
 * سطح دسترسی ۳ — فقط نقش admin (اعمال گارد توسط سمد):
 * پنل مدیریت، زمانبند خودکار کران شبانه و اجرای دریافت گزارشها (Ingestion).
 */
class AdminController extends BaseController {
  @Route('/api/admin/overview')
  @HTTP('GET')
  getOverview(response) {
    return helpers.getOverview(response);
  }

  @Route('/api/admin/cron')
  @HTTP('GET')
  getCron(response) {
    return helpers.getCron(response);
  }

  @Route('/api/admin/cron')
  @HTTP('PUT')
  updateCron(request, response) {
    return helpers.updateCron(request, response);
  }

  @Route('/api/admin/cron/run-now')
  @HTTP('POST')
  runCronNow(response) {
    return helpers.runCronNow(response);
  }

  @Route('/api/admin/runs/check')
  @HTTP('POST')
  checkExisting(request, response) {
    return helpers.checkExisting(request, response);
  }

  @Route('/api/admin/runs/start')
  @HTTP('POST')
  startRun(request, response) {
    return helpers.startRun(request, response);
  }

  @Route('/api/admin/jobs')
  @HTTP('GET')
  listJobs(response) {
    return helpers.listJobs(response);
  }

  @Route('/api/admin/jobs/:id')
  @HTTP('GET')
  getJob(request, response, inputData) {
    return helpers.getJob(request, response, inputData);
  }

  @Route('/api/admin/runs')
  @HTTP('POST')
  runAdminDay(request, response) {
    return helpers.runAdminDay(request, response);
  }

  @Route('/api/runs')
  @HTTP('POST')
  run(request, response) {
    return helpers.run(request, response);
  }
}

module.exports = {
  controller: AdminController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
