'use strict';

const { recordControllerException } = require('../../../services/logger/exception-audit');

/**
 * نگاشت خطاهای پنل مدیریت/دریافت گزارش به ساختار استاندارد پارت.
 */
module.exports = (exception) => {
  const mapped =
    exception && typeof exception === 'object' && exception.statusCode && exception.meta
      ? {
          statusCode: exception.statusCode,
          data: exception.data,
          meta: exception.meta,
        }
      : {
          statusCode: Number(exception?.statusCode) || 500,
          meta: exception?.meta || {
            code: 'internalServerError',
            sourceType: 'controller',
            sourceName: 'admin-controller',
          },
          data: exception?.data || {
            message: {
              fa: 'خطای داخلی سرور، لطفا بعدا مجددا تلاش نمایید',
              en: 'Internal server error',
            },
            additionalInfo: typeof exception === 'string' ? exception : exception?.message,
          },
        };
  return recordControllerException('admin', exception, mapped);
};
