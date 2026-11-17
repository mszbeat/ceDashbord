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
const recentRefreshCache = new Map<string, { at: number; outcome: RefreshOutcome }>();

export function resolveBackendOrigin(): string {
  return (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
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
  for (const sc of setCookieHeaders) {
    const firstSemi = sc.indexOf(';');
    const pair = firstSemi >= 0 ? sc.slice(0, firstSemi) : sc;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    const maxAgeZero = /;\s*max-age=0\b/i.test(sc);
    if (!val || maxAgeZero) {
      jar.delete(name);
    } else {
      jar.set(name, val);
    }
  }
  return serializeCookieMap(jar);
}

export function dedupeSetCookies(cookies: string[]): string[] {
  const order: string[] = [];
  const latestByName = new Map<string, string>();
  for (const sc of cookies) {
    const firstSemi = sc.indexOf(';');
    const pair = firstSemi >= 0 ? sc.slice(0, firstSemi) : sc;
    const eq = pair.indexOf('=');
    const name = eq > 0 ? pair.slice(0, eq).trim() : sc;
    if (!latestByName.has(name)) {
      order.push(name);
    }
    latestByName.set(name, sc);
  }
  return order.map((k) => latestByName.get(k)!).filter(Boolean);
}

export function buildForwardClientHeaders(incoming: Headers, cookieHeader: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
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

export interface SessionProbeResult {
  ok: boolean;
  status: number;
  rawText: string;
  rawJson: any;
  data: AuthPayload | null;
  cookieHeader: string;
  setCookies: string[];
}

export async function probeSessionWithCleanRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
  options: { forceCleanTokenIfUnauthed?: boolean } = {},
): Promise<SessionProbeResult> {
  const callMe = async (cookieVal: string) => {
    const res = await fetch(new URL('/api/auth/me', backendUrl).toString(), {
      method: 'GET',
      cache: 'no-store',
      headers: buildForwardClientHeaders(incomingHeaders, cookieVal),
    });
    const setCookies = extractSetCookies(res.headers);
    const rawText = await res.text().catch(() => '');
    const rawJson = safeParseJson(rawText);
    const data = unwrapAuthPayload(rawJson);
    return { res, setCookies, rawText, rawJson, data };
  };

  let first = await callMe(incomingCookieHeader);
  let mergedCookies = mergeCookieHeader(incomingCookieHeader, first.setCookies);
  let collectedSetCookies = [...first.setCookies];

  const issuedNewToken = first.setCookies.some((c) => /^token=[^;]+/.test(c.trim()) && !/max-age=0/i.test(c));
  const shouldRecoverToken =
    hasCookie(incomingCookieHeader, 'token') &&
    (!first.res.ok || (options.forceCleanTokenIfUnauthed && first.data?.authenticated !== true && !issuedNewToken));

  if (shouldRecoverToken) {
    // توکن قبلی در Redis منقضی یا نامعتبر است؛ بدون توکن قبلی و با حفظ ce_refresh سشن بازدیدکننده تازه می‌گیریم.
    const cleanCookie = stripCookie(incomingCookieHeader, 'token');
    const cleanAttempt = await callMe(cleanCookie);
    if (cleanAttempt.res.ok || cleanAttempt.setCookies.length) {
      mergedCookies = mergeCookieHeader(cleanCookie, cleanAttempt.setCookies);
      collectedSetCookies = dedupeSetCookies([...collectedSetCookies, ...cleanAttempt.setCookies]);
      first = cleanAttempt;
    }
  }

  return {
    ok: first.res.ok,
    status: first.res.status,
    rawText: first.rawText,
    rawJson: first.rawJson,
    data: first.data,
    cookieHeader: mergedCookies,
    setCookies: dedupeSetCookies(collectedSetCookies),
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
  // ۱. ابتدا وضعیت فعلی + گرفتن توکن بازدیدکنندهٔ معتبر (در صورت منقضی بودن token قبلی)
  const probe = existingProbe ?? await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, incomingCookieHeader);

  if (probe.ok && probe.data?.authenticated === true) {
    return {
      ok: true,
      status: 200,
      rawText: probe.rawText,
      rawJson: probe.rawJson,
      data: probe.data,
      cookieHeader: probe.cookieHeader,
      setCookies: probe.setCookies,
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
      setCookies: probe.setCookies,
    };
  }

  const postRefresh = async (cookieVal: string) => {
    const res = await fetch(new URL('/api/auth/refresh', backendUrl).toString(), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        ...buildForwardClientHeaders(incomingHeaders, cookieVal),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const setCookies = extractSetCookies(res.headers);
    const rawText = await res.text().catch(() => '');
    const rawJson = safeParseJson(rawText);
    const data = unwrapAuthPayload(rawJson);
    return { res, setCookies, rawText, rawJson, data };
  };

  let attempt = await postRefresh(probe.cookieHeader);
  let allSetCookies = dedupeSetCookies([...probe.setCookies, ...attempt.setCookies]);
  let liveCookies = mergeCookieHeader(probe.cookieHeader, attempt.setCookies);

  // ۲. اگر partSessionManager خودِ کوکی token را رد کرد (مثلاً به دلیل انقضا/ناهماهنگی میان‌درخواست)، با یک token بازدیدکنندهٔ تازه تلاش می‌کنیم
  if (!attempt.res.ok) {
    const metaCode = extractPartMetaCode(attempt.rawJson);
    if (!REFRESH_TOKEN_ERROR_CODES.has(metaCode) && hasCookie(probe.cookieHeader, 'token')) {
      const freshProbe = await probeSessionWithCleanRecovery(
        backendUrl,
        incomingHeaders,
        stripCookie(probe.cookieHeader, 'token'),
      );
      attempt = await postRefresh(freshProbe.cookieHeader);
      allSetCookies = dedupeSetCookies([...allSetCookies, ...freshProbe.setCookies, ...attempt.setCookies]);
      liveCookies = mergeCookieHeader(freshProbe.cookieHeader, attempt.setCookies);
    }
  }

  return {
    ok: attempt.res.ok && attempt.data?.authenticated === true,
    status: attempt.res.status,
    rawText: attempt.rawText,
    rawJson: attempt.rawJson,
    data: attempt.data,
    cookieHeader: liveCookies,
    setCookies: allSetCookies,
  };
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
  const postLogin = async (cookieVal: string) => {
    const res = await fetch(new URL('/api/auth/login', backendUrl).toString(), {
      method: 'POST',
      cache: 'no-store',
      headers: {
        ...buildForwardClientHeaders(incomingHeaders, cookieVal),
        'content-type': 'application/json',
      },
      body: bodyText,
    });
    const setCookies = extractSetCookies(res.headers);
    const rawText = await res.text().catch(() => '');
    const rawJson = safeParseJson(rawText);
    const data = unwrapAuthPayload(rawJson);
    return { res, setCookies, rawText, rawJson, data };
  };

  // گرفتن نشست بازدیدکنندهٔ سالم پیش از login (در صورت منقضی بودن token قبلی، جایگزین می‌شود)
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

  // اطمینان از فعال شدن سشن روی token جاری (تثبیت ورود اول بدون نیاز به تلاش دوم کاربر)
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

  return {
    ok: attempt.res.ok,
    status: attempt.res.status,
    rawText: attempt.rawText,
    rawJson: attempt.rawJson,
    data: attempt.data,
    cookieHeader: liveCookies,
    setCookies: allSetCookies,
  };
}

export async function performRegisterWithRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
  bodyText: string,
): Promise<RefreshOutcome> {
  // حذف نقش احتمالی ارسالی در BFF — ثبت‌نام همواره visitor است
  let sanitizedBody = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      delete parsed.role;
      sanitizedBody = JSON.stringify(parsed);
    }
  } catch {
    // pass through
  }

  const probe = await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, incomingCookieHeader);
  const res = await fetch(new URL('/api/auth/register', backendUrl).toString(), {
    method: 'POST',
    cache: 'no-store',
    headers: {
      ...buildForwardClientHeaders(incomingHeaders, probe.cookieHeader),
      'content-type': 'application/json',
    },
    body: sanitizedBody,
  });
  const setCookies = extractSetCookies(res.headers);
  const rawText = await res.text().catch(() => '');
  const rawJson = safeParseJson(rawText);
  const data = unwrapAuthPayload(rawJson);
  const allSetCookies = dedupeSetCookies([...probe.setCookies, ...setCookies]);

  return {
    ok: res.ok,
    status: res.status,
    rawText,
    rawJson,
    data,
    cookieHeader: mergeCookieHeader(probe.cookieHeader, setCookies),
    setCookies: allSetCookies,
  };
}

export async function performLogoutWithRecovery(
  backendUrl: string,
  incomingHeaders: Headers,
  incomingCookieHeader: string,
): Promise<RefreshOutcome> {
  const res = await fetch(new URL('/api/auth/logout', backendUrl).toString(), {
    method: 'POST',
    cache: 'no-store',
    headers: {
      ...buildForwardClientHeaders(incomingHeaders, incomingCookieHeader),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const setCookies = extractSetCookies(res.headers);
  const rawText = await res.text().catch(() => '');
  const rawJson = safeParseJson(rawText);
  return {
    ok: res.ok,
    status: res.status,
    rawText,
    rawJson,
    data: unwrapAuthPayload(rawJson),
    cookieHeader: mergeCookieHeader(incomingCookieHeader, setCookies),
    setCookies,
  };
}
