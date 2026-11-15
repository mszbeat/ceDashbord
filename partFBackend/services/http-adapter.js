'use strict';

/**
 * لایهٔ تطبیق HTTP برای partFramework:
 * - استخراج یکنواخت queryString، params، body و مشخصات کلاینت از protocolRef
 * - پشتیبانی از HttpResult بومی partFramework (از حوزهٔ کنترلر، ماژولها یا require.cache) برای ارسال مستقیم HTML/هدرها
 * - ارسال خطاهای ساختیافته بدون دوبار JSON.stringify شدن در پوشش { data: ... } فریمورک
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
    } catch {
      // ادامه به ماژول بعدی
    }
  }

  // جستجو در ماژولهای بارگذاریشدهٔ فریمورک در require.cache
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

function getQuery(protocolRef) {
  const direct = protocolRef?.request?.queryString || protocolRef?.request?.query;
  if (direct && typeof direct === 'object' && Object.keys(direct).length > 0) {
    return direct;
  }
  const rawUrl =
    protocolRef?.request?.url ||
    protocolRef?.request?.originalUrl ||
    '';
  const qIdx = String(rawUrl).indexOf('?');
  if (qIdx >= 0) {
    const rawQs = String(rawUrl).slice(qIdx + 1).split('#')[0];
    return Object.fromEntries(new URLSearchParams(rawQs).entries());
  }
  return direct || {};
}

function getParams(protocolRef, fallbackRegex, paramName) {
  const rawParams =
    protocolRef?.request?.params ||
    protocolRef?.request?.urlParams ||
    protocolRef?.params ||
    {};
  if (paramName && rawParams[paramName] !== undefined && rawParams[paramName] !== '') {
    return rawParams;
  }
  if (fallbackRegex && paramName) {
    const rawUrl =
      protocolRef?.request?.url ||
      protocolRef?.request?.originalUrl ||
      protocolRef?.request?.path ||
      '';
    const m = String(rawUrl).match(fallbackRegex);
    if (m && m[1]) {
      return { ...rawParams, [paramName]: decodeURIComponent(m[1]) };
    }
  }
  return rawParams;
}

function getBody(protocolRef) {
  const raw =
    protocolRef?.request?.body ??
    protocolRef?.request?.data ??
    protocolRef?.body ??
    {};
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function getClientMeta(protocolRef) {
  const req = protocolRef?.request || {};
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

function applyResponseMeta(protocolRef, statusCode, headers) {
  const targets = [
    protocolRef?.response,
    protocolRef?.response?.res,
    protocolRef?.res,
  ].filter(Boolean);
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

  // سازنده تکارگومانی یا ترنسپایلشده با arguments
  if (/\.statusCode\b|\.headers\b|\.contentType\b/.test(src) && /=\s*\w+\.(statusCode|headers|contentType|data|body)/.test(src)) {
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

function buildCustomHttpResponse(protocolRef, body, statusCode = 200, headers = {}) {
  const contentType =
    headers['Content-Type'] || headers['content-type'] || 'application/json; charset=utf-8';
  applyResponseMeta(protocolRef, statusCode, headers);

  const HttpResult = resolveHttpResultClass();
  if (typeof HttpResult === 'function') {
    try {
      const payloadForHttpResult =
        typeof body === 'object' && body !== null && !Buffer.isBuffer(body)
          ? JSON.stringify(body)
          : body;
      return instantiateHttpResult(HttpResult, payloadForHttpResult, statusCode, headers, contentType);
    } catch {
      // بازگشت امن به مقدار مستقیم در صورت تفاوت امضا
    }
  }
  return body;
}

function sendHtml(protocolRef, html, statusCode = 200) {
  return buildCustomHttpResponse(protocolRef, html, statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
}

function sendNoStoreJson(protocolRef, payload, statusCode = 200) {
  applyResponseMeta(protocolRef, statusCode, {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });
  if (statusCode === 200) return payload;
  return buildCustomHttpResponse(protocolRef, payload, statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
}

async function runJsonHandler(protocolRef, fn, options = {}) {
  try {
    const result = await fn();
    if (options.noStore) {
      return sendNoStoreJson(protocolRef, result, 200);
    }
    applyResponseMeta(protocolRef, 200, {});
    return result;
  } catch (err) {
    const statusCode = err?.statusCode || 500;
    const payload =
      err?.response || {
        statusCode,
        message: String(err?.message ?? err),
      };
    return buildCustomHttpResponse(
      protocolRef,
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
  NotFoundError,
  ConflictError,
  registerFrameworkGlobals,
  resolveHttpResultClass,
  getQuery,
  getParams,
  getBody,
  getClientMeta,
  sendHtml,
  sendNoStoreJson,
  runJsonHandler,
  get registeredResult() {
    return registeredResult;
  },
};
