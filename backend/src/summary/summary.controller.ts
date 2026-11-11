import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import { SummaryService } from './summary.service';

/**
 * Web API فقطخواندنی از دیتابیس جانبی (M3).
 * تنها استثناء GET /sample/:requestId است که لحظهای به API اصلی پروکسی میشود.
 */
@Controller()
export class SummaryController {
  constructor(private svc: SummaryService) {}

  @Get('health')
  health() {
    return { ok: true, service: 'ce-dashboard-backend', time: new Date().toISOString() };
  }

  @Get('banks')
  banks() {
    return this.svc.banks();
  }

  @Get('specs')
  specs(@Query('bank') bank = 'tavan_mellat') {
    return this.svc.specs(bank);
  }

  @Get('report')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  report(
    @Query('bank') bank = 'tavan_mellat',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('rowsCap') rowsCap?: string,
  ) {
    return this.svc.report(bank, from, to, rowsCap ? Number(rowsCap) : 100);
  }

  @Get('summary')
  summary(
    @Query('bank') bank = 'tavan_mellat',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.summary(bank, from, to);
  }

  @Get('list')
  list(
    @Query('bank') bank = 'tavan_mellat',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('indicator') indicator?: string,
    @Query('type') type?: string,
    @Query('id') id?: string,
    @Query('value') value?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.svc.list({
      bank, from, to, indicator, type, id, value, status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('sample/:requestId')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  @Header('Pragma', 'no-cache')
  sample(@Param('requestId') requestId: string, @Req() req: any) {
    return this.svc.sample(requestId, req);
  }

  @Get('runs')
  runs() {
    return this.svc.runs();
  }
}
