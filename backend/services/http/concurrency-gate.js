'use strict';

/**
 * سقف هم‌زمانی برای مسیرهای سنگین خواندن (فاز ۳).
 *
 * چرا: هر درخواست `/api/summary` روی روزهای ناقص یک تجمیع SQL کامل است. اگر ده درخواست
 * هم‌زمان برسد، هم استخر اتصال اشباع می‌شود و هم p95 بقیه بالا می‌رود. این گیت تعداد
 * درخواست‌های در حال اجرا را می‌شمارد و بالاتر از سقف، **۴۲۹ با `Retry-After`** می‌دهد
 * (رفتار صریح و قابل تنظیم) به‌جای صف بی‌پایان.
 *
 * گیت با **کلید** کار می‌کند (bank|from|to) تا درخواست‌های هم‌کلید که کش single-flight
 * آن‌ها را ادغام می‌کند، سهمیهٔ جدا نسوزانند.
 *
 * متغیر: CE_MAX_CONCURRENT_READS (پیش‌فرض ۸، صفر = بی‌سقف)
 */
class ConcurrencyGate {
  constructor({ max = Number(process.env.CE_MAX_CONCURRENT_READS ?? 8), retryAfterSeconds = 1 } = {}) {
    this.max = Number(max) > 0 ? Number(max) : Infinity;
    this.retryAfterSeconds = retryAfterSeconds;
    this.active = 0;
    this.rejected = 0;
    this.peak = 0;
  }

  /** اجرای تابع زیر گیت؛ در صورت رد، خطای ۴۲۹ با کد `tooManyRequests` */
  async run(fn, meta = {}) {
    if (this.active >= this.max) {
      this.rejected += 1;
      const error = new Error('درخواست‌های هم‌زمان بیش از حد؛ لطفاً کمی بعد دوباره تلاش کنید');
      error.statusCode = 429;
      error.code = 'tooManyRequests';
      error.meta = { ...meta, active: this.active, max: this.max };
      error.data = {
        code: 'tooManyRequests',
        retryAfter: this.retryAfterSeconds,
        message: { fa: error.message, en: 'too many concurrent requests' },
      };
      error.retryAfter = this.retryAfterSeconds;
      throw error;
    }
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await fn();
    } finally {
      this.active -= 1;
    }
  }

  stats() {
    return { active: this.active, peak: this.peak, rejected: this.rejected, max: this.max };
  }
}

module.exports = { ConcurrencyGate };
