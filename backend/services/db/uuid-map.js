'use strict';

/**
 * نگاشت شناسهٔ خارجی → UUID پایدار.
 *
 * `request_id` در v1 ستون `text` بود و هر رشته‌ای را می‌پذیرفت؛ در v2 نوع `uuid` است
 * (۱۶ بایت در برابر ~۳۷ بایت، و قابل ایندکس‌شدن بهینه). شناسه‌هایی که از قبل UUID معتبرند
 * دست‌نخورده می‌مانند؛ بقیه با UUIDv5 از فضای‌نام ثابت مشتق می‌شوند.
 *
 * برای اینکه `/api/sample/:id` با شناسهٔ اصلی هم کار کند، نگاشت معکوس در
 * `external_id_map` نگه داشته می‌شود (فقط برای شناسه‌های غیر-UUID).
 */

const crypto = require('node:crypto');

// namespace ثابت پروژه (UUIDv5 از DNS namespace تولید شده و هرگز نباید تغییر کند)
const NAMESPACE = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid5(name, namespace = NAMESPACE) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([nsBytes, Buffer.from(String(name), 'utf8')])).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @returns {string} UUID معتبر (ورودی UUID همان‌طور برمی‌گردد) */
function ensureUuid(value) {
  const text = String(value ?? '');
  return UUID_RE.test(text) ? text.toLowerCase() : uuid5(text);
}

/** آیا این شناسه در v2 به UUID تبدیل شده است؟ */
function needsMapping(value) {
  return !UUID_RE.test(String(value ?? ''));
}

module.exports = { ensureUuid, uuid5, needsMapping, NAMESPACE, UUID_RE };
