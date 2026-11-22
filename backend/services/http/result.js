'use strict';

/**
 * پاسخ‌های کنترل‌شدهٔ HTTP برای کنترلرهای partFramework.
 *
 * در نسخهٔ ۱۰ فریم‌ورک:
 *  - اگر هندلر مقدار ساده (مثلاً رشتهٔ HTML یا شیء JSON) برگرداند، `@partFramework/http`
 *    پاسخ را با وضعیت ۲۰۰ و در پوشش `{ "data": ... }` ارسال می‌کند.
 *  - فقط زمانی که کلاس بومی `HttpResult` فریم‌ورک وجود داشته و با امضای صحیح
 *    ساخته شود، از آن برای کنترل مستقیم status/headers/content-type استفاده می‌کنیم.
 *  - اگر `HttpResult` بومی در محیط در دسترس نباشد (یا ساخت آن خطا بدهد)، هرگز شیء
 *    ساختگی `{ data, statusCode, headers }` برنمی‌گردانیم تا `@partFramework/http` دچار
 *    خطای ناشناخته یا دوگانه‌پیچی نشود؛ بلکه هدرها/وضعیت را روی `_protocolRef.response`
 *    اعمال کرده و خود payload خام را برمی‌گردانیم (الگوی اثبات‌شدهٔ `http-adapter.js`).
 */

let cachedHttpResultClass;

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
  if (cachedHttpResultClass !== undefined) return cachedHttpResultClass;

  if (typeof global.HttpResult === 'function') {
    cachedHttpResultClass = global.HttpResult;
    return cachedHttpResultClass;
  }

  const candidates = [
    '@partFramework/http',
    '@partFramework/baseController',
    '@partFramework/helper',
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
      // پکیج در این محیط نصب یا در دسترس نیست
    }
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
  } catch {
    // ignore
  }

  cachedHttpResultClass = null;
  return null;
}

function resetHttpResultCacheForTest() {
  cachedHttpResultClass = undefined;
}

class LocalHttpResult {
  constructor(data, statusCode = 200, headers = {}) {
    this.data = data;
    this.statusCode = statusCode;
    this.headers = headers && typeof headers === 'object' ? headers : {};
  }
}

class HttpError extends Error {
  constructor(statusCode, payload) {
    const message =
      typeof payload === 'string' ? payload : payload?.message?.fa || payload?.message?.en || payload?.message;
    super(typeof message === 'string' && message ? message : `HTTP ${statusCode}`);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.data = typeof payload === 'object' && payload !== null ? payload : { message: String(payload) };
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

function applyResponseMeta(responseTarget, statusCode, headers) {
  const targets = [
    responseTarget?.response,
    responseTarget?.response?.res,
    responseTarget?.res,
    responseTarget,
  ].filter((t) => t && typeof t === 'object');

  for (const target of targets) {
    try {
      if (typeof target.status === 'function') target.status(statusCode);
      else if ('statusCode' in target) target.statusCode = statusCode;
    } catch {
      // ignore
    }
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        try {
          if (typeof target.setHeader === 'function') target.setHeader(k, v);
          else if (typeof target.header === 'function') target.header(k, v);
          else if (target.headers && typeof target.headers === 'object') target.headers[k] = v;
        } catch {
          // ignore
        }
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

/**
 * هدر `Content-Type` را با کلید استاندارد و **مقدار درست** برمی‌گرداند.
 * اگر فراخوان هدر نداده باشد، از پیش‌فرض همان پاسخ استفاده می‌شود.
 */
function normalizeHeaders(headers, contentType) {
  const out = { ...(headers && typeof headers === 'object' ? headers : {}) };
  const existingKey = Object.keys(out).find((k) => k.toLowerCase() === 'content-type');
  const value = existingKey ? out[existingKey] : contentType;

  if (existingKey && existingKey !== 'Content-Type') delete out[existingKey];
  if (value) out['Content-Type'] = value;
  return out;
}

function createHttpResult(data, statusCode = 200, headers = {}, responseTarget = null) {
  const contentType =
    headers['Content-Type'] || headers['content-type'] || 'application/json; charset=utf-8';
  // هدرها همیشه روی پاسخ خام اعمال شوند (حتی وقتی HttpResult فریم‌ورک در دسترس است)
  const normalizedHeaders = normalizeHeaders(headers, contentType);
  applyResponseMeta(responseTarget, statusCode, normalizedHeaders);

  const Resolved = resolveHttpResultClass();
  if (typeof Resolved === 'function') {
    try {
      /**
       * 🐞 اصلاح «استایل‌ها لود نشدند»:
       * رشته (مثلاً HTML گزارش) نباید JSON.stringify شود. قبلاً هر مقدار غیر-Buffer
       * رشته‌ای‌سازی می‌شد و در نتیجه ترنسپورت، HTML را در پوشش `{ "data": "…" }`
       * می‌فرستاد. اگر هدر هم HTML می‌ماند، مرورگر بدنهٔ JSON را به‌عنوان HTML
       * تجزیه می‌کرد: `class=\"page\"` ⇒ سلکتورهای CSS بی‌اثر ⇒ صفحهٔ بدون استایل.
       * حالا رشته «همان‌طور که هست» پاس داده می‌شود.
       */
      const payloadForHttpResult =
        typeof data === 'string' || Buffer.isBuffer(data) || typeof data !== 'object' || data === null
          ? data
          : JSON.stringify(data);
      return instantiateHttpResult(
        Resolved,
        payloadForHttpResult,
        statusCode,
        normalizedHeaders,
        contentType,
      );
    } catch {
      // اگر ساختار HttpResult فریم‌ورک ناسازگار بود، به مقدار خام بازگرد
    }
  }

  return data;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

/**
 * پاسخ JSON با هدر no-store.
 */
function sendJson(payload, statusCode = 200, responseTarget = null) {
  return createHttpResult(payload, statusCode, JSON_HEADERS, responseTarget);
}

/**
 * پاسخ HTML (صفحهٔ زندهٔ داشبورد یا صفحهٔ خطای گزارش).
 */
function sendHtml(html, statusCode = 200, responseTarget = null) {
  return createHttpResult(html, statusCode, HTML_HEADERS, responseTarget);
}

/**
 * یکسان‌سازی خطای کنترلر به ساختار استاندارد پارت:
 *   { meta, data: { message: { fa, en }, additionalInfo? }, statusCode }
 * ورودی می‌تواند خروجی دیکشنری `config.error`، یک HttpError یا Error خام باشد.
 */
function normalizeError(error) {
  if (error && typeof error === 'object' && typeof error.statusCode === 'number' && error.meta) {
    return error;
  }
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      meta: error.data?.meta,
      data: error.data,
    };
  }
  return null;
}

module.exports = {
  get HttpResultClass() {
    return resolveHttpResultClass();
  },
  LocalHttpResult,
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  resolveHttpResultClass,
  resetHttpResultCacheForTest,
  applyResponseMeta,
  instantiateHttpResult,
  normalizeHeaders,
  createHttpResult,
  sendJson,
  sendHtml,
  normalizeError,
  JSON_HEADERS,
  HTML_HEADERS,
};
