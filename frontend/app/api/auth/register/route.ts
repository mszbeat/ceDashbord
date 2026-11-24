import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  return NextResponse.json(
    {
      status: 'error',
      message: {
        fa: 'ثبت‌نام عمومی غیرفعال است؛ برای دریافت حساب کاربری با مدیر سامانه تماس بگیرید.',
        en: 'Public registration is disabled; contact the system administrator for an account.',
      },
    },
    { status: 403, headers: { 'cache-control': 'no-store, no-cache, must-revalidate' } },
  );
}
