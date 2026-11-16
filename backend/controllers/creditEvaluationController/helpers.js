'use strict';

const { getServices } = require('../../services/container');
const { readRouteParam, readClientMeta } = require('../../services/http/request');
const { error: ceError } = require('./config');

/**
 * سطح دسترسی ۲ — نقش‌های `creditEvaluation` و `admin` (اعمال گارد توسط سمد
 * با `checkAccess(true)` روی روت `/api/sample/:requestId`):
 * مشاهدهٔ جزئیات کامل یک گزارش اعتبارسنجی.
 */
exports.sample = function (request, inputData) {
  const requestId = readRouteParam(request, inputData, 'requestId', /\/api\/sample\/([^/?#]+)/);
  if (!requestId) throw ceError.requestIdRequired;
  return getServices().summary.sample(requestId, readClientMeta(request));
};
