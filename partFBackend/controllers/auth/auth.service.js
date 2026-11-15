class AuthService {
  #user = process.env.PART_AUTH_USERNAME;
  #pass = process.env.PART_AUTH_PASS;
  #system = process.env.PART_AUTH_SYSTEM;
  #status = 'Active';

  constructor(
    partAuthenticationInterface,
    partRequest,
    partLogger,
  ) {
    this.partRequest = partRequest;
    this.logger = partLogger;
    this.partAuth = partAuthenticationInterface;
    this.partAuthenticationInterface = partAuthenticationInterface;
  }

  #normalizeBody(body) {
    if (!body) return {};
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    }
    return typeof body === 'object' ? body : {};
  }

  #rethrowAuthError(err, fallbackFa, fallbackEn) {
    if (err && typeof err === 'object' && err.statusCode && err.data?.message) {
      throw err;
    }
    if (this.logger && typeof this.logger.error === 'function') {
      this.logger.error(err);
    }
    const statusCode = Number(err?.statusCode) || 500;
    throw {
      statusCode,
      data: err?.data || {
        message: {
          fa: fallbackFa,
          en: err?.meta?.code || err?.message || fallbackEn,
        },
      },
    };
  }

  async addAuthEntry(body, trackingHeaders) {
    const { username, password } = this.#normalizeBody(body);
    if (!username || !password) {
      throw {
        statusCode: 400,
        data: {
          message: {
            fa: 'نام کاربری و رمز عبور الزامی است',
            en: 'username and password are required',
          },
        },
      };
    }

    const payload = {
      username,
      password,
    };

    try {
      await this.partAuthenticationInterface.addUser(
        payload,
        this.#status,
        this.#system,
        trackingHeaders,
      );
      return 'ok';
    } catch (err) {
      if (err?.meta?.code === 'authEntryAlreadyExists') {
        throw {
          statusCode: 409,
          data: {
            message: {
              fa: 'ترکیب اصالت‌سنجی تکراری است',
              en: 'auth entry alreadyExists',
            },
          },
        };
      }
      this.#rethrowAuthError(
        err,
        'خطا در ثبت اطلاعات اصالت‌سنجی کاربر',
        'failed to add auth entry',
      );
    }
  }

  async authenticate(body, trackingHeaders) {
    const { username, password } = this.#normalizeBody(body);
    if (!username || !password) {
      throw {
        statusCode: 400,
        data: {
          message: {
            fa: 'نام کاربری و رمز عبور الزامی است',
            en: 'username and password are required',
          },
        },
      };
    }

    const fields = { username, password };

    try {
      const result = await this.partAuthenticationInterface.authenticate(
        fields,
        this.#system,
        trackingHeaders,
      );
      return result ?? 'ok';
    } catch (err) {
      const code = err?.meta?.code;
      if (
        err?.statusCode === 401 ||
        code === 'invalidUsernameOrPassword' ||
        code === 'authenticationFailed' ||
        code === 'wrongPassword' ||
        code === 'invalidCredentials' ||
        code === 'authEntryNotFound' ||
        code === 'userNotFound'
      ) {
        throw {
          statusCode: 401,
          data: {
            message: {
              fa: 'نام کاربری یا رمز عبور نادرست است',
              en: 'invalid username or password',
            },
          },
        };
      }
      if (
        err?.statusCode === 403 ||
        code === 'userIsInactive' ||
        code === 'authEntryIsInactive' ||
        code === 'authEntryIsNotActive'
      ) {
        throw {
          statusCode: 403,
          data: {
            message: {
              fa: 'حساب کاربری غیرفعال است',
              en: 'user account is inactive',
            },
          },
        };
      }
      this.#rethrowAuthError(
        err,
        'خطا در بررسی اصالت‌سنجی کاربر',
        'authentication failed',
      );
    }
  }

  async removeUser(body, trackingHeaders) {
    const parsed =
      typeof body === 'string' && !body.trim().startsWith('{')
        ? { username: body.trim() }
        : this.#normalizeBody(body);
    const { username } = parsed;

    if (!username) {
      throw {
        statusCode: 400,
        data: {
          message: {
            fa: 'نام کاربری الزامی است',
            en: 'username is required',
          },
        },
      };
    }

    try {
      await this.partAuthenticationInterface.removeUser(
        { username },
        this.#system,
        trackingHeaders,
      );
      return 'ok';
    } catch (err) {
      const code = err?.meta?.code;
      if (
        err?.statusCode === 404 ||
        code === 'authEntryNotFound' ||
        code === 'userNotFound'
      ) {
        throw {
          statusCode: 404,
          data: {
            message: {
              fa: 'کاربر مورد نظر یافت نشد',
              en: 'auth entry not found',
            },
          },
        };
      }
      this.#rethrowAuthError(
        err,
        'خطا در حذف کاربر از سرویس اصالت‌سنجی',
        'failed to remove auth entry',
      );
    }
  }

  async removeAuthEntry(body, trackingHeaders) {
    return this.removeUser(body, trackingHeaders);
  }

  async login(body, trackingHeaders) {
    return this.authenticate(body, trackingHeaders);
  }
}

module.exports = AuthService;
