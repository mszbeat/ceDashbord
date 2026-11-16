'use strict';

/**
 * سازندهٔ استاندارد بخش meta خطاها در فایل کانفیگ کنترلرهای partFramework
 */
function createErrorInfo(packageJson = {}) {
  return function errorInfo(code) {
    return {
      code,
      version: packageJson.version || '1.0.0',
      sourceType: 'controller',
      sourceName: packageJson.name || 'partFBackend',
    };
  };
}

module.exports = { createErrorInfo };
