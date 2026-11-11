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
<p>بررسی سریع: <a href="/api/diagnostics">گزارش تشخیصی دیتابیس</a> · <a href="/">تلاش دوباره</a></p>
<p>اگر روی سیستم خودتان اجرا میکنید: <code>backend/.env</code>، <code>./migrate.sh</code>، <code>./ingest.sh</code> و <code>BACKEND_URL</code> در <code>frontend/.env.local</code> را بررسی کنید.</p>
</main></body></html>`;

/**
 * صفحهٔ زنده داشبورد: همان HTML قدیمی (render.js + style.css + client.js)
 * در لحظه از بکاند گرفته میشود؛ هیچ فایل HTML برای دانلود تولید نمیشود.
 */
export async function GET(request: NextRequest) {
  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
  const target = new URL('/api/report', backendUrl);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate' };

  try {
    const response = await fetch(target.toString(), { cache: 'no-store' });
    const body = await response.text();
    const contentType = response.headers.get('content-type') || '';

    // بکاند یا صفحهٔ خطای HTML خودش را داده یا HTML معمولی report را.
    if (contentType.includes('text/html')) {
      return new Response(body, { status: response.status, headers });
    }
    // جلوی نمایش JSON خام {"statusCode":500,...} در مرورگر گرفته میشود.
    return new Response(
      errorPage('پاسخ بکاند معتبر نیست', `پاسخ ${target.origin}/api/report بهجای HTML، ${contentType || 'بدون Content-Type'} بود.\n${body.slice(0, 1200)}`, response.status),
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
