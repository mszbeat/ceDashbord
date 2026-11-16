'use strict';

/**
 * نگاشت خطاهای سطح کاربر عادی به ساختار استاندارد پارت.
 */
module.exports = (exception) => {
  if (exception && typeof exception === 'object' && exception.statusCode && exception.meta) {
    return {
      statusCode: exception.statusCode,
      data: exception.data,
      meta: exception.meta,
    };
  }

  return {
    statusCode: Number(exception?.statusCode) || 500,
    meta: exception?.meta || {
      code: 'internalServerError',
      sourceType: 'controller',
      sourceName: 'summary-controller',
    },
    data: exception?.data || {
      message: {
        fa: 'خطای داخلی سرور، لطفا بعدا مجددا تلاش نمایید',
        en: 'Internal server error',
      },
      additionalInfo: typeof exception === 'string' ? exception : exception?.message,
    },
  };
};
