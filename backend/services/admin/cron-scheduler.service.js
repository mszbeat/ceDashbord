'use strict';

const { getActionLogger } = require('../logger/action-logger.service');

class CronSchedulerService {
  constructor(admin, options = {}) {
    this.admin = admin;
    this.timer = null;
    this.ticking = false;
    this.alertTimer = null;
    this.db = options.db || null;
    /** هشدار روز ناقص (D8): هر ۱۵ دقیقه یک‌بار بررسی می‌شود */
    this.alertIntervalMs = Number(process.env.CE_INCOMPLETE_ALERT_MS || 15 * 60 * 1000);
    this.staleHours = Number(process.env.CE_INCOMPLETE_STALE_HOURS || 6);
  }

  start() {
    if (process.env.DISABLE_CRON_SCHEDULER === '1' || this.timer) return;
    this.timer = setInterval(() => {
      void this.safeTick();
    }, 20_000);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    // هشدار «روز ناقص/گیرکرده» — همان چیزی که در /api/readyz هم دیده می‌شود
    this.alertTimer = setInterval(() => void this.checkIncompleteDays(), this.alertIntervalMs);
    if (typeof this.alertTimer.unref === 'function') this.alertTimer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.alertTimer) {
      clearInterval(this.alertTimer);
      this.alertTimer = null;
    }
  }

  /**
   * روزهایی که بیش از `staleHours` در وضعیت «در جریان/ناقص» مانده‌اند = هشدار عملیاتی.
   * هر بار یک لاگ warn + شمارندهٔ متریک (نه ایمیل/وب‌هوک؛ تیم مانیتورینگ از لاگ می‌خواند).
   */
  async checkIncompleteDays() {
    if (!this.db) return { stale: 0 };
    try {
      const res = await this.db.query(
        `SELECT bank, day, status, updated_at FROM day_runs
          WHERE status IN ('running','partial','needs_review')
            AND updated_at < now() - ($1 || ' hours')::interval
          ORDER BY updated_at LIMIT 50`,
        [String(this.staleHours)],
      );
      const stale = res.rows || [];
      if (stale.length) {
        require('../metrics').metrics.set('incomplete_days', stale.length);
        getActionLogger().warn({
          category: 'ingestion',
          action: 'ingestion.incomplete_days',
          message: `${stale.length} روز ناقص/گیرکرده بیش از ${this.staleHours} ساعت`,
          meta: { count: stale.length, sample: stale.slice(0, 10), staleHours: this.staleHours },
        });
      } else {
        require('../metrics').metrics.set('incomplete_days', 0);
      }
      return { stale: stale.length };
    } catch (error) {
      getActionLogger().warn({
        category: 'ingestion',
        action: 'ingestion.incomplete_days_failed',
        message: error?.message || 'بررسی روزهای ناقص شکست خورد',
      });
      return { stale: 0, error: error?.message };
    }
  }

  async safeTick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const started = await this.admin.tickScheduledCron(new Date());
      if (started) {
        getActionLogger().info({
          category: 'cron',
          action: 'cron.tick_started',
          actor: 'cron',
          message: `Scheduled nightly cron started: ${started.id}`,
          meta: { jobId: started.id, banks: started.banks, days: started.days },
        });
      }
    } catch (err) {
      getActionLogger().error({
        category: 'cron',
        action: 'cron.tick_error',
        actor: 'cron',
        errorCode: err?.code || 'CRON_TICK_ERROR',
        message: err?.message ?? String(err),
        stack: err?.stack,
      });
    } finally {
      this.ticking = false;
    }
  }
}

module.exports = { CronSchedulerService };
