'use strict';

const { getActionLogger } = require('./action-logger.service');
const { updateAuditContext } = require('./http-audit');

function recordControllerException(controllerName, rawException, mapped) {
  try {
    const statusCode = Number(mapped?.statusCode) || 500;
    const errorCode = mapped?.meta?.code ? String(mapped.meta.code) : 'internalServerError';
    const message =
      mapped?.data?.message?.en ||
      mapped?.data?.message?.fa ||
      (rawException instanceof Error ? rawException.message : String(rawException || 'error'));

    updateAuditContext({ errorCode, errorMessage: message });

    const level = statusCode >= 500 ? 'error' : 'warn';
    const additionalInfo = mapped?.data?.additionalInfo;
    getActionLogger().logEvent({
      level,
      category: 'controller',
      action: `controller.${controllerName}.exception`,
      statusCode,
      errorCode,
      message,
      meta: additionalInfo !== undefined ? { additionalInfo } : {},
      stack: statusCode >= 500 && rawException instanceof Error ? rawException.stack : undefined,
    });
  } catch {
    // لاگ خطا هرگز نباید خروجی exception handler را مختل کند
  }
  return mapped;
}

module.exports = { recordControllerException };
