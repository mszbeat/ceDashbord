'use strict';

/**
 * کش «report HTML» — رفع تام‌اوت داشبورد در تولید.
 *
 * چرا: `/api/report` گزارشِ ۳۰ روز اخیر را با پیمایش **تمام ردیف‌ها** می‌سازد (cursor
 * + تجمیع در Node). روی جدول‌های بزرگ این چند ده ثانیه تا چند دقیقه طول می‌کشد؛
 * ولی مهلت پاسخ فرانت به بک‌اند پیش‌فرض ۳۰ ثانیه است — نتیجه: مرورگر تاموت می‌شود،
 * بک‌اند درخواست را تا آخر (بی‌ثمر) ادامه می‌دهد و هر بارگذاری دوباره، همین کار را
 * از نو می‌کند (چند کاربر هم‌زمان = چند گزارشِ کامل = قفل شدن دیتابیس).
 *
 * راه‌حل: خروجی report به نقش کاربر وابسته نیست (نوار احراز در کلاینت رندر می‌شود)،
 * پس HTML برای هر (bank|from|to|rowsCap) یکتا و کش‌پذیر است:
 *   • fresh (< TTL)            → همان‌لحظه از کش
 *   • stale (TTL..staleMs)     → همان‌لحظه نسخهٔ کهنه، و یک نو/سازی **تکی‌پرواز** در پس‌زمینه
 *   • نبود/کهنه‌تر از stale    → نو/سازی تکی‌پرواز؛ درخواست‌های هم‌زمان همان Promise را می‌بینند
 *
 * ⚠️ اگر خروجی report روزی وابسته به نقش کاربر شد، کلید کش را گسترش دهید یا کش را غیرفعال کنید.
 */

const DEFAULT_TTL_MS = Number(process.env.CE_REPORT_CACHE_TTL_MS ?? 600_000); // ۱۰ دقیقه
const DEFAULT_STALE_MS = Number(process.env.CE_REPORT_CACHE_STALE_MS ?? 3_600_000); // ۱ ساعت
const DEFAULT_MAX_ENTRIES = Number(process.env.CE_REPORT_CACHE_MAX_ENTRIES ?? 12);

function numeric(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

class ReportCache {
  /**
   * @param {{ttlMs?: number, staleMs?: number, maxEntries?: number, now?: () => number}} options
   */
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? numeric('CE_REPORT_CACHE_TTL_MS', DEFAULT_TTL_MS);
    this.staleMs = options.staleMs ?? numeric('CE_REPORT_CACHE_STALE_MS', DEFAULT_STALE_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? numeric('CE_REPORT_CACHE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, {html: string, createdAt: number}>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<string>>} */
    this.inflight = new Map();
  }

  static keyOf(bank, from, to, rowsCap) {
    return [bank || '', from || '', to || '', rowsCap ?? ''].join('|');
  }

  get size() {
    return this.entries.size;
  }

  /** پاک‌سازی دستی کش (برای تست‌ها و عملیات دستی — مثلاً بعد از ingest اضطراری) */
  clear() {
    this.entries.clear();
    this.inflight.clear();
  }

  /** در بچ‌های بسیار کوچک، evict ساده: قدیمی‌ترین createdAt اول بیرون می‌رود */
  #evictIfNeeded() {
    while (this.entries.size > this.maxEntries) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of this.entries) {
        if (entry.createdAt < oldestAt) {
          oldestAt = entry.createdAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.entries.delete(oldestKey);
    }
  }

  #set(key, html) {
    this.entries.set(key, { html, createdAt: this.now() });
    this.#evictIfNeeded();
  }

  /**
   * نوسازی پس‌زمینه — خطاها فقط لاگ می‌شوند؛ نسخهٔ کهنه سرجایش می‌ماند.
   * @private
   */
  #refreshInBackground(key, buildFn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const task = (async () => {
      const startedAt = Date.now();
      try {
        const html = await buildFn();
        this.#set(key, html);
        try {
          require('../logger/action-logger.service').getActionLogger().info({
            category: 'summary',
            action: 'summary.report.cache_rebuilt',
            statusCode: 200,
            meta: { key, durationMs: Date.now() - startedAt, bytes: html?.length ?? null },
          });
        } catch { /* لاگر آماده نیست */ }
        return html;
      } catch (error) {
        try {
          require('../logger/action-logger.service').getActionLogger().error({
            category: 'summary',
            action: 'summary.report.cache_rebuild_failed',
            errorCode: error?.code || 'REPORT_REBUILD_FAILED',
            message: error?.message || 'background rebuild failed',
            meta: { key, durationMs: Date.now() - startedAt },
          });
        } catch { /* لاگر آماده نیست */ }
        // نسخهٔ کهنه حفظ می‌شود؛ خطا پرتاب نمی‌شود (کسی منتظرش نبود)
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  /**
   * گزارش را برمی‌گرداند؛ در صورت نیاز می‌سازد.
   * @param {string} key خروجی `ReportCache.keyOf`
   * @param {() => Promise<string>} buildFn ساخت HTML گزارش
   * @returns {Promise<{html: string, fromCache: 'fresh'|'stale'|'miss'|'joined'}>}
   */
  async getOrBuild(key, buildFn) {
    if (this.ttlMs === 0) {
      // کش غیرفعال: همیشه تازه بساز (تکی‌پرواز همچنان فعال است تا طوفانِ موازی نشود)
      const html = await this.#singleFlight(key, buildFn);
      return { html, fromCache: 'miss' };
    }

    const now = this.now();
    const hit = this.entries.get(key);

    if (hit) {
      const age = now - hit.createdAt;
      if (age < this.ttlMs) return { html: hit.html, fromCache: 'fresh' };
      if (age < this.ttlMs + this.staleMs) {
        // پاسخ کهنه فوراً؛ به‌روزرسانی در پس‌زمینه
        void this.#refreshInBackground(key, buildFn);
        return { html: hit.html, fromCache: 'stale' };
      }
      // کهنهٔ بی‌کیفیت: حذف و نوسازی اجباری
      this.entries.delete(key);
    }

    const { html, joined } = await this.#singleFlight(key, buildFn, /* reportJoin */ true);
    return { html, fromCache: joined ? 'joined' : 'miss' };
  }

  /**
   * ساخت تکی‌پرواز: درخواست‌های هم‌زمان روی یک کلید، همان Promise را می‌بینند.
   * @private
   */
  async #singleFlight(key, buildFn, reportJoin = false) {
    const pending = this.inflight.get(key);
    if (pending) return { html: await pending, joined: reportJoin };

    const task = (async () => {
      const html = await buildFn();
      this.#set(key, html);
      return html;
    })();
    this.inflight.set(key, task);
    try {
      return { html: await task, joined: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** نمونه‌ساز تزریق‌ناپذیر برای تست */
function createReportCache(options) {
  return new ReportCache(options);
}

/** نمونهٔ سراسری برای مسیر `/api/report` */
const reportCache = new ReportCache();

module.exports = { ReportCache, createReportCache, reportCache, DEFAULT_TTL_MS, DEFAULT_STALE_MS, DEFAULT_MAX_ENTRIES };
