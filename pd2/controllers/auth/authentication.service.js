'use strict';

const { error: authError } = require('./config');

const STATUS = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
};

/**
 * لایهٔ نازک روی `partAuthenticationInterface`.
 *
 * در `partFramework@10.2.0` این پکیج از طریق `loaderConf`/`configs` تزریق می‌شود
 * (مانند `authentication` در `samplePF/services/authentication`).
 * این کلاس همان قرارداد را برای pd2 پیاده می‌کند تا سرویس اصالت‌سنجی
 * به‌صورت یک وابستگی تزریقی در دسترس کنترلر باشد.
 *
 * API عمومی:
 *   init(partAuthenticationInterface)  — تزریق نمونهٔ پکیج
 *   addUser({ username, password }, trackingHeaders)
 *   authenticate({ username, password }, trackingHeaders)
 *   removeUser({ username }, trackingHeaders)
 */
class AuthenticationService {
  #partAuthenticationInterface = null;
  #system = process.env.PART_AUTH_SYSTEM || 'ceDashboard';
  #status = STATUS.ACTIVE;

  init(partAuthenticationInterface) {
    this.#partAuthenticationInterface = partAuthenticationInterface || this.#partAuthenticationInterface;
    return this;
  }

  #assertReady() {
    if (!this.#partAuthenticationInterface) {
      throw authError.authBaseServiceError;
    }
  }

  async addUser(credentials, trackingHeaders) {
    this.#assertReady();
    return this.#partAuthenticationInterface.addUser(
      { username: credentials.username, password: credentials.password },
      this.#status,
      this.#system,
      trackingHeaders,
    );
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
