import { authFetch, extractPartErrorMessage, unwrapPartPayload } from '@/lib/auth-client';

/**
 * F8 — خطای مسیر پروکسی (۵xx با بدنهٔ غیر-JSON/HTML) هم به پیام قابل‌فهم تبدیل می‌شود.
 *
 * نسخهٔ قبلی برای هر پاسخ ناموفق `extractPartErrorMessage` را صدا می‌زد؛ اگر پروکسی
 * (BFF) خطای HTML یا متنی می‌داد، `parsed` تهی می‌شد و پیام «خطای نامشخص» بیرون می‌آمد.
 * همچنین متن خام سرور هرگز نباید به کاربر برسد؛ این‌جا فقط پیام‌های کوتاهِ مجاز می‌مانند.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;

  constructor(message: string, status: number, code = 'api_error', retryable = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const PROXY_ERROR_MESSAGES: Record<number, string> = {
  401: 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.',
  403: 'برای این بخش دسترسی ندارید.',
  404: 'موردی یافت نشد.',
  413: 'درخواست بزرگ‌تر از حد مجاز است؛ بازه یا فیلترها را کوچک‌تر کنید.',
  429: 'تعداد درخواست‌ها زیاد است؛ چند لحظه بعد دوباره تلاش کنید.',
  502: 'ارتباط با سرور گزارش برقرار نشد.',
  503: 'سرویس موقتاً در دسترس نیست.',
  504: 'پاسخ سرور طول کشید؛ بازهٔ کوچک‌تری انتخاب کنید.',
};

/** خطای شبکه (بدون پاسخ) هم شکل یکسانی می‌گیرد */
function networkError(error: unknown): ApiError {
  const aborted = (error as any)?.name === 'AbortError';
  if (aborted) return new ApiError('درخواست لغو شد.', 0, 'aborted', true);
  return new ApiError('ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید.', 0, 'network', true);
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await authFetch(`/api${path}`, {
      ...init,
      cache: 'no-store',
    });
  } catch (error) {
    throw networkError(error);
  }
  const text = await response.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? unwrapPartPayload(JSON.parse(text)) : null;
  } catch {
    parsed = null; // بدنهٔ غیر-JSON (HTML خطای پروکسی)
  }
  if (!response.ok) {
    // پیام ساختارمند بک‌اند، در صورت وجود، اولویت دارد
    const backendMessage = parsed ? extractPartErrorMessage(parsed, response.status) : '';
    const usable = backendMessage && backendMessage.length <= 200 ? backendMessage : '';
    const fallback = PROXY_ERROR_MESSAGES[response.status]
      || `درخواست ناموفق بود (HTTP ${response.status}).`;
    throw new ApiError(
      usable || fallback,
      response.status,
      'http_error',
      response.status >= 500 || response.status === 408 || response.status === 429,
    );
  }
  return parsed as T;
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
