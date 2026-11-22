'use strict';

/**
 * کش نتیجهٔ تجمیع (فاز ۳).
 *
 * کلید: `(bank, from, to, analysis_version, rebuild-counter)` — «شمارندهٔ rebuild روز»
 * از `day_runs.updated_at`/`MAX(day)` گرفته می‌شود، پس هر rebuild خودکار کش را باطل می‌کند.
 *
 *  * TTL کوتاه برای روز جاری (چون `complete` نیست و ممکن است داده اضافه شود)
 *  * single-flight: چند درخواست هم‌کلید فقط یک محاسبه ایجاد می‌کنند
 *  * سقف اندازه (LRU سبک) تا RAM مستقل از تعداد ردیف بماند
 */

class StatsCache {
  constructor({ ttlMs = 60000, currentDayTtlMs = 5000, maxEntries = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.currentDayTtlMs = currentDayTtlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
    this.coalesced = 0;
  }

  keyOf(parts) {
    return JSON.stringify(parts);
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU سبک: تازه‌سازی ترتیب
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }

  /** محاسبهٔ single-flight: اگر همان کلید در جریان است، همان promise برگردانده می‌شود */
  async remember(key, producer, ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    this.misses += 1;
    if (this.inflight.has(key)) {
      this.coalesced += 1;
      return this.inflight.get(key);
    }
    const promise = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : 0,
    };
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = { StatsCache };
