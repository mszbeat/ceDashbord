'use client';

export interface AuthSessionState {
  authenticated: boolean;
  username: string;
  samadUsername?: string;
  roles: string[];
  canRefresh?: boolean;
  refreshExpiresAt?: string | null;
  accessExpireMs?: number;
  idleExpireMs?: number;
}

export const ROLE_LABELS_FA: Record<string, string> = {
  admin: 'مدیر سیستم',
  creditEvaluation: 'کارشناس اعتبارسنجی',
  visitor: 'بازدیدکننده',
};

const ROLE_SHORT_LABELS_FA: Record<string, string> = {
  admin: 'ادمین',
  creditEvaluation: 'CE',
  visitor: 'بازدیدکننده',
};

/** ترتیب برتری نقش‌ها: admin > creditEvaluation (CE) > visitor */
const ROLE_PRIORITY: Record<string, number> = {
  admin: 3,
  creditEvaluation: 2,
  visitor: 1,
};

export function formatRoleFa(role: string): string {
  return ROLE_LABELS_FA[role] || role;
}

export function formatRoleShortFa(role: string): string {
  return ROLE_SHORT_LABELS_FA[role] || ROLE_LABELS_FA[role] || role;
}

/** بالاترین نقش کاربر؛ حتی وقتی هم‌زمان چند نقش دارد. */
export function pickPrimaryRole(roles?: string[] | null): string {
  if (!Array.isArray(roles) || !roles.length) return 'visitor';
  const known = roles.filter((role) => typeof role === 'string' && role.trim());
  if (!known.length) return 'visitor';
  return [...known].sort(
    (a, b) => (ROLE_PRIORITY[b] ?? 0) - (ROLE_PRIORITY[a] ?? 0),
  )[0];
}

/**
 * فقط نقش برتر را نمایش می‌دهد: admin، سپس CE (خلاصهٔ creditEvaluation) و در نهایت بازدیدکننده.
 */
export function formatRolesFa(roles?: string[] | null): string {
  return formatRoleShortFa(pickPrimaryRole(roles));
}

/* F4 — اعتبارسنجی `next` در `lib/next-path.mjs` است تا مستقل از Next تست شود. */
export { sanitizeNextPath } from './next-path.mjs';

/**
 * F9 — کلیدهای تم در یک جا متمرکز شدند.
 *
 * قبلاً نام کلیدها در چند فایل تکرار می‌شد (و اپ قدیمی `bank-ce-dashboard-theme` را
 * می‌نوشت)؛ اگر یکی جا می‌ماند، تم بین تب‌ها/صفحات هم‌خوان نمی‌شد. حالا فقط همین دو
 * ثابت استفاده می‌شوند و نوشتن در هر دو کلید انجام می‌شود تا مهاجرت کاربران قدیمی بی‌درد باشد.
 */
export const THEME_STORAGE_KEY = 'ce-theme';
export const LEGACY_THEME_STORAGE_KEY = 'bank-ce-dashboard-theme';
const THEME_KEYS = [THEME_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY] as const;

export function getSavedTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    let val: string | null = null;
    for (const key of THEME_KEYS) {
      val = window.localStorage.getItem(key);
      if (val) break;
    }
    return val === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: 'light' | 'dark'): void {
  if (typeof window === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  // F9: رنگ نوار مرورگر همراه تم تا آیکون/آدرس‌بار با صفحه هم‌خوان باشد
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b1220' : '#ffffff');
  try {
    for (const key of THEME_KEYS) window.localStorage.setItem(key, theme);
  } catch {
    // حالت ناشناس/سهمیهٔ پر: تم فقط برای همین صفحه اعمال می‌شود
  }
}

export function unwrapPartPayload<T = any>(raw: any): T {
  let cur = raw;
  if (
    cur &&
    typeof cur === 'object' &&
    !Array.isArray(cur) &&
    'data' in cur &&
    cur.data !== undefined &&
    Object.keys(cur).every((k) => ['data', 'meta', 'status', 'statusCode', 'success'].includes(k))
  ) {
    cur = cur.data;
    if (typeof cur === 'string') {
      try {
        cur = JSON.parse(cur);
      } catch {
        // plain string payload
      }
    }
  }
  return cur as T;
}

export function extractPartErrorMessage(payload: any, status: number): string {
  const candidates = [
    payload?.message?.fa,
    payload?.data?.message?.fa,
    payload?.error?.message?.fa,
    payload?.message?.en,
    payload?.data?.message?.en,
    typeof payload?.message === 'string' ? payload.message : null,
    typeof payload?.data?.message === 'string' ? payload.data.message : null,
    Array.isArray(payload?.message) ? payload.message.join(' | ') : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (status === 401) return 'نام کاربری یا رمز عبور نادرست است یا نشست شما منقضی شده است.';
  if (status === 403) return 'شما مجوز دسترسی به این بخش را ندارید.';
  if (status === 404) return 'کاربر یا نقش مورد نظر در سرویس سمد یافت نشد.';
  if (status === 409) return 'این نام کاربری قبلاً در سیستم ثبت شده است.';
  if (status === 429) return 'تعداد تلاش‌های ناموفق بیش از حد مجاز است؛ لطفاً چند لحظه صبر کنید.';
  if (status === 503) return 'سرویس احراز هویت موقتاً در دسترس نیست.';
  return `خطای سرور (HTTP ${status})`;
}

let refreshInFlight: Promise<AuthSessionState | null> | null = null;

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel !== 'function') return null;
  try {
    return new BroadcastChannel('ce-auth');
  } catch {
    return null;
  }
}

function broadcastAuthEvent(event: { type: 'login' | 'logout' | 'refreshed'; auth?: AuthSessionState | null }) {
  const channel = getBroadcastChannel();
  if (!channel) return;
  try {
    channel.postMessage(event);
  } catch {
    // ignore
  } finally {
    channel.close();
  }
}

export async function getAuthStatus(): Promise<AuthSessionState & { _ok?: boolean }> {
  const res = await fetch('/api/auth/me', {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? unwrapPartPayload(JSON.parse(text)) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok || !parsed || typeof parsed !== 'object') {
    return {
      authenticated: false,
      username: 'visitor',
      samadUsername: 'visitor',
      roles: ['visitor'],
      canRefresh: false,
      _ok: false,
    };
  }
  return {
    authenticated: Boolean(parsed.authenticated),
    username: String(parsed.username || parsed.samadUsername || 'visitor'),
    samadUsername: String(parsed.samadUsername || parsed.username || 'visitor'),
    roles: Array.isArray(parsed.roles) && parsed.roles.length ? parsed.roles : ['visitor'],
    canRefresh: Boolean(parsed.canRefresh),
    refreshExpiresAt: parsed.refreshExpiresAt || null,
    accessExpireMs: typeof parsed.accessExpireMs === 'number' ? parsed.accessExpireMs : undefined,
    idleExpireMs: typeof parsed.idleExpireMs === 'number' ? parsed.idleExpireMs : undefined,
    _ok: true,
  };
}

async function runLockedRefresh(): Promise<AuthSessionState | null> {
  const exec = async (): Promise<AuthSessionState | null> => {
    const current = await getAuthStatus().catch(() => null);
    if (current && current.authenticated) {
      return current;
    }
    // canRefresh:false در پاسخ unauthenticated /me صرفاً یعنی اکسس توکن منقضی شده؛
    // تنها POST /api/auth/refresh میتواند معتبر بودن کوکی رفرش را تعیین کند.

    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
    });

    const text = await res.text().catch(() => '');
    let parsed: any = null;
    try {
      parsed = text ? unwrapPartPayload(JSON.parse(text)) : null;
    } catch {
      parsed = null;
    }

    if (!res.ok || !parsed || !parsed.authenticated) {
      return null;
    }

    const state: AuthSessionState = {
      authenticated: true,
      username: String(parsed.username || parsed.samadUsername || 'visitor'),
      samadUsername: String(parsed.samadUsername || parsed.username || 'visitor'),
      roles: Array.isArray(parsed.roles) && parsed.roles.length ? parsed.roles : ['visitor'],
      canRefresh: true,
      refreshExpiresAt: parsed.refreshExpiresAt || null,
      accessExpireMs: typeof parsed.accessExpireMs === 'number' ? parsed.accessExpireMs : undefined,
      idleExpireMs: typeof parsed.idleExpireMs === 'number' ? parsed.idleExpireMs : undefined,
    };
    broadcastAuthEvent({ type: 'refreshed', auth: state });
    return state;
  };

  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request('ce-auth-refresh', exec);
  }
  return exec();
}

export function refreshSession(): Promise<AuthSessionState | null> {
  if (!refreshInFlight) {
    refreshInFlight = runLockedRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function ensureAuthenticated(): Promise<AuthSessionState> {
  const me = await getAuthStatus();
  if (!me.authenticated) {
    const refreshed = await refreshSession();
    if (refreshed && refreshed.authenticated) {
      return refreshed;
    }
  }
  return me;
}

async function postLoginRequest(params: {
  username: string;
  password: string;
  rememberMe?: boolean;
}): Promise<any> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      username: params.username.trim(),
      password: params.password,
      rememberMe: Boolean(params.rememberMe),
    }),
  });

  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? unwrapPartPayload(JSON.parse(text)) : null;
  } catch {
    parsed = { message: text };
  }

  if (!res.ok) {
    const err: any = new Error(extractPartErrorMessage(parsed, res.status));
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }
  return parsed;
}

export async function loginWithPassword(params: {
  username: string;
  password: string;
  rememberMe?: boolean;
}): Promise<AuthSessionState> {
  let parsed = await postLoginRequest(params);

  // BFF ورود (performLoginWithRecovery) نشست و کوکی را سمت سرور راستی‌آزمایی کرده است؛
  // در صورت دریافت authenticated: true نیازی به رفت‌وبرگشت اضافه نیست و انتقال سریع‌تر انجام می‌شود.
  let verified: AuthSessionState | null =
    parsed?.authenticated === true
      ? {
          authenticated: true,
          username: String(parsed.username || parsed.samadUsername || params.username.trim()),
          samadUsername: String(parsed.samadUsername || parsed.username || params.username.trim()),
          roles: Array.isArray(parsed.roles) && parsed.roles.length ? parsed.roles : ['visitor'],
          canRefresh: true,
          refreshExpiresAt: parsed.refreshExpiresAt || null,
          accessExpireMs: typeof parsed.accessExpireMs === 'number' ? parsed.accessExpireMs : undefined,
          idleExpireMs: typeof parsed.idleExpireMs === 'number' ? parsed.idleExpireMs : undefined,
        }
      : null;

  if (!verified?.authenticated) {
    verified = await getAuthStatus().catch(() => null);
    if (!verified?.authenticated) {
      const refreshed = await refreshSession().catch(() => null);
      if (refreshed?.authenticated) {
        verified = refreshed;
      }
    }
    if (!verified?.authenticated) {
      parsed = await postLoginRequest(params);
      verified = await getAuthStatus().catch(() => null);
      if (!verified?.authenticated) {
        const refreshed = await refreshSession().catch(() => null);
        if (refreshed?.authenticated) {
          verified = refreshed;
        }
      }
    }
  }

  if (!verified?.authenticated) {
    const err: any = new Error('ورود انجام شد اما کوکی نشست روی مرورگر تثبیت نشد. لطفاً تنظیمات کوکی/سشن را بررسی کنید.');
    err.status = 401;
    throw err;
  }

  const state: AuthSessionState = {
    authenticated: true,
    username: String(verified.username || parsed?.username || params.username.trim()),
    samadUsername: String(verified.samadUsername || parsed?.samadUsername || params.username.trim()),
    roles: Array.isArray(verified.roles) && verified.roles.length
      ? verified.roles
      : Array.isArray(parsed?.roles) && parsed.roles.length
        ? parsed.roles
        : ['visitor'],
    canRefresh: Boolean(verified.canRefresh ?? true),
    refreshExpiresAt: verified.refreshExpiresAt || parsed?.refreshExpiresAt || null,
    accessExpireMs: verified.accessExpireMs ?? (typeof parsed?.accessExpireMs === 'number' ? parsed.accessExpireMs : undefined),
    idleExpireMs: verified.idleExpireMs ?? (typeof parsed?.idleExpireMs === 'number' ? parsed.idleExpireMs : undefined),
  };
  broadcastAuthEvent({ type: 'login', auth: state });
  return state;
}

export interface RegisterAccountResult {
  username: string;
  roles: string[];
  autoLoggedIn: boolean;
  sessionState: AuthSessionState | null;
}

export async function registerAccount(params: {
  username: string;
  password: string;
  rememberMe?: boolean;
  autoLogin?: boolean;
}): Promise<RegisterAccountResult> {
  const cleanUser = params.username.trim();
  const shouldAutoLogin = params.autoLogin !== false;

  const bodyPayload = {
    username: cleanUser,
    password: params.password,
    rememberMe: Boolean(params.rememberMe),
    autoLogin: shouldAutoLogin,
  };

  const res = await fetch('/api/auth/register', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(bodyPayload),
  });

  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? unwrapPartPayload(JSON.parse(text)) : null;
  } catch {
    parsed = { message: text };
  }

  if (!res.ok) {
    const err: any = new Error(extractPartErrorMessage(parsed, res.status));
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }

  const roles = Array.isArray(parsed?.roles) && parsed.roles.length
    ? parsed.roles
    : ['visitor'];

  if (!shouldAutoLogin) {
    return {
      username: String(parsed?.username || cleanUser),
      roles,
      autoLoggedIn: false,
      sessionState: null,
    };
  }

  let verified = await getAuthStatus().catch(() => null);
  if (!verified?.authenticated) {
    // حتی اگر /me بگوید canRefresh:false، رفرش توکن HttpOnly ممکن است معتبر باشد.
    const refreshed = await refreshSession().catch(() => null);
    if (refreshed?.authenticated) {
      verified = refreshed;
    }
    if (!verified?.authenticated) {
      try {
        verified = await loginWithPassword({
          username: cleanUser,
          password: params.password,
          rememberMe: params.rememberMe,
        });
      } catch {
        verified = null;
      }
    }
  }

  if (verified?.authenticated) {
    broadcastAuthEvent({ type: 'login', auth: verified });
    return {
      username: String(verified.username || parsed?.username || cleanUser),
      roles: verified.roles?.length ? verified.roles : roles,
      autoLoggedIn: true,
      sessionState: verified,
    };
  }

  return {
    username: String(parsed?.username || cleanUser),
    roles,
    autoLoggedIn: false,
    sessionState: null,
  };
}

export async function logoutSession(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: '{}',
    });
  } finally {
    broadcastAuthEvent({ type: 'logout', auth: null });
  }
}

export async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const doFetch = () =>
    fetch(input, {
      ...init,
      cache: 'no-store',
      credentials: 'include',
    });

  const res = await doFetch();
  if (res.status === 401) {
    // ۴۰۱ برای داده یعنی اکسس توکن منقضی شده است؛ یک بار تمدید و تکرار همان درخواست.
    // سمت سرور، تمدیدهای هم‌زمان ادغام می‌شوند و توکنِ چرخیده دوباره ارسال نمی‌شود.
    const refreshed = await refreshSession().catch(() => null);
    if (refreshed?.authenticated) {
      return doFetch();
    }
  }
  return res;
}

export function startSessionKeepalive(
  onUpdate: (state: AuthSessionState) => void,
  onExpired?: () => void,
  options: { requireSession?: boolean } = {},
): () => void {
  let stopped = false;
  let timerId: number | null = null;
  let refreshTimerId: number | null = null;
  let lastAuthenticated = false;
  let unconfirmed = 0;
  const requireSession = Boolean(options.requireSession);

  const clearRefreshTimer = () => {
    if (refreshTimerId !== null) {
      window.clearTimeout(refreshTimerId);
      refreshTimerId = null;
    }
  };

  /**
   * تمدید پیش‌دستانه: پیش از انقضای اکسس توکن، رفرش توکن را در پس‌زمینه می‌چرخانیم
   * تا کاربر هیچ‌وقت به «نشست منقضی» نخورد. فاصله با تلورانس انتخاب می‌شود تا اگر
   * مرورگر در حالت بیکار تایمر را عقب انداخت، هنوز فرصت تمدید باشد.
   */
  const schedulePreemptiveRefresh = (state: AuthSessionState) => {
    clearRefreshTimer();
    if (stopped || !state.authenticated) return;
    const accessMs = Number(state.accessExpireMs || 120000);
    const delay = Math.max(15000, Math.floor(accessMs * 0.6));
    refreshTimerId = window.setTimeout(() => {
      if (stopped) return;
      void (async () => {
        const refreshed = await refreshSession().catch(() => null);
        if (refreshed?.authenticated) {
          unconfirmed = 0;
          lastAuthenticated = true;
          onUpdate(refreshed);
          scheduleNext(refreshed);
        }
      })();
    }, delay);
  };

  const scheduleNext = (state: AuthSessionState) => {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    if (stopped || !state.authenticated) return;
    const idleMs = state.idleExpireMs || 20000;
    const accessMs = state.accessExpireMs || 120000;
    const intervalMs = Math.max(10000, Math.min(60000, Math.floor(Math.min(idleMs, accessMs) * 0.65)));

    timerId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void sync();
      }
    }, intervalMs);
  };

  const sync = async () => {
    if (stopped) return;
    const state = await ensureAuthenticated().catch(() => null);
    if (stopped) return;
    if (!state) {
      // خطای موقت (شبکه/۵xx): فقط پس از چند بار تلاش پیاپی، نشست را منقضی می‌دانیم.
      unconfirmed += 1;
      if (unconfirmed >= 3 && (lastAuthenticated || requireSession)) {
        unconfirmed = 0;
        onExpired?.();
      }
      return;
    }
    onUpdate(state);
    if (state.authenticated) {
      unconfirmed = 0;
      lastAuthenticated = true;
      scheduleNext(state);
      schedulePreemptiveRefresh(state);
    } else {
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
      clearRefreshTimer();
      if (lastAuthenticated || requireSession) {
        lastAuthenticated = false;
        onExpired?.();
      }
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      void sync();
    }
  };

  const channel = getBroadcastChannel();
  const onChannelMessage = (event: MessageEvent) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'logout') {
      lastAuthenticated = false;
      unconfirmed = 0;
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
      clearRefreshTimer();
      const visitorState: AuthSessionState = {
        authenticated: false,
        username: 'visitor',
        samadUsername: 'visitor',
        roles: ['visitor'],
        canRefresh: false,
      };
      onUpdate(visitorState);
      onExpired?.();
    } else if ((msg.type === 'login' || msg.type === 'refreshed') && msg.auth) {
      lastAuthenticated = true;
      unconfirmed = 0;
      onUpdate(msg.auth);
      scheduleNext(msg.auth);
      schedulePreemptiveRefresh(msg.auth);
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  channel?.addEventListener('message', onChannelMessage);
  void sync();

  return () => {
    stopped = true;
    if (timerId !== null) window.clearInterval(timerId);
    clearRefreshTimer();
    document.removeEventListener('visibilitychange', onVisibility);
    channel?.removeEventListener('message', onChannelMessage);
    channel?.close();
  };
}
