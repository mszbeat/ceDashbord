'use strict';

const BaseController = require('@partFramework/baseController');
const helpers = require('./helpers');

/**
 * سطح دسترسی ۳ — فقط نقش `admin` (اعمال گارد توسط سمد):
 * پنل مدیریت، زمان‌بند خودکار کران شبانه و اجرای دریافت گزارش‌ها (Ingestion).
 *
 * پارامترهای تزریقی هر هندلر در `config.js` (params) و مسیرها در `routes.js` تعریف شده‌اند.
 */
exports.controller = class AdminController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
   */
  constructor(core, schema, config) {
    super(core, schema, config);
  }

  /** GET /api/admin/overview */
  getOverview(session) {
    return helpers.getOverview(session);
  }

  /** GET /api/admin/cron */
  getCron() {
    return helpers.getCron();
  }

  /** PUT /api/admin/cron */
  updateCron(body, session) {
    return helpers.updateCron(body, session);
  }

  /** POST /api/admin/cron/run-now */
  runCronNow(session) {
    return helpers.runCronNow(session);
  }

  /** POST /api/admin/runs/check */
  checkExisting(body) {
    return helpers.checkExisting(body);
  }

  /** POST /api/admin/runs/start */
  startRun(body, session) {
    return helpers.startRun(body, session);
  }

  /** GET /api/admin/jobs */
  listJobs() {
    return helpers.listJobs();
  }

  /** GET /api/admin/jobs/:id */
  getJob(request, inputData) {
    return helpers.getJob(request, inputData);
  }

  /** POST /api/admin/runs */
  runAdminDay(body) {
    return helpers.runAdminDay(body);
  }

  /** POST /api/runs */
  run(body) {
    return helpers.run(body);
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config'),
);
