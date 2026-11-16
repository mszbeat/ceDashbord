'use strict';

const BaseController = require('@partFramework/baseController');
const helpers = require('./helpers');

/**
 * سطح دسترسی ۱ — کاربر دارای سشن احرازشده:
 * مشاهدهٔ صفحهٔ اول داشبورد و تحلیل‌های کلی (به‌جز `/api/health` که عمومی است).
 *
 * مسیرها در `routes.js` و پارامترهای تزریقی در `config.js` تعریف شده‌اند
 * (`needProtocolRef: false`).
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
  banks(session) {
    return helpers.banks(session);
  }

  /** GET /api/specs?bank=... */
  specs(queryString, session) {
    return helpers.specs(queryString, session);
  }

  /** GET /api/report?bank=...&from=...&to=... (HTML) */
  report(queryString, response, session) {
    return helpers.report(queryString, response, session);
  }

  /** GET /api/diagnostics */
  diagnostics(session) {
    return helpers.diagnostics(session);
  }

  /** GET /api/summary?bank=...&from=...&to=... */
  summary(queryString, session) {
    return helpers.summary(queryString, session);
  }

  /** GET /api/list?bank=... */
  list(queryString, session) {
    return helpers.list(queryString, session);
  }

  /** GET /api/runs */
  runs(session) {
    return helpers.runs(session);
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config'),
);
