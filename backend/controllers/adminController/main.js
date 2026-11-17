'use strict';

const BaseController = require('@partFramework/baseController');
const helpers = require('./helpers');

/**
 * سطح دسترسی ۳ — فقط نقش `admin` (با الزام سشن معتبر و گارد سمد):
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
  getCron(session) {
    return helpers.getCron(session);
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
  checkExisting(body, session) {
    return helpers.checkExisting(body, session);
  }

  /** POST /api/admin/runs/start */
  startRun(body, session) {
    return helpers.startRun(body, session);
  }

  /** GET /api/admin/jobs */
  listJobs(session) {
    return helpers.listJobs(session);
  }

  /** GET /api/admin/jobs?id=… */
  getJob(request, inputData, session) {
    return helpers.getJob(request, inputData, session);
  }

  /** POST /api/admin/runs */
  runAdminDay(body, session) {
    return helpers.runAdminDay(body, session);
  }

  /** POST /api/runs */
  run(body, session) {
    return helpers.run(body, session);
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config'),
);
