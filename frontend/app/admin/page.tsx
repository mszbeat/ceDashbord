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
import AdminClient, { OverviewPayload } from './AdminClient';

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
  const incomingHeaders = headers();
  const cookieHeader = incomingHeaders.get('cookie') || '';
  const backendUrl = resolveBackendOrigin();

  let probe = await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, cookieHeader);
  let activeCookieHeader = probe.cookieHeader;
  let authData = probe.data;

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
  if (!roles.includes('admin')) {
    redirect('/');
  }

  // استعلام واقعی دسترسی از بک‌اند پیش از نمایش صفحهٔ مدیریت
  let initialOverview: OverviewPayload | null = null;
  try {
    const res = await fetch(new URL('/api/admin/overview', backendUrl).toString(), {
      method: 'GET',
      cache: 'no-store',
      headers: buildForwardClientHeaders(incomingHeaders, activeCookieHeader),
    });

    if (res.status === 401 || res.status === 403) {
      if (res.status === 401) {
        const recheck = await probeSessionWithCleanRecovery(backendUrl, incomingHeaders, activeCookieHeader);
        if (recheck.data?.authenticated !== true) {
          redirect('/login?next=%2Fadmin');
        }
      }
      redirect('/');
    }

    if (res.ok) {
      const json = await res.json().catch(() => null);
      initialOverview = unwrapOverviewEnvelope(json);
    }
  } catch {
    // در خطای موقت شبکه، کلاینت از طریق گیت بررسی دسترسی دوباره اقدام می‌کند
  }

  return <AdminClient initialAuth={authUser} initialOverview={initialOverview} />;
}
