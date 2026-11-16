'use strict';

const { error: authError } = require('./config');

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
    partLogger
  ) {
    this.partLogger = partLogger;
    this.#partAuthenticationInterface = partAuthenticationInterface || this.#partAuthenticationInterface;
  }

  async addUser(body, trackingHeaders) {
    const { username, password } = body;
    if (!username || !password) {
      throw authError.invalidAuthInput
    }
    try {
      this.#partAuthenticationInterface.addUser(
        { username, password },
        this.#status,
        this.#system,
        trackingHeaders,
      );
    }
    catch (err) {

    }
    return
  }

  async authenticate(credentials, trackingHeaders) {
    return this.#partAuthenticationInterface.authenticate(
      { username: credentials.username, password: credentials.password },
      this.#system,
      trackingHeaders,
    );
  }

  async removeUser(fields, trackingHeaders) {
    return this.#partAuthenticationInterface.removeUser({ username: fields.username }, this.#system, trackingHeaders);
  }
}

module.exports = AuthenticationService;
