'use strict';

const http = require('node:http');

const kPendingRefreshCookies = Symbol.for('ce.pendingRefreshCookies');
const kInstalled = Symbol.for('ce.httpCookieNormalizerInstalled');

function splitSetCookieHeaderValue(raw) {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => splitSetCookieHeaderValue(entry));
  }
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/,\s*(?=[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSetCookieLine(line) {
  const parts = String(line || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  const attrs = parts.slice(1);
  let path = '';
  let domain = '';
  let maxAge = '';
  for (const attr of attrs) {
    const lower = attr.toLowerCase();
    if (lower.startsWith('path=')) path = attr.slice(5).trim();
    else if (lower.startsWith('domain=')) domain = attr.slice(7).trim();
    else if (lower.startsWith('max-age=')) maxAge = attr.slice(8).trim();
  }
  const isDeletion = value === '' || maxAge === '0';
  return { name, value, attrs, path, domain, maxAge, isDeletion };
}

/**
 * کوکی‌های `token` و `ce_refresh` را یکدست می‌کند:
 * - برای کوکی فعال، Path همیشه روی `/` قرار می‌گیرد تا مرورگر به همهٔ مسیرها بفرستد
 *   (جلوگیری از باگ `Path: /api/auth` در partSessionManager).
 * - اگر `COOKIE_DOMAIN` صراحتاً تنظیم نشده باشد، `Domain=localhost` اضافی از کوکی فعال حذف می‌شود.
 * - برای کوکی‌های پاک‌سازی (`Max-Age=0`) مسیر صریح (مثل `/api/auth`) جهت پاک‌کردن کوکی‌های قدیمی حفظ می‌شود.
 */
function normalizeSetCookieLine(rawLine, options = {}) {
  const parsed = parseSetCookieLine(rawLine);
  if (!parsed) return String(rawLine || '').trim();
  const { name, value, attrs, isDeletion } = parsed;
  if (name !== 'token' && name !== 'ce_refresh') {
    return String(rawLine).trim();
  }

  if (isDeletion) {
    return String(rawLine).trim();
  }

  const configuredDomain = process.env.COOKIE_DOMAIN ? process.env.COOKIE_DOMAIN.trim() : '';
  const keptAttrs = [];
  let hasHttpOnly = false;
  let hasSameSite = false;
  let hasSecure = false;

  for (const attr of attrs) {
    const lower = attr.toLowerCase();
    if (lower.startsWith('path=')) continue;
    if (lower.startsWith('domain=')) {
      const domVal = attr.slice(7).trim();
      if (configuredDomain && domVal.toLowerCase() === configuredDomain.toLowerCase()) {
        keptAttrs.push(`Domain=${configuredDomain}`);
      }
      continue;
    }
    if (lower === 'httponly') {
      hasHttpOnly = true;
      keptAttrs.push('HttpOnly');
      continue;
    }
    if (lower.startsWith('samesite=')) {
      hasSameSite = true;
      keptAttrs.push(attr);
      continue;
    }
    if (lower === 'secure') {
      if (options.stripSecure) continue;
      hasSecure = true;
      keptAttrs.push('Secure');
      continue;
    }
    keptAttrs.push(attr);
  }

  const out = [`${name}=${value}`, 'Path=/'];
  if (configuredDomain && !keptAttrs.some((a) => a.toLowerCase().startsWith('domain='))) {
    out.push(`Domain=${configuredDomain}`);
  }
  out.push(...keptAttrs);
  if (!hasHttpOnly) out.push('HttpOnly');
  if (!hasSameSite) out.push('SameSite=Lax');
  if (!hasSecure && options.forceSecure && !options.stripSecure) out.push('Secure');

  return out.join('; ');
}

function dedupeSetCookiesList(cookies) {
  const order = [];
  const map = new Map();
  for (const line of cookies) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    const parsed = parseSetCookieLine(trimmed);
    const key = parsed
      ? `${parsed.name.toLowerCase()}@${parsed.path || '/'}@${(parsed.domain || '').toLowerCase()}`
      : trimmed;
    if (!map.has(key)) order.push(key);
    map.set(key, trimmed);
  }
  return order.map((k) => map.get(k));
}

function mergeAndNormalizeSetCookies(existingRaw, newCookies = [], pendingRefresh = []) {
  const combined = [
    ...splitSetCookieHeaderValue(existingRaw),
    ...splitSetCookieHeaderValue(newCookies),
  ].map((line) => normalizeSetCookieLine(line));

  const hasRefreshInCombined = combined.some((line) => line.startsWith('ce_refresh='));
  if (!hasRefreshInCombined && Array.isArray(pendingRefresh) && pendingRefresh.length) {
    for (const r of pendingRefresh) {
      combined.push(normalizeSetCookieLine(r));
    }
  }

  return dedupeSetCookiesList(combined);
}

function installHttpCookiePathNormalizer() {
  const proto = http.ServerResponse && http.ServerResponse.prototype;
  if (!proto || proto[kInstalled]) return false;

  const origSetHeader = proto.setHeader;
  const origAppendHeader = typeof proto.appendHeader === 'function' ? proto.appendHeader : null;
  const origWriteHead = proto.writeHead;

  proto.setHeader = function patchedSetHeader(name, value) {
    if (String(name).toLowerCase() === 'set-cookie') {
      const normalized = mergeAndNormalizeSetCookies(
        value,
        [],
        this[kPendingRefreshCookies],
      );
      const refreshLines = normalized.filter((c) => c.startsWith('ce_refresh='));
      if (refreshLines.length) {
        this[kPendingRefreshCookies] = refreshLines;
      }
      return origSetHeader.call(this, name, normalized);
    }
    return origSetHeader.call(this, name, value);
  };

  if (origAppendHeader) {
    proto.appendHeader = function patchedAppendHeader(name, value) {
      if (String(name).toLowerCase() === 'set-cookie') {
        const current = typeof this.getHeader === 'function' ? this.getHeader('Set-Cookie') : [];
        const normalized = mergeAndNormalizeSetCookies(
          current,
          value,
          this[kPendingRefreshCookies],
        );
        const refreshLines = normalized.filter((c) => c.startsWith('ce_refresh='));
        if (refreshLines.length) {
          this[kPendingRefreshCookies] = refreshLines;
        }
        return origSetHeader.call(this, 'Set-Cookie', normalized);
      }
      return origAppendHeader.call(this, name, value);
    };
  }

  proto.writeHead = function patchedWriteHead(statusCode, statusMessage, headers) {
    let resolvedHeaders = headers;
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      resolvedHeaders = statusMessage;
    }

    if (resolvedHeaders && typeof resolvedHeaders === 'object') {
      for (const key of Object.keys(resolvedHeaders)) {
        if (key.toLowerCase() === 'set-cookie') {
          const current = typeof this.getHeader === 'function' ? this.getHeader('Set-Cookie') : [];
          const merged = mergeAndNormalizeSetCookies(
            current,
            resolvedHeaders[key],
            this[kPendingRefreshCookies],
          );
          resolvedHeaders[key] = merged;
        }
      }
    } else if (typeof this.getHeader === 'function') {
      const current = this.getHeader('Set-Cookie');
      if (current !== undefined || (this[kPendingRefreshCookies] && this[kPendingRefreshCookies].length)) {
        const merged = mergeAndNormalizeSetCookies(current, [], this[kPendingRefreshCookies]);
        if (merged.length) {
          origSetHeader.call(this, 'Set-Cookie', merged);
        }
      }
    }

    return origWriteHead.apply(this, arguments);
  };

  proto[kInstalled] = true;
  return true;
}

module.exports = {
  kPendingRefreshCookies,
  splitSetCookieHeaderValue,
  parseSetCookieLine,
  normalizeSetCookieLine,
  dedupeSetCookiesList,
  mergeAndNormalizeSetCookies,
  installHttpCookiePathNormalizer,
};
