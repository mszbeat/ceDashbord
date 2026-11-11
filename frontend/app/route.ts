import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * صفحهٔ زنده داشبورد: همان HTML قدیمی (render.js + style.css + client.js)
 * در لحظه از بکاند گرفته میشود؛ هیچ فایل HTML برای دانلود تولید نمیشود.
 */
export async function GET(request: NextRequest) {
  const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
  const target = new URL('/api/report', backendUrl);
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));

  try {
    const response = await fetch(target.toString(), { cache: 'no-store' });
    const html = await response.text();
    return new Response(html, {
      status: response.status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const body = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>داشبورد در دسترس نیست</title></head><body style="font:14px/1.9 Tahoma,sans-serif;padding:40px;background:#f3f6f8;color:#1a2935"><h1>ارتباط با بکاند برقرار نشد</h1><p>${escapeHtml(message)}</p><p>مطمئن شوید BACKEND_URL و سرویس NestJS روی پورت ۳۰۰۰ فعالاند.</p><p><a href="/">تلاش دوباره</a></p></body></html>`;
    return new Response(body, {
      status: 502,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
