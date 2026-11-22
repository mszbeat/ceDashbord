'use strict';

/**
 * D8 — شناسهٔ درخواست (requestId) برای همهٔ لاگ‌های یک درخواست.
 *
 * چرا: در لاگ‌های فعلی هیچ راهی برای وصل‌کردن لاگ‌های یک درخواست به هم نبود. با این ماژول
 * هر درخواست یک `requestId` می‌گیرد (از هدر `x-request-id` اگر درست باشد، وگرنه تصادفی) و
 * لاگر عمل آن را به‌صورت خودکار در فیلد `requestId` می‌نویسد.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const storage = new AsyncLocalStorage();

const ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function newId() {
  return crypto.randomUUID();
}

function currentId() {
  return storage.getStore()?.requestId ?? null;
}

/** اجرای تابع در بافت یک درخواست */
function runWithRequestId(requestId, fn) {
  return storage.run({ requestId: requestId || newId() }, fn);
}

/** انتخاب شناسه از هدر یا تولید تازه (هدر نامعتبر نادیده گرفته می‌شود) */
function requestIdFrom(headers) {
  const raw = headers?.['x-request-id'] ?? headers?.['X-Request-Id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && ID_RE.test(value) ? value : newId();
}

/**
 * میان‌افزار سازگار با هر دو سبک (Express یا فریم‌ورک پارت): اگر آبجکت درخواست/پاسخ
 * شناخته‌شده باشد شناسه ست می‌شود، در غیر این صورت فقط بافت را می‌سازد.
 */
function middleware(req, res, next) {
  const headers = req?.headers || {};
  const requestId = requestIdFrom(headers);
  if (req && typeof req === 'object') {
    try { req.requestId = requestId; } catch { /* فقط‌خواندنی */ }
  }
  if (res && typeof res.setHeader === 'function') {
    try { res.setHeader('x-request-id', requestId); } catch { /* نادیده */ }
  }
  if (typeof next === 'function') return runWithRequestId(requestId, next);
  return runWithRequestId(requestId, () => undefined);
}

module.exports = { runWithRequestId, requestIdFrom, currentId, newId, middleware, storage };
