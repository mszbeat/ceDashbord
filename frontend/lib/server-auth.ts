import { fetchWithHeadersTimeout, DEFAULT_SESSION_TIMEOUT_MS } from '@/lib/upstream-timeout.mjs';

export interface AuthPayload {
  authenticated?: boolean;
  username?: string;
  samadUsername?: string;
  roles?: string[];
  canRefresh?: boolean;
  refreshExpiresAt?: string | null;
  accessExpireMs?: number;
  idleExpireMs?: number;
  [key: string]: any;
}

const REFRESH_TOKEN_ERROR_CODES = new Set([
  'refreshTokenRequired',
  'invalidRefreshToken',
  'refreshTokenExpired',
  'refreshTokenRevoked',
]);

const CREDENTIAL_ERROR_CODES = new Set([
  'invalidAuthInput',
  'invalidCredentials',
  'wrongPassword',
  'userNotFound',
  'tooManyRequests',
]);

const refreshFlights = new Map<string, Promise<RefreshOutcome>>();
/**
 * توکن‌هایی که بک‌اند صریحاً نامعتبر اعلام کرده است. تا وقتی همین کوکی در درخواست
 * حاضر باشد، تمدید دوباره تلاش نمی‌شود (چرخش توکنِ باطل، خانوادهٔ توکن را باطل می‌کند).
 */
const invalidRefreshTokens = new Map<string, number>();
const INVALID_TOKEN_TTL_MS = 30_000;
const recentRefreshCache = new Map<string, { at: number; outcome: RefreshOutcome }>();

export function refreshTokenFingerprint(cookieHeader: string): string {
  return getCookieValue(cookieHeader, 'ce_refresh');
}

export function isRefreshTokenKnownInvalid(cookieHeader: string): boolean {
  const token = refreshTokenFingerprint(cookieHeader);
  if (!token) return false;
  const at = invalidRefreshTokens.get(token);
  if (!at) return false;
  if (Date.now() - at > INVALID_TOKEN_TTL_MS) {
    invalidRefreshTokens.delete(token);
    return false;
  }
  return true;
}

export function markRefreshTokenInvalid(cookieHeader: string): void {
  const token = refreshTokenFingerprint(cookieHeader);
  if (!token) return;
  invalidRefreshTokens.set(token, Date.now());
  if (invalidRefreshTokens.size > 300) {
    const cutoff = Date.now() - INVALID_TOKEN_TTL_MS;
    for (const [key, at] of Array.from(invalidRefreshTokens.entries())) {
      if (at < cutoff) invalidRefreshTokens.delete(key);
    }
  }
}

export function resolveBackendOrigin(): string {
  return (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

/**
 * 🐞 باگ «بعد از لاگین وارد داشبورد نمی‌شوم» (رفت‌وبرگشت به `?reason=expired`).
 *
 * تمدید نشست دو نوع شکست دارد که رفتارشان **باید** متفاوت باشد:
 *
 *   • شکست قطعی: کوکی رفرش باطل/چرخیده/منقضی است (۴۰۱/۴۰۳ یا کدهای `refreshToken*`).
 *     ⇒ کوکی‌ها پاک شوند و کاربر به صفحهٔ ورود برود. این درست است.
 *
 *   • شکست موقت: بک‌اند ۵xx داد یا پاسخ نداد (دیتابیس/سمد شلوغ یا در حال ری‌استارت).
 *     کوکی رفرش **هنوز معتبر** است و فقط سرویس تمدید در دسترس نیست.
 *     رفتار قبلی: middleware کوکی‌های سالم را پاک می‌کرد و کاربر را به
 *     `/login?reason=expired` می‌فرستاد. با هر رفرش صفحه، اکسس‌توکن کوتاه
 *     (پیش‌فرض ۵ دقیقه) منقضی است، تمدید دوباره ۵۰۳ می‌گیرد و کاربر در یک حلقهٔ
 *     بی‌پایان «نشست شما منقضی شده» گیر می‌کند — بدون اینکه نشستش واقعاً منقضی شده باشد.
 *
 * حالا شکست موقت، کوکی‌ها را دست‌نخورده نگه می‌دارد و به لایهٔ بعد (route/page) اجازه می‌دهد
 * خودش تصمیم بگیرد؛ آن‌جا هم به‌جای پاک‌کردن کوکی، خطای «سرویس در دسترس نیست» نمایش داده می‌شود.
 */
export function isTransientAuthFailure(status: number, metaCode?: string): boolean {
  // کدهای قطعیِ نشست هرگز موقت حساب نمی‌شوند (حتی اگر با ۵xx برگردند)
  if (metaCode && REFRESH_TOKEN_ERROR_CODES.has(metaCode)) return false;
  if (status === 401 || status === 403) return false;
  // ۵xx، ۴۰۸، ۴۲۹ و هر پاسخ غیرقطعی دیگر ⇒ موقت
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * آیا پاسخ تمدید، توکن رفرش را «قطعاً» باطل اعلام کرده است؟
 * فقط در این حالت مجازیم کوکی `ce_refresh` را پاک کنیم.
 */
export function isDefinitiveRefreshFailure(status: number, metaCode?: string): boolean {
  if (metaCode && REFRESH_TOKEN_ERROR_CODES.has(metaCode)) return true;
  return status === 401 || status === 403;
}

export function isRequestHttps(incoming: Headers, requestUrl?: string): boolean {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  const xfp = incoming.get('x-forwarded-proto');
  if (xfp) {
    return xfp.split(',')[0].trim().toLowerCase() === 'https';
  }
  if (requestUrl && requestUrl.toLowerCase().startsWith('https://')) {
    return true;
  }
  return false;
}

export function extractSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as any).getSetCookie;
  if (typeof getSetCookie === 'function') {
    const list = getSetCookie.call(headers) as string[];
    if (Array.isArray(list) && list.length) return list;
  }
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  // تقسیم امن بدون شکستن تاریخ Expires=Thu, 01 Jan 1970...
  return combined.split(/,\s*(?=[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/).filter(Boolean);
}

interface ParsedSetCookie {
  name: string;
  value: string;
  attrs: string[];
  path: string;
  domain: string;
  maxAge: string;
  isDeletion: boolean;
}

function parseSetCookieLine(line: string): ParsedSetCookie | null {
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
  return {
    name,
    value,
    attrs,
    path,
    domain,
    maxAge,
    isDeletion: value === '' || maxAge === '0',
  };
}

export function buildExpiredCookieLines(
  name: string,
  options: { includeApiAuthPath?: boolean; includeLocalhostDomain?: boolean; isHttps?: boolean } = {},
): string[] {
  const secure = options.isHttps ? ' Secure;' : '';
  const sameSite = name === 'ce_refresh' ? ' SameSite=Lax;' : '';
  const paths = options.includeApiAuthPath ? ['/', '/api/auth'] : ['/'];
  const configuredDomain = process.env.COOKIE_DOMAIN ? process.env.COOKIE_DOMAIN.trim() : '';
  const out: string[] = [];
  for (const p of paths) {
    out.push(`${name}=; Path=${p}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;${sameSite}${secure}`);
    if (options.includeLocalhostDomain) {
      out.push(
        `${name}=; Path=${p}; Domain=localhost; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;${sameSite}${secure}`,
      );
    }
    if (configuredDomain && configuredDomain.toLowerCase() !== 'localhost') {
      out.push(
        `${name}=; Path=${p}; Domain=${configuredDomain}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;${sameSite}${secure}`,
      );
    }
  }
  return out;
}

export function normalizeBrowserSetCookies(
  cookies: string[],
  options: {
    allowToken?: boolean;
    scrubApiAuthPath?: boolean;
    isHttps?: boolean;
  } = {},
): string[] {
  const allowToken = options.allowToken !== false;
  const scrubApiAuthPath = options.scrubApiAuthPath !== false;
  const isHttps = Boolean(options.isHttps);
  const configuredDomain = process.env.COOKIE_DOMAIN ? process.env.COOKIE_DOMAIN.trim() : '';
  const out: string[] = [];
  let touchedToken = false;

  for (const raw of cookies) {
    const parsed = parseSetCookieLine(raw);
    if (!parsed) {
      if (raw && raw.trim()) out.push(raw.trim());
      continue;
    }

    const { name, value, attrs, isDeletion } = parsed;
    if (name !== 'token' && name !== 'ce_refresh') {
      out.push(raw.trim());
      continue;
    }

    if (isDeletion) {
      if (name === 'token') touchedToken = true;
      // هر دو مسیر / و /api/auth را جهت پاک‌سازی کوکی‌های قدیمی حفظ می‌کنیم
      const kept = attrs.filter((a) => !/^secure$/i.test(a) || isHttps);
      const line = [`${name}=${value}`, ...kept].join('; ');
      out.push(line);
      continue;
    }

    if (name === 'token' && !allowToken) {
      // هرگز توکن بازدیدکنندهٔ احرازنشده به مرورگر فرستاده نشود
      continue;
    }

    if (name === 'token') {
      touchedToken = true;
    }

    const keptAttrs: string[] = [];
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
        if (isHttps) {
          hasSecure = true;
          keptAttrs.push('Secure');
        }
        continue;
      }
      keptAttrs.push(attr);
    }

    const rebuilt = [`${name}=${value}`, 'Path=/'];
    if (configuredDomain && !keptAttrs.some((a) => a.toLowerCase().startsWith('domain='))) {
      rebuilt.push(`Domain=${configuredDomain}`);
    }
    rebuilt.push(...keptAttrs);
    if (!hasHttpOnly) rebuilt.push('HttpOnly');
    if (!hasSameSite) rebuilt.push('SameSite=Lax');
    if (isHttps && !hasSecure && process.env.COOKIE_SECURE === 'true') {
      rebuilt.push('Secure');
    }

    out.push(rebuilt.join('; '));
  }

  const scrubList: string[] = [];
  if (scrubApiAuthPath && touchedToken) {
    scrubList.push(
      `token=; Path=/api/auth; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly`,
      `token=; Path=/api/auth; Domain=localhost; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly`,
    );
    if (configuredDomain.toLowerCase() !== 'localhost') {
      scrubList.push(
        `token=; Path=/; Domain=localhost; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly`,
      );
    }
  }

  return dedupeSetCookies([...scrubList, ...out]);
}

export function parseCookieHeader(rawCookieHeader: string): Map<string, string> {
  const jar = new Map<string, string>();
  if (!rawCookieHeader) return jar;
  for (const part of rawCookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (name) jar.set(name, val);
  }
  return jar;
}

export function serializeCookieMap(jar: Map<string, string>): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function hasCookie(rawCookieHeader: string, name: string): boolean {
  const jar = parseCookieHeader(rawCookieHeader);
  const val = jar.get(name);
  return typeof val === 'string' && val.length > 0;
}

export function getCookieValue(rawCookieHeader: string, name: string): string {
  return parseCookieHeader(rawCookieHeader).get(name) || '';
}

export function stripCookie(rawCookieHeader: string, name: string): string {
  const jar = parseCookieHeader(rawCookieHeader);
  jar.delete(name);
  return serializeCookieMap(jar);
}

export function mergeCookieHeader(rawCookieHeader: string, setCookieHeaders: string[]): string {
  const jar = parseCookieHeader(rawCookieHeader);
  const configuredDomain = (process.env.COOKIE_DOMAIN || '').trim().toLowerCase();
  for (const sc of setCookieHeaders) {
    const parsed = parseSetCookieLine(sc);
    if (!parsed) continue;
    if (parsed.isDeletion) {
      // پاک‌کردن کوکی قدیمی با مسیر `/api/auth` یا دامنهٔ قدیمی نباید کوکی سالم روی `/` را حذف کند
      const samePath = !parsed.path || parsed.path === '/';
      const sameScopeDomain = !parsed.domain || (configuredDomain && parsed.domain.toLowerCase() === configuredDomain);
      if (samePath && sameScopeDomain) {
        jar.delete(parsed.name);
      }
    } else {
      jar.set(parsed.name, parsed.value);
    }
  }
  return serializeCookieMap(jar);
}

export function dedupeSetCookies(cookies: string[]): string[] {
  const order: string[] = [];
  const latestByKey = new Map<string, string>();
  for (const sc of cookies) {
    const parsed = parseSetCookieLine(sc);
    const key = parsed
      ? `${parsed.name.toLowerCase()}@${parsed.path || '/'}@${parsed.domain.toLowerCase()}`
      : sc;
    if (!latestByKey.has(key)) {
      order.push(key);
    }
    latestByKey.set(key, sc);
  }
  return order.map((k) => latestByKey.get(k)!).filter(Boolean);
}

export function buildForwardClientHeaders(incoming: Headers, cookieHeader: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-ce-bff': '1',
  };
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }
  for (const key of ['user-agent', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-proto']) {
    const val = incoming.get(key);
    if (val) headers[key] = val;
  }
  return headers;
}

export function unwrapAuthPayload(raw: any): AuthPayload | null {
  let cur = raw;
  for (let i = 0; i < 3; i += 1) {
    if (
      cur &&
      typeof cur === 'object' &&
      !Array.isArray(cur) &&
      'data' in cur &&
      cur.data !== undefined &&
      !('authenticated' in cur) &&
      !('canRefresh' in cur)
    ) {
      cur = cur.data;
      if (typeof cur === 'string') {
        try {
          cur = JSON.parse(cur);
        } catch {
          break;
        }
      }
      continue;
    }
    break;
  }
  return cur && typeof cur === 'object' ? (cur as AuthPayload) : null;
}

export function extractPartMetaCode(raw: any): string {
  return String(raw?.meta?.code || raw?.data?.meta?.code || raw?.error?.meta?.code || '');
}

function safeParseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractBridgedCookiesFromJson(rawText: string, rawJson: any): {
  cleanText: string;
  cleanJson: any;
  bridgedCookies: string[];
} {
  if (!rawJson || typeof rawJson !== 'object') {
    return { cleanText: rawText, cleanJson: rawJson, bridgedCookies: [] };
  }

  const bridged: string[] = [];
  let mutated = false;
  const clone = Array.isArray(rawJson) ? [...rawJson] : { ...rawJson };

  const pullList = (obj: any) => {
    if (obj && typeof obj === 'object' && Array.isArray(obj._ceSetCookies)) {
      for (const item of obj._ceSetCookies) {
        if (typeof item === 'string' && item.trim()) bridged.push(item.trim());
      }
      delete obj._ceSetCookies;
      mutated = true;
    }
  };

  pullList(clone);
  if (clone.data && typeof clone.data === 'object') {
    clone.data = { ...clone.data };
    pullList(clone.data);
  } else if (typeof clone.data === 'string') {
    const inner = safeParseJson(clone.data);
    if (inner && typeof inner === 'object' && Array.isArray(inner._ceSetCookies)) {
      pullList(inner);
      clone.data = JSON.stringify(inner);
      mutated = true;
    }
  }

  return {
    cleanText: mutated ? JSON.stringify(clone) : rawText,
    cleanJson: clone,
    bridgedCookies: bridged,
  };
}

function collectResponseCookies(res: Response, rawText: string, rawJson: any): {
  setCookies: string[];
  cleanText: string;
  cleanJson: any;
} {
  const httpCookies = extractSetCookies(res.headers);
  const { cleanText, cleanJson, bridgedCookies } = extractBridgedCookiesFromJson(rawText, rawJson);
  const setCookies = dedupeSetCookies([...httpCookies, ...bridgedCookies]);
  return { setCookies, cleanText, cleanJson };
}

function ensureActiveTokenSetCookie(
  setCookies: string[],
  liveCookieHeader: string,
  isHttps: boolean,
): string[] {
  const hasActiveToken = setCookies.some((c) => {
    const parsed = parseSetCookieLine(c);
    return parsed?.name === 'token' && !parsed.isDeletion;
  });
  if (hasActiveToken) return setCookies;

  const tokenVal = getCookieValue(liveCookieHeader, 'token');
  if (!tokenVal) return setCookies;

  const securePart = isHttps && process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return [
    `token=${tokenVal}; Path=/; HttpOnly; SameSite=Lax${securePart}`,
    ...setCookies,
  ];
}

export interface SessionProbeResult {
  ok: boolean;
  status: number;
  rawText: string;
  rawJson: any;
  data: AuthPayload | null;
  cookieHeader: string;
  setCookies: string[];
  browserSetCookies: string[];
}

export async function probeSessionWithCleanRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
  options: { forceCleanTokenIfUnauthed?: boolean } = {},
): Promise<SessionProbeResult> {
  const isHttps = isRequestHttps(incomingHeaders);

  const callMe = async (cookieVal: string) => {
    const res = await fetchWithHeadersTimeout(
      fetch,
      new URL('/api/auth/me', backendUrl).toString(),
      {
        method: 'GET',
        cache: 'no-store',
        headers: buildForwardClientHeaders(incomingHeaders, cookieVal),
      },
      { timeoutMs: DEFAULT_SESSION_TIMEOUT_MS },
    );
    const rawText = await res.text().catch(() => '');
    const rawJson = safeParseJson(rawText);
    const { setCookies, cleanText, cleanJson } = collectResponseCookies(res, rawText, rawJson);
    const data = unwrapAuthPayload(cleanJson);
    return { res, setCookies, rawText: cleanText, rawJson: cleanJson, data };
  };

  let first = await callMe(incomingCookieHeader);
  let mergedCookies = mergeCookieHeader(incomingCookieHeader, first.setCookies);
  let collectedSetCookies = [...first.setCookies];

  const issuedNewToken = first.setCookies.some((c) => {
    const parsed = parseSetCookieLine(c);
    return parsed?.name === 'token' && !parsed.isDeletion;
  });
  const shouldRecoverToken =
    hasCookie(incomingCookieHeader, 'token') &&
    (!first.res.ok || (options.forceCleanTokenIfUnauthed && first.data?.authenticated !== true && !issuedNewToken));

  if (shouldRecoverToken) {
    const cleanCookie = stripCookie(incomingCookieHeader, 'token');
    const cleanAttempt = await callMe(cleanCookie);
    if (cleanAttempt.res.ok || cleanAttempt.setCookies.length) {
      mergedCookies = mergeCookieHeader(cleanCookie, cleanAttempt.setCookies);
      collectedSetCookies = dedupeSetCookies([...collectedSetCookies, ...cleanAttempt.setCookies]);
      first = cleanAttempt;
    }
  }

  const isAuthenticated = first.res.ok && first.data?.authenticated === true;
  let browserSetCookies: string[];
  if (isAuthenticated) {
    browserSetCookies = normalizeBrowserSetCookies(collectedSetCookies, {
      allowToken: true,
      scrubApiAuthPath: true,
      isHttps,
    });
  } else {
    // به کاربر احرازنشده هرگز کوکی visitor جدید ارسال نمی‌شود؛ فقط در صورت نیاز کوکی‌های خراب قبلی پاک می‌شوند.
    const cleanup =
      hasCookie(incomingCookieHeader, 'token') && first.data?.canRefresh !== true
        ? buildExpiredCookieLines('token', {
            includeApiAuthPath: true,
            includeLocalhostDomain: true,
            isHttps,
          })
        : [];
    browserSetCookies = normalizeBrowserSetCookies([...collectedSetCookies, ...cleanup], {
      allowToken: false,
      scrubApiAuthPath: true,
      isHttps,
    });
  }

  return {
    ok: first.res.ok,
    status: first.res.status,
    rawText: first.rawText,
    rawJson: first.rawJson,
    data: first.data,
    cookieHeader: mergedCookies,
    setCookies: dedupeSetCookies(collectedSetCookies),
    browserSetCookies,
  };
}

export interface RefreshOutcome {
  ok: boolean;
  status: number;
  rawText: string;
  rawJson: any;
  data: AuthPayload | null;
  cookieHeader: string;
  setCookies: string[];
}

async function executeRefreshWithRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
  existingProbe?: SessionProbeResult,
): Promise<RefreshOutcome> {
  const isHttps = isRequestHttps(incomingHeaders);

  if (isRefreshTokenKnownInvalid(incomingCookieHeader)) {
    return {
      ok: false,
      status: 401,
      rawText: JSON.stringify({
        status: 'error',
        authenticated: false,
        canRefresh: false,
        message: { fa: 'نشست شما منقضی شده است.', en: 'Refresh token is known to be invalid.' },
      }),
      rawJson: null,
      data: { authenticated: false, canRefresh: false },
      cookieHeader: incomingCookieHeader,
      setCookies: [],
    };
  }

  const probe =
    existingProbe ??
    (await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, incomingCookieHeader, {
      forceCleanTokenIfUnauthed: true,
    }));

  if (probe.ok && probe.data?.authenticated === true) {
    return {
      ok: true,
      status: 200,
      rawText: probe.rawText,
      rawJson: probe.rawJson,
      data: probe.data,
      cookieHeader: probe.cookieHeader,
      setCookies: normalizeBrowserSetCookies(
        ensureActiveTokenSetCookie(probe.setCookies, probe.cookieHeader, isHttps),
        { allowToken: true, scrubApiAuthPath: true, isHttps },
      ),
    };
  }

  if (!hasCookie(probe.cookieHeader, 'ce_refresh')) {
    return {
      ok: false,
      status: 401,
      rawText: JSON.stringify({
        status: 'error',
        authenticated: false,
        canRefresh: false,
        message: { fa: 'توکن تمدید نشست یافت نشد.', en: 'Refresh token cookie is missing.' },
      }),
      rawJson: null,
      data: { authenticated: false, canRefresh: false },
      cookieHeader: probe.cookieHeader,
      setCookies: normalizeBrowserSetCookies(probe.setCookies, {
        allowToken: false,
        scrubApiAuthPath: true,
        isHttps,
      }),
    };
  }

  const postRefresh = async (cookieVal: string) => {
    const res = await fetchWithHeadersTimeout(
      fetch,
      new URL('/api/auth/refresh', backendUrl).toString(),
      {
      method: 'POST',
      cache: 'no-store',
      headers: {
        ...buildForwardClientHeaders(incomingHeaders, cookieVal),
        'content-type': 'application/json',
      },
      body: '{}',
    },
      { timeoutMs: DEFAULT_SESSION_TIMEOUT_MS },
    );
    const rawText = await res.text().catch(() => '');
    const rawJson = safeParseJson(rawText);
    const { setCookies, cleanText, cleanJson } = collectResponseCookies(res, rawText, rawJson);
    const data = unwrapAuthPayload(cleanJson);
    return { res, setCookies, rawText: cleanText, rawJson: cleanJson, data };
  };

  // اکسس توکن منقضی/visitor نباید همراه درخواست تمدید ارسال شود؛ برخی نسخه‌های
  // partFramework پیش از اجرای کنترلر refresh، توکن نامعتبر را ۴۰۱ میکنند.
  const refreshBaseCookies =
    probe.ok && probe.data?.authenticated === true
      ? probe.cookieHeader
      : stripCookie(probe.cookieHeader, 'token');

  let attempt = await postRefresh(refreshBaseCookies);
  let allSetCookies = dedupeSetCookies([...probe.setCookies, ...attempt.setCookies]);
  let liveCookies = mergeCookieHeader(refreshBaseCookies, attempt.setCookies);

  if (!attempt.res.ok) {
    const metaCode = extractPartMetaCode(attempt.rawJson);
    if (!REFRESH_TOKEN_ERROR_CODES.has(metaCode) && hasCookie(refreshBaseCookies, 'token')) {
      const freshProbe = await probeSessionWithCleanRecovery(
        backendUrl,
        incomingHeaders,
        stripCookie(refreshBaseCookies, 'token'),
      );
      attempt = await postRefresh(freshProbe.cookieHeader);
      allSetCookies = dedupeSetCookies([...allSetCookies, ...freshProbe.setCookies, ...attempt.setCookies]);
      liveCookies = mergeCookieHeader(freshProbe.cookieHeader, attempt.setCookies);
    }
  }

  const ok = attempt.res.ok && attempt.data?.authenticated === true;
  let finalCookies: string[];
  if (ok) {
    const ensured = ensureActiveTokenSetCookie(allSetCookies, liveCookies, isHttps);
    finalCookies = normalizeBrowserSetCookies(ensured, {
      allowToken: true,
      scrubApiAuthPath: true,
      isHttps,
    });
  } else {
    const metaCode = extractPartMetaCode(attempt.rawJson);
    const definitive = isDefinitiveRefreshFailure(attempt.res.status, metaCode);
    if (definitive) {
      markRefreshTokenInvalid(incomingCookieHeader);
    }

    if (definitive) {
      // شکست قطعی: کوکی اکسس پاک شود؛ `ce_refresh` هم توسط فراخواننده پاک می‌شود.
      finalCookies = normalizeBrowserSetCookies(
        [
          ...allSetCookies,
          ...buildExpiredCookieLines('token', {
            includeApiAuthPath: true,
            includeLocalhostDomain: true,
            isHttps,
          }),
        ],
        { allowToken: false, scrubApiAuthPath: true, isHttps },
      );
    } else {
      /**
       * شکست موقت (۵xx/408/429/بدون‌پاسخ): توکن رفرش هنوز معتبر است.
       *
       * قبلاً اینجا هم کوکی اکسس پاک و تمدید «نامعتبر» تلقی می‌شد؛ نتیجه: کاربر با
       * یک ۵۰۳ گذرا از حساب خارج می‌شد و چون اکسس‌توکن کوتاه است، هر بازدید تازه
       * دوباره به همان مسیر می‌رسید («بعد از لاگین وارد نمی‌شود»).
       *
       * اکنون هیچ کوکی پاک نمی‌شود و کوکی‌های به‌روزشدهٔ بک‌اند (در صورت وجود) پاس
       * داده می‌شوند تا مرورگر وضعیت یکدست داشته باشد.
       */
      finalCookies = normalizeBrowserSetCookies(allSetCookies, {
        allowToken: true,
        scrubApiAuthPath: true,
        isHttps,
      });
    }
  }

  return {
    ok,
    status: attempt.res.status,
    rawText: attempt.rawText,
    rawJson: attempt.rawJson,
    data: attempt.data,
    cookieHeader: liveCookies,
    setCookies: finalCookies,
  };
}

/**
 * فقط «اعتبار» کوکی رفرش را می‌سنجد، بدون چرخش (rotate) آن.
 * مرورگرها هنگام رفرش هم‌زمان چند درخواست می‌فرستند؛ اگر همه بخواهند توکن را
 * بچرخانند، توکن‌های بعدی «چرخیده» محسوب و خانوادهٔ توکن باطل می‌شود.
 * با این پیش‌بررسی فقط یک درخواست واقعاً توکن را می‌چرخاند.
 */
export async function peekRefreshToken(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
): Promise<{ ok: boolean; valid: boolean; rawText: string; rawJson: any } | null> {
  try {
    const res = await fetchWithHeadersTimeout(
      fetch,
      new URL('/api/auth/refresh/peek', backendUrl).toString(),
      {
      method: 'GET',
      cache: 'no-store',
      headers: buildForwardClientHeaders(incomingHeaders, incomingCookieHeader),
    },
      { timeoutMs: DEFAULT_SESSION_TIMEOUT_MS },
    );
    const rawText = await res.text().catch(() => '');
    const rawJson = safeParseJson(rawText);
    const data = unwrapAuthPayload(rawJson) as any;
    if (!res.ok || !data) return null;
    return { ok: true, valid: data.valid === true, rawText, rawJson };
  } catch {
    return null;
  }
}

export async function performRefreshWithRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
  existingProbe?: SessionProbeResult,
): Promise<RefreshOutcome> {
  const refreshKey = getCookieValue(existingProbe?.cookieHeader || incomingCookieHeader, 'ce_refresh');
  if (!refreshKey) {
    return executeRefreshWithRecovery(backendUrl, incomingHeaders, incomingCookieHeader, existingProbe);
  }

  const cached = recentRefreshCache.get(refreshKey);
  if (cached && Date.now() - cached.at < 2000) {
    return cached.outcome;
  }

  const existing = refreshFlights.get(refreshKey);
  if (existing) {
    return existing;
  }

  const promise = executeRefreshWithRecovery(backendUrl, incomingHeaders, incomingCookieHeader, existingProbe)
    .then((outcome) => {
      if (outcome.ok) {
        recentRefreshCache.set(refreshKey, { at: Date.now(), outcome });
        if (recentRefreshCache.size > 200) {
          const cutoff = Date.now() - 3000;
          for (const [k, v] of Array.from(recentRefreshCache.entries())) {
            if (v.at < cutoff) recentRefreshCache.delete(k);
          }
        }
      }
      return outcome;
    })
    .finally(() => {
      refreshFlights.delete(refreshKey);
    });

  refreshFlights.set(refreshKey, promise);
  return promise;
}

export async function performLoginWithRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
  bodyText: string,
): Promise<RefreshOutcome> {
  const isHttps = isRequestHttps(incomingHeaders);

  const postLogin = async (cookieVal: string) => {
    const res = await fetchWithHeadersTimeout(
      fetch,
      new URL('/api/auth/login', backendUrl).toString(),
      {
      method: 'POST',
      cache: 'no-store',
      headers: {
        ...buildForwardClientHeaders(incomingHeaders, cookieVal),
        'content-type': 'application/json',
      },
      body: bodyText,
    },
      { timeoutMs: DEFAULT_SESSION_TIMEOUT_MS },
    );
    const rawText = await res.text().catch(() => '');
    const rawJson = safeParseJson(rawText);
    const { setCookies, cleanText, cleanJson } = collectResponseCookies(res, rawText, rawJson);
    const data = unwrapAuthPayload(cleanJson);
    return { res, setCookies, rawText: cleanText, rawJson: cleanJson, data };
  };

  let probe = await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, incomingCookieHeader, {
    forceCleanTokenIfUnauthed: true,
  });
  let attempt = await postLogin(probe.cookieHeader);
  let allSetCookies = dedupeSetCookies([...probe.setCookies, ...attempt.setCookies]);
  let liveCookies = mergeCookieHeader(probe.cookieHeader, attempt.setCookies);

  if (!attempt.res.ok) {
    const metaCode = extractPartMetaCode(attempt.rawJson);
    if (!CREDENTIAL_ERROR_CODES.has(metaCode) && attempt.res.status !== 400 && attempt.res.status !== 429) {
      const freshProbe = await probeSessionWithCleanRecovery(
        backendUrl,
        incomingHeaders,
        stripCookie(incomingCookieHeader, 'token'),
      );
      attempt = await postLogin(freshProbe.cookieHeader);
      allSetCookies = dedupeSetCookies([...allSetCookies, ...freshProbe.setCookies, ...attempt.setCookies]);
      liveCookies = mergeCookieHeader(freshProbe.cookieHeader, attempt.setCookies);
    }
  }

  if (attempt.res.ok) {
    const verify = await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, liveCookies);
    allSetCookies = dedupeSetCookies([...allSetCookies, ...verify.setCookies]);
    liveCookies = verify.cookieHeader;
    if (verify.ok && verify.data?.authenticated !== true) {
      const cleanProbe = await probeSessionWithCleanRecovery(
        backendUrl,
        incomingHeaders,
        stripCookie(incomingCookieHeader, 'token'),
      );
      const retryAttempt = await postLogin(cleanProbe.cookieHeader);
      if (retryAttempt.res.ok) {
        attempt = retryAttempt;
        allSetCookies = dedupeSetCookies([...cleanProbe.setCookies, ...retryAttempt.setCookies]);
        liveCookies = mergeCookieHeader(cleanProbe.cookieHeader, retryAttempt.setCookies);
      }
    }
  }

  const finalCookies = attempt.res.ok
    ? normalizeBrowserSetCookies(ensureActiveTokenSetCookie(allSetCookies, liveCookies, isHttps), {
        allowToken: true,
        scrubApiAuthPath: true,
        isHttps,
      })
    : normalizeBrowserSetCookies(allSetCookies, {
        allowToken: false,
        scrubApiAuthPath: true,
        isHttps,
      });

  return {
    ok: attempt.res.ok,
    status: attempt.res.status,
    rawText: attempt.rawText,
    rawJson: attempt.rawJson,
    data: attempt.data,
    cookieHeader: liveCookies,
    setCookies: finalCookies,
  };
}

export async function performRegisterWithRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
  bodyText: string,
): Promise<RefreshOutcome> {
  const isHttps = isRequestHttps(incomingHeaders);
  let sanitizedBody = bodyText;
  let shouldAutoLogin = true;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      delete parsed.role;
      shouldAutoLogin = parsed.autoLogin !== false;
      sanitizedBody = JSON.stringify(parsed);
    }
  } catch {
    // pass through
  }

  const probe = await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, incomingCookieHeader, {
    forceCleanTokenIfUnauthed: shouldAutoLogin,
  });
  const res = await fetchWithHeadersTimeout(
    fetch,
    new URL('/api/auth/register', backendUrl).toString(),
    {
    method: 'POST',
    cache: 'no-store',
    headers: {
      ...buildForwardClientHeaders(incomingHeaders, probe.cookieHeader),
      'content-type': 'application/json',
    },
    body: sanitizedBody,},
    { timeoutMs: DEFAULT_SESSION_TIMEOUT_MS },
  );
  const rawText = await res.text().catch(() => '');
  const rawJson = safeParseJson(rawText);
  const { setCookies, cleanText, cleanJson } = collectResponseCookies(res, rawText, rawJson);
  const data = unwrapAuthPayload(cleanJson);
  const allSetCookies = dedupeSetCookies([...probe.setCookies, ...setCookies]);
  const liveCookies = mergeCookieHeader(probe.cookieHeader, setCookies);

  const allowIssuedToken = res.ok && shouldAutoLogin;
  const finalCookies = normalizeBrowserSetCookies(
    allowIssuedToken ? ensureActiveTokenSetCookie(allSetCookies, liveCookies, isHttps) : allSetCookies,
    { allowToken: allowIssuedToken, scrubApiAuthPath: true, isHttps },
  );

  return {
    ok: res.ok,
    status: res.status,
    rawText: cleanText,
    rawJson: cleanJson,
    data,
    cookieHeader: liveCookies,
    setCookies: finalCookies,
  };
}

export async function performLogoutWithRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
): Promise<RefreshOutcome> {
  const isHttps = isRequestHttps(incomingHeaders);
  const res = await fetchWithHeadersTimeout(
    fetch,
    new URL('/api/auth/logout', backendUrl).toString(),
    {
    method: 'POST',
    cache: 'no-store',
    headers: {
      ...buildForwardClientHeaders(incomingHeaders, incomingCookieHeader),
      'content-type': 'application/json',
    },
    body: '{}',},
    { timeoutMs: DEFAULT_SESSION_TIMEOUT_MS },
  );
  const rawText = await res.text().catch(() => '');
  const rawJson = safeParseJson(rawText);
  const { setCookies, cleanText, cleanJson } = collectResponseCookies(res, rawText, rawJson);
  const merged = dedupeSetCookies([
    ...setCookies,
    ...buildExpiredCookieLines('token', {
      includeApiAuthPath: true,
      includeLocalhostDomain: true,
      isHttps,
    }),
    ...buildExpiredCookieLines('ce_refresh', {
      includeApiAuthPath: true,
      includeLocalhostDomain: true,
      isHttps,
    }),
  ]);

  return {
    ok: res.ok,
    status: res.status,
    rawText: cleanText,
    rawJson: cleanJson,
    data: unwrapAuthPayload(cleanJson),
    cookieHeader: mergeCookieHeader(incomingCookieHeader, merged),
    setCookies: normalizeBrowserSetCookies(merged, {
      allowToken: false,
      scrubApiAuthPath: true,
      isHttps,
    }),
  };
}
