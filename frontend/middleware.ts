import { NextRequest, NextResponse } from 'next/server';
import {
  buildExpiredCookieLines,
  dedupeSetCookies,
  hasCookie,
  isRequestHttps,
  performRefreshWithRecovery,
  probeSessionWithCleanRecovery,
  resolveBackendOrigin,
} from '@/lib/server-auth';

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
    for (const c of dedupeSetCookies(extraSetCookies)) {
      res.headers.append('set-cookie', c);
    }
  }
  return res;
}

const PUBLIC_ASSET_RE = /\.(?:png|jpe?g|svg|webp|gif|ico|css|js|woff2?|map)$/i;

/**
 * محافظ سراسری مسیرهای فرانت‌اند:
 * کاربر تنها با داشتن سشن معتبر یا رفرش‌توکن معتبر اجازهٔ مشاهدهٔ صفحات را دارد؛
 * در صورت انقضای سشن، تمدید خودکار انجام و کوکی‌ها بدون اختلال به‌روزرسانی می‌شوند.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === '/login' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/images/') ||
    pathname.startsWith('/fonts/') ||
    pathname === '/favicon.ico' ||
    PUBLIC_ASSET_RE.test(pathname)
  ) {
    return NextResponse.next();
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const hasAuthTokens = hasCookie(cookieHeader, 'token') || hasCookie(cookieHeader, 'ce_refresh');
  if (!hasAuthTokens) {
    return redirectToLogin(request);
  }

  const backendUrl = resolveBackendOrigin();
  const isHttps = isRequestHttps(request.headers, request.url);

  try {
    const probe = await probeSessionWithCleanRecovery(backendUrl, request.headers, cookieHeader);

    if (probe.ok && probe.data?.authenticated === true) {
      if (probe.browserSetCookies.length) {
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set('cookie', probe.cookieHeader);
        const nextRes = NextResponse.next({
          request: { headers: requestHeaders },
        });
        for (const c of probe.browserSetCookies) {
          nextRes.headers.append('set-cookie', c);
        }
        return nextRes;
      }
      return NextResponse.next();
    }

    const canAttemptRefresh =
      probe.data?.canRefresh === true ||
      (hasCookie(probe.cookieHeader, 'ce_refresh') && probe.data?.canRefresh !== false);

    if (canAttemptRefresh) {
      const refreshed = await performRefreshWithRecovery(backendUrl, request.headers, probe.cookieHeader, probe);
      if (refreshed.ok && refreshed.data?.authenticated === true) {
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set('cookie', refreshed.cookieHeader);
        const nextRes = NextResponse.next({
          request: { headers: requestHeaders },
        });
        for (const c of refreshed.setCookies) {
          nextRes.headers.append('set-cookie', c);
        }
        return nextRes;
      }
      const clearAll = dedupeSetCookies([
        ...refreshed.setCookies,
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
      return redirectToLogin(request, 'expired', clearAll);
    }

    const clearStale = dedupeSetCookies([
      ...probe.browserSetCookies,
      ...buildExpiredCookieLines('token', {
        includeApiAuthPath: true,
        includeLocalhostDomain: true,
        isHttps,
      }),
    ]);
    return redirectToLogin(request, 'expired', clearStale);
  } catch {
    if (!hasAuthTokens || pathname !== '/') {
      return redirectToLogin(request);
    }
    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|images/|fonts/|favicon\\.ico|login(?:/|$)|.*\\.(?:png|jpe?g|svg|webp|gif|ico|css|js|woff2?|map)$).*)',
  ],
};
