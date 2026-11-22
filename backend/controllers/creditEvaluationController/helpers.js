'use strict';

const { getServices } = require('../../services/container');
const { readRouteParam, readQuery, readQueryParam, readClientMeta } = require('../../services/http/request');
const { requireAdminSession } = require('../../services/http/session-guard');
const { getActionLogger } = require('../../services/logger/action-logger.service');
const { error: ceError } = require('./config');

/**
 * سطح دسترسی ۲ — نقش‌های `creditEvaluation` و `admin` (با الزام سشن معتبر و گارد سمد):
 * مشاهدهٔ جزئیات کامل یک گزارش اعتبارسنجی.
 */
exports.sample = async function (request, inputData, session) {
  // D1/D2: گزارش خام (شامل کد ملی و متن آزاد پیام) فقط برای ادمین؛ هر دسترسی با نقش‌ها ثبت می‌شود
  const actor = await requireAdminSession(session, () => ceError.sessionRequired);
  // مسیر استاتیک است: GET /api/sample?requestId=… (پارامترهای پویا از query خوانده می‌شوند)
  const query = readQuery(request, inputData);
  const requestId =
    readQueryParam(query, 'requestId') ||
    readQueryParam(query, 'id') ||
    readRouteParam(request, inputData, 'requestId', /\/api\/sample\/([^/?#]+)/);
  if (!requestId) throw ceError.requestIdRequired;
  const res = await getServices().summary.sample(
    requestId,
    readClientMeta(request),
    readQueryParam(query, 'bank'),
    actor,
  );
  getActionLogger().info({
    category: 'detail',
    action: res?.found ? 'detail.sample.viewed' : 'detail.sample.not_found',
    actor: actor.username,
    roles: actor.roles,
    statusCode: 200,
    meta: { sampleRequestId: requestId, bank: res?.meta?.methodKey || query.bank || null, found: Boolean(res?.found) },
  });
  return res;
};
