'use strict';
const crypto = require('node:crypto');
const { ForbiddenError, getClientMeta } = require('../http-adapter');

/**
 * سطوح دسترسی سامانه:
 *  - کاربر عادی (user / visitor / بدون نقش خاص): مشاهدهٔ صفحهٔ اول و تحلیلهای کلی
 *  - creditEvaluation: علاوه بر تحلیلهای کلی، مجاز به درخواست و مشاهدهٔ جزئیات تکی گزارش (/api/sample/:requestId)
 *  - admin: دسترسی کامل به همهٔ بخشها (تحلیلهای کلی + جزئیات تکی گزارش + پنل مدیریت و اجرای Ingestion)
 */
const ROLES = Object.freeze({
  USER: 'user',
  CREDIT_EVALUATION: 'creditEvaluation',
  ADMIN: 'admin',
});

let customAuthResolver = null;

/**
 * قلاب اتصال سرویس احراز هویت سازمانی (مانند partAuthenticationInterface / partSamadInterface).
 * میتوانید در Program.js تابع async دلخواهتان را ثبت کنید:
 *   setAuthResolver(async (protocolRef) => ({ username: '...', roles: ['creditEvaluation'] }))
 */
function setAuthResolver(resolverFn) {
  customAuthResolver = typeof resolverFn === 'function' ? resolverFn : null;
}

function normalizeRoleName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase().replace(/[\s_-]+/g, '');
  if (lower === 'admin' || lower === 'administrator' || lower === 'superadmin') {
    return ROLES.ADMIN;
  }
  if (lower === 'creditevaluation') {
    return ROLES.CREDIT_EVALUATION;
  }
  if (lower === 'visitor' || lower === 'guest' || lower === 'user' || lower === 'viewer') {
    return ROLES.USER;
  }
  return s;
}

function extractRolesArray(input) {
  if (!input) return [];
  const rawItems = [];
  const collect = (val) => {
    if (!val) return;
    if (Array.isArray(val)) {
      for (const item of val) collect(item);
      return;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            collect(parsed);
            return;
          }
        } catch {}
      }
      for (const part of trimmed.split(/[,;\s]+/)) {
        if (part.trim()) rawItems.push(part.trim());
      }
      return;
    }
    if (typeof val === 'object') {
      if (val.name) collect(val.name);
      else if (val.role) collect(val.role);
      else if (val.code) collect(val.code);
      else if (val.title) collect(val.title);
    }
  };
  collect(input);

  const unique = [];
  for (const r of rawItems) {
    const norm = normalizeRoleName(r);
    if (norm && !unique.includes(norm)) unique.push(norm);
  }
  return unique;
}

function extractFromUserObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const roles = extractRolesArray(
    obj.roles ??
      obj.role ??
      obj.authorities ??
      obj.permissions ??
      obj.realm_access?.roles ??
      obj.user?.roles ??
      obj.user?.role ??
      obj.data?.roles ??
      obj.data?.role,
  );
  const username =
    obj.samadUsername ??
    obj.username ??
    obj.preferred_username ??
    obj.user?.samadUsername ??
    obj.user?.username ??
    obj.sub ??
    null;
  if (!roles.length && !username) return null;
  return { username: username ? String(username) : null, roles };
}

function readPartSession(session) {
  if (!session || typeof session !== 'object') return Promise.resolve(null);
  const direct = extractFromUserObject(session);
  if (direct && direct.roles.length) return Promise.resolve(direct);

  if (typeof session.get !== 'function') return Promise.resolve(direct);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(extractFromUserObject(val) || direct);
    };
    const timer = setTimeout(() => finish(null), 1500);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const maybePromise = session.get(['roles', 'role', 'samadUsername', 'username'], (err, result) => {
        clearTimeout(timer);
        if (err) return finish(null);
        finish(result);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(
          (res) => {
            clearTimeout(timer);
            finish(res);
          },
          () => {
            clearTimeout(timer);
            finish(null);
          },
        );
      } else if (session.get.length < 2) {
        clearTimeout(timer);
        finish(maybePromise);
      }
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

function verifyHs256Jwt(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header?.alg !== 'HS256') return null;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest();
    const actualSig = Buffer.from(parts[2], 'base64url');
    if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload?.exp && Date.now() >= Number(payload.exp) * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseBearerToken(headers = {}) {
  const authHeader = headers.authorization || headers.Authorization || '';
  const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function resolveAuthContext(protocolRef) {
  if (protocolRef?.authContext) return protocolRef.authContext;

  let username = null;
  let roles = [];
  let source = 'default_user';

  // ۱. قلاب سفارشی (مثلاً partAuthenticationInterface / partSamadInterface)
  if (customAuthResolver) {
    const resolved = await customAuthResolver(protocolRef);
    const parsed = extractFromUserObject(resolved);
    if (parsed) {
      username = parsed.username;
      roles = parsed.roles;
      source = 'custom_resolver';
    }
  }

  // ۲. اشیاء user / auth روی protocolRef یا request (میدلورهای partFramework)
  if (!roles.length) {
    for (const candidate of [
      protocolRef?.user,
      protocolRef?.auth,
      protocolRef?.request?.user,
      protocolRef?.request?.auth,
      protocolRef?.scope?.user,
    ]) {
      const parsed = extractFromUserObject(candidate);
      if (parsed && (parsed.roles.length || parsed.username)) {
        username = username || parsed.username;
        if (parsed.roles.length) {
          roles = parsed.roles;
          source = 'framework_context';
          break;
        }
      }
    }
  }

  // ۳. نشست partSessionManager (protocolRef.session یا protocolRef.request.session)
  if (!roles.length) {
    const sessionObj = protocolRef?.session || protocolRef?.request?.session;
    const fromSession = await readPartSession(sessionObj);
    if (fromSession) {
      username = username || fromSession.username;
      if (fromSession.roles.length) {
        roles = fromSession.roles;
        source = 'part_session';
      }
    }
  }

  const { headers } = getClientMeta(protocolRef);
  const normalizedHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    normalizedHeaders[String(k).toLowerCase()] = v;
  }

  // ۴. توکن Bearer JWT امضاشده (در صورت تنظیم AUTH_JWT_SECRET)
  const jwtSecret = process.env.AUTH_JWT_SECRET || '';
  if (!roles.length && jwtSecret) {
    const bearer = parseBearerToken(normalizedHeaders);
    const payload = verifyHs256Jwt(bearer, jwtSecret);
    const parsed = extractFromUserObject(payload);
    if (parsed) {
      username = username || parsed.username;
      if (parsed.roles.length) {
        roles = parsed.roles;
        source = 'jwt';
      }
    }
  }

  // ۵. هدرهای گیتوی مورد اعتماد (در صورت فعال بودن AUTH_TRUST_ROLE_HEADERS=true)
  const trustHeaders = (process.env.AUTH_TRUST_ROLE_HEADERS || 'false') === 'true';
  if (!roles.length && trustHeaders) {
    const headerRoles = extractRolesArray(
      normalizedHeaders['x-user-roles'] ??
        normalizedHeaders['x-user-role'] ??
        normalizedHeaders['x-part-roles'] ??
        normalizedHeaders['gateway-user-roles'],
    );
    const headerUser =
      normalizedHeaders['x-user-name'] ??
      normalizedHeaders['x-samad-username'] ??
      normalizedHeaders['gateway-username'] ??
      null;
    if (headerUser && !username) username = String(headerUser);
    if (headerRoles.length) {
      roles = headerRoles;
      source = 'trusted_headers';
    }
  }

  // ۶. نقش پیشفرض توسعه محلی (AUTH_DEV_DEFAULT_ROLE در صورت تنظیم صریح در .env)
  const devDefaultRole = process.env.AUTH_DEV_DEFAULT_ROLE || '';
  if (!roles.length && devDefaultRole) {
    roles = extractRolesArray(devDefaultRole);
    if (roles.length) source = 'dev_default';
  }

  // اگر هیچ نقش خاصی تشخیص داده نشد، کاربر عادی (user) محسوب میشود
  if (!roles.length) {
    roles = [ROLES.USER];
  }

  const isAdmin = roles.includes(ROLES.ADMIN);
  const canViewReportDetails = isAdmin || roles.includes(ROLES.CREDIT_EVALUATION);

  const context = {
    authenticated: Boolean(username) || source !== 'default_user',
    username,
    roles,
    source,
    permissions: {
      canViewDashboard: true,
      canViewReportDetails,
      canAccessAdmin: isAdmin,
    },
  };

  if (protocolRef && typeof protocolRef === 'object') {
    protocolRef.authContext = context;
  }
  return context;
}

function hasAnyRole(authContext, allowedRoles = []) {
  if (!allowedRoles || !allowedRoles.length || allowedRoles.includes('*')) return true;
  const userRoles = Array.isArray(authContext?.roles) ? authContext.roles : [];
  // نقش admin به تمام مسیرهای سامانه دسترسی کامل دارد
  if (userRoles.includes(ROLES.ADMIN)) return true;
  const normalizedAllowed = allowedRoles.map(normalizeRoleName).filter(Boolean);
  return userRoles.some((r) => normalizedAllowed.includes(r));
}

async function requireRoles(protocolRef, allowedRoles = [], options = {}) {
  const auth = await resolveAuthContext(protocolRef);
  if (!hasAnyRole(auth, allowedRoles)) {
    const message =
      options.message ||
      (allowedRoles.length === 1 && allowedRoles[0] === ROLES.ADMIN
        ? 'دسترسی غیرمجاز: ورود به پنل مدیریت و اجرای عملیات مدیریتی فقط برای نقش admin مجاز است.'
        : `دسترسی غیرمجاز: مشاهدهٔ جزئیات گزارش فقط برای نقشهای ${allowedRoles.join(' و ')} مجاز است.`);
    throw new ForbiddenError({
      code: 'FORBIDDEN_ROLE',
      message,
      requiredRoles: allowedRoles,
      roles: auth.roles,
    });
  }
  return auth;
}

module.exports = {
  ROLES,
  setAuthResolver,
  normalizeRoleName,
  extractRolesArray,
  resolveAuthContext,
  hasAnyRole,
  requireRoles,
};
