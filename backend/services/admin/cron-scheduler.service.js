'use strict';

const { getActionLogger } = require('../logger/action-logger.service');

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
