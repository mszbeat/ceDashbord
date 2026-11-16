'use strict';

/**
 * شبیه‌سازی حداقلی `@partFramework/baseController` برای تست‌های واحد،
 * زمانی که پکیج‌های داخلی پارت (رجیستری سازمانی) نصب نیستند.
 *
 * در محیط واقعی، `main.js` مستقیم از `@partFramework/baseController` استفاده می‌کند،
 * بنابراین این فایل هیچ‌گاه در مسیر اجرای سرور قرار نمی‌گیرد.
 */
const Module = require('node:module');

class BaseController {
  static exportedProperties(schema, config) {
    return { schema, config };
  }

  constructor(core, schema, config) {
    this.core = core;
    this.schema = schema;
    this.config = config;
  }
}

const MOCKED = new Set(['@partFramework/baseController', '@partFramework/http']);

class MockHttpResult {
  constructor(data, statusCode = 200, headers = {}) {
    this.data = data;
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

function install() {
  const originalLoad = Module._load;

  Module._load = function load(request, parent, isMain) {
    if (request === '@partFramework/baseController') return BaseController;
    if (request === '@partFramework/http') return { HttpResult: MockHttpResult };
    return originalLoad.call(this, request, parent, isMain);
  };

  // پاک‌سازی کش ماژول‌هایی که پیش از نصب mock بارگذاری شده‌اند
  for (const key of Object.keys(require.cache)) {
    if (/controllers[\\/].*[\\/](main|helpers)\.js$/.test(key) || /services[\\/]http[\\/]result\.js$/.test(key)) {
      delete require.cache[key];
    }
  }

  return () => {
    Module._load = originalLoad;
  };
}

module.exports = { BaseController, MockHttpResult, install, MOCKED };
