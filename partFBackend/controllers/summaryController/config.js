const { createErrorInfo } = require('../../services/error-info');
const errorInfo = createErrorInfo(require('./package.json'));

module.exports = {
  name: 'summary-controller',
  path: './',
  handlers: {
    health: {
      needProtocolRef: false,
      params: [],
    },
    banks: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    specs: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response'],
    },
    report: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response'],
    },
    diagnostics: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    summary: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response'],
    },
    list: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response'],
    },
    runs: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
  },
  error: {
    unsupportedBank: function (bank) {
      return {
        meta: errorInfo('unsupportedBank'),
        data: {
          message: {
            fa: `بانک پشتیبانی‌شده نیست: ${bank}`,
            en: 'unsupported bank',
          },
          additionalInfo: { bank },
        },
        statusCode: 400,
      };
    },
    invalidDateRange: function (additionalInfo) {
      return {
        meta: errorInfo('invalidDateRange'),
        data: {
          message: {
            fa: 'بازهٔ تاریخ واردشده معتبر نیست',
            en: 'invalid date range',
          },
          additionalInfo,
        },
        statusCode: 400,
      };
    },
    reportBuildFailed: function (additionalInfo) {
      return {
        meta: errorInfo('reportBuildFailed'),
        data: {
          message: {
            fa: 'خطا در ساخت گزارش داشبورد زنده',
            en: 'dashboard report build failed',
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
