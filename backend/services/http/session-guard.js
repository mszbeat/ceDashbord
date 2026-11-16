'use strict';

/**
 * استخراج وضعیت سشن از `_session` (پشتیبانی از سشن callback-based
 * فریم‌ورک `partSessionManager` و آبجکت ساده در تست‌ها).
 */
async function readSessionState(session) {
  if (!session) {
    return { authenticated: false, username: 'visitor', roles: ['visitor'] };
  }

  if (typeof session.get === 'function') {
    const raw = await new Promise((resolve, reject) => {
      try {
        session.get(['samadUsername', 'roles'], (err, res) => {
          if (err) return reject(err);
          resolve(res || {});
        });
      } catch (err) {
        reject(err);
      }
    });
    const username =
      typeof raw?.samadUsername === 'string' && raw.samadUsername.trim()
        ? raw.samadUsername.trim()
        : 'visitor';
    const roles = Array.isArray(raw?.roles) && raw.roles.length ? raw.roles : ['visitor'];
    return {
      authenticated: username !== 'visitor',
      username,
      roles,
    };
  }

  const username =
    typeof session.samadUsername === 'string' && session.samadUsername.trim()
      ? session.samadUsername.trim()
      : 'visitor';
  const roles = Array.isArray(session.roles) && session.roles.length ? session.roles : ['visitor'];
  return {
    authenticated: username !== 'visitor',
    username,
    roles,
  };
}

/**
 * تضمین می‌کند برای کاربر یک سشن احرازشده ست شده است (نه مهمان `visitor`).
 * در غیر این صورت خطای ۴۰۱ استاندارد کنترلر پرتاب می‌شود.
 */
async function requireAuthenticatedSession(session, errorFactory) {
  let state;
  try {
    state = await readSessionState(session);
  } catch {
    throw typeof errorFactory === 'function' ? errorFactory() : errorFactory;
  }
  if (!state.authenticated) {
    throw typeof errorFactory === 'function' ? errorFactory() : errorFactory;
  }
  return state;
}

module.exports = {
  readSessionState,
  requireAuthenticatedSession,
};
