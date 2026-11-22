'use strict';

/**
 * پروتکل «پل BFF» بین Next.js و بک‌اند — جایگزین اعتماد به هدر خام `x-ce-bff`.
 *
 * ── مشکلی که حل می‌کند (امنیت) ──────────────────────────────────────────────
 * در حالت BFF، بک‌اند کوکی‌های `token`/`ce_refresh` را که HttpOnly هستند در **بدنهٔ JSON**
 * قرار می‌دهد تا Next بتواند آن‌ها را روی پاسخ مرورگر بگذارد. پیش‌تر این کار به یک هدر
 * خام وابسته بود:
 *
 *     if (request.headers['x-ce-bff'] === '1') { … reveal HttpOnly cookies in JSON … }
 *
 * هر کلاینتی می‌توانست همان هدر را بفرستد. یعنی اگر پورت بک‌اند از بیرون در دسترس بود
 * (که `BACKEND_HOST=0.0.0.0` پیش‌فرض است)، محافظت HttpOnly دور زده می‌شد و
 * رفرش‌توکن داخل بدنهٔ JSON خوانده می‌شد — عملاً نشت نشست.
 *
 * ── راه‌حل ─────────────────────────────────────────────────────────────────
 * هدر امضاشده با HMAC-SHA256 روی (timestamp + nonce + متد + مسیر + هش SHA-256 کوکی‌های
 * ارسالی). امضای درست فقط با `CE_BFF_SHARED_SECRET` ساخته می‌شود که فقط Next.js و
 * بک‌اند دارند. امضای یک درخواست را نمی‌توان روی درخواست دیگر (مسیر/کوکی متفاوت) سوار کرد.
 *
 * ── سازگاری ────────────────────────────────────────────────────────────────
 *  • اگر `CE_BFF_SHARED_SECRET` تنظیم نشده باشد (مثلاً نسخهٔ قدیمی Next):
 *    - روی شبکهٔ **خصوصی/داخلی** (loopback، RFC1918، link-local، CGNAT، ULA/fe80) هدر خام
 *      پذیرفته می‌شود — رایج‌ترین شکل استقرار شما (دو فرایند روی یک ماشین/یک LAN) بدون هیچ
 *      تغییری کار می‌کند.
 *    - از راه دور (IP عمومی اینترنت)، هدر خام **رد** می‌شود (۴۰۳) تا کوکی‌ها به بدنه نمی‌آیند.
 *  • اگر secret تنظیم شده باشد، فقط امضای معتبر پذیرفته می‌شود.
 */

const crypto = require('node:crypto');

const HEADER_TS = 'x-ce-bff-ts';
const HEADER_NONCE = 'x-ce-bff-nonce';
const HEADER_SIG = 'x-ce-bff-sig';
/** مقدار قدیمی — فقط برای تشخیص «کلاینت نسخهٔ قبل» */
const HEADER_LEGACY = 'x-ce-bff';

const MAX_SKEW_MS = Number(process.env.CE_BFF_MAX_SKEW_MS || 60_000);
const NONCE_TTL_MS = Number(process.env.CE_BFF_NONCE_TTL_MS || 120_000);

/** nonceهای مصرف‌شده (برای anti-replay). حافظهٔ کوچک و محدود. */
const seenNonces = new Map();

function cleanupNonces(now) {
  if (seenNonces.size <= 5000) return;
  for (const [nonce, at] of Array.from(seenNonces.entries())) {
    if (now - at > NONCE_TTL_MS) seenNonces.delete(nonce);
  }
}

function sharedSecret() {
  const value = String(process.env.CE_BFF_SHARED_SECRET || '').trim();
  return value.length >= 16 ? value : '';
}

function readHeader(request, name) {
  const direct =
    request?.headers?.[name] ??
    request?.header?.[name] ??
    request?.req?.headers?.[name];
  if (direct !== undefined && direct !== null) return String(direct);
  const rawHeaders = request?.rawHeaders || request?.req?.rawHeaders;
  if (Array.isArray(rawHeaders)) {
    for (let i = 0; i < rawHeaders.length - 1; i += 2) {
      if (String(rawHeaders[i]).toLowerCase() === name) return String(rawHeaders[i + 1]);
    }
  }
  return '';
}

function cookieHash(cookieHeader) {
  return crypto.createHash('sha256').update(String(cookieHeader || '')).digest('hex');
}

/** متد و مسیر درخواست، نرمال‌شده (بدون query — تا امضا قابل جابه‌جایی نباشد) */
function requestTarget(request) {
  const method = String(request?.method || request?.req?.method || 'POST').toUpperCase();
  const rawUrl = String(request?.url || request?.req?.url || '/');
  const path = rawUrl.split('?')[0] || '/';
  return { method, path };
}

/** رشتهٔ امضا: ts.nonce.method.path.cookieHash */
function buildSigningString({ ts, nonce, method, path, cookies }) {
  return [ts, nonce, method, path, cookieHash(cookies)].join('.');
}

function sign({ ts, nonce, method, path, cookies }, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(buildSigningString({ ts, nonce, method, path, cookies }))
    .digest('base64url');
}

/**
 * ساخت هدرهای پل BFF — در سمت Next.js معادل همین تابع وجود دارد
 * (`frontend/lib/bff-bridge.mjs`). هر دو باید یک خروجی بدهند.
 */
function buildBffHeaders({ method, path, cookies, secret, nonce, now = Date.now() }) {
  const ts = String(now);
  const realNonce = nonce || crypto.randomBytes(16).toString('base64url');
  const signature = sign({ ts, nonce: realNonce, method, path, cookies }, secret);
  return {
    [HEADER_TS]: ts,
    [HEADER_NONCE]: realNonce,
    [HEADER_SIG]: signature,
  };
}

/** آیا IP loopback است؟ */
function isLoopbackAddress(address) {
  const value = stripV4Mapped(String(address || '').trim().toLowerCase());
  if (!value) return false;
  return (
    value === '::1' ||
    value === 'localhost' ||
    value === '127.0.0.1' ||
    value.startsWith('127.')
  );
}

function stripV4Mapped(value) {
  // ::ffff:1.2.3.4 → 1.2.3.4 | ::ffff:0102:0304 → هگز → دسیمال
  const v4 = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return v4[1];
  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const h = (s) => parseInt(s, 16);
    return [(h(hex[1]) >> 8), h(hex[1]) & 255, (h(hex[2]) >> 8), h(hex[2]) & 255].join('.');
  }
  return value;
}

function parseV4(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255 || String(n).includes('.'))) {
    return null;
  }
  return nums;
}

/** آیا IP در محدودهٔ خصوصی/داخلی است (RFC1918 + link-local + CGNAT + ULA/link-local v6)؟ */
function isPrivateOrInternalAddress(address) {
  const raw = String(address || '').trim().toLowerCase();
  if (!raw) return false;
  if (isLoopbackAddress(raw)) return true;

  const value = stripV4Mapped(raw);

  // IPv6: ULA fc00::/7, link-local fe80::/10
  if (value.includes(':')) {
    const first = value.split(':')[0] || '';
    const firstNum = parseInt(first || '0', 16);
    if (Number.isFinite(firstNum)) {
      if ((firstNum & 0xfe00) === 0xfc00) return true; // fc00::/7 (private)
      if ((firstNum & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
    }
    return false;
  }

  const octets = parseV4(value);
  if (!octets) return false;
  const [a, b] = octets;

  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 127) return true; // loopback
  return false;
}

function remoteAddress(request) {
  return (
    request?.socket?.remoteAddress ||
    request?.connection?.remoteAddress ||
    request?.req?.socket?.remoteAddress ||
    request?.req?.connection?.remoteAddress ||
    ''
  );
}

/**
 * آیا این درخواست مجاز است در حالت پل BFF پاسخ بگیرد (یعنی کوکی‌ها در بدنه بیایند)؟
 *
 * @param {object} request
 * @param {{cookies?: string}} options کوکی‌های دریافتی، برای صحت امضا
 * @returns {{ok: boolean, mode: 'signed'|'legacy-internal'|'none', reason?: string, statusCode?: number}}
 */
function isBffBridgeRequest(request, options = {}) {
  const secret = sharedSecret();
  const cookies = options.cookies ?? readHeader(request, 'cookie');
  const ts = readHeader(request, HEADER_TS);
  const nonce = readHeader(request, HEADER_NONCE);
  const signature = readHeader(request, HEADER_SIG);

  // ── ۱) مسیر ترجیحی: امضای معتبر
  if (secret) {
    if (!ts || !nonce || !signature) {
      // کلاینت قدیمی با هدر خام؟ فقط از شبکهٔ خصوصی/داخلی؛ وگرنه رد.
      if (readHeader(request, HEADER_LEGACY) === '1' && isPrivateOrInternalAddress(remoteAddress(request))) {
        return { ok: true, mode: 'legacy-internal', reason: 'unsigned_internal_network' };
      }
      return { ok: false, mode: 'none', statusCode: 403, reason: 'missing_signature' };
    }

    const tsNum = Number(ts);
    const now = Date.now();
    if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > MAX_SKEW_MS) {
      return { ok: false, mode: 'none', statusCode: 403, reason: 'stale_timestamp' };
    }

    const { method, path } = requestTarget(request);
    const expected = sign({ ts, nonce, method, path, cookies }, secret);

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, mode: 'none', statusCode: 403, reason: 'bad_signature' };
    }

    // anti-replay: هر nonce یک بار
    if (seenNonces.has(nonce)) {
      return { ok: false, mode: 'none', statusCode: 403, reason: 'replayed_nonce' };
    }
    seenNonces.set(nonce, now);
    cleanupNonces(now);

    return { ok: true, mode: 'signed' };
  }

  // ── ۲) بدون secret: فقط شبکهٔ خصوصی/داخلی اجازه دارد
  if (readHeader(request, HEADER_LEGACY) === '1' || (ts && signature)) {
    if (isPrivateOrInternalAddress(remoteAddress(request))) {
      return { ok: true, mode: 'legacy-internal' };
    }
    return { ok: false, mode: 'none', statusCode: 403, reason: 'unsigned_remote_bridge' };
  }

  return { ok: false, mode: 'none' };
}

module.exports = {
  HEADER_TS,
  HEADER_NONCE,
  HEADER_SIG,
  HEADER_LEGACY,
  buildBffHeaders,
  buildSigningString,
  isBffBridgeRequest,
  sharedSecret,
  isLoopbackAddress,
  isPrivateOrInternalAddress,
};
