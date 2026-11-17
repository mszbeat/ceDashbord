import { NextRequest, NextResponse } from 'next/server';
import {
  performLogoutWithRecovery,
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
    const outcome = await performLogoutWithRecovery(backendUrl, request.headers, cookieHeader);
    return jsonReply(outcome.rawText, outcome.status, outcome.setCookies);
  } catch (err: any) {
    return jsonReply(
      JSON.stringify({
        status: 'error',
        message: { fa: 'خطا در خروج از حساب', en: err?.message || 'Logout service unreachable' },
      }),
      502,
      [],
    );
  }
}
