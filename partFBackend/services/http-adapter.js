'use strict';

/**
 * لایهٔ تطبیق HTTP برای partFramework (حالت needProtocolRef: false):
 * - کار مستقیم با پارامترهای تزریقشدهٔ فریمورک (_protocolRef.request.queryString،
 *   _protocolRef.request.data، _protocolRef.request، _protocolRef.response، _inputData)
 * - پشتیبانی از HttpResult بومی فریمورک برای پاسخهای HTML و خطاهای HTTP
 */

class HttpError extends Error {
  constructor(statusCode, payload) {
    const msg =
      typeof payload === 'string'
        ? payload
        : payload?.message || `HTTP ${statusCode}`;
    super(msg);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.response =
      typeof payload === 'object' && payload !== null
        ? { statusCode, ...payload }
        : { statusCode, message: String(payload) };
  }
}

class BadRequestError extends HttpError {
  constructor(payload) {
    super(400, payload);
  }
}

class UnauthorizedError extends HttpError {
  constructor(payload) {
    super(401, payload);
  }
}

class ForbiddenError extends HttpError {
  constructor(payload) {
    super(403, payload);
  }
}

class NotFoundError extends HttpError {
  constructor(payload) {
    super(404, payload);
  }
}

class ConflictError extends HttpError {
  constructor(payload) {
    super(409, payload);
  }
}

let registeredHttpResult = null;
let registeredResult = null;
let registeredBaseController = null;
let cachedHttpResultClass = null;

function registerFrameworkGlobals(globals = {}) {
  if (typeof globals.HttpResult === 'function') {
    registeredHttpResult = globals.HttpResult;
    cachedHttpResultClass = globals.HttpResult;
  }
  if (globals.Result) registeredResult = globals.Result;
  if (globals.BaseController) registeredBaseController = globals.BaseController;
}

function extractHttpResultFromExport(mod) {
  if (!mod) return null;
  if (typeof mod === 'function' && mod.name === 'HttpResult') return mod;
  if (typeof mod.HttpResult === 'function') return mod.HttpResult;
  if (typeof mod.default?.HttpResult === 'function') return mod.default.HttpResult;
  if (typeof mod.result?.HttpResult === 'function') return mod.result.HttpResult;
  if (typeof mod.response?.HttpResult === 'function') return mod.response.HttpResult;
  return null;
}

function resolveHttpResultClass() {
  if (cachedHttpResultClass) return cachedHttpResultClass;
  if (typeof registeredHttpResult === 'function') {
    cachedHttpResultClass = registeredHttpResult;
    return cachedHttpResultClass;
  }
  if (typeof global.HttpResult === 'function') {
    cachedHttpResultClass = global.HttpResult;
    return cachedHttpResultClass;
  }
  const fromBase = extractHttpResultFromExport(registeredBaseController);
  if (fromBase) {
    cachedHttpResultClass = fromBase;
    return cachedHttpResultClass;
  }

  const candidates = [
    '@partFramework/baseController',
    '@partFramework/helper',
    '@partFramework/http',
    '@partFramework/router',
    '@partFramework/baseServer',
    '@partFramework/core',
    '@partFramework/decorators',
    'partFramework',
    'partUtilities',
  ];
  for (const modName of candidates) {
    try {
      const found = extractHttpResultFromExport(require(modName));
      if (found) {
        cachedHttpResultClass = found;
        return cachedHttpResultClass;
      }
    } catch {}
  }

  try {
    for (const [cacheKey, modEntry] of Object.entries(require.cache || {})) {
      if (!cacheKey.includes('partFramework') && !cacheKey.includes('partUtilities')) continue;
      const found = extractHttpResultFromExport(modEntry?.exports);
      if (found) {
        cachedHttpResultClass = found;
        return cachedHttpResultClass;
      }
    }
  } catch {}

  return null;
}

function normalizeQuery(queryStringOrReq) {
  if (!queryStringOrReq || typeof queryStringOrReq !== 'object') return {};
  // اگر مستقیماً _protocolRef.request.queryString پاس داده شده باشد
  if (
    !('queryString' in queryStringOrReq) &&
    !('headers' in queryStringOrReq) &&
    !('url' in queryStringOrReq)
  ) {
    return queryStringOrReq;
  }
  const direct = queryStringOrReq.queryString || queryStringOrReq.query;
  if (direct && typeof direct === 'object' && Object.keys(direct).length > 0) {
    return direct;
  }
  const rawUrl = queryStringOrReq.url || queryStringOrReq.originalUrl || '';
  const qIdx = String(rawUrl).indexOf('?');
  if (qIdx >= 0) {
    const rawQs = String(rawUrl).slice(qIdx + 1).split('#')[0];
    return Object.fromEntries(new URLSearchParams(rawQs).entries());
  }
  return direct || {};
}

function normalizeBody(data) {
  if (data === null || data === undefined || data === '') return {};
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  if (typeof data === 'object') {
    // در صورتی که کل _protocolRef.request پاس داده شده باشد (پشتیبانی همزمان از postData، putData، data و body)
    if (
      ('postData' in data || 'putData' in data || 'data' in data || 'body' in data) &&
      ('url' in data || 'headers' in data || 'method' in data || 'queryString' in data)
    ) {
      return normalizeBody(data.postData ?? data.putData ?? data.data ?? data.body);
    }
    return data;
  }
  return {};
}

function extractRouteParam(request, inputData, paramName, fallbackRegex) {
  const candidates = [
    inputData?.params?.[paramName],
    inputData?.[paramName],
    request?.params?.[paramName],
    request?.urlParams?.[paramName],
  ];
  for (const val of candidates) {
    if (val !== undefined && val !== null && val !== '') {
      return String(val);
    }
  }
  if (fallbackRegex) {
    const rawUrl = request?.url || request?.originalUrl || request?.path || '';
    const m = String(rawUrl).match(fallbackRegex);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return '';
}

function extractClientMeta(request) {
  const req = request?.request || request || {};
  const headers = req.headers || req.header || {};
  const forwarded = headers['x-forwarded-for'];
  const ip =
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    null;
  return { ip, headers };
}

function applyResponseMeta(responseOrProtocolRef, statusCode, headers) {
  const targets = [
    responseOrProtocolRef?.response,
    responseOrProtocolRef?.response?.res,
    responseOrProtocolRef?.res,
    responseOrProtocolRef,
  ].filter((t) => t && typeof t === 'object');

  for (const target of targets) {
    try {
      if (typeof target.status === 'function') target.status(statusCode);
      else if ('statusCode' in target) target.statusCode = statusCode;
    } catch {}
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        try {
          if (typeof target.setHeader === 'function') target.setHeader(k, v);
          else if (typeof target.header === 'function') target.header(k, v);
          else if (target.headers && typeof target.headers === 'object') target.headers[k] = v;
        } catch {}
      }
    }
  }
}

function instantiateHttpResult(HttpResult, body, statusCode, headers, contentType) {
  const src = Function.prototype.toString.call(HttpResult);
  const ctorMatch =
    src.match(/constructor\s*\(([^)]*)\)/) ||
    src.match(/^function(?:\s+\w+)?\s*\(([^)]*)\)/);
  const paramSig = (ctorMatch ? ctorMatch[1] : '').trim();

  if (paramSig.startsWith('{')) {
    return new HttpResult({
      statusCode,
      status: statusCode,
      code: statusCode,
      headers,
      contentType,
      type: contentType,
      mimeType: contentType,
      data: body,
      body,
      content: body,
      result: body,
    });
  }

  if (paramSig && paramSig.includes(',')) {
    const paramNames = paramSig.split(',').map((s) => s.split('=')[0].trim().toLowerCase());
    const args = paramNames.map((name, idx) => {
      if (name.includes('status') || name === 'code') return statusCode;
      if (name.includes('header')) return headers;
      if (name.includes('type') || name.includes('mime')) return contentType;
      if (
        name.includes('data') ||
        name.includes('body') ||
        name.includes('content') ||
        name.includes('result') ||
        name.includes('payload') ||
        idx === 0
      ) {
        return body;
      }
      return undefined;
    });
    return new HttpResult(...args);
  }

  if (
    /\.statusCode\b|\.headers\b|\.contentType\b/.test(src) &&
    /=\s*\w+\.(statusCode|headers|contentType|data|body)/.test(src)
  ) {
    return new HttpResult({
      statusCode,
      status: statusCode,
      headers,
      contentType,
      data: body,
      body,
      result: body,
    });
  }

  return new HttpResult(body, statusCode, headers, contentType);
}

function buildCustomHttpResponse(responseTarget, body, statusCode = 200, headers = {}) {
  const contentType =
    headers['Content-Type'] || headers['content-type'] || 'application/json; charset=utf-8';
  applyResponseMeta(responseTarget, statusCode, headers);

  const HttpResult = resolveHttpResultClass();
  if (typeof HttpResult === 'function') {
    try {
      const payloadForHttpResult =
        typeof body === 'object' && body !== null && !Buffer.isBuffer(body)
          ? JSON.stringify(body)
          : body;
      return instantiateHttpResult(HttpResult, payloadForHttpResult, statusCode, headers, contentType);
    } catch {}
  }
  return body;
}

function sendHtml(responseTarget, html, statusCode = 200) {
  return buildCustomHttpResponse(responseTarget, html, statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
}

function sendNoStoreJson(responseTarget, payload, statusCode = 200) {
  applyResponseMeta(responseTarget, statusCode, {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });
  if (statusCode === 200) return payload;
  return buildCustomHttpResponse(responseTarget, payload, statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
}

async function runJsonHandler(responseTarget, fn, options = {}) {
  try {
    const result = await fn();
    if (options.noStore) {
      return sendNoStoreJson(responseTarget, result, 200);
    }
    applyResponseMeta(responseTarget, 200, {});
    return result;
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    const payload =
      err?.response || {
        statusCode,
        message: String(err?.message ?? err),
      };
    return buildCustomHttpResponse(
      responseTarget,
      payload,
      statusCode,
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    );
  }
}

module.exports = {
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  registerFrameworkGlobals,
  resolveHttpResultClass,
  normalizeQuery,
  normalizeBody,
  extractRouteParam,
  extractClientMeta,
  sendHtml,
  sendNoStoreJson,
  runJsonHandler,
  get registeredResult() {
    return registeredResult;
  },
};
