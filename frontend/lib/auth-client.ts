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

export function formatRoleFa(role: string): string {
  return ROLE_LABELS_FA[role] || role;
}

export function formatRolesFa(roles?: string[] | null): string {
  if (!Array.isArray(roles) || !roles.length) return ROLE_LABELS_FA.visitor;
  return roles.map(formatRoleFa).join('، ');
}

export function sanitizeNextPath(raw: string | null | undefined, fallback = '/'): string {
  if (!raw || typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return fallback;
  }
  if (trimmed === '/login' || trimmed.startsWith('/login?')) {
    return fallback;
  }
  return trimmed;
}

export function getSavedTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    const val = window.localStorage.getItem('ce-theme') || window.localStorage.getItem('bank-ce-dashboard-theme');
    return val === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: 'light' | 'dark'): void {
  if (typeof window === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem('ce-theme', theme);
    window.localStorage.setItem('bank-ce-dashboard-theme', theme);
  } catch {
    // ignore storage errors
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
    if (current && current._ok && current.canRefresh === false) {
      return null;
    }

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
  if (!me.authenticated && (me.canRefresh || !me._ok)) {
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

  // اطمینان از اینکه نشست در بک‌اند/کوکی مرورگر واقعاً فعال شده است
  // (اگر توکن بازدیدکننده قبلی منقضی بوده، یک بار با رفرش یا درخواست مجدد تثبیت می‌شود).
  let verified = await getAuthStatus().catch(() => null);
  if (!verified?.authenticated) {
    if (verified?.canRefresh) {
      const refreshed = await refreshSession().catch(() => null);
      if (refreshed?.authenticated) {
        verified = refreshed;
      }
    }
    if (!verified?.authenticated) {
      parsed = await postLoginRequest(params);
      verified = await getAuthStatus().catch(() => null);
      if (!verified?.authenticated && verified?.canRefresh) {
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
    if (verified?.canRefresh) {
      const refreshed = await refreshSession().catch(() => null);
      if (refreshed?.authenticated) {
        verified = refreshed;
      }
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
  if (res.status === 401 || res.status === 403) {
    const before = await getAuthStatus().catch(() => null);
    // اگر سشن واقعاً احرازنشده است با رفرش تمدید و فقط در آن صورت درخواست تکرار شود؛
    // اگر کاربر لاگین است و خطای سطح دسترسی (۴۰۱/۴۰۳ نقش) گرفته، دوباره تکرار نشود.
    if (!before?.authenticated) {
      const refreshed = await refreshSession();
      if (refreshed && refreshed.authenticated) {
        return doFetch();
      }
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
  let lastAuthenticated = false;
  const requireSession = Boolean(options.requireSession);

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
    if (stopped || !state) return;
    onUpdate(state);
    if (state.authenticated) {
      lastAuthenticated = true;
      scheduleNext(state);
    } else {
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
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
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
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
      onUpdate(msg.auth);
      scheduleNext(msg.auth);
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  channel?.addEventListener('message', onChannelMessage);
  void sync();

  return () => {
    stopped = true;
    if (timerId !== null) window.clearInterval(timerId);
    document.removeEventListener('visibilitychange', onVisibility);
    channel?.removeEventListener('message', onChannelMessage);
    channel?.close();
  };
}
