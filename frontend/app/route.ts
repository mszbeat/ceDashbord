import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const errorPage = (title: string, detail: string, status?: number) => `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  body{margin:0;background:#f3f6f8;color:#1a2935;font:14px/1.9 Tahoma,"Segoe UI",sans-serif;padding:40px}
  main{max-width:820px;margin:auto;background:#fff;border:1px solid #dfe7e9;border-radius:16px;padding:28px 32px;box-shadow:0 14px 36px rgba(20,52,64,.06)}
  h1{color:#af711e;font-size:22px;margin:0 0 12px}p{color:#627484}pre{direction:ltr;text-align:left;background:#f7f9fa;border:1px solid #ebeff0;border-radius:8px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}
  a{color:#087b72;font-weight:700}code{background:#f7f9fa;border-radius:6px;padding:2px 6px}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<pre>${escapeHtml(status ? `HTTP ${status}\n` : '')}${escapeHtml(detail)}</pre>
<p>بررسی سریع: <a href="/api/diagnostics">گزارش تشخیصی دیتابیس</a> · <a href="/login">ورود به سامانه</a> · <a href="/">تلاش دوباره</a></p>
<p>اگر روی سیستم خودتان اجرا میکنید: <code>backend/.env</code>، <code>./migrate.sh</code>، <code>./ingest.sh</code> و <code>BACKEND_URL</code> در <code>frontend/.env.local</code> را بررسی کنید.</p>
</main></body></html>`;

function extractHtmlDocument(rawBody: string, depth = 0): string | null {
  if (depth > 4 || typeof rawBody !== 'string') return null;
  const trimmed = rawBody.trimStart();
  if (/^<!doctype\s+html\b|^<html\b/i.test(trimmed)) {
    return rawBody;
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      for (const candidate of [parsed?.data, parsed?.result, parsed?.body, parsed?.html]) {
        if (typeof candidate === 'string') {
          if (/<!doctype\s+html\b|<html\b/i.test(candidate)) {
            return candidate;
          }
          const nested = extractHtmlDocument(candidate, depth + 1);
          if (nested !== null) return nested;
        } else if (candidate && typeof candidate === 'object') {
          for (const inner of [candidate.data, candidate.result, candidate.body, candidate.html]) {
            if (typeof inner === 'string' && /<!doctype\s+html\b|<html\b/i.test(inner)) {
              return inner;
            }
          }
        }
      }
    } catch {
      // بدنه JSON معتبر نیست
    }
  }
  return null;
}

function appendSetCookieHeaders(source: Headers, dest: Headers) {
  const getSetCookie = (source as any).getSetCookie;
  if (typeof getSetCookie === 'function') {
    for (const cookie of getSetCookie.call(source) as string[]) {
      dest.append('set-cookie', cookie);
    }
    return;
  }
  const single = source.get('set-cookie');
  if (single) {
    dest.append('set-cookie', single);
  }
}

function redirectToLoginResponse(request: NextRequest, reason?: string, sourceHeaders?: Headers) {
  const search = request.nextUrl.search || '';
  const nextPath = `/${search}`;
  const sp = new URLSearchParams();
  if (search) sp.set('next', nextPath);
  if (reason) sp.set('reason', reason);
  const qs = sp.toString();

  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost?.split(',')[0].trim() || request.headers.get('host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const proto = forwardedProto?.split(',')[0].trim() || request.nextUrl.protocol.replace(/:$/, '') || 'http';
  const origin = host ? `${proto}://${host}` : request.nextUrl.origin;

  const headers = new Headers({
    location: new URL(qs ? `/login?${qs}` : '/login', origin).toString(),
    'cache-control': 'no-store',
  });
  if (sourceHeaders) {
    appendSetCookieHeaders(sourceHeaders, headers);
  }
  return new Response(null, { status: 307, headers });
}

/**
 * صفحهٔ زنده داشبورد: همان HTML قدیمی (render.js + style.css + client.js)
 * در لحظه از بکاند گرفته میشود و کوکی‌های نشست/رفرش‌توکن بکاند را حفظ میکند.
 */
export async function GET(request: NextRequest) {
  const cookieHeader = request.headers.get('cookie') || '';
  if (!cookieHeader.trim()) {
    return redirectToLoginResponse(request);
  }

  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
  const target = new URL('/api/report', backendUrl);
  request.nextUrl.searchParams.forEach((value, key) => {
    if (value !== '') target.searchParams.set(key, value);
  });
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
  });

  try {
    const forwardHeaders: Record<string, string> = {};
    for (const key of [
      'cookie',
      'authorization',
      'user-agent',
      'x-forwarded-for',
      'x-real-ip',
      'x-user-role',
      'x-user-roles',
      'x-part-roles',
      'gateway-user-roles',
      'x-user-name',
      'x-samad-username',
    ]) {
      const val = request.headers.get(key);
      if (val) forwardHeaders[key] = val;
    }

    const response = await fetch(target.toString(), {
      cache: 'no-store',
      headers: forwardHeaders,
    });
    appendSetCookieHeaders(response.headers, headers);

    if (response.status === 401) {
      return redirectToLoginResponse(request, 'expired', response.headers);
    }

    const body = await response.text();
    const contentType = response.headers.get('content-type') || '';

    const extractedHtml = extractHtmlDocument(body);
    if (extractedHtml !== null) {
      return new Response(extractedHtml, { status: response.status, headers });
    }

    if (contentType.includes('text/html') && !body.trimStart().startsWith('{')) {
      return new Response(body, { status: response.status, headers });
    }

    const hintTitle =
      response.status === 403
        ? 'دسترسی به داشبورد مجاز نیست'
        : 'پاسخ بکاند معتبر نیست';
    return new Response(
      errorPage(
        hintTitle,
        `پاسخ ${target.origin}/api/report بهجای HTML، ${contentType || 'بدون Content-Type'} بود.\n${body.slice(0, 1200)}`,
        response.status,
      ),
      { status: response.status, headers },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      errorPage('ارتباط با بکاند برقرار نشد', `${message}\nآدرس بکاند: ${target.origin}`),
      { status: 502, headers },
    );
  }
}
