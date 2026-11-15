import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { AdminService, CronConfigInput, ManualRunRequest } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  getOverview() {
    return this.admin.getOverview();
  }

  @Get('cron')
  getCron() {
    return this.admin.getCronConfig();
  }

  @Put('cron')
  updateCron(@Body() body: CronConfigInput) {
    return this.admin.updateCronConfig(body ?? {});
  }

  @Post('cron/run-now')
  runCronNow() {
    return this.admin.triggerCronExecution('cron_manual');
  }

  @Post('runs/check')
  checkExisting(@Body() body: ManualRunRequest) {
    return this.admin.checkExistingData(body ?? {});
  }

  @Post('runs/start')
  startRun(@Body() body: ManualRunRequest) {
    return this.admin.startManualRun(body ?? {});
  }

  @Get('jobs')
  listJobs() {
    return this.admin.listJobs(20);
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.admin.getJob(id);
  }
}
