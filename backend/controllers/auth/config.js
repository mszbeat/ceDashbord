'use strict';

const { createErrorInfo } = require('../../services/error-info');
const errorInfo = createErrorInfo(require('./package.json'));

/**
 * کانفیگ کنترلر `auth-controller` مطابق الگوی `samplePF/controllers/*`:
 *  - name / path / exception.handler
 *  - handlers با `needProtocolRef: false` و `params` مرتب
 *  - دیکشنری خطاهای همین کنترلر زیر کلید `error`
 */
module.exports = {
  name: 'auth-controller',
  path: './main.js',
  exception: {
    handler: require('./exceptions/authException'),
  },
  handlers: {
    register: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_trackingHeaders', '_session'],
    },
    login: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_trackingHeaders', '_session', '_protocolRef.request', '_protocolRef.response'],
    },
    refresh: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_session', '_protocolRef.request', '_protocolRef.response'],
    },
    logout: {
      needProtocolRef: false,
      params: ['_session', '_protocolRef.response', '_protocolRef.request'],
    },
    me: {
      needProtocolRef: false,
      params: ['_session', '_protocolRef.request'],
    },
    assignRole: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_session'],
    },
    getRole: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_session'],
    },
    removeUser: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_trackingHeaders', '_session', '_protocolRef.response'],
    },
  },
  error: {
    invalidAuthInput: {
      meta: errorInfo('invalidAuthInput'),
      data: {
        message: {
          fa: 'نام کاربری و رمز عبور الزامی است',
          en: 'username and password are required',
        },
      },
      statusCode: 400,
    },
    usernameRequired: {
      meta: errorInfo('usernameRequired'),
      data: {
        message: {
          fa: 'نام کاربری الزامی است',
          en: 'username is required',
        },
      },
      statusCode: 400,
    },
    roleRequired: {
      meta: errorInfo('roleRequired'),
      data: {
        message: {
          fa: 'نام کاربری و نقش الزامی است',
          en: 'username and role are required',
        },
      },
      statusCode: 400,
    },
    authEntryAlreadyExists: {
      meta: errorInfo('authEntryAlreadyExists'),
      data: {
        message: {
          fa: 'ترکیب اصالت‌سنجی تکراری است',
          en: 'auth entry already exists',
        },
      },
      statusCode: 409,
    },
    samadUserAlreadyExists: {
      meta: errorInfo('samadUserAlreadyExists'),
      data: {
        message: {
          fa: 'کاربر در سرویس سمد قبلا ثبت شده است',
          en: 'user already exists in samad',
        },
      },
      statusCode: 409,
    },
    invalidCredentials: {
      meta: errorInfo('invalidCredentials'),
      data: {
        message: {
          fa: 'نام کاربری یا رمز عبور نادرست است',
          en: 'invalid username or password',
        },
      },
      statusCode: 401,
    },
    unauthorizedSession: {
      meta: errorInfo('unauthorizedSession'),
      data: {
        message: {
          fa: 'نشست کاربری معتبر یافت نشد؛ لطفا وارد شوید',
          en: 'unauthorized session',
        },
      },
      statusCode: 401,
    },
    refreshTokenRequired: {
      meta: errorInfo('refreshTokenRequired'),
      data: {
        message: {
          fa: 'توکن تمدید نشست یافت نشد؛ لطفا دوباره وارد شوید',
          en: 'refresh token is required',
        },
      },
      statusCode: 401,
    },
    invalidRefreshToken: {
      meta: errorInfo('invalidRefreshToken'),
      data: {
        message: {
          fa: 'توکن تمدید نشست نامعتبر است؛ لطفا دوباره وارد شوید',
          en: 'invalid refresh token',
        },
      },
      statusCode: 401,
    },
    refreshTokenExpired: {
      meta: errorInfo('refreshTokenExpired'),
      data: {
        message: {
          fa: 'مدت اعتبار نشست شما به پایان رسیده است؛ لطفا دوباره وارد شوید',
          en: 'refresh token expired',
        },
      },
      statusCode: 401,
    },
    refreshTokenRevoked: {
      meta: errorInfo('refreshTokenRevoked'),
      data: {
        message: {
          fa: 'نشست کاربری لغو شده است؛ لطفا دوباره وارد شوید',
          en: 'refresh token revoked',
        },
      },
      statusCode: 401,
    },
    tooManyLoginAttempts: {
      meta: errorInfo('tooManyLoginAttempts'),
      data: {
        message: {
          fa: 'تعداد تلاش‌های ناموفق بیش از حد مجاز است؛ لطفا چند لحظه صبر کرده و دوباره تلاش کنید',
          en: 'too many failed login attempts',
        },
      },
      statusCode: 429,
    },
    userAccountInactive: {
      meta: errorInfo('userAccountInactive'),
      data: {
        message: {
          fa: 'حساب کاربری غیرفعال است',
          en: 'user account is inactive',
        },
      },
      statusCode: 403,
    },
    samadPermissionDenied: {
      meta: errorInfo('samadPermissionDenied'),
      data: {
        message: {
          fa: 'عدم دسترسی به عملیات در سرویس سمد',
          en: 'samad permission denied',
        },
      },
      statusCode: 403,
    },
    userNotFound: {
      meta: errorInfo('userNotFound'),
      data: {
        message: {
          fa: 'کاربر مورد نظر یافت نشد',
          en: 'user not found',
        },
      },
      statusCode: 404,
    },
    roleNotFound: {
      meta: errorInfo('roleNotFound'),
      data: {
        message: {
          fa: 'نقش مورد نظر در سامانه سمد یافت نشد',
          en: 'role not found in samad',
        },
      },
      statusCode: 404,
    },
    authBaseServiceError: {
      meta: errorInfo('authBaseServiceError'),
      data: {
        message: {
          fa: 'خطای سرویس پایه اصالت‌سنجی',
          en: 'authentication base service error',
        },
      },
      statusCode: 503,
    },
    samadBaseServiceError: function (additionalInfo) {
      return {
        meta: errorInfo('samadBaseServiceError'),
        data: {
          message: {
            fa: 'خطای سرویس پایه سمد',
            en: 'samad base service error',
          },
          additionalInfo,
        },
        statusCode: 503,
      };
    },
    sessionError: function (additionalInfo) {
      return {
        meta: errorInfo('sessionError'),
        data: {
          message: {
            fa: 'خطا در مدیریت نشست کاربری',
            en: 'session management error',
          },
          additionalInfo,
        },
        statusCode: 500,
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
