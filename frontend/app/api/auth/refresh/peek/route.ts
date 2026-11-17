import { NextRequest, NextResponse } from 'next/server';
import { peekRefreshToken, resolveBackendOrigin } from '@/lib/server-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/auth/refresh/peek
 * اعتبار کوکی رفرش را بدون چرخاندن توکن گزارش می‌کند؛ مصرف‌کنندهٔ اصلی، مسیر
 * POST /api/auth/refresh و نظرسنجی نشست در کلاینت است تا هرگز توکنِ باطل/چرخیده
 * ارسال نشود (چرخش دوبارهٔ توکنِ مصرف‌شده، کل خانوادهٔ توکن را باطل می‌کند).
 */
export async function GET(request: NextRequest) {
  try {
    const backendUrl = resolveBackendOrigin();
    const cookieHeader = request.headers.get('cookie') || '';
    const peek = await peekRefreshToken(backendUrl, request.headers, cookieHeader);
    if (!peek) {
      return NextResponse.json(
        { status: 'error', valid: false, reason: 'peek_unavailable' },
        { status: 502, headers: { 'cache-control': 'no-store' } },
      );
    }
    return new NextResponse(peek.rawText || '{}', {
      status: peek.ok ? 200 : 502,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { status: 'error', valid: false, reason: err?.message || 'unreachable' },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}
