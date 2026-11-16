
const PartRequest = require('partRequest');
const pr = new PartRequest();

class SamadService {
  org = process.env.org;
  samadService = new pr({
    defaultHttpRequestOptions: {
      baseURL: process.env.samadServiceUrl,
      headers: {
        user: process.env.user,
        pass: process.env.pass,
      },
      timeout: 7000,
      protocol: 'http'
    }
  });
  
  
  async addUser  (username, role)  {
    try {
      const data = {
        org: this.org,
        users: [{ username }]
      };
      const options = {
        url: 'users',
        method: 'PUT'
      };
      const addUser = await this.samadService.sendHttp(options, data);
      const status = addUser?.data[0].status;
      if (status !== 'ok') {
        const error = errorReturner(addUser, 409, 'userAlreadyExists');
        throw error;
      }
      else {
        const rollback = await this.setRole(username, role);
        return rollback;
      }
    }
    catch (err) {
      if (err?.setRole) {
        await this.removeUser(username);
      }
      catchHandler(err);
    }
  }

  async removeUser  (username) {
    try {
      const data = {
        org: this.org,
        filters: [{ 'username': username }]
      };
      const options = {
        url: 'users',
        method: 'DELETE'
      };
      const removeUser = await this.samadService.sendHttp(options, data);
      const status = removeUser?.data[0].status;
      if (status !== 'ok') {
        const error = errorReturner(removeUser, 404, 'userNotFound');
        throw error;
      }
    }
    catch (err) {
      catchHandler(err);
    }
  }

  async setRole  (username, role = 'visitor') {
    try {
      const data = {
        org: this.org,
        roleName: role,
        users: [username]
      };
      const options = {
        url: 'users',
        method: 'PUT'
      };
      const setRole = await this.samadService.sendHttp(options, data);
      const status = setRole?.data[0].status;
      if (status !== 'ok') {
        const error = errorReturner(setRole, 404, 'userNotFound');
        throw error;
      }
      else {
        const rollback = this.removeUser.bind(this,username);
        return rollback;
      }
    }
    catch (err) {
      err.setRole = true;
      catchHandler(err);
    }
  }

  async getRole  (username) {
    const data = {
      org: this.org,
      filters: [{ 'username': username }]
    };
    const options = {
      url: 'users',
      method: 'POST'
    };
    const getInfo = await this.samadService.sendHttp(options, data);
    return getInfo?.data[0].roles;
  }
}


const errorReturner = (err, statusCode, code = 'badRequest') => {
  return {
    statusCode,
    meta: {
      code: code,
      sourceName: 'partServiceSamad',
      requestId: err?.meta?.requestId || 'unknown'
    },
    data: err?.data || {}
  };
};


const catchHandler = (err) => {
  if (!err?.statusCode) {
    const code = err?.meta.code;
    let statusCode = null;
    switch (code) {
      case 'permissionDenied':
        statusCode = 403;
        break;
      case 'roleNotFound':
        statusCode = 404;
        break;
      default:
        statusCode = 400;
    }
    throw errorReturner(err, statusCode, code);
  }
  else {
    throw err;
  }
};

module.exports = SamadService;