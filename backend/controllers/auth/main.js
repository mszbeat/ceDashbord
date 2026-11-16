const BaseController = require('@partFramework/baseController');
const { readBody, readQuery } = require('../../services/http/request');
const { error: authError } = require('./config');

exports.controller = class AuthController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
   * @param {AuthService} authService
   * @param {SessionManager} sessionManager
   * @param {SamadService} samadService
   * @param {AuthenticationService} authenticationService
   */
  constructor(core, schema, config, authService, sessionManager, samadService, authenticationService) {
    super(core, schema, config);
    this.authService = authService;
    this.sessionManager = sessionManager;
    this.samadService = samadService;
  }

  async register(body, trackingHeaders, session) {
    const payload = readBody(body);
    if (!payload.username || !payload.password) throw authError.invalidAuthInput;

    const role = typeof payload.role === 'string' && payload.role.trim() ? payload.role.trim() : 'visitor';
    let rollback = null;

    try {
      if (this.samadService) {
        rollback = await this.samadService.addUser(payload.username, role);
      }
      await this.authService.addUser({ username: payload.username, password: payload.password }, trackingHeaders);

      if (session && this.sessionManager) {
        const current = await this.sessionManager.getSession(session).catch(() => null);
        if (!current?.samadUsername || current.samadUsername === 'visitor') {
          await this.sessionManager.setSession(session, { username: payload.username }, [role]);
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

  async login(body, trackingHeaders, session) {
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
    return { status: 'ok', username: payload.username, roles };
  }

  async logout(session, response) {
    await this.sessionManager.removeSession(session, response);
    return { status: 'ok' };
  }

  async me(session) {
    return this.sessionManager.getSessionInfo(session);
  }

  async assignRole(body, session) {
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

  async getRole(queryString) {
    const query = readQuery(queryString);
    if (!query.username) throw authError.usernameRequired;
    const roles = await this.samadService.getRole(query.username);
    return { username: query.username, roles };
  }

  async removeUser(body, trackingHeaders, session, response) {
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
