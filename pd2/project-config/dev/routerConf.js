const path = require('path');

/**
 * تنظیمات روتر — معادل `samplePF/project-config/dev/routerConf.js`.
 *
 * - `routerPath` به `routes.js` پروژه اشاره می‌کند تا همهٔ مسیرها به‌صورت
 *   مرکزی ثبت شوند (`router.setRoute(...).method(...).validate().checkAccess(true)`).
 * - `accessControl` فعال است: با `checkAccess(true)` روی هر روت، فریم‌ورک
 *   `_session` را (پس از اعتبارسنجی سشن/نقش با سمد) به آرگومان‌های هندلر تزریق می‌کند.
 */
module.exports = {
  routerPath: path.join(__dirname, '../../routes.js'),
  accessControl: {
    partSessionManagerConfig: require('./dependencies/partSessionManagerConfig'),
    partSecurityConfig: require('./dependencies/partSecurityConfig'),
    config: {
      org: process.env.SAMAD_ORG || process.env.org || 'ceDashboard'
    }
  }
};
