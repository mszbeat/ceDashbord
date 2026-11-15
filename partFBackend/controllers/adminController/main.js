const BaseController = require('@partFramework/baseController');
const { registerFrameworkGlobals } = require('../../services/http-adapter');
const helpers = require('./helpers');

registerFrameworkGlobals({
  HttpResult: typeof HttpResult !== 'undefined' ? HttpResult : undefined,
  Result: typeof Result !== 'undefined' ? Result : undefined,
  BaseController,
});

/**
 * سطح دسترسی ۳ — فقط نقش admin:
 * دسترسی کامل به پنل مدیریت، تنظیمات و اجرای کران شبانه و اجرای دریافت گزارشها (Ingestion).
 * کاربران عادی و نقش creditEvaluation از ورود به این مسیرها منع میشوند (403 Forbidden).
 */
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

  @Route('/api/admin/runs')
  @HTTP('POST')
  runAdminDay(protocolRef) {
    return helpers.runAdminDay(protocolRef);
  }

  @Route('/api/runs')
  @HTTP('POST')
  run(protocolRef) {
    return helpers.run(protocolRef);
  }
}

module.exports = {
  controller: AdminController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
