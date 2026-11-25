'use strict';

const { getServices } = require('../../services/container');
const { readRouteParam, readQuery, readQueryParam, readClientMeta } = require('../../services/http/request');
const { requireAuthenticatedSession } = require('../../services/http/session-guard');
const { getActionLogger } = require('../../services/logger/action-logger.service');
const { error: ceError } = require('./config');

/**
 * دسترسی به جزئیات گزارش با مجوز مسیر در checkAccess/Samad کنترل می‌شود؛
 * این لایه فقط وجود سشن معتبر را لازم دارد.
 */
exports.sample = async function (request, inputData, session) {
  // مجوز دسترسی به /api/sample در لایهٔ روتر و بر اساس نقش/مسیر ثبت‌شده در سمد بررسی می‌شود.
  const actor = await requireAuthenticatedSession(session, () => ceError.sessionRequired);
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
