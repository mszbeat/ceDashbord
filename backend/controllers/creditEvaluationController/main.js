'use strict';

const BaseController = require('@partFramework/baseController');
const helpers = require('./helpers');

/**
 * سطح دسترسی ۲ — نقش‌های `creditEvaluation` و `admin`:
 * دریافت و مشاهدهٔ اطلاعات کامل یک گزارش اعتبارسنجی.
 *
 * دسترسی این کنترلر در `routes.js` با `.checkAccess(true)` روی سمد اعمال می‌شود.
 */
exports.controller = class CreditEvaluationController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
   */
  constructor(core, schema, config) {
    super(core, schema, config);
  }

  /** GET /api/sample?requestId=… */
  sample(request, inputData, session) {
    return helpers.sample(request, inputData, session);
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config'),
);
