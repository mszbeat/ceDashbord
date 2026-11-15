'use strict';
const { getServices } = require('../../services/container');
const { ROLES, requireRoles } = require('../../services/auth/role-guard');
const { getParams, getClientMeta, runJsonHandler } = require('../../services/http-adapter');
const accessConfig = require('../../configs/creditEvaluationController.config');

const ALLOWED_ROLES = accessConfig.allowedRoles || [ROLES.CREDIT_EVALUATION, ROLES.ADMIN];

exports.sample = function (protocolRef) {
  return runJsonHandler(
    protocolRef,
    async () => {
      await requireRoles(protocolRef, ALLOWED_ROLES, {
        message:
          'دسترسی غیرمجاز: مشاهدهٔ اطلاعات و جزئیات گزارش فقط برای نقشهای creditEvaluation و admin مجاز است.',
      });
      const params = getParams(protocolRef, /\/api\/sample\/([^/?#]+)/, 'requestId');
      const clientMeta = getClientMeta(protocolRef);
      return getServices().summary.sample(String(params.requestId || ''), clientMeta);
    },
    { noStore: true },
  );
};
