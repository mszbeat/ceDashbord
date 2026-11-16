const { createErrorInfo } = require('../../services/error-info');
const errorInfo = createErrorInfo(require('./package.json'));

module.exports = {
  name: 'credit-evaluation-controller',
  path: './',
  handlers: {
    sample: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response', '_inputData'],
    },
  },
  error: {
    requestIdRequired: {
      meta: errorInfo('requestIdRequired'),
      data: {
        message: {
          fa: 'شناسهٔ درخواست (requestId) الزامی است',
          en: 'requestId is required',
        },
      },
      statusCode: 400,
    },
    sampleNotFound: function (requestId) {
      return {
        meta: errorInfo('sampleNotFound'),
        data: {
          message: {
            fa: 'گزارش مورد نظر یافت نشد',
            en: 'sample report not found',
          },
          additionalInfo: { requestId },
        },
        statusCode: 404,
      };
    },
    creditEvaluationBaseServiceError: function (additionalInfo) {
      return {
        meta: errorInfo('creditEvaluationBaseServiceError'),
        data: {
          message: {
            fa: 'خطای سرویس پایه اعتبارسنجی',
            en: 'credit evaluation base service error',
          },
          additionalInfo,
        },
        statusCode: 503,
      };
    },
    internalServerError: function (additionalInfo) {
      return {
        meta: errorInfo('internalServerError'),
        data: {
          message: {
            fa: 'خطای داخلی سرور، لطفا بعدا مجددا تلاش نمایید',
            en: 'Internal server error',
          },
          additionalInfo,
        },
        statusCode: 500,
      };
    },
  },
};
