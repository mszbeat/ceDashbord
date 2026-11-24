/**
 * ۳-الف — منطق صفحه‌بندی سمت کلاینت.
 *
 * قرارداد API: `GET /api/list?...&limit=50&cursor=<token>` →
 *   `{ items, total, nextCursor, cursor, limit }`
 * (سرور `rows` هم برای سازگاری برمی‌گرداند؛ این‌جا هر دو پذیرفته می‌شوند.)
 *
 * تصمیم‌های مهم:
 *  * ناوبری «بعدی/قبلی» با **cursor** است، نه offset؛ فقط شماره‌صفحه (`offset`) برای پرش.
 *  * هر درخواست با `AbortController` همراه است؛ درخواست قبلی که هنوز برنگشته لغو می‌شود
 *    تا با کلیک سریع، دادهٔ صفحهٔ قدیمی روی صفحهٔ جدید ننشیند.
 *  * وضعیت صفحه در URL ذخیره می‌شود (`cursor` و `offset`) تا رفرش/اشتراک‌گذاری همان
 *    صفحه را نشان دهد.
 */

export const PAGE_SIZE = 50;

/** ساخت آدرس با حفظ فیلترها و حذف کلیدهای خالی */
export function buildListUrl(base, params, state = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  search.set('limit', String(state.limit || PAGE_SIZE));
  if (state.cursor) {
    search.set('cursor', state.cursor);
    search.delete('offset');
  } else if (state.offset) {
    search.set('offset', String(state.offset));
    search.delete('cursor');
  }
  const query = search.toString();
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

/** نرمال‌سازی پاسخ سرور به شکل یکنواخت صفحه */
export function normalizePage(payload) {
  const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.rows) ? body.rows : [];
  return {
    items,
    total: Number(body?.total ?? items.length),
    nextCursor: body?.nextCursor ?? null,
    cursor: body?.cursor ?? null,
    limit: Number(body?.limit ?? PAGE_SIZE),
  };
}

/** وضعیت صفحه از URL (برای رفرش و back/forward) */
export function pageStateFrom(search) {
  const params = new URLSearchParams(search || '');
  const offset = Number(params.get('offset') || 0);
  return {
    cursor: params.get('cursor') || null,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
    limit: Number(params.get('limit') || PAGE_SIZE) || PAGE_SIZE,
  };
}

/** نوشتن وضعیت صفحه در URL بدون بارگذاری مجدد */
export function pageStateToUrl(search, state) {
  const params = new URLSearchParams(search || '');
  if (state.cursor) {
    params.set('cursor', state.cursor);
    params.delete('offset');
  } else {
    params.delete('cursor');
    if (state.offset) params.set('offset', String(state.offset));
    else params.delete('offset');
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * صفحه بعد/قبل.
 * `nextCursor` تنها راه رفتن به جلو است؛ برگشت با `offset` (پرش) یا بازسازی cursor.
 */
export function nextPageState(current, page) {
  if (!page.nextCursor) return null;
  return { ...current, cursor: page.nextCursor, offset: 0, page: (current.page || 1) + 1 };
}

export function prevPageState(current) {
  if ((current.page || 1) <= 1) return null;
  // برگشت با offset (سرور برای پرش، offset را می‌پذیرد) — صفحهٔ آخر دقیق نیست، ولی سریع است
  const offset = Math.max(0, (current.page - 2) * (current.limit || PAGE_SIZE));
  return { ...current, cursor: null, offset, page: (current.page || 1) - 1 };
}

/** درصد پیشرفت تا انتهای مجموعه (برای نمایش «۵۰۰ از ۱۲٬۴۳۰») */
export function progressLabel(page, pageNumber, limit = PAGE_SIZE) {
  const seen = Math.min(page.total, (pageNumber - 1) * limit + page.items.length);
  return `${seen.toLocaleString('fa-IR')} از ${page.total.toLocaleString('fa-IR')}`;
}

/**
 * دریافت یک صفحه با لغو درخواست قبلی.
 * @param {{signal: AbortSignal, fetchImpl: Function}} ctx
 */
export async function fetchPage(ctx, url) {
  const { signal, fetchImpl = fetch } = ctx;
  const response = await fetchImpl(url, {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`دریافت فهرست ناموفق بود (HTTP ${response.status})`);
    error.status = response.status;
    error.body = text.slice(0, 500);
    throw error;
  }
  return normalizePage(await response.json());
}

/** مدیر درخواست‌های فهرست: آخرین درخواست برنده است */
export function createPageLoader({ fetchImpl = fetch, onPage, onError } = {}) {
  let controller = null;
  return async function load(url) {
    if (controller) controller.abort();
    controller = new AbortController();
    const mine = controller;
    try {
      const page = await fetchPage({ signal: mine.signal, fetchImpl }, url);
      if (mine.signal.aborted) return null;
      onPage?.(page);
      return page;
    } catch (error) {
      if (error?.name === 'AbortError') return null; // لغو عمدی، خطا نیست
      onError?.(error);
      return null;
    }
  };
}
