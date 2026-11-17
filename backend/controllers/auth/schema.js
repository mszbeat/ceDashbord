'use strict';

/**
 * اسکیمای اعتبارسنجی ورودی هر هندلر (کلیدها = نام هندلر در `main.js`).
 * با `.validate()` روی روت مربوطه در `routes.js` فعال می‌شود.
 */

const usernameSchema = {
  type: 'string',
  minLength: 3,
  errorMessages: {
    type: 'username must be a string',
    minLength: 'username minimum length is 3',
  },
};

const passwordSchema = {
  type: 'string',
  minLength: 4,
  errorMessages: {
    type: 'password must be a string',
    minLength: 'password minimum length is 4',
  },
};

const roleSchema = {
  type: 'string',
  minLength: 2,
  errorMessages: {
    type: 'role must be a string',
    minLength: 'role minimum length is 2',
  },
};

exports.register = {
  body: {
    type: 'object',
    properties: {
      username: usernameSchema,
      password: passwordSchema,
      rememberMe: {
        type: 'boolean',
        errorMessages: {
          type: 'rememberMe must be a boolean',
        },
      },
      autoLogin: {
        type: 'boolean',
        errorMessages: {
          type: 'autoLogin must be a boolean',
        },
      },
    },
    required: ['username', 'password'],
    additionalProperties: false,
  },
};

exports.login = {
  body: {
    type: 'object',
    properties: {
      username: usernameSchema,
      password: passwordSchema,
      rememberMe: {
        type: 'boolean',
        errorMessages: {
          type: 'rememberMe must be a boolean',
        },
      },
    },
    required: ['username', 'password'],
    additionalProperties: false,
  },
};

exports.refresh = {
  header: {},
  params: {},
  queryString: {},
};

exports.logout = {
  header: {},
  params: {},
  queryString: {},
};

exports.me = {
  header: {},
  params: {},
  queryString: {},
};

exports.assignRole = {
  body: {
    type: 'object',
    properties: {
      username: usernameSchema,
      role: roleSchema,
    },
    required: ['username', 'role'],
    additionalProperties: false,
  },
};

exports.getRole = {
  header: {},
  params: {},
  queryString: {
    username: usernameSchema,
  },
};

exports.removeUser = {
  body: {
    type: 'object',
    properties: {
      username: usernameSchema,
    },
    required: ['username'],
    additionalProperties: false,
  },
};
