'use strict';

/**
 * نگاشت خطاهای سطح مشاهدهٔ جزئیات گزارش.
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
      sourceName: 'credit-evaluation-controller',
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
