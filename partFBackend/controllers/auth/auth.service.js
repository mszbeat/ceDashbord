const { error: authError } = require('./config');

class AuthService {
  #system = process.env.PART_AUTH_SYSTEM;
  #status = 'Active';

  constructor(
    partAuthenticationInterface,
    partRequest,
    partLogger,
    sessionManager,
    samadService,
  ) {
    this.partRequest = partRequest;
    this.logger = partLogger;
    this.partAuthenticationInterface = partAuthenticationInterface;
    this.sessionManager = sessionManager
    this.samadService = samadService
  }


  #rethrowUnexpected(err) {
    if (err && typeof err === 'object' && err.statusCode && err.meta) {
      throw err;
    }
    if (this.logger && typeof this.logger.error === 'function') {
      this.logger.error(err);
    }
    if (err?.statusCode === 503) {
      throw authError.authBaseServiceError;
    }
    throw authError.internalServerError(err?.meta?.code || err?.message);
  }

  async addAuthEntry(body, trackingHeaders, session) {
    const { username, password, role } = body
    if (!username || !password) {
      throw authError.invalidAuthInput;
    }

    const targetRole = typeof role === 'string' && role.trim() ? role.trim() : 'visitor';
    let rollbackSamad = null;

    try {
      if (this.samadService) {
        rollbackSamad = await this.samadService.addUser(username, targetRole);
      }

      await this.partAuthenticationInterface.addUser(
        { username, password },
        this.#status,
        this.#system,
        trackingHeaders,
      );

      if (session && this.sessionManager) {
        const current = await this.sessionManager.getSession(session).catch(() => null);
        if (!current?.samadUsername || current.samadUsername === 'visitor') {
          await this.sessionManager.setSession(session, { username }, [targetRole]);
        }
      }

      return { status: 'ok', username, roles: [targetRole] };
    } catch (err) {
      if (typeof rollbackSamad === 'function') {
        try {
          await rollbackSamad();
        } catch (rbErr) {
          this.logger?.error?.(rbErr);
        }
      }
      if (err?.meta?.code === 'authEntryAlreadyExists') {
        throw authError.authEntryAlreadyExists;
      }
      this.#rethrowUnexpected(err);
    }
  }

  async authenticate(body, trackingHeaders, session) {
    const { username, password } = body;
    if (!username || !password) {
      throw authError.invalidAuthInput;
    }

    try {
      await this.partAuthenticationInterface.authenticate(
        { username, password },
        this.#system,
        trackingHeaders,
      );

      let roles = ['visitor'];
      if (this.samadService) {
        const samadRoles = await this.samadService.getRole(username);
        if (Array.isArray(samadRoles) && samadRoles.length) {
          roles = samadRoles;
        }
      }

      if (this.sessionManager) {
        await this.sessionManager.setSession(session, { username }, roles);
      }

      return { status: 'ok', username, roles };
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
        throw authError.invalidCredentials;
      }
      if (
        err?.statusCode === 403 ||
        code === 'userIsInactive' ||
        code === 'authEntryIsInactive' ||
        code === 'authEntryIsNotActive'
      ) {
        throw authError.userAccountInactive;
      }
      this.#rethrowUnexpected(err);
    }
  }

  async logout(session, response) {
    try {
      if (this.sessionManager) {
        await this.sessionManager.removeSession(session, response);
      }
      return { status: 'ok' };
    } catch (err) {
      this.#rethrowUnexpected(err);
    }
  }

  async getCurrentSession(session) {
    try {
      const info = this.sessionManager
        ? await this.sessionManager.getSession(session)
        : { samadUsername: 'visitor', roles: ['visitor'] };
      const username = info?.samadUsername || 'visitor';
      const roles = Array.isArray(info?.roles) && info.roles.length ? info.roles : ['visitor'];
      return {
        authenticated: username !== 'visitor',
        username,
        samadUsername: username,
        roles,
      };
    } catch (err) {
      this.#rethrowUnexpected(err);
    }
  }

  async assignRole(body, session) {
    const { username, role } = body;
    if (!username || !role) {
      throw authError.roleRequired;
    }

    try {
      await this.samadService.setRole(username, role);
      const fetchedRoles = await this.samadService.getRole(username).catch(() => [role]);
      const roles = Array.isArray(fetchedRoles) && fetchedRoles.length ? fetchedRoles : [role];

      if (session && this.sessionManager) {
        const current = await this.sessionManager.getSession(session).catch(() => null);
        if (current?.samadUsername === username) {
          await this.sessionManager.setSession(session, { username }, roles);
        }
      }

      return { status: 'ok', username, roles };
    } catch (err) {
      this.#rethrowUnexpected(err);
    }
  }

  async getUserRoles(queryOrBody) {
    const { username } = queryOrBody
    if (!username) {
      throw authError.usernameRequired;
    }

    try {
      const roles = await this.samadService.getRole(username);
      return { username, roles };
    } catch (err) {
      this.#rethrowUnexpected(err);
    }
  }

  async removeUser(body, trackingHeaders, session, response) {
    const parsed =
      typeof body === 'string' && !body.trim().startsWith('{')
        ? { username: body.trim() }
        : body
    const { username } = parsed;

    if (!username) {
      throw authError.usernameRequired;
    }

    try {
      await this.partAuthenticationInterface.removeUser(
        { username },
        this.#system,
        trackingHeaders,
      );

      if (this.samadService) {
        try {
          await this.samadService.removeUser(username);
        } catch (samadErr) {
          if (samadErr?.statusCode !== 404) throw samadErr;
        }
      }

      if (session && this.sessionManager) {
        const current = await this.sessionManager.getSession(session).catch(() => null);
        if (current?.samadUsername === username) {
          await this.sessionManager.removeSession(session, response);
        }
      }

      return { status: 'ok', username };
    } catch (err) {
      const code = err?.meta?.code;
      if (
        err?.statusCode === 404 ||
        code === 'authEntryNotFound' ||
        code === 'userNotFound'
      ) {
        throw authError.userNotFound;
      }
      this.#rethrowUnexpected(err);
    }
  }

  async setRole(body, session) {
    return this.assignRole(body, session);
  }

  async removeAuthEntry(body, trackingHeaders, session, response) {
    return this.removeUser(body, trackingHeaders, session, response);
  }

  async login(body, trackingHeaders, session) {
    return this.authenticate(body, trackingHeaders, session);
  }
}

module.exports = AuthService;
