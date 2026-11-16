const { error: authError } = require('./config');

/**
 * ماژول مدیریت سشن کاربر (Promise-based روی partSessionManager).
 *
 * عملیات‌های پشتیبانی‌شده:
 *  - ذخیره اطلاعات در سشن (setSession)
 *  - حذف سشن و کوکی (removeSession)
 *  - دریافت اطلاعات از سشن (getSession)
 */
class SessionManager {
  setSession = async (session, body, roles) => {
    const normalizedRoles = Array.isArray(roles) && roles.length ? roles : ['visitor'];
    if (!session || typeof session.set !== 'function') {
      return { samadUsername: body.username, roles: normalizedRoles };
    }
    return new Promise((resolve, reject) => {
      session.set(
        { samadUsername: body.username, roles: normalizedRoles },
        (err, res) => {
          if (err) return reject(authError.sessionError(err?.message || err));
          resolve(res);
        },
      );
    });
  };

  removeSession = async (session, response) => {
    if (!session || typeof session.remove !== 'function') {
      await this.removeCookie(response);
      return [];
    }
    return new Promise((resolve, reject) => {
      session.remove((err, resArray) => {
        if (err) return reject(authError.sessionError(err?.message || err));
        this.removeCookie(response);
        resolve(resArray);
      });
    });
  };

  getSession = async (session) => {
    if (!session || typeof session.get !== 'function') {
      return { samadUsername: 'visitor', roles: ['visitor'] };
    }
    return new Promise((resolve, reject) => {
      session.get(['samadUsername', 'roles'], (err, res) => {
        if (err) return reject(authError.sessionError(err?.message || err));
        resolve({
          samadUsername: res?.samadUsername || 'visitor',
          roles: Array.isArray(res?.roles) && res.roles.length ? res.roles : ['visitor'],
        });
      });
    });
  };

  removeCookie = async (response) => {
    if (!response || typeof response.setHeader !== 'function') return;
    const domain = process.env.COOKIE_DOMAIN || 'localhost';
    response.setHeader('Set-Cookie', [
      'token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;',
      `token=; Path=/; Domain=${domain}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;`,
    ]);
  };
}

module.exports = SessionManager;
