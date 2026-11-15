'use strict';

/**
 * لایهٔ تطبیق HTTP برای partFramework:
 * - استخراج یکنواخت queryString، params، body و مشخصات کلاینت از protocolRef
 * - ساخت پاسخهای سفارشی HTML و خطاهای HTTP (400/404/503) با پشتیبانی هوشمند از HttpResult در partFramework
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

let cachedHttpResultClass;
function resolveHttpResultClass() {
  if (cachedHttpResultClass !== undefined) return cachedHttpResultClass;
  if (typeof global.HttpResult === 'function') {
    cachedHttpResultClass = global.HttpResult;
    return cachedHttpResultClass;
  }
  const candidates = [
    '@partFramework/helper',
    'partFramework',
    '@partFramework/http',
    '@partFramework/router',
    '@partFramework/baseServer',
  ];
  for (const modName of candidates) {
    try {
      const mod = require(modName);
      if (typeof mod?.HttpResult === 'function') {
        cachedHttpResultClass = mod.HttpResult;
        return cachedHttpResultClass;
      }
      if (typeof mod === 'function' && mod.name === 'HttpResult') {
        cachedHttpResultClass = mod;
        return cachedHttpResultClass;
      }
    } catch {
      // ادامه به ماژول بعدی
    }
  }
  cachedHttpResultClass = null;
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

function buildCustomHttpResponse(protocolRef, body, statusCode = 200, headers = {}) {
  const contentType =
    headers['Content-Type'] || headers['content-type'] || 'application/json; charset=utf-8';
  applyResponseMeta(protocolRef, statusCode, headers);

  const HttpResult = resolveHttpResultClass();
  if (typeof HttpResult === 'function') {
    try {
      const src = Function.prototype.toString.call(HttpResult);
      const ctorMatch = src.match(/constructor\s*\(([^)]*)\)/);
      const paramSig = (ctorMatch ? ctorMatch[1] : '').trim();
      // اگر سازنده شیء تنظیمات دریافت میکند (معمول در @partFramework/helper)
      if (!paramSig || paramSig.startsWith('{') || !paramSig.includes(',')) {
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
      // اگر سازنده پارامترهای موقعیتی دارد، بر اساس نام پارامترها مقداردهی کن
      const paramNames = paramSig.split(',').map((s) => s.split('=')[0].trim().toLowerCase());
      const args = paramNames.map((name, idx) => {
        if (name.includes('status') || name === 'code') return statusCode;
        if (name.includes('header')) return headers;
        if (name.includes('type') || name.includes('mime')) return contentType;
        if (idx === 0) return body;
        return undefined;
      });
      return new HttpResult(...args);
    } catch {
      // بازگشت به مقدار مستقیم در صورت تفاوت امضا
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
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return buildCustomHttpResponse(protocolRef, serialized, statusCode, {
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
      JSON.stringify(payload),
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
  getQuery,
  getParams,
  getBody,
  getClientMeta,
  sendHtml,
  sendNoStoreJson,
  runJsonHandler,
};
