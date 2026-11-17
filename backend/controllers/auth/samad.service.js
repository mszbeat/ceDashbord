const { error: authError } = require('./config');
const { getActionLogger } = require('../../services/logger/action-logger.service');

class SamadService {
  constructor(httpClient) {
    this.httpClient = httpClient;
    this.org = process.env.SAMAD_ORG || process.env.org || 'mohammadsadeghZarei';
  }

  #assertReady() {
    if (!this.httpClient) throw authError.samadBaseServiceError('samad http client not injected');
  }

  #rethrow(err, operation = 'unknown') {
    if (err && typeof err === 'object' && err.statusCode && err.meta) throw err;
    const code = err?.meta?.code || err?.data?.code;
    getActionLogger().error({
      category: 'auth',
      action: `samad.${operation}.error`,
      errorCode: code || 'SAMAD_ERROR',
      statusCode: Number(err?.statusCode) || 503,
      message: err?.message || 'Samad service error',
      meta: { operation, meta: err?.meta, data: err?.data },
    });
    if (code === 'permissionDenied') throw authError.samadPermissionDenied;
    if (code === 'roleNotFound') throw authError.roleNotFound;
    if (code === 'userNotFound') throw authError.userNotFound;
    if (code === 'userAlreadyExists') throw authError.samadUserAlreadyExists;
    throw authError.samadBaseServiceError(err?.meta || err?.data || err?.message);
  }

  async #send(options, data) {
    this.#assertReady();
    return this.httpClient.sendHttp(options, data);
  }

  async addUser(username, role = 'visitor') {
    try {
      const result = await this.#send(
        { url: 'users', method: 'PUT' },
        { org: this.org, users: [{ username }] },
      );
      if (result?.data?.[0]?.status !== 'ok') throw authError.samadUserAlreadyExists;
    } catch (err) {
      this.#rethrow(err, 'addUser');
    }

    try {
      return await this.setRole(username, role);
    } catch (err) {
      try {
        await this.removeUser(username);
      } catch {
        // rollback بهترین‌تلاش؛ خطای اصلی پایین‌تر پرتاب می‌شود
      }
      throw err;
    }
  }

  async setRole(username, role = 'visitor') {
    try {
      const result = await this.#send(
        { url: 'users', method: 'PUT' },
        { org: this.org, roleName: role, users: [username] },
      );
      if (result?.data?.[0]?.status !== 'ok') throw authError.userNotFound;
    } catch (err) {
      this.#rethrow(err, 'setRole');
    }
    return this.removeUser.bind(this, username);
  }

  async getRole(username) {
    try {
      const result = await this.#send(
        { url: 'users', method: 'POST' },
        { org: this.org, filters: [{ username }] },
      );
      const roles = result?.data?.[0]?.roles;
      return Array.isArray(roles) ? roles : [];
    } catch (err) {
      this.#rethrow(err, 'getRole');
    }
  }

  async removeUser(username) {
    try {
      const result = await this.#send(
        { url: 'users', method: 'DELETE' },
        { org: this.org, filters: [{ username }] },
      );
      if (result?.data?.[0]?.status !== 'ok') throw authError.userNotFound;
      return 'ok';
    } catch (err) {
      this.#rethrow(err, 'removeUser');
    }
  }
}

module.exports = SamadService;
