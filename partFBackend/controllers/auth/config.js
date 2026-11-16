const { createErrorInfo } = require('../../services/error-info');
const errorInfo = createErrorInfo(require('./package.json'));

module.exports = {
  name: 'auth-controller',
  path: './main.js',
  handlers: {
    register: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
        '_session',
      ],
    },
    login: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
        '_session',
      ],
    },
    logout: {
      needProtocolRef: false,
      params: [
        '_session',
        '_protocolRef.response',
      ],
    },
    me: {
      needProtocolRef: false,
      params: [
        '_session',
      ],
    },
    assignRole: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_session',
      ],
    },
    getRole: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.queryString',
      ],
    },
    removeUser: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
        '_session',
        '_protocolRef.response',
      ],
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
          en: 'auth entry alreadyExists',
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
