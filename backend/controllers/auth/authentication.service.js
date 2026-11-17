'use strict';

const { error: authError } = require('./config');
const { getActionLogger } = require('../../services/logger/action-logger.service');

const STATUS = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
};

class AuthenticationService {
  #partAuthenticationInterface = null;
  #system = process.env.PART_AUTH_SYSTEM || 'ceDashboard';
  #status = STATUS.ACTIVE;

  constructor(
    partAuthenticationInterface,
    partLogger,
  ) {
    this.partLogger = partLogger;
    this.#partAuthenticationInterface = partAuthenticationInterface || this.#partAuthenticationInterface;
  }

  init(partAuthenticationInterface) {
    this.#partAuthenticationInterface = partAuthenticationInterface || this.#partAuthenticationInterface;
    return this;
  }

  #assertReady() {
    if (!this.#partAuthenticationInterface) {
      throw authError.authBaseServiceError;
    }
  }

  async addUser(body, trackingHeaders) {
    const { username, password } = body;
    if (!username || !password) {
      throw authError.invalidAuthInput;
    }
    this.#assertReady();
    try {
      return await this.#partAuthenticationInterface.addUser(
        { username, password },
        this.#status,
        this.#system,
        trackingHeaders,
      );
    } catch (err) {
      getActionLogger().warn({
        category: 'auth',
        action: 'auth.base.add_user_skipped',
        errorCode: err?.meta?.code || err?.code || 'AUTH_ADD_USER_SKIPPED',
        message: err?.message || 'Auth base addUser skipped (user may already exist)',
        meta: { targetUsername: username },
      });
    }
    return undefined;
  }

  async authenticate(credentials, trackingHeaders) {
    this.#assertReady();
    return this.#partAuthenticationInterface.authenticate(
      { username: credentials.username, password: credentials.password },
      this.#system,
      trackingHeaders,
    );
  }

  async removeUser(fields, trackingHeaders) {
    this.#assertReady();
    return this.#partAuthenticationInterface.removeUser({ username: fields.username }, this.#system, trackingHeaders);
  }
}

module.exports = AuthenticationService;
