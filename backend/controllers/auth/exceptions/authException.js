module.exports = (exception) => {
  if (exception && typeof exception === 'object' && exception.statusCode && exception.meta) {
    return {
      statusCode: exception.statusCode,
      data: exception.data,
      meta: exception.meta,
    };
  }

  const code = exception?.meta?.code || exception?.data?.code || exception?.code;
  const statusCode = Number(exception?.statusCode) || 0;

  if (statusCode === 401 || ['invalidUsernameOrPassword', 'authenticationFailed', 'wrongPassword', 'invalidCredentials', 'authEntryNotFound'].includes(code)) {
    return {
      statusCode: 401,
      meta: { code: 'invalidCredentials', sourceType: 'controller', sourceName: 'auth-controller' },
      data: { message: { fa: 'نام کاربری یا رمز عبور نادرست است', en: 'invalid username or password' } },
    };
  }

  if (statusCode === 403 || ['userIsInactive', 'authEntryIsInactive', 'authEntryIsNotActive'].includes(code)) {
    return {
      statusCode: 403,
      meta: { code: 'userAccountInactive', sourceType: 'controller', sourceName: 'auth-controller' },
      data: { message: { fa: 'حساب کاربری غیرفعال است', en: 'user account is inactive' } },
    };
  }

  if (statusCode === 404 || code === 'userNotFound') {
    return {
      statusCode: 404,
      meta: { code: 'userNotFound', sourceType: 'controller', sourceName: 'auth-controller' },
      data: { message: { fa: 'کاربر مورد نظر یافت نشد', en: 'user not found' } },
    };
  }

  if (statusCode === 429 || ['tooManyFailedLogins', 'maxFailedLogins', 'tooManyRequests', 'loginBlocked'].includes(code)) {
    return {
      statusCode: 429,
      meta: { code: 'tooManyLoginAttempts', sourceType: 'controller', sourceName: 'auth-controller' },
      data: {
        message: {
          fa: 'تعداد تلاش‌های ناموفق بیش از حد مجاز است؛ لطفا چند لحظه صبر کرده و دوباره تلاش کنید',
          en: 'too many failed login attempts',
        },
      },
    };
  }

  if (code === 'authEntryAlreadyExists') {
    return {
      statusCode: 409,
      meta: { code: 'authEntryAlreadyExists', sourceType: 'controller', sourceName: 'auth-controller' },
      data: { message: { fa: 'ترکیب اصالت‌سنجی تکراری است', en: 'auth entry already exists' } },
    };
  }

  return {
    statusCode: statusCode || 500,
    meta: exception?.meta || { code: 'internalServerError', sourceType: 'controller', sourceName: 'auth-controller' },
    data: exception?.data || {
      message: { fa: 'خطای داخلی سرور، لطفا بعدا مجددا تلاش نمایید', en: 'Internal server error' },
      additionalInfo: typeof exception === 'string' ? exception : exception?.message,
    },
  };
};
