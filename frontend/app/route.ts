import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { fetchWithHeadersTimeout, isTimeoutError } from '@/lib/upstream-timeout.mjs';
import {
  extractHtmlDocument,
  isHtmlDocument,
  looksLikeJsonEnvelope,
  peekStream,
  readText,
} from '@/lib/report-payload.mjs';
import {
  buildExpiredCookieLines,
  dedupeSetCookies,
  extractSetCookies,
  hasCookie,
  isRequestHttps,
  normalizeBrowserSetCookies,
  performRefreshWithRecovery,
  resolveBackendOrigin,
} from '@/lib/server-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const errorPage = (title: string, detail: string, status?: number) => `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  @font-face{font-family:'Vazirmatn';src:url('/fonts/Vazirmatn-Variable.woff2') format('woff2');font-weight:100 900;font-style:normal;font-display:swap}
  body{margin:0;background:#eef4fb;color:#0c1e3e;font:14px/1.9 'Vazirmatn',Tahoma,"Segoe UI",sans-serif;padding:40px}
  main{max-width:640px;margin:auto;background:#fff;border:1px solid #d4e2f4;border-radius:16px;padding:28px 32px;box-shadow:0 14px 36px rgba(0,28,88,.08)}
  h1{color:#002878;font-size:20px;margin:0 0 12px}p{color:#4e6788}pre{direction:ltr;text-align:left;background:#f4f8fe;border:1px solid #e7effa;border-radius:8px;padding:8px 12px;white-space:pre-wrap;word-break:break-word;font-size:12px}
  a{color:#0b5ed7;font-weight:700}
</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<pre>${escapeHtml(status ? `HTTP ${status}\n` : '')}${escapeHtml(detail)}</pre>
<p><a href="/login">ورود به سامانه</a> · <a href="/">تلاش دوباره</a></p>
</main></body></html>`;

function redirectToLoginResponse(request: NextRequest, reason?: string, setCookies: string[] = []) {
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
  for (const c of dedupeSetCookies(setCookies)) {
    headers.append('set-cookie', c);
  }
  return new Response(null, { status: 307, headers });
}

function buildReportHeaders(request: NextRequest, cookieValue: string): Record<string, string> {
  const forwardHeaders: Record<string, string> = {};
  if (cookieValue) forwardHeaders.cookie = cookieValue;
  for (const key of [
    'authorization',
    'user-agent',
    'x-forwarded-for',
    'x-real-ip',
    'x-forwarded-proto',
  ]) {
    const val = request.headers.get(key);
    if (val) forwardHeaders[key] = val;
  }
  return forwardHeaders;
}

/**
 * صفحهٔ زنده داشبورد: گزارش از بکاند گرفته می‌شود و در صورت انقضای سشن کوتاه‌مدت،
 * ابتدا با رفرش‌توکن تمدید و سپس صفحه بارگذاری می‌گردد.
 */
export async function GET(request: NextRequest) {
  const cookieHeader = request.headers.get('cookie') || '';
  const hasAuthTokens = hasCookie(cookieHeader, 'token') || hasCookie(cookieHeader, 'ce_refresh');
  if (!hasAuthTokens) {
    return redirectToLoginResponse(request);
  }

  const backendUrl = resolveBackendOrigin();
  const isHttps = isRequestHttps(request.headers, request.url);
  const target = new URL('/api/report', backendUrl);
  request.nextUrl.searchParams.forEach((value, key) => {
    if (value !== '') target.searchParams.set(key, value);
  });

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
  });

  try {
    let activeCookie = cookieHeader;
    let collectedCookies: string[] = [];

    // F1: مهلت اتصال/هدرها — بک‌اندی که پاسخ نمی‌دهد نباید سوکت را برای همیشه نگه دارد
    let response = await fetchWithHeadersTimeout(fetch, target.toString(), {
      cache: 'no-store',
      headers: buildReportHeaders(request, activeCookie),
    }, { signal: request.signal });
    collectedCookies.push(...extractSetCookies(response.headers));

    if (response.status === 401 && hasCookie(activeCookie, 'ce_refresh')) {
      const refreshed = await performRefreshWithRecovery(backendUrl, request.headers, activeCookie);
      collectedCookies.push(...refreshed.setCookies);
      if (refreshed.ok && refreshed.data?.authenticated === true) {
        activeCookie = refreshed.cookieHeader;
        response = await fetchWithHeadersTimeout(fetch, target.toString(), {
          cache: 'no-store',
          headers: buildReportHeaders(request, activeCookie),
        }, { signal: request.signal });
        collectedCookies.push(...extractSetCookies(response.headers));
      }
    }

    if (response.status === 401) {
      const clearAll = normalizeBrowserSetCookies(
        [
          ...collectedCookies,
          ...buildExpiredCookieLines('token', {
            includeApiAuthPath: true,
            includeLocalhostDomain: true,
            isHttps,
          }),
        ],
        { allowToken: false, scrubApiAuthPath: true, isHttps },
      );
      return redirectToLoginResponse(request, 'expired', clearAll);
    }

    const finalCookies = normalizeBrowserSetCookies(collectedCookies, {
      allowToken: response.ok,
      scrubApiAuthPath: true,
      isHttps,
    });
    for (const c of finalCookies) {
      headers.append('set-cookie', c);
    }

    /**
     * F1 — بدنه بافر نمی‌شود.
     *
     * نسخهٔ قبلی بدنه را کامل می‌خواند (`response.text()`) و بعد در صورت JSON، HTML را از آن
     * بیرون می‌کشید. برای گزارش بزرگ یعنی: کل HTML در حافظهٔ Node، تأخیر تا پایان دانلود،
     * و از دست رفتن موتور جریان مرورگر (کاربر صفحهٔ سفید می‌دید).
     *
     * حالا بدنه به‌صورت **جریان** پاس داده می‌شود. فقط وقتی لازم است داخل JSON را نگاه
     * کنیم (پاسخ JSON کوچک) بافر می‌کنیم؛ آستانه از `CE_REPORT_INLINE_MAX_BYTES` می‌آید.
     */
    const contentType = response.headers.get('content-type') || '';
    const inlineLimit = Number(process.env.CE_REPORT_INLINE_MAX_BYTES || 65536);

    /**
     * به `content-type` **اعتماد نمی‌کنیم** — باگ «استایل‌ها لود نشدند» از اینجا آمد.
     *
     * ترنسپورت partFramework رشتهٔ HTML را در `{"data": "…"}` می‌پیچد؛ اگر هدر
     * `text/html` بماند، بدنهٔ JSON به‌عنوان HTML رندر می‌شود: `class=\"page\"` می‌شود
     * `\"page\"` (با کوتیشن) و هیچ سلکتور CSS تطبیق نمی‌کند ⇒ صفحهٔ بی‌استایل.
     *
     * پس اول چند بایت اول بدنه را «نگاه» می‌کنیم:
     *   • HTML واقعی ⇒ همان جریان، بدون بافر (قواعد F1 حفظ می‌شود)
     *   • پوشش JSON ⇒ باز می‌کنیم و HTML درونی را با هدر درست می‌فرستیم
     */
    const { head, stream } = await peekStream(response.body);
    const envelope = looksLikeJsonEnvelope(head);

    if (!envelope) {
      headers.set('content-type', contentType || 'text/html; charset=utf-8');
      const passthrough = stream ?? response.body;
      if (passthrough) return new Response(passthrough, { status: response.status, headers });
      return new Response('', { status: response.status, headers });
    }

    // پوشش JSON: حالا مجاز است بدنه را کامل بخوانیم (پاسخ کوچک است).
    // از استریم بازسازی‌شده می‌خوانیم — `response.text()` بعد از peek غیرقابل استفاده است.
    const { text: body } = await readText(stream);
    const extractedHtml = extractHtmlDocument(body);
    if (extractedHtml !== null) {
      headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(extractedHtml, { status: response.status, headers });
    }
    if (body.length <= inlineLimit && isHtmlDocument(body)) {
      headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(body, { status: response.status, headers });
    }

    const hintTitle =
      response.status === 403
        ? 'دسترسی به داشبورد مجاز نیست'
        : 'گزارش در دسترس نیست';
    return new Response(
      errorPage(hintTitle, 'در حال حاضر امکان بارگذاری گزارش وجود ندارد.', response.status),
      { status: response.status, headers },
    );
  } catch (error) {
    /**
     * F3 — متن خام خطا به کاربر نمی‌رود.
     *
     * پیام خطای شبکه/فریم‌ورک می‌تواند آدرس داخلی، نام پورت یا جزئیات پشته داشته باشد
     * (نشت اطلاعات). به کاربر شناسهٔ پیگیری می‌دهیم و جزئیات را سمت سرور لاگ می‌کنیم.
     */
    const requestId = request.headers.get('x-request-id') || crypto.randomUUID();
    const timedOut = isTimeoutError(error);
    console.error('[report] upstream failure', {
      requestId,
      code: (error as any)?.code || 'UPSTREAM_ERROR',
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      target: target.toString(),
    });
    return new Response(
      errorPage(
        timedOut ? 'سرور گزارش پاسخ نداد' : 'ارتباط با سرور برقرار نشد',
        timedOut
          ? `دریافت گزارش بیش از حد طول کشید. بازهٔ زمانی کوچک‌تری انتخاب کنید. شناسهٔ پیگیری: ${requestId}`
          : `بارگذاری گزارش ممکن نشد. لطفاً چند لحظه بعد دوباره تلاش کنید. شناسهٔ پیگیری: ${requestId}`,
      ),
      { status: 502, headers: { ...Object.fromEntries(headers.entries()), 'x-request-id': requestId } },
    );
  }
}
