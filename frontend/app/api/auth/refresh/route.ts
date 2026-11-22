import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import {
  markRefreshTokenInvalid,
  peekRefreshToken,
  performRefreshWithRecovery,
  refreshTokenFingerprint,
  resolveBackendOrigin,
  type RefreshOutcome,
} from '@/lib/server-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function jsonReply(bodyText: string, status: number, setCookies: string[], extraHeaders: Record<string, string> = {}) {
  const res = new NextResponse(bodyText || '{}', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      ...extraHeaders,
    },
  });
  for (const c of setCookies) {
    res.headers.append('set-cookie', c);
  }
  return res;
}

const UNAUTHORIZED_BODY = JSON.stringify({
  status: 'error',
  authenticated: false,
  canRefresh: false,
  message: { fa: 'نشست شما منقضی شده است؛ لطفاً دوباره وارد شوید.', en: 'Refresh token is no longer valid.' },
});

/**
 * مرورگر هنگام انقضای اکسس توکن معمولاً چند درخواست را هم‌زمان می‌فرستد. اگر همهٔ
 * آن‌ها توکن رفرش را بچرخانند، درخواست‌های بعدی توکنِ «چرخیده» می‌فرستند و بک‌اند
 * کل خانوادهٔ توکن را باطل می‌کند؛ نتیجه: پرتاب ناگهانی کاربر به صفحهٔ ورود.
 *
 * دو محافظ:
 *  ۱) پیش‌بررسی `GET /api/auth/refresh/peek` بدون چرخش توکن بررسی می‌کند که کوکی
 *     رفرش هنوز معتبر است (توکن باطل/چرخیده هرگز ارسال نمی‌شود).
 *  ۲) درخواست‌های هم‌زمانِ یک توکن روی یک Promise مشترک ادغام می‌شوند تا فقط یکی
 *     واقعاً توکن را بچرخاند و بقیه همان نتیجه را دریافت کنند.
 */
const flights = new Map<string, Promise<RefreshOutcome>>();
/**
 * نتیجهٔ چرخش موفق، با کلید «اثر انگشت توکنِ قبلی» برای مدت کوتاه نگه داشته می‌شود.
 * تب‌های دیگر/درخواست‌هایی که با همان کوکی قدیمی رسیده‌اند همان پاسخ موفق را
 * دریافت می‌کنند؛ در غیر این صورت ارسال دوبارهٔ توکنِ چرخیده، خانوادهٔ توکن را
 * باطل می‌کند و کاربر به صفحهٔ ورود پرتاب می‌شود.
 */
const rotationReplay = new Map<string, { at: number; rawText: string; setCookies: string[] }>();
const REPLAY_TTL_MS = 120_000;
const FLIGHT_TIMEOUT_MS = 15000;

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

export async function POST(request: NextRequest) {
  try {
    const backendUrl = resolveBackendOrigin();
    const cookieHeader = request.headers.get('cookie') || '';
    const fingerprint = refreshTokenFingerprint(cookieHeader);

    if (!fingerprint) {
      markRefreshTokenInvalid(cookieHeader);
      return jsonReply(UNAUTHORIZED_BODY, 401, []);
    }

    // ۱) اعتبار کوکی رفرش را بدون چرخاندن توکن بررسی می‌کنیم.
    const peek = await peekRefreshToken(backendUrl, request.headers, cookieHeader);
    if (peek && peek.valid === false) {
      markRefreshTokenInvalid(cookieHeader);
      return jsonReply(peek.rawText || UNAUTHORIZED_BODY, 401, []);
    }

    const key = shortHash(fingerprint);

    // ۲) این توکن همین چند لحظه پیش چرخیده است (تب دیگر/درخواست موازی)؛
    // همان پاسخ موفق را تکرار می‌کنیم تا توکنِ مصرف‌شده دوباره ارسال نشود.
    const replay = rotationReplay.get(key);
    if (replay && Date.now() - replay.at < REPLAY_TTL_MS) {
      return jsonReply(replay.rawText, 200, replay.setCookies, { 'x-ce-refresh-replay': '1' });
    }
    if (replay) rotationReplay.delete(key);

    // ۳) درخواست هم‌زمان برای همان توکن؟ نتیجهٔ همان تمدید را به اشتراک می‌گذاریم.
    const existing = flights.get(key);
    if (existing) {
      const shared = await waitFor(existing, FLIGHT_TIMEOUT_MS);
      if (shared) {
        return jsonReply(shared.rawText, shared.ok ? 200 : shared.status, [], {
          'x-ce-refresh-flight': 'joined',
        });
      }
    }

    const flight = performRefreshWithRecovery(backendUrl, request.headers, cookieHeader);
    flights.set(key, flight);
    try {
      // executeRefreshWithRecovery خودش توکن‌های قطعاً باطل (۴۰۱/۴۰۳) را علامت می‌زند؛
      // خطاهای موقت (۵۰۲/۵۰۳/شبکه) نباید منجر به ورود اجباریِ دوباره شوند.
      const outcome = await flight;
      if (outcome.ok) {
        // ⚠️ تمدید «موفق» بدون Set-Cookie = پل BFF از سمت بک‌اند رد شده است.
        // بدون کوکی جدید، توکن بعدی باطل است و کاربر به صفحهٔ ورود پرتاب می‌شود —
        // با پیام خطای صریح همین‌جا متوقف شویم تا علتش گم نشود.
        if (outcome.setCookies.length === 0) {
          console.error(
            '[auth.bff] Refresh succeeded at backend but produced ZERO cookies. ' +
              'Backend likely rejected the BFF bridge (check CE_BFF_SHARED_SECRET in both services, ' +
              'or BACKEND_HOST/private-network reachability). See RUNBOOK §15.',
          );
          return jsonReply(
            JSON.stringify({
              status: 'error',
              authenticated: false,
              canRefresh: false,
              message: {
                fa: 'پیکربندی پل نشست (BFF) با بک‌اند سازگار نیست؛ لطفاً با پشتیبانی فنی تماس بگیرید.',
                en: 'BFF bridge misconfigured: backend did not set the session cookies',
              },
            }),
            500,
            [],
          );
        }
        rotationReplay.set(key, {
          at: Date.now(),
          rawText: outcome.rawText,
          setCookies: outcome.setCookies,
        });
        if (rotationReplay.size > 200) {
          const cutoff = Date.now() - REPLAY_TTL_MS;
          for (const [k, v] of Array.from(rotationReplay.entries())) {
            if (v.at < cutoff) rotationReplay.delete(k);
          }
        }
      }
      return jsonReply(outcome.rawText, outcome.status, outcome.setCookies);
    } finally {
      flights.delete(key);
    }
  } catch (err: any) {
    return jsonReply(
      JSON.stringify({
        status: 'error',
        authenticated: false,
        message: { fa: 'خطا در تمدید نشست', en: err?.message || 'Refresh service unreachable' },
      }),
      502,
      [],
    );
  }
}
