const BaseController = require('@partFramework/baseController');
const { readBody, readQuery, readClientMeta } = require('../../services/http/request');
const { requireAuthenticatedSession } = require('../../services/http/session-guard');
const { error: authError } = require('./config');

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

  async register(body, trackingHeaders, session, request, response) {
    const payload = readBody(body);
    if (!payload.username || !payload.password) throw authError.invalidAuthInput;

    const role = typeof payload.role === 'string' && payload.role.trim() ? payload.role.trim() : 'visitor';
    const shouldAutoLogin = payload.autoLogin !== false;
    let rollback = null;

    try {
      if (this.samadService) {
        rollback = await this.samadService.addUser(payload.username, role);
      }
      await this.authService.addUser({ username: payload.username, password: payload.password }, trackingHeaders);

      if (shouldAutoLogin && session && this.sessionManager) {
        const current = await this.sessionManager.getSession(session).catch(() => null);
        if (!current?.samadUsername || current.samadUsername === 'visitor') {
          await this.sessionManager.setSession(session, { username: payload.username }, [role]);
          if (typeof this.sessionManager.issueRefreshToken === 'function' && response) {
            const meta = readClientMeta(request);
            await this.sessionManager.issueRefreshToken(
              {
                username: payload.username,
                roles: [role],
                rememberMe: payload.rememberMe === true,
                ip: meta.ip,
                userAgent: meta.headers?.['user-agent'],
              },
              response,
              request,
            );
          }
        }
      }
      return { status: 'ok', username: payload.username, roles: [role] };
    } catch (err) {
      if (typeof rollback === 'function') {
        try {
          await rollback();
        } catch {
          // rollback بهترین‌تلاش
        }
      }
      throw err;
    }
  }

  async login(body, trackingHeaders, session, request, response) {
    const payload = readBody(body);
    if (!payload.username || !payload.password) throw authError.invalidAuthInput;

    await this.authService.authenticate(
      { username: payload.username, password: payload.password },
      trackingHeaders,
    );

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

    return {
      status: 'ok',
      authenticated: true,
      username: payload.username,
      samadUsername: payload.username,
      roles,
      ...timings,
    };
  }

  async refresh(body, session, request, response) {
    const payload = readBody(body);
    const rawRefresh = this.sessionManager.extractRefreshToken(request, payload);
    if (!rawRefresh) {
      this.sessionManager.clearRefreshCookie(response, request);
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
          throw authError.invalidRefreshToken;
        }
        // اگر سرویس سمد موقتاً 503 داد، از نقش ذخیره‌شدهٔ همین سشن استفاده می‌کنیم
        if (err?.statusCode !== 503) throw err;
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

    return {
      status: 'ok',
      authenticated: true,
      username: rotated.username,
      samadUsername: rotated.username,
      roles: activeRoles,
      ...this.sessionManager.getTokenTimings(rotated),
    };
  }

  async logout(session, response, request) {
    await this.sessionManager.removeSession(session, response, request);
    return { status: 'ok' };
  }

  async me(session, request) {
    if (typeof this.sessionManager.getSessionStatus === 'function') {
      return this.sessionManager.getSessionStatus(session, request);
    }
    return this.sessionManager.getSessionInfo(session);
  }

  async assignRole(body, session) {
    await requireAuthenticatedSession(session, () => authError.unauthorizedSession);
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
    return { status: 'ok', username: payload.username, roles };
  }

  async getRole(queryString, session) {
    await requireAuthenticatedSession(session, () => authError.unauthorizedSession);
    const query = readQuery(queryString);
    if (!query.username) throw authError.usernameRequired;
    const roles = await this.samadService.getRole(query.username);
    return { username: query.username, roles };
  }

  async removeUser(body, trackingHeaders, session, response) {
    await requireAuthenticatedSession(session, () => authError.unauthorizedSession);
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
    return { status: 'ok', username: payload.username };
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config'),
);
