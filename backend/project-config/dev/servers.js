const { config, cleanEnv } = require('../../services/config');

const allowedOrigin = cleanEnv(process.env.CORS_ALLOWED_ORIGIN) || 'http://localhost:3001';

module.exports = [
  {
    name: 'http',
    packageName: '@partFramework/http',
    port: config.backendPort,
    host: config.backendHost,
    responseHeaders: {
      // کوکی‌های HttpOnly فقط با origin مشخص و credentials مجازند؛ '*' با احراز هویت کوکی ناسازگار است.
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
      Vary: 'Origin',
    },

    // ===========================
    // https config

    httpsServerConfig: {
      host: config.backendHost,
      port: Number(process.env.BACKEND_HTTPS_PORT || 4000)
      // مسیر گواهی/کلید خصوصی TLS فقط از متغیر محیطی خوانده شود؛ هیچ فایل .pem در ریپو نگهداری نمیشود.
    },
    // ===========================

    // partSecurityConfig / partServeIndexConfig / corsConfig
    // در صورت نیاز مانند samplePF فعال می‌شوند (نمونهٔ کامنت‌شده در نمونه پروژه)
  }
];
