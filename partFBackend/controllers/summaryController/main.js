const BaseController = require('@partFramework/baseController');
const { registerFrameworkGlobals } = require('../../services/http-adapter');
const helpers = require('./helpers');

registerFrameworkGlobals({
  HttpResult: typeof HttpResult !== 'undefined' ? HttpResult : undefined,
  Result: typeof Result !== 'undefined' ? Result : undefined,
  BaseController,
});

/**
 * سطح دسترسی ۱ — کاربر عادی (عمومی):
 * مشاهدهٔ صفحهٔ اول داشبورد و تحلیلهای کلی.
 */
class SummaryController extends BaseController {
  @Route('/api/health')
  @HTTP('GET')
  health() {
    return helpers.health();
  }

  @Route('/api/banks')
  @HTTP('GET')
  banks(response) {
    return helpers.banks(response);
  }

  @Route('/api/specs')
  @HTTP('GET')
  specs(queryString, response) {
    return helpers.specs(queryString, response);
  }

  @Route('/api/report')
  @HTTP('GET')
  report(queryString, response) {
    return helpers.report(queryString, response);
  }

  @Route('/api/diagnostics')
  @HTTP('GET')
  diagnostics(response) {
    return helpers.diagnostics(response);
  }

  @Route('/api/summary')
  @HTTP('GET')
  summary(queryString, response) {
    return helpers.summary(queryString, response);
  }

  @Route('/api/list')
  @HTTP('GET')
  list(queryString, response) {
    return helpers.list(queryString, response);
  }

  @Route('/api/runs')
  @HTTP('GET')
  runs(response) {
    return helpers.runs(response);
  }
}

module.exports = {
  controller: SummaryController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
