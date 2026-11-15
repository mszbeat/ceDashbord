import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AdminService } from './admin.service';

@Injectable()
export class CronSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly admin: AdminService) {}

  onModuleInit() {
    if (process.env.DISABLE_CRON_SCHEDULER === '1') return;
    this.timer = setInterval(() => {
      void this.safeTick();
    }, 20_000);
    // جلوگیری از نگه داشتن پروسهٔ Node در اسکریپتهای CLI و تستها
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async safeTick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const started = await this.admin.tickScheduledCron(new Date());
      if (started) {
        console.log(`[cron] جاب شبانهٔ خودکار آغاز شد: ${started.id} (${started.banks.join(', ')} -> ${started.days.join(', ')})`);
      }
    } catch (err: any) {
      console.error('[cron] خطا در بررسی زمانبند کران:', err?.message ?? err);
    } finally {
      this.ticking = false;
    }
  }
}
