'use strict';

const { getActionLogger } = require('../logger/action-logger.service');
const { updateAuditContext } = require('../logger/http-audit');

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
    const state = {
      authenticated: username !== 'visitor',
      username,
      roles,
    };
    if (state.authenticated) {
      updateAuditContext({ actor: state.username, roles: state.roles });
    }
    return state;
  }

  const username =
    typeof session.samadUsername === 'string' && session.samadUsername.trim()
      ? session.samadUsername.trim()
      : 'visitor';
  const roles = Array.isArray(session.roles) && session.roles.length ? session.roles : ['visitor'];
  const state = {
    authenticated: username !== 'visitor',
    username,
    roles,
  };
  if (state.authenticated) {
    updateAuditContext({ actor: state.username, roles: state.roles });
  }
  return state;
}

/**
 * تضمین می‌کند برای کاربر یک سشن احرازشده ست شده است (نه مهمان `visitor`).
 * در غیر این صورت خطای ۴۰۱ استاندارد کنترلر پرتاب می‌شود.
 */
async function requireAuthenticatedSession(session, errorFactory) {
  let state;
  try {
    state = await readSessionState(session);
  } catch (err) {
    getActionLogger().warn({
      category: 'auth',
      action: 'auth.session_read_failed',
      errorCode: 'SESSION_READ_ERROR',
      message: err?.message || 'Failed to read session',
    });
    throw typeof errorFactory === 'function' ? errorFactory() : errorFactory;
  }
  if (!state.authenticated) {
    getActionLogger().warn({
      category: 'auth',
      action: 'auth.session_denied',
      actor: state.username,
      roles: state.roles,
      statusCode: 401,
      errorCode: 'sessionRequired',
      message: 'Unauthenticated visitor session rejected',
    });
    throw typeof errorFactory === 'function' ? errorFactory() : errorFactory;
  }
  return state;
}

/**
 * نقش‌های ادمین (D1/D2). از `CE_ADMIN_ROLES` خوانده می‌شود (پیش‌فرض `admin,ce-admin`).
 * هر نقشی که با `admin` شروع شود (مثل `admin.bank`) هم پذیرفته است.
 */
const ADMIN_ROLES = String(process.env.CE_ADMIN_ROLES || 'admin,ce-admin')
  .split(',')
  .map((role) => role.trim().toLowerCase())
  .filter(Boolean);

function isAdminRoles(roles) {
  const list = Array.isArray(roles) ? roles : [];
  return list.some((role) => {
    const value = String(role || '').trim().toLowerCase();
    return value && ADMIN_ROLES.some((admin) => value === admin || value.startsWith(`${admin}.`) || value.startsWith(`${admin}:`));
  });
}

/**
 * سطح دسترسی ۲ — فقط ادمین (D1): تشخیص‌ها، دسترسی به نمونهٔ خام و هر چیز عملیاتی.
 * تفکیک صریح از سطح ۱ («کاربر وارد‌شده») چون این مسیرها داده‌های حساس/عملیاتی دارند.
 */
async function requireAdminSession(session, errorFactory) {
  const state = await requireAuthenticatedSession(session, errorFactory);
  if (!isAdminRoles(state.roles)) {
    getActionLogger().warn({
      category: 'auth',
      action: 'auth.admin_denied',
      actor: state.username,
      roles: state.roles,
      statusCode: 403,
      errorCode: 'adminRequired',
      message: 'دسترسی به این مسیر فقط برای نقش ادمین مجاز است',
    });
    const error = typeof errorFactory === 'function' ? errorFactory() : errorFactory;
    const forbidden = new Error('این مسیر فقط برای ادمین در دسترس است');
    forbidden.statusCode = 403;
    forbidden.code = 'adminRequired';
    forbidden.data = {
      code: 'adminRequired',
      message: { fa: forbidden.message, en: 'admin role required' },
    };
    void error;
    throw forbidden;
  }
  return state;
}

module.exports = {
  readSessionState,
  requireAuthenticatedSession,
  requireAdminSession,
  isAdminRoles,
  ADMIN_ROLES,
};
