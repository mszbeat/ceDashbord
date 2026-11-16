'use strict';

/**
 * پاسخ‌های کنترل‌شدهٔ HTTP برای کنترلرهای partFramework 10.2.0.
 *
 * در نسخهٔ ۱۰.۲.۰ فریم‌ورک، اگر هندلر مقدار ساده برگرداند، `@partFramework/http`
 * آن را در پوشش `{ "data": <value> }` می‌پیچد (Content-Type: application/json).
 * برای مواردی که باید status/header/content-type را خودمان تعیین کنیم
 * (مثلاً HTML داشبورد یا no-store) از `HttpResult` استفاده می‌کنیم.
 */

let HttpResultClass = null;

try {
  const httpPackage = require('@partFramework/http');
  const candidates = [
    httpPackage?.HttpResult,
    httpPackage?.result?.HttpResult,
    httpPackage?.default?.HttpResult,
  ];
  HttpResultClass = candidates.find((c) => typeof c === 'function') || null;
} catch {
  HttpResultClass = null;
}

/**
 * کلاس جانشین (فقط برای تست‌های واحد داخل خود پروژه، زمانی که
 * `@partFramework/http` در دسترس نیست).
 */
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

function createHttpResult(data, statusCode = 200, headers = {}) {
  const Resolved = HttpResultClass || LocalHttpResult;
  let payload = data;
  if (statusCode === 200 && typeof Resolved === 'function' && Resolved === HttpResultClass) {
    // در پاسخ ۲۰۰ نیاز به رشته‌سازی نیست؛ فریم‌ورک body را خودش مدیریت می‌کند
    payload = data;
  }
  return new Resolved(payload, statusCode, headers);
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
function sendJson(payload, statusCode = 200) {
  return createHttpResult(payload, statusCode, JSON_HEADERS);
}

/**
 * پاسخ HTML (صفحهٔ زندهٔ داشبورد یا صفحهٔ خطای گزارش).
 */
function sendHtml(html, statusCode = 200) {
  return createHttpResult(html, statusCode, HTML_HEADERS);
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
  HttpResultClass,
  LocalHttpResult,
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  createHttpResult,
  sendJson,
  sendHtml,
  normalizeError,
  JSON_HEADERS,
  HTML_HEADERS,
};
