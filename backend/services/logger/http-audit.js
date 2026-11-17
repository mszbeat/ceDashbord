'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { readClientMeta } = require('../http/request');
const {
  getActionLogger,
  registerAuditContextGetter,
  SENSITIVE_KEY_RE,
} = require('./action-logger.service');

const kHttpAuditInstalled = Symbol.for('ce.httpAuditLoggerInstalled');
const auditContextStorage = new AsyncLocalStorage();

registerAuditContextGetter(() => auditContextStorage.getStore() || null);

function getAuditContext() {
  return auditContextStorage.getStore() || null;
}

function updateAuditContext(patch = {}) {
  const ctx = auditContextStorage.getStore();
  if (!ctx || typeof patch !== 'object' || patch === null) return ctx || null;
  if (patch.actor !== undefined && patch.actor !== null) ctx.actor = String(patch.actor);
  if (Array.isArray(patch.roles)) ctx.roles = [...patch.roles];
  if (patch.errorCode !== undefined) ctx.errorCode = patch.errorCode;
  if (patch.errorMessage !== undefined) ctx.errorMessage = patch.errorMessage;
  if (patch.meta && typeof patch.meta === 'object') {
    ctx.meta = { ...(ctx.meta || {}), ...patch.meta };
  }
  return ctx;
}

function sanitizeRequestUrl(rawUrl) {
  const text = String(rawUrl || '/');
  const qIdx = text.indexOf('?');
  if (qIdx < 0) return text.slice(0, 500);
  const pathname = text.slice(0, qIdx);
  const rawQuery = text.slice(qIdx + 1).split('#')[0];
  try {
    const sp = new URLSearchParams(rawQuery);
    for (const key of [...sp.keys()]) {
      if (SENSITIVE_KEY_RE.test(key)) {
        sp.set(key, '[REDACTED]');
      }
    }
    const qs = sp.toString();
    return qs ? `${pathname}?${qs}`.slice(0, 500) : pathname.slice(0, 500);
  } catch {
    return pathname.slice(0, 500);
  }
}

function installHttpAuditLogger(loggerProvider = getActionLogger) {
  const proto = http.Server && http.Server.prototype;
  if (!proto || proto[kHttpAuditInstalled]) return false;

  const origEmit = proto.emit;
  proto.emit = function patchedServerEmit(event, arg1, arg2) {
    if (event === 'clientError' && arg1) {
      try {
        const logger = typeof loggerProvider === 'function' ? loggerProvider() : loggerProvider;
        logger.warn({
          category: 'http',
          action: 'http.client_error',
          errorCode: arg1.code || 'CLIENT_ERROR',
          message: arg1.message || 'HTTP client socket error',
        });
      } catch {
        // ignore
      }
      return origEmit.apply(this, arguments);
    }

    if (event !== 'request' || !arg1 || !arg2) {
      return origEmit.apply(this, arguments);
    }

    const req = arg1;
    const res = arg2;
    const logger = typeof loggerProvider === 'function' ? loggerProvider() : loggerProvider;
    const headerReqId = req.headers?.['x-request-id'];
    const requestId =
      typeof headerReqId === 'string' && headerReqId.trim()
        ? headerReqId.trim().slice(0, 128)
        : randomUUID();
    const clientMeta = readClientMeta(req);
    const safePath = sanitizeRequestUrl(req.originalUrl || req.url || '/');
    const method = String(req.method || 'GET').toUpperCase();
    const userAgent = req.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : null;
    const startNs = process.hrtime.bigint();

    const ctx = {
      requestId,
      method,
      path: safePath,
      ip: clientMeta.ip,
      userAgent,
      actor: null,
      roles: [],
      errorCode: null,
      errorMessage: null,
      meta: {},
    };
    req.__ceAuditCtx = ctx;
    res.__ceAuditCtx = ctx;

    if (typeof res.setHeader === 'function' && !res.headersSent) {
      try {
        res.setHeader('X-Request-Id', requestId);
      } catch {
        // ignore if headers already sent
      }
    }

    let recorded = false;
    const finalize = (aborted) => {
      if (recorded) return;
      recorded = true;
      const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - startNs) / 1e6));
      const statusCode = aborted && !res.writableEnded ? 499 : Number(res.statusCode || 200);
      const isHealth = safePath === '/api/health' || safePath.startsWith('/api/health?');
      if (isHealth && statusCode < 400 && process.env.LOG_IGNORE_HEALTHCHECK === '1') {
        return;
      }
      const level = statusCode >= 500 ? 'error' : statusCode >= 400 || aborted ? 'warn' : 'info';
      logger.logEvent({
        level,
        category: 'http',
        action: aborted ? 'http.request.aborted' : 'http.request',
        actor: ctx.actor,
        roles: ctx.roles,
        method,
        path: safePath,
        statusCode,
        durationMs,
        requestId,
        ip: ctx.ip,
        userAgent,
        errorCode: ctx.errorCode,
        message: ctx.errorMessage || undefined,
        meta: ctx.meta,
      });
    };

    if (typeof res.once === 'function') {
      res.once('finish', () => finalize(false));
      res.once('close', () => {
        if (!res.writableFinished) finalize(true);
      });
    }

    return auditContextStorage.run(ctx, () => origEmit.apply(this, arguments));
  };

  proto[kHttpAuditInstalled] = true;
  return true;
}

module.exports = {
  installHttpAuditLogger,
  getAuditContext,
  updateAuditContext,
  sanitizeRequestUrl,
};
