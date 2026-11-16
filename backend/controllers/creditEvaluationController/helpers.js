'use strict';

const { getServices } = require('../../services/container');
const { readRouteParam, readClientMeta } = require('../../services/http/request');
const { requireAuthenticatedSession } = require('../../services/http/session-guard');
const { error: ceError } = require('./config');

/**
 * سطح دسترسی ۲ — نقش‌های `creditEvaluation` و `admin` (با الزام سشن معتبر و گارد سمد):
 * مشاهدهٔ جزئیات کامل یک گزارش اعتبارسنجی.
 */
exports.sample = async function (request, inputData, session) {
  await requireAuthenticatedSession(session, () => ceError.sessionRequired);
  const requestId = readRouteParam(request, inputData, 'requestId', /\/api\/sample\/([^/?#]+)/);
  if (!requestId) throw ceError.requestIdRequired;
  return getServices().summary.sample(requestId, readClientMeta(request));
};
