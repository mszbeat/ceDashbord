const { config } = require('../../services/config');

module.exports = [
  {
    name: 'http',
    packageName: '@partFramework/http',
    port: config.backendPort,
    host: config.backendHost,
    responseHeaders: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    },

    // ===========================
    // https config

    httpsServerConfig: {
      host: config.backendHost,
      port: Number(process.env.BACKEND_HTTPS_PORT || 4000)
      // certificate:
    },
    // ===========================

    // partSecurityConfig / partServeIndexConfig / corsConfig
    // در صورت نیاز مانند samplePF فعال می‌شوند (نمونهٔ کامنت‌شده در نمونه پروژه)
  }
];
