const BaseController = require('@partFramework/baseController');
const { readBody, readQuery, readClientMeta } = require('../../services/http/request');
const { requireAuthenticatedSession } = require('../../services/http/session-guard');
const { getActionLogger } = require('../../services/logger/action-logger.service');
const { updateAuditContext } = require('../../services/logger/http-audit');
const { isBffBridgeRequest: verifyBffBridge, sharedSecret } = require('../../services/http/bff-bridge');
const { error: authError } = require('./config');

/**
 * فاش‌کردن کوکی‌های HttpOnly در بدنهٔ JSON فقط برای درخواستِ **امضاشده**ی Next.js.
 *
 * 🐞 قبلاً صرف وجود هدر خام `x-ce-bff: 1` کافی بود. بک‌اند به‌طور پیش‌فرض روی
 * `0.0.0.0` گوش می‌دهد، پس اگر پورت از بیرون قابل دسترسی بود، هر کسی می‌توانست
 * `ce_refresh` (رفرش‌توکن ۱۴روزه) را در بدنهٔ پاسخ بخواند — یعنی دور زدن کامل HttpOnly.
 *
 * حالا: امضای HMAC الزامی است؛ بدون secret فقط شبکهٔ خصوصی/داخلی (loopback + RFC1918 +
 * link-local + CGNAT + ULA) و فقط برای سازگاری با نسخهٔ قبلی Next پذیرفته می‌شود.
 * هر رد شدن در لاگ با سطح **error** نوشته می‌شود (نه silent) تا اگر استقرار دو‌هاستی
 * بدون `CE_BFF_SHARED_SECRET` انجام شود، علت «ورود کار نمی‌کند» بلافاصله دیده شود.
 */
function isBffBridgeRequest(request) {
  const verdict = verifyBffBridge(request, { cookies: readCookieFromRequest(request) });
  if (!verdict.ok) {
    if (verdict.statusCode === 403) {
      // ⚠️ این مسیر نباید silent باشد: امضای نامعتبر، یعنی یا استقرار دو‌هاستی بدون
      // کلید انجام شده، یا یک مهاجم/پروکسی بد رفتار است. هر دو را باید دید.
      const meta = { reason: verdict.reason, mode: verdict.mode };
      try {
        getActionLogger().error({
          category: 'auth',
          action: 'auth.bff.bridge_rejected',
          errorCode: 'BFF_BRIDGE_REJECTED',
          statusCode: 403,
          message: `Unsigned/invalid BFF bridge request rejected: ${verdict.reason}`,
          meta,
        });
      } catch { /* لاگر آماده نیست */ }
      try {
        // حتی اگر لاگر فایل/DB غیرفعال است، باید در خروجی سرویس دیده شود
        console.error('[auth.bff.bridge_rejected]', JSON.stringify(meta));
      } catch { /* بیایید silent نماند */ }
    }
    return false;
  }
  if (verdict.mode === 'legacy-internal' && sharedSecret()) {
    try {
      getActionLogger().warn({
        category: 'auth',
        action: 'auth.bff.legacy_bridge_used',
        message: 'BFF bridge accepted via legacy x-ce-bff on an internal/private address; set CE_BFF_SHARED_SECRET to sign requests',
      });
    } catch {
      // ignore
    }
  }
  return true;
}

function readCookieFromRequest(request) {
  const candidates = [
    request?.headers?.cookie,
    request?.header?.cookie,
    request?.req?.headers?.cookie,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function withBffBridgedCookies(payload, request, response) {
  if (!isBffBridgeRequest(request)) return payload;
  const cookies =
    (Array.isArray(request?.__cePendingSetCookies) && request.__cePendingSetCookies.length
      ? request.__cePendingSetCookies
      : null) ||
    (Array.isArray(response?.__cePendingSetCookies) && response.__cePendingSetCookies.length
      ? response.__cePendingSetCookies
      : null);
  if (cookies && cookies.length) {
    return { ...payload, _ceSetCookies: cookies };
  }
  return payload;
}

exports.controller = class AuthController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
   * @param {AuthService} authService
   * @param {SessionManager} sessionManager
   * @param {SamadService} samadService
   */
  constructor(core, schema, config, authService, sessionManager, samadService) {
    super(core, schema, config);
    this.authService = authService;
    this.sessionManager = sessionManager;
    this.samadService = samadService;
  }

  async register() {
    // Public self-service registration is disabled; accounts are provisioned by service staff.
    throw authError.registrationDisabled;
  }

  async login(body, trackingHeaders, session, request, response) {
    if (this.sessionManager && typeof this.sessionManager.ensureResponseCookieNormalization === 'function') {
      this.sessionManager.ensureResponseCookieNormalization(response, request);
    }
    const payload = readBody(body);
    if (!payload.username || !payload.password) throw authError.invalidAuthInput;

    try {
      await this.authService.authenticate(
        { username: payload.username, password: payload.password },
        trackingHeaders,
      );
    } catch (err) {
      getActionLogger().warn({
        category: 'auth',
        action: 'auth.login.failed',
        actor: payload.username,
        errorCode: err?.meta?.code || err?.code || 'LOGIN_FAILED',
        statusCode: Number(err?.statusCode) || 401,
        message: err?.data?.message?.en || err?.message || 'Authentication failed',
      });
      throw err;
    }

    let roles = ['visitor'];
    if (this.samadService) {
      const samadRoles = await this.samadService.getRole(payload.username);
      if (Array.isArray(samadRoles) && samadRoles.length) roles = samadRoles;
    }

    if (this.sessionManager) {
      await this.sessionManager.setSession(session, { username: payload.username }, roles);
    }

    let timings = {};
    if (this.sessionManager && typeof this.sessionManager.issueRefreshToken === 'function') {
      const meta = readClientMeta(request);
      const issued = await this.sessionManager.issueRefreshToken(
        {
          username: payload.username,
          roles,
          rememberMe: payload.rememberMe === true,
          ip: meta.ip,
          userAgent: meta.headers?.['user-agent'],
        },
        response,
        request,
      );
      timings = this.sessionManager.getTokenTimings(issued);
    }

    updateAuditContext({ actor: payload.username, roles });
    getActionLogger().info({
      category: 'auth',
      action: 'auth.login.success',
      actor: payload.username,
      roles,
      statusCode: 200,
      meta: { rememberMe: payload.rememberMe === true },
    });

    return withBffBridgedCookies(
      {
        status: 'ok',
        authenticated: true,
        username: payload.username,
        samadUsername: payload.username,
        roles,
        ...timings,
      },
      request,
      response,
    );
  }

  async refresh(body, session, request, response) {
    if (this.sessionManager && typeof this.sessionManager.ensureResponseCookieNormalization === 'function') {
      this.sessionManager.ensureResponseCookieNormalization(response, request);
    }
    const payload = readBody(body);
    const rawRefresh = this.sessionManager.extractRefreshToken(request, payload);
    if (!rawRefresh) {
      this.sessionManager.clearRefreshCookie(response, request);
      getActionLogger().warn({
        category: 'auth',
        action: 'auth.refresh.missing',
        statusCode: 401,
        errorCode: 'refreshTokenRequired',
        message: 'Refresh token cookie missing',
      });
      throw authError.refreshTokenRequired;
    }

    const peeked = await this.sessionManager.peekRefreshToken(rawRefresh);
    let roles = peeked.valid ? peeked.roles : null;

    if (peeked.valid && this.samadService) {
      try {
        const samadRoles = await this.samadService.getRole(peeked.username);
        roles = Array.isArray(samadRoles) && samadRoles.length ? samadRoles : ['visitor'];
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 403) {
          await this.sessionManager.revokeRefreshToken(rawRefresh, response, request);
          getActionLogger().warn({
            category: 'auth',
            action: 'auth.refresh.user_revoked',
            actor: peeked.username,
            statusCode: 401,
            errorCode: 'invalidRefreshToken',
            message: 'Refresh token revoked because Samad user missing or denied',
          });
          throw authError.invalidRefreshToken;
        }
        // در خطاهای موقت سمد (503/5xx/شبکه)، از نقش ذخیره‌شدهٔ همین سشن استفاده می‌کنیم
      }
    }

    const meta = readClientMeta(request);
    const rotated = await this.sessionManager.rotateRefreshToken(
      rawRefresh,
      {
        roles,
        ip: meta.ip,
        userAgent: meta.headers?.['user-agent'],
      },
      response,
      request,
    );

    const activeRoles = Array.isArray(rotated.roles) && rotated.roles.length ? rotated.roles : ['visitor'];
    await this.sessionManager.setSession(session, { username: rotated.username }, activeRoles);

    updateAuditContext({ actor: rotated.username, roles: activeRoles });
    getActionLogger().info({
      category: 'auth',
      action: 'auth.refresh.success',
      actor: rotated.username,
      roles: activeRoles,
      statusCode: 200,
    });

    return withBffBridgedCookies(
      {
        status: 'ok',
        authenticated: true,
        username: rotated.username,
        samadUsername: rotated.username,
        roles: activeRoles,
        ...this.sessionManager.getTokenTimings(rotated),
      },
      request,
      response,
    );
  }

  /**
   * GET /api/auth/refresh/peek
   * فقط اعتبار کوکی رفرش را گزارش می‌کند و توکن را نمی‌چرخاند. لایهٔ BFF پیش از
   * تمدید واقعی از این مسیر استفاده می‌کند تا توکنِ باطل/چرخیده ارسال نشود
   * (چرخش دوبارهٔ توکنِ مصرف‌شده باعث ابطال کل خانوادهٔ توکن می‌شود).
   */
  async refreshPeek(body, session, request) {
    const rawRefresh = this.sessionManager.extractRefreshToken(request);
    if (!rawRefresh) {
      return { status: 'ok', valid: false, reason: 'missing', authenticated: false };
    }
    const peeked = await this.sessionManager.peekRefreshToken(rawRefresh);
    return {
      status: 'ok',
      valid: peeked.valid === true,
      reason: peeked.valid ? null : peeked.reason || 'invalid',
      authenticated: session ? Boolean(session.authenticated) : false,
      username: peeked.valid ? peeked.username : null,
      expiresAt: peeked.valid && peeked.expiresAt ? new Date(peeked.expiresAt).toISOString() : null,
    };
  }

  async logout(session, response, request) {
    if (this.sessionManager && typeof this.sessionManager.ensureResponseCookieNormalization === 'function') {
      this.sessionManager.ensureResponseCookieNormalization(response, request);
    }
    const before = await this.sessionManager.getSessionInfo(session).catch(() => null);
    await this.sessionManager.removeSession(session, response, request);
    if (before?.authenticated) {
      updateAuditContext({ actor: before.username, roles: before.roles });
    }
    getActionLogger().info({
      category: 'auth',
      action: 'auth.logout',
      actor: before?.authenticated ? before.username : 'visitor',
      roles: before?.roles || ['visitor'],
      statusCode: 200,
    });
    return withBffBridgedCookies({ status: 'ok' }, request, response);
  }

  async me(session, request, response) {
    if (this.sessionManager && typeof this.sessionManager.ensureResponseCookieNormalization === 'function') {
      this.sessionManager.ensureResponseCookieNormalization(response, request);
    }
    const status =
      typeof this.sessionManager.getSessionStatus === 'function'
        ? await this.sessionManager.getSessionStatus(session, request)
        : await this.sessionManager.getSessionInfo(session);
    if (status?.authenticated) {
      updateAuditContext({ actor: status.username, roles: status.roles });
    }
    return status;
  }

  async assignRole(body, session) {
    const actor = await requireAuthenticatedSession(session, () => authError.unauthorizedSession);
    const payload = readBody(body);
    if (!payload.username || !payload.role) throw authError.roleRequired;

    await this.samadService.setRole(payload.username, payload.role);
    const fetched = await this.samadService.getRole(payload.username).catch(() => [payload.role]);
    const roles = Array.isArray(fetched) && fetched.length ? fetched : [payload.role];

    if (session && this.sessionManager) {
      const current = await this.sessionManager.getSession(session).catch(() => null);
      if (current?.samadUsername === payload.username) {
        await this.sessionManager.setSession(session, { username: payload.username }, roles);
      }
    }
    getActionLogger().info({
      category: 'auth',
      action: 'auth.role.assign',
      actor: actor.username,
      roles: actor.roles,
      statusCode: 200,
      meta: { targetUsername: payload.username, assignedRoles: roles },
    });
    return { status: 'ok', username: payload.username, roles };
  }

  async getRole(queryString, session) {
    const actor = await requireAuthenticatedSession(session, () => authError.unauthorizedSession);
    const query = readQuery(queryString);
    if (!query.username) throw authError.usernameRequired;
    const roles = await this.samadService.getRole(query.username);
    getActionLogger().info({
      category: 'auth',
      action: 'auth.role.read',
      actor: actor.username,
      roles: actor.roles,
      statusCode: 200,
      meta: { targetUsername: query.username, roles },
    });
    return { username: query.username, roles };
  }

  async removeUser(body, trackingHeaders, session, response) {
    const actor = await requireAuthenticatedSession(session, () => authError.unauthorizedSession);
    const payload = readBody(body);
    if (!payload.username) throw authError.usernameRequired;

    await this.authService.removeUser({ username: payload.username }, trackingHeaders);

    if (this.samadService) {
      try {
        await this.samadService.removeUser(payload.username);
      } catch (err) {
        if (err?.statusCode !== 404) throw err;
      }
    }

    if (this.sessionManager && typeof this.sessionManager.revokeUserRefreshTokens === 'function') {
      await this.sessionManager.revokeUserRefreshTokens(payload.username);
    }

    if (session && this.sessionManager) {
      const current = await this.sessionManager.getSession(session).catch(() => null);
      if (current?.samadUsername === payload.username) {
        await this.sessionManager.removeSession(session, response);
      }
    }
    getActionLogger().info({
      category: 'auth',
      action: 'auth.user.remove',
      actor: actor.username,
      roles: actor.roles,
      statusCode: 200,
      meta: { removedUsername: payload.username },
    });
    return { status: 'ok', username: payload.username };
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config'),
);
