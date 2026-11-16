'use strict';

const { error: authError } = require('./config');

/**
 * مدیریت سشن کاربر (Promise-based روی session فریم‌ورک).
 *
 * در `partFramework@10.2.0` با `checkAccess(true)` روی روت، نمونهٔ سشن به‌عنوان
 * `_session` به هندلر تزریق می‌شود؛ همان قراردادی که `samplePF/utils/sessionManager`
 * استفاده می‌کند: `session.get / session.set / session.remove` با callback.
 */
class SessionManager {
  setSession = async (session, body, roles) => {
    const normalizedRoles = Array.isArray(roles) && roles.length ? roles : ['visitor'];
    const payload = { samadUsername: body.username, roles: normalizedRoles };
    if (!session || typeof session.set !== 'function') {
      return payload;
    }
    return new Promise((resolve, reject) => {
      session.set(payload, (err, res) => {
        if (err) return reject(authError.sessionError(err?.message || err));
        resolve(res);
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

  removeSession = async (session, response) => {
    this.#clearCookie(response);
    if (!session || typeof session.remove !== 'function') {
      return [];
    }
    return new Promise((resolve, reject) => {
      session.remove((err, res) => {
        if (err) return reject(authError.sessionError(err?.message || err));
        resolve(res);
      });
    });
  };

  /**
   * اطلاعات سشن به همراه پرچم authenticated برای پاسخ `/api/auth/me`.
   */
  getSessionInfo = async (session) => {
    const info = await this.getSession(session);
    const username = info?.samadUsername || 'visitor';
    const roles = Array.isArray(info?.roles) && info.roles.length ? info.roles : ['visitor'];
    return {
      authenticated: username !== 'visitor',
      username,
      samadUsername: username,
      roles,
    };
  };

  #clearCookie(response) {
    if (!response || typeof response.setHeader !== 'function') return;
    const domain = process.env.COOKIE_DOMAIN || 'localhost';
    response.setHeader('Set-Cookie', [
      'token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;',
      `token=; Path=/; Domain=${domain}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;`,
    ]);
  }
}

module.exports = SessionManager;
