const { error: authError } = require('./config');

class SamadService {
  constructor(httpClient) {
    this.org = process.env.SAMAD_ORG || process.env.org;
    if (httpClient) {
      this.samadService = httpClient;
    } else {
      const PartRequest = require('partRequest');
      const pr = new PartRequest();
      this.samadService = new pr({
        defaultHttpRequestOptions: {
          baseURL: process.env.SAMAD_SERVICE_URL || process.env.samadServiceUrl,
          headers: {
            user: process.env.SAMAD_USER || process.env.user,
            pass: process.env.SAMAD_PASS || process.env.pass,
          },
          timeout: 7000,
          protocol: 'http',
        },
      });
    }
  }

  #rethrowSamadError(err) {
    if (err && typeof err === 'object' && err.statusCode && err.meta) {
      throw err;
    }
    const code = err?.meta?.code;
    if (code === 'permissionDenied') throw authError.samadPermissionDenied;
    if (code === 'roleNotFound') throw authError.roleNotFound;
    if (code === 'userNotFound') throw authError.userNotFound;
    if (code === 'userAlreadyExists') throw authError.samadUserAlreadyExists;
    throw authError.samadBaseServiceError(err?.meta || err?.data || err?.message);
  }

  async addUser(username, role = 'visitor') {
    let createdInSamad = false;
    try {
      const data = {
        org: this.org,
        users: [{ username }],
      };
      const options = {
        url: 'users',
        method: 'PUT',
      };
      const addRes = await this.samadService.sendHttp(options, data);
      const status = addRes?.data?.[0]?.status;
      if (status !== 'ok') {
        throw authError.samadUserAlreadyExists;
      }
      createdInSamad = true;
      return await this.setRole(username, role);
    } catch (err) {
      if (createdInSamad) {
        try {
          await this.removeUser(username);
        } catch {}
      }
      this.#rethrowSamadError(err);
    }
  }

  async removeUser(username) {
    try {
      const data = {
        org: this.org,
        filters: [{ username }],
      };
      const options = {
        url: 'users',
        method: 'DELETE',
      };
      const removeRes = await this.samadService.sendHttp(options, data);
      const status = removeRes?.data?.[0]?.status;
      if (status !== 'ok') {
        throw authError.userNotFound;
      }
      return 'ok';
    } catch (err) {
      this.#rethrowSamadError(err);
    }
  }

  async setRole(username, role = 'visitor') {
    try {
      const data = {
        org: this.org,
        roleName: role,
        users: [username],
      };
      const options = {
        url: 'users',
        method: 'PUT',
      };
      const setRes = await this.samadService.sendHttp(options, data);
      const status = setRes?.data?.[0]?.status;
      if (status !== 'ok') {
        throw authError.userNotFound;
      }
      return this.removeUser.bind(this, username);
    } catch (err) {
      this.#rethrowSamadError(err);
    }
  }

  async getRole(username) {
    try {
      const data = {
        org: this.org,
        filters: [{ username }],
      };
      const options = {
        url: 'users',
        method: 'POST',
      };
      const getInfo = await this.samadService.sendHttp(options, data);
      const roles = getInfo?.data?.[0]?.roles;
      return Array.isArray(roles) ? roles : [];
    } catch (err) {
      this.#rethrowSamadError(err);
    }
  }
}

module.exports = SamadService;
