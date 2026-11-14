import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { IngestionService } from './ingestion.service';
import { tehranToday, tehranYesterday } from '../utils/date';

@Controller('runs')
export class IngestionController {
  constructor(private ingestion: IngestionService) {}

  /** نسخه ۱ بدون احراز هویت؛ بعداً با سرویس بومی شرکت محدود میشود. */
  @Post()
  async run(@Body() body: { bank?: string; day?: string; mode?: 'nightly' | 'intraday'; rebuild?: boolean }) {
    const mode = body.mode === 'intraday' ? 'intraday' : 'nightly';
    const rebuild = body.rebuild === true;
    // rebuild فقط با روز صریح؛ برای جلوگیری از پاک شدن ناخواستهٔ دیروز.
    if (rebuild && !body.day) throw new BadRequestException('rebuild نیاز به day صریح دارد.');
    const day = body.day ?? (mode === 'nightly' ? tehranYesterday() : tehranToday());
    return this.ingestion.runDay(body.bank ?? 'tavan_mellat', day, mode, { rebuild });
  }
}
