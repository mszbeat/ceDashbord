import { NextRequest, NextResponse } from 'next/server';

function extractSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as any).getSetCookie;
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers) as string[];
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function mergeCookies(rawCookieHeader: string, setCookieHeaders: string[]): string {
  const jar = new Map<string, string>();
  if (rawCookieHeader) {
    for (const part of rawCookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (name) jar.set(name, val);
    }
  }
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
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function unwrapAuthPayload(raw: any): any {
  let cur = raw;
  for (let i = 0; i < 3; i += 1) {
    if (
      cur &&
      typeof cur === 'object' &&
      !Array.isArray(cur) &&
      'data' in cur &&
      cur.data !== undefined &&
      !('authenticated' in cur)
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
  return cur;
}

function buildPublicOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost?.split(',')[0].trim() || request.headers.get('host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const proto = forwardedProto?.split(',')[0].trim() || request.nextUrl.protocol.replace(/:$/, '') || 'http';
  if (host) return `${proto}://${host}`;
  return request.nextUrl.origin;
}

function redirectToLogin(request: NextRequest, reason?: string, extraSetCookies?: string[]) {
  const pathname = request.nextUrl.pathname || '/';
  const search = request.nextUrl.search || '';
  const nextPath = `${pathname}${search}`;
  const sp = new URLSearchParams();
  if (nextPath && nextPath !== '/' && !nextPath.startsWith('/login')) {
    sp.set('next', nextPath);
  }
  if (reason) {
    sp.set('reason', reason);
  }
  const qs = sp.toString();
  const target = new URL(qs ? `/login?${qs}` : '/login', buildPublicOrigin(request));
  const res = NextResponse.redirect(target, 307);
  res.headers.set('cache-control', 'no-store');
  if (extraSetCookies) {
    for (const c of extraSetCookies) {
      res.headers.append('set-cookie', c);
    }
  }
  return res;
}

function buildBackendClientHeaders(request: NextRequest, cookieValue: string): Record<string, string> {
  const headers: Record<string, string> = {
    cookie: cookieValue,
    accept: 'application/json',
  };
  for (const key of ['user-agent', 'x-forwarded-for', 'x-real-ip']) {
    const val = request.headers.get(key);
    if (val) headers[key] = val;
  }
  return headers;
}

/**
 * محافظ سراسری تمام مسیرهای فرانت‌اند:
 * کاربر تنها با داشتن سشن احرازشده اجازهٔ مشاهدهٔ داشبورد و سایر مسیرها را دارد؛
 * در غیر این صورت به صفحهٔ `/login` هدایت می‌شود.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  const cookieHeader = request.headers.get('cookie') || '';
  if (!cookieHeader.trim()) {
    return redirectToLogin(request);
  }

  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:3000';

  try {
    const meRes = await fetch(new URL('/api/auth/me', backendUrl).toString(), {
      method: 'GET',
      cache: 'no-store',
      headers: buildBackendClientHeaders(request, cookieHeader),
    });

    const meCookies = extractSetCookies(meRes.headers);
    const meText = await meRes.text().catch(() => '');
    let meData: any = null;
    try {
      meData = meText ? unwrapAuthPayload(JSON.parse(meText)) : null;
    } catch {
      meData = null;
    }

    if (meRes.ok && meData?.authenticated === true) {
      if (meCookies.length) {
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set('cookie', mergeCookies(cookieHeader, meCookies));
        const nextRes = NextResponse.next({
          request: { headers: requestHeaders },
        });
        for (const c of meCookies) {
          nextRes.headers.append('set-cookie', c);
        }
        return nextRes;
      }
      return NextResponse.next();
    }

    if (meRes.ok && meData && meData.canRefresh === true) {
      const mergedForRefresh = meCookies.length ? mergeCookies(cookieHeader, meCookies) : cookieHeader;
      const refreshRes = await fetch(new URL('/api/auth/refresh', backendUrl).toString(), {
        method: 'POST',
        cache: 'no-store',
        headers: {
          ...buildBackendClientHeaders(request, mergedForRefresh),
          'content-type': 'application/json',
        },
        body: '{}',
      });
      const refreshCookies = extractSetCookies(refreshRes.headers);
      const combinedCookies = [...meCookies, ...refreshCookies];
      const refreshText = await refreshRes.text().catch(() => '');
      let refreshData: any = null;
      try {
        refreshData = refreshText ? unwrapAuthPayload(JSON.parse(refreshText)) : null;
      } catch {
        refreshData = null;
      }

      if (refreshRes.ok && refreshData?.authenticated === true) {
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set('cookie', mergeCookies(cookieHeader, combinedCookies));
        const nextRes = NextResponse.next({
          request: { headers: requestHeaders },
        });
        for (const c of combinedCookies) {
          nextRes.headers.append('set-cookie', c);
        }
        return nextRes;
      }

      return redirectToLogin(request, 'expired', combinedCookies);
    }

    const hadAuthCookie = /(?:^|;\s*)(?:token|ce_refresh)=/.test(cookieHeader);
    return redirectToLogin(request, hadAuthCookie ? 'expired' : undefined, meCookies);
  } catch {
    const hasAuthCookie = /(?:^|;\s*)(?:token|ce_refresh)=/.test(cookieHeader);
    if (!hasAuthCookie || pathname !== '/') {
      return redirectToLogin(request);
    }
    // در صورت قطعی کامل بکاند روی مسیر اصلی با وجود کوکی سشن، route.ts پیام تشخیصی را نمایش می‌دهد.
    return NextResponse.next();
  }
}

export const config = {
  matcher: ['/((?!api/|_next/static|_next/image|favicon\\.ico|login(?:/|$)).*)'],
};
