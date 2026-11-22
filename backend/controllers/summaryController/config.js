'use strict';

const { createErrorInfo } = require('../../services/error-info');
const errorInfo = createErrorInfo(require('./package.json'));

module.exports = {
  name: 'summary-controller',
  path: './main.js',
  exception: {
    handler: require('./exceptions/summaryException'),
  },
  handlers: {
    health: { needProtocolRef: false, params: [] },
    // D8 — liveness (بدون پارامتر) و readiness (به response نیاز دارد تا ۵۰۳ ست کند)
    healthz: { needProtocolRef: false, params: [] },
    readyz: { needProtocolRef: false, params: ['_protocolRef.response'] },
    banks: { needProtocolRef: false, params: ['_session'] },
    specs: { needProtocolRef: false, params: ['_protocolRef.request.queryString', '_session'] },
    report: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response', '_session'],
    },
    diagnostics: { needProtocolRef: false, params: ['_session'] },
    summary: { needProtocolRef: false, params: ['_protocolRef.request.queryString', '_session'] },
    list: { needProtocolRef: false, params: ['_protocolRef.request.queryString', '_session'] },
    runs: { needProtocolRef: false, params: ['_session'] },
  },
  error: {
    sessionRequired: {
      meta: errorInfo('sessionRequired'),
      data: {
        message: {
          fa: 'برای مشاهدهٔ داشبورد ابتدا وارد حساب کاربری شوید',
          en: 'authentication session is required',
        },
      },
      statusCode: 401,
    },
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
