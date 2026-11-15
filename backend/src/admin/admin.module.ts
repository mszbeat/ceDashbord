import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { CronSchedulerService } from './cron-scheduler.service';

@Module({
  imports: [IngestionModule],
  controllers: [AdminController],
  providers: [AdminService, CronSchedulerService],
  exports: [AdminService],
})
export class AdminModule {}
