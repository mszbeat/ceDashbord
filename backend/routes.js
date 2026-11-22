module.exports = (router) => {
  // ─────────────────────────── سطح ۰: اصالت‌سنجی و سشن ───────────────────────────
  router
    .setRoute('/api/auth/register', 'auth-controller.register')
    .method('POST')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/auth/login', 'auth-controller.login')
    .method('POST')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/auth/refresh', 'auth-controller.refresh')
    .method('POST')
    .checkAccess(true);

  router
    .setRoute('/api/auth/refresh/peek', 'auth-controller.refreshPeek')
    .method('GET')
    .checkAccess(true);

  router
    .setRoute('/api/auth/logout', 'auth-controller.logout')
    .method('POST')
    .checkAccess(true);

  router
    .setRoute('/api/auth/me', 'auth-controller.me')
    .method('GET')
    .checkAccess(true);

  router
    .setRoute('/api/auth/role', 'auth-controller.assignRole')
    .method('POST')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/auth/role', 'auth-controller.getRole')
    .method('GET')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/auth/remove', 'auth-controller.removeUser')
    .method('POST')
    .validate()
    .checkAccess(true);

  // ───────────────── سطح ۱: کاربر عادی (صفحهٔ اول و تحلیل‌های کلی) ─────────────────
  router.setRoute('/api/health', 'summary-controller.health').method('GET');

  // D8 — سلامت/آمادگی برای مانیتورینگ و orchestrator (بدون احراز هویت)
  router.setRoute('/api/healthz', 'summary-controller.healthz').method('GET');
  router.setRoute('/api/readyz', 'summary-controller.readyz').method('GET');

  router.setRoute('/api/banks', 'summary-controller.banks').method('GET').checkAccess(true);

  router
    .setRoute('/api/specs', 'summary-controller.specs')
    .method('GET')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/report', 'summary-controller.report')
    .method('GET')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/diagnostics', 'summary-controller.diagnostics')
    .method('GET')
    .checkAccess(true);

  router
    .setRoute('/api/summary', 'summary-controller.summary')
    .method('GET')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/list', 'summary-controller.list')
    .method('GET')
    .validate()
    .checkAccess(true);

  router.setRoute('/api/runs', 'summary-controller.runs').method('GET').checkAccess(true);

  // ─────────── سطح ۲: جزئیات گزارش — نقش‌های creditEvaluation و admin ───────────
  router
    .setRoute('/api/sample', 'credit-evaluation-controller.sample')
    .method('GET')
    .checkAccess(true);

  // ────────────────────────── سطح ۳: پنل مدیریت (فقط admin) ──────────────────────────
  router
    .setRoute('/api/admin/overview', 'admin-controller.getOverview')
    .method('GET')
    .checkAccess(true);

  router
    .setRoute('/api/admin/cron', 'admin-controller.getCron')
    .method('GET')
    .checkAccess(true);

  router
    .setRoute('/api/admin/cron', 'admin-controller.updateCron')
    .method('PUT')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/admin/cron/run-now', 'admin-controller.runCronNow')
    .method('POST')
    .checkAccess(true);

  router
    .setRoute('/api/admin/runs/check', 'admin-controller.checkExisting')
    .method('POST')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/admin/runs/start', 'admin-controller.startRun')
    .method('POST')
    .validate()
    .checkAccess(true);

  router
    .setRoute('/api/admin/jobs', 'admin-controller.listJobs')
    .method('GET')
    .checkAccess(true);

  router
    .setRoute('/api/admin/jobs', 'admin-controller.getJob')
    .method('GET')
    .checkAccess(true);

  router
    .setRoute('/api/admin/runs', 'admin-controller.runAdminDay')
    .method('POST')
    .validate()
    .checkAccess(true);

  router.setRoute('/api/runs', 'admin-controller.run').method('POST').validate().checkAccess(true);
};
