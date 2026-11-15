const BaseController = require('@partFramework/baseController');
const { registerFrameworkGlobals } = require('../../services/http-adapter');
const helpers = require('./helpers');

registerFrameworkGlobals({
  HttpResult: typeof HttpResult !== 'undefined' ? HttpResult : undefined,
  Result: typeof Result !== 'undefined' ? Result : undefined,
  BaseController,
});

/**
 * سطح دسترسی ۲ — نقشهای creditEvaluation و admin (اعمال گارد توسط سمد):
 * دریافت و مشاهدهٔ اطلاعات کامل یک گزارش اعتبارسنجی.
 */
class CreditEvaluationController extends BaseController {
  @Route('/api/sample/:requestId')
  @HTTP('GET')
  sample(request, response, inputData) {
    return helpers.sample(request, response, inputData);
  }
}

module.exports = {
  controller: CreditEvaluationController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
