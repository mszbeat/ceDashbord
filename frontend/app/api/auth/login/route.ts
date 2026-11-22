import { NextRequest, NextResponse } from 'next/server';
import {
  performLoginWithRecovery,
  resolveBackendOrigin,
} from '@/lib/server-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function jsonReply(bodyText: string, status: number, setCookies: string[]) {
  const res = new NextResponse(bodyText || '{}', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  });
  for (const c of setCookies) {
    res.headers.append('set-cookie', c);
  }
  return res;
}

export async function POST(request: NextRequest) {
  try {
    const backendUrl = resolveBackendOrigin();
    const cookieHeader = request.headers.get('cookie') || '';
    const bodyText = await request.text().catch(() => '{}');
    const outcome = await performLoginWithRecovery(backendUrl, request.headers, cookieHeader, bodyText || '{}');

    // ⚠️ ورود «موفق» بدون هیچ کوکی = پل BFF از سمت بک‌اند رد شده است (مثلاً استقرار
    // دو‌هاستی بدون CE_BFF_SHARED_SECRET). این نباید silent باشد: کاربر فکر می‌کند
    // وارد شده اما نشستی وجود ندارد و با حلقهٔ /login?reason=expired مواجه می‌شود.
    if (outcome.ok && outcome.setCookies.length === 0) {
      console.error(
        '[auth.bff] Login succeeded at backend but produced ZERO cookies. ' +
          'Backend likely rejected the BFF bridge (check CE_BFF_SHARED_SECRET in both services, ' +
          'or BACKEND_HOST/private-network reachability). See RUNBOOK §15.',
      );
      return jsonReply(
        JSON.stringify({
          status: 'error',
          authenticated: false,
          message: {
            fa: 'پیکربندی پل نشست (BFF) با بک‌اند سازگار نیست؛ لطفاً با پشتیبانی فنی تماس بگیرید.',
            en: 'BFF bridge misconfigured: backend did not set the session cookies',
          },
        }),
        500,
        [],
      );
    }

    return jsonReply(outcome.rawText, outcome.status, outcome.setCookies);
  } catch (err: any) {
    return jsonReply(
      JSON.stringify({
        status: 'error',
        authenticated: false,
        message: { fa: 'خطا در ارتباط با سرویس ورود', en: err?.message || 'Login service unreachable' },
      }),
      502,
      [],
    );
  }
}
