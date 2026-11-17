'use strict';

const { error: authError } = require('./config');
const { RefreshTokenService, REFRESH_COOKIE_NAME } = require('./refresh-token.service');

function readCookieHeader(request) {
  const candidates = [
    request?.headers?.cookie,
    request?.header?.cookie,
    request?.req?.headers?.cookie,
    request?.request?.headers?.cookie,
  ];
  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim()) return cand;
  }
  const rawHeaders = request?.rawHeaders || request?.req?.rawHeaders;
  if (Array.isArray(rawHeaders)) {
    for (let i = 0; i < rawHeaders.length - 1; i += 2) {
      if (String(rawHeaders[i]).toLowerCase() === 'cookie' && rawHeaders[i + 1]) {
        return String(rawHeaders[i + 1]);
      }
    }
  }
  return '';
}

function parseCookies(request) {
  const out = {};
  if (request?.cookies && typeof request.cookies === 'object' && !Array.isArray(request.cookies)) {
    for (const [k, v] of Object.entries(request.cookies)) {
      if (k && typeof v === 'string') out[k] = v;
    }
  }
  const rawCookie = readCookieHeader(request);
  if (!rawCookie || typeof rawCookie !== 'string') return out;
  for (const part of rawCookie.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    const val = part.slice(eqIndex + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function resolveResponseTarget(response) {
  const candidates = [
    response?.response?.res,
    response?.response,
    response?.res,
    response,
  ];
  for (const target of candidates) {
    if (target && typeof target.setHeader === 'function') return target;
  }
  return null;
}

function isSecureRequest(request) {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  const proto =
    request?.headers?.['x-forwarded-proto'] ||
    request?.req?.headers?.['x-forwarded-proto'] ||
    request?.protocol ||
    '';
  return String(proto).toLowerCase().split(',')[0].trim() === 'https';
}

function appendSetCookies(response, newCookies) {
  const target = resolveResponseTarget(response);
  if (!target) return;
  let existingRaw;
  if (typeof target.getHeader === 'function') {
    existingRaw = target.getHeader('Set-Cookie');
    if (existingRaw === undefined) {
      existingRaw = target.getHeader('set-cookie');
    }
  }
  const existing = Array.isArray(existingRaw)
    ? existingRaw.map(String)
    : existingRaw
      ? [String(existingRaw)]
      : [];
  const next = [...existing, ...newCookies.map(String)];
  target.setHeader('Set-Cookie', next);
}

/**
 * مدیریت سشن کاربر (Promise-based روی session فریم‌ورک) + مدیریت رفرش‌توکن (HttpOnly Cookie).
 *
 * در `partFramework@10.2.0` با `checkAccess(true)` روی روت، نمونهٔ سشن به‌عنوان
 * `_session` به هندلر تزریق می‌شود؛ همان قراردادی که `samplePF/utils/sessionManager`
 * استفاده می‌کند: `session.get / session.set / session.remove` با callback.
 */
class SessionManager {
  constructor(options = {}) {
    this.refreshTokens = options.refreshTokenService || new RefreshTokenService(options);
  }

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

  removeSession = async (session, response, request) => {
    const rawRefresh = this.extractRefreshToken(request);
    if (rawRefresh) {
      await this.refreshTokens.revoke(rawRefresh).catch(() => {});
    }
    this.#clearCookie(response, request);
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
   * اطلاعات پایهٔ سشن (سازگار با تست‌های واحد).
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

  /**
   * اطلاعات کامل سشن به همراه وضعیت رفرش‌توکن و زمان‌های انقضای Access Token برای کلاینت.
   */
  getSessionStatus = async (session, request) => {
    const base = await this.getSessionInfo(session);
    const timings = this.refreshTokens.getTimings();
    const rawRefresh = this.extractRefreshToken(request);
    const peeked = rawRefresh ? await this.refreshTokens.peek(rawRefresh).catch(() => ({ valid: false })) : { valid: false };
    return {
      ...base,
      canRefresh: Boolean(peeked.valid),
      refreshExpiresAt: peeked.valid && peeked.expiresAt ? peeked.expiresAt.toISOString() : null,
      accessExpireMs: timings.accessExpireMs,
      idleExpireMs: timings.idleExpireMs,
    };
  };

  extractRefreshToken(request, bodyPayload) {
    const cookies = parseCookies(request);
    if (cookies[REFRESH_COOKIE_NAME]) return cookies[REFRESH_COOKIE_NAME];
    if (typeof bodyPayload?.refreshToken === 'string' && bodyPayload.refreshToken.trim()) {
      return bodyPayload.refreshToken.trim();
    }
    return null;
  }

  getTokenTimings(issued) {
    const timings = this.refreshTokens.getTimings();
    return {
      accessExpireMs: timings.accessExpireMs,
      idleExpireMs: timings.idleExpireMs,
      refreshExpiresAt: issued?.expiresAt ? new Date(issued.expiresAt).toISOString() : null,
    };
  }

  async issueRefreshToken(details, response, request) {
    const issued = await this.refreshTokens.issue(details);
    this.#setRefreshCookie(response, request, issued.rawToken, issued.ttlMs, issued.expiresAt);
    return issued;
  }

  async peekRefreshToken(rawToken) {
    return this.refreshTokens.peek(rawToken);
  }

  async rotateRefreshToken(rawToken, options, response, request) {
    try {
      const rotated = await this.refreshTokens.rotate(rawToken, options);
      this.#setRefreshCookie(response, request, rotated.rawToken, rotated.ttlMs, rotated.expiresAt);
      return rotated;
    } catch (err) {
      this.clearRefreshCookie(response, request);
      throw err;
    }
  }

  async revokeRefreshToken(rawToken, response, request) {
    if (rawToken) {
      await this.refreshTokens.revoke(rawToken).catch(() => {});
    }
    this.clearRefreshCookie(response, request);
  }

  async revokeUserRefreshTokens(username) {
    await this.refreshTokens.revokeUser(username).catch(() => {});
  }

  #setRefreshCookie(response, request, rawToken, ttlMs, expiresAt) {
    if (!resolveResponseTarget(response)) return;
    const maxAgeSec = Math.max(1, Math.floor(Number(ttlMs) / 1000));
    const securePart = isSecureRequest(request) ? ' Secure;' : '';
    const domainEnv = process.env.COOKIE_DOMAIN ? ` Domain=${process.env.COOKIE_DOMAIN};` : '';
    const expiresPart = expiresAt ? ` Expires=${new Date(expiresAt).toUTCString()};` : '';
    const cookie = `${REFRESH_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/;${domainEnv} Max-Age=${maxAgeSec};${expiresPart} HttpOnly; SameSite=Lax;${securePart}`;
    appendSetCookies(response, [cookie]);
  }

  clearRefreshCookie(response, request) {
    if (!resolveResponseTarget(response)) return;
    const securePart = isSecureRequest(request) ? ' Secure;' : '';
    const cookies = [
      `${REFRESH_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax;${securePart}`,
    ];
    if (process.env.COOKIE_DOMAIN) {
      cookies.push(
        `${REFRESH_COOKIE_NAME}=; Path=/; Domain=${process.env.COOKIE_DOMAIN}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax;${securePart}`,
      );
    }
    appendSetCookies(response, cookies);
  }

  #clearCookie(response, request) {
    if (!resolveResponseTarget(response)) return;
    const domain = process.env.COOKIE_DOMAIN || 'localhost';
    const securePart = isSecureRequest(request) ? ' Secure;' : '';
    const cookies = [
      'token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;',
      `token=; Path=/; Domain=${domain}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;`,
      `${REFRESH_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax;${securePart}`,
    ];
    if (process.env.COOKIE_DOMAIN) {
      cookies.push(
        `${REFRESH_COOKIE_NAME}=; Path=/; Domain=${process.env.COOKIE_DOMAIN}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax;${securePart}`,
      );
    }
    appendSetCookies(response, cookies);
  }
}

module.exports = SessionManager;
