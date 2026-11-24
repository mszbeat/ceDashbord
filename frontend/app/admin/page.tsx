import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AuthSessionState } from '@/lib/auth-client';
import {
  buildForwardClientHeaders,
  hasCookie,
  performRefreshWithRecovery,
  probeSessionWithCleanRecovery,
  resolveBackendOrigin,
} from '@/lib/server-auth';
import { readSession, SESSION_HEADER } from '@/lib/session-handoff.mjs';
import AdminClient, { OverviewPayload } from './AdminClient';
import { hasAdminRole } from '@/lib/admin-role.mjs';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function unwrapOverviewEnvelope(raw: any): OverviewPayload | null {
  let cur = raw;
  if (
    cur &&
    typeof cur === 'object' &&
    !Array.isArray(cur) &&
    'data' in cur &&
    cur.data !== undefined &&
    !('serverClock' in cur)
  ) {
    cur = cur.data;
    if (typeof cur === 'string') {
      try {
        cur = JSON.parse(cur);
      } catch {
        return null;
      }
    }
  }
  return cur && typeof cur === 'object' && 'serverClock' in cur ? (cur as OverviewPayload) : null;
}

export default async function AdminPage() {
  const incomingHeaders = await headers();
  const cookieHeader = incomingHeaders.get('cookie') || '';
  const backendUrl = resolveBackendOrigin();

  /**
   * F2 — اگر middleware همین حالا نشست را تأیید کرده، دوباره `/api/auth/me` صدا زده
   * نمی‌شود. هدر امضاشده است؛ در صورت نبود/نامعتبر بودن، به مسیر قبلی (probe) برمی‌گردیم.
   */
  const handoffSession = await readSession(
    incomingHeaders.get(SESSION_HEADER),
    process.env.CE_SESSION_HANDOFF_SECRET || '',
  );

  let probe;
  if (handoffSession) {
    probe = {
      ok: true,
      status: 200,
      rawText: '',
      rawJson: null,
      data: handoffSession,
      cookieHeader,
      setCookies: [],
      browserSetCookies: [],
    } as unknown as Awaited<ReturnType<typeof probeSessionWithCleanRecovery>>;
  } else {
    probe = await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, cookieHeader);
  }
  let activeCookieHeader = probe.cookieHeader;
  let authData = probe.data;

  // برخلاف فیلد canRefresh، وجود کوکی ce_refresh کافی است؛ /me ممکن است پس از انقضای
  // اکسس توکن سشن visitor و canRefresh:false بدهد در حالی که رفرش توکن هنوز معتبر است.
  if ((!probe.ok || authData?.authenticated !== true) && hasCookie(activeCookieHeader, 'ce_refresh')) {
    const refreshed = await performRefreshWithRecovery(
      backendUrl,
      incomingHeaders,
      activeCookieHeader,
      probe,
    );
    if (refreshed.ok && refreshed.data?.authenticated === true) {
      activeCookieHeader = refreshed.cookieHeader;
      authData = refreshed.data;
    }
  }

  if (!authData || authData.authenticated !== true) {
    redirect('/login?next=%2Fadmin');
  }

  const roles = Array.isArray(authData.roles) && authData.roles.length ? authData.roles : ['visitor'];
  const authUser: AuthSessionState = {
    authenticated: true,
    username: String(authData.username || authData.samadUsername || 'visitor'),
    samadUsername: String(authData.samadUsername || authData.username || 'visitor'),
    roles,
    canRefresh: Boolean(authData.canRefresh ?? true),
    refreshExpiresAt: authData.refreshExpiresAt || null,
    accessExpireMs: typeof authData.accessExpireMs === 'number' ? authData.accessExpireMs : undefined,
    idleExpireMs: typeof authData.idleExpireMs === 'number' ? authData.idleExpireMs : undefined,
  };

  // بررسی نقش در سمت سرور پیش از رندر کوچک‌ترین بخش از پنل مدیریت: کاربر غیرمدیر مستقیماً به داشبورد هدایت می‌شود
  if (!hasAdminRole(roles)) {
    redirect('/');
  }

  // استعلام واقعی دسترسی از بک‌اند پیش از نمایش صفحهٔ مدیریت
  let initialOverview: OverviewPayload | null = null;
  let overviewResponse: Response | null = null;
  try {
    overviewResponse = await fetch(new URL('/api/admin/overview', backendUrl).toString(), {
      method: 'GET',
      cache: 'no-store',
      headers: await buildForwardClientHeaders(incomingHeaders, activeCookieHeader, { method: 'GET', path: '/api/admin/overview' }),
    });
  } catch {
    // در خطای موقت شبکه، کلاینت از طریق گیت بررسی دسترسی دوباره اقدام می‌کند
  }

  // redirect() پرتاب می‌کند؛ بیرون از try/catch باشد تا ریدایرکت‌ها بلعیده نشوند.
  if (overviewResponse?.status === 401 || overviewResponse?.status === 403) {
    if (overviewResponse.status === 401) {
      let recheck: Awaited<ReturnType<typeof probeSessionWithCleanRecovery>> | null = null;
      try {
        recheck = await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, activeCookieHeader);
      } catch {
        // خطای شبکه را به logout قطعی تبدیل نکنیم؛ کلاینت می‌تواند پس از render دوباره تلاش کند.
      }
      if (recheck) {
        if (recheck.data?.authenticated !== true) {
          redirect('/login?next=%2Fadmin');
        }
        redirect('/');
      }
      // probe موقتاً شکست خورده؛ shell رندر می‌شود ولی دادهٔ مدیریتی وارد صفحه نشده است.
    } else {
      redirect('/');
    }
  }

  if (overviewResponse?.ok) {
    const json = await overviewResponse.json().catch(() => null);
    initialOverview = unwrapOverviewEnvelope(json);
  }

  return <AdminClient initialAuth={authUser} initialOverview={initialOverview} />;
}
