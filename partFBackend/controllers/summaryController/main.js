const BaseController = require('@partFramework/baseController');
const { registerFrameworkGlobals } = require('../../services/http-adapter');
const helpers = require('./helpers');

registerFrameworkGlobals({
  HttpResult: typeof HttpResult !== 'undefined' ? HttpResult : undefined,
  Result: typeof Result !== 'undefined' ? Result : undefined,
  BaseController,
});

/**
 * سطح دسترسی ۱ — کاربر عادی (عمومی / همهٔ کاربران):
 * مشاهدهٔ صفحهٔ اول داشبورد و تحلیلهای کلی، بدون امکان دریافت اطلاعات تکی گزارش یا ورود به پنل ادمین.
 */
class SummaryController extends BaseController {
  @Route('/api/health')
  @HTTP('GET')
  health(protocolRef) {
    return helpers.health(protocolRef);
  }

  @Route('/api/auth/me')
  @HTTP('GET')
  me(protocolRef) {
    return helpers.me(protocolRef);
  }

  @Route('/api/banks')
  @HTTP('GET')
  banks(protocolRef) {
    return helpers.banks(protocolRef);
  }

  @Route('/api/specs')
  @HTTP('GET')
  specs(protocolRef) {
    return helpers.specs(protocolRef);
  }

  @Route('/api/report')
  @HTTP('GET')
  report(protocolRef) {
    return helpers.report(protocolRef);
  }

  @Route('/api/diagnostics')
  @HTTP('GET')
  diagnostics(protocolRef) {
    return helpers.diagnostics(protocolRef);
  }

  @Route('/api/summary')
  @HTTP('GET')
  summary(protocolRef) {
    return helpers.summary(protocolRef);
  }

  @Route('/api/list')
  @HTTP('GET')
  list(protocolRef) {
    return helpers.list(protocolRef);
  }

  @Route('/api/runs')
  @HTTP('GET')
  runs(protocolRef) {
    return helpers.runs(protocolRef);
  }
}

module.exports = {
  controller: SummaryController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
