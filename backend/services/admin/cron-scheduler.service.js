'use strict';

class CronSchedulerService {
  constructor(admin) {
    this.admin = admin;
    this.timer = null;
    this.ticking = false;
  }

  start() {
    if (process.env.DISABLE_CRON_SCHEDULER === '1' || this.timer) return;
    this.timer = setInterval(() => {
      void this.safeTick();
    }, 20_000);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async safeTick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const started = await this.admin.tickScheduledCron(new Date());
      if (started) {
        console.log(
          `[cron] جاب شبانهٔ خودکار آغاز شد: ${started.id} (${started.banks.join(', ')} -> ${started.days.join(', ')})`,
        );
      }
    } catch (err) {
      console.error('[cron] خطا در بررسی زمانبند کران:', err?.message ?? err);
    } finally {
      this.ticking = false;
    }
  }
}

module.exports = { CronSchedulerService };
