'use strict';

/**
 * D8 — متریک‌های سبک درون‌پروسه‌ای برای ingestion و کش، بدون وابستگی به Prometheus.
 *
 * چرا درون‌پروسه: افزودن کلاینت Prometheus یعنی یک سرویس دیگر برای نگهداری. این شمارنده‌ها
 * برای `/api/diagnostics` (ادمین) و لاگ دوره‌ای کافی‌اند و اگر روزی Prometheus لازم شد،
 * همان اعداد بدون تغییر منبع قابل صدورند.
 */
class Metrics {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.startedAt = new Date();
  }

  inc(name, value = 1, labels = {}) {
    const key = this.#key(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + Number(value || 0));
    return this.counters.get(key);
  }

  observe(name, value, labels = {}) {
    // میانگین/حداکثر ساده برای تأخیرها (بدون پنجک سنگین)
    const key = this.#key(name, labels);
    const entry = this.gauges.get(key) || { count: 0, sum: 0, max: 0, last: 0 };
    const n = Number(value) || 0;
    entry.count += 1;
    entry.sum += n;
    entry.max = Math.max(entry.max, n);
    entry.last = n;
    this.gauges.set(key, entry);
    return entry;
  }

  set(name, value, labels = {}) {
    this.gauges.set(this.#key(name, labels), { value: Number(value) || 0, last: Number(value) || 0, count: 1, sum: Number(value) || 0, max: Number(value) || 0 });
  }

  #key(name, labels) {
    const parts = Object.entries(labels || {})
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  }

  snapshot() {
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      counters: Object.fromEntries([...this.counters.entries()].sort()),
      gauges: Object.fromEntries(
        [...this.gauges.entries()]
          .sort()
          .map(([key, entry]) => [key, entry.count ? { ...entry, mean: Math.round((entry.sum / entry.count) * 10) / 10 } : entry]),
      ),
    };
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
  }
}

const shared = new Metrics();

module.exports = { Metrics, metrics: shared };
