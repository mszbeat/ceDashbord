const BaseController = require('@partFramework/baseController');
const { registerFrameworkGlobals } = require('../../services/http-adapter');
const helpers = require('./helpers');

registerFrameworkGlobals({
  HttpResult: typeof HttpResult !== 'undefined' ? HttpResult : undefined,
  Result: typeof Result !== 'undefined' ? Result : undefined,
  BaseController,
});

/**
 * سطح دسترسی ۲ — نقشهای creditEvaluation و admin:
 * مجاز به درخواست زدن و مشاهدهٔ اطلاعات کامل یک گزارش (کاربر عادی مسدود میشود).
 */
class CreditEvaluationController extends BaseController {
  @Route('/api/sample/:requestId')
  @HTTP('GET')
  sample(protocolRef) {
    return helpers.sample(protocolRef);
  }
}

module.exports = {
  controller: CreditEvaluationController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
