'use strict';

const BaseController = require('@partFramework/baseController');
const helpers = require('./helpers');

/**
 * سطح دسترسی ۱ — کاربر عادی (عمومی):
 * مشاهدهٔ صفحهٔ اول داشبورد و تحلیل‌های کلی.
 *
 * مسیرها در `routes.js` و پارامترهای تزریقی در `config.js` تعریف شده‌اند
 * (`needProtocolRef: false`). خروجی ساده توسط `@partFramework/http` در پوشش
 * `{ "data": ... }` برگردانده می‌شود؛ برای HTML زنده از `sendHtml` (HttpResult) استفاده می‌شود.
 */
exports.controller = class SummaryController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
   */
  constructor(core, schema, config) {
    super(core, schema, config);
  }

  /** GET /api/health */
  health() {
    return helpers.health();
  }

  /** GET /api/banks */
  banks() {
    return helpers.banks();
  }

  /** GET /api/specs?bank=... */
  specs(queryString) {
    return helpers.specs(queryString);
  }

  /** GET /api/report?bank=...&from=...&to=... (HTML) */
  report(queryString, response) {
    return helpers.report(queryString, response);
  }

  /** GET /api/diagnostics */
  diagnostics() {
    return helpers.diagnostics();
  }

  /** GET /api/summary?bank=...&from=...&to=... */
  summary(queryString) {
    return helpers.summary(queryString);
  }

  /** GET /api/list?bank=... */
  list(queryString) {
    return helpers.list(queryString);
  }

  /** GET /api/runs */
  runs() {
    return helpers.runs();
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config'),
);
