/**
 * تنظیم CORS — پاک‌سازی بازماندهٔ قالب (D6).
 *
 * نسخهٔ قبلی از قالب فریم‌ورک کپی شده بود: مسیرهای نمونهٔ `/service/myService/myServiceApi`
 * و دامنهٔ جعلی `https/foo.ir` (با اسلش به‌جای `://`). هر دوی این‌ها یعنی «قاعده‌ای که
 * هرگز مطابقت نمی‌کند» — یعنی CORS عملاً فقط default سرور را داشت ولی خواننده فکر می‌کرد
 * تنظیم شده است. حالا مسیرها و مبدأها از env می‌آیند و پیش‌فرض هم‌خانواده (same-origin) است.
 *
 * متغیرها:
 *   CE_CORS_ORIGINS= https://dash.example.ir,https://dash2.example.ir
 *   CE_CORS_PATHS=   /api/*            (پیش‌فرض)
 */
const origins = String(process.env.CE_CORS_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value) => /^https?:\/\/[^/\s]+$/.test(value));

const paths = String(process.env.CE_CORS_PATHS || '/api/*')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const staticHeaders = {};
if (origins.length) {
  staticHeaders['Access-Control-Allow-Origin'] = origins.length === 1 ? origins[0] : origins.join(' ');
  staticHeaders['Access-Control-Allow-Credentials'] = 'true';
  staticHeaders['Vary'] = 'Origin';
}

module.exports = {
  enabled: origins.length > 0,
  optionsSuccessStatus: 204,
  allowedOrigins: origins,
  ...Object.fromEntries(paths.map((route) => [route, { static: { ...staticHeaders } }])),
};
