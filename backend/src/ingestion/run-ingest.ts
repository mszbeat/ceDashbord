/* CLI اجرای Ingestion:
   npm run ingest -- --bank=tavan_mellat --mode=nightly
   npm run ingest -- --mode=intraday
   npm run ingest -- --days=7            (بکفیل ۷ روز قبل تا دیروز)
*/
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IngestionService } from './ingestion.service';
import { tehranJalali } from '../utils/date';

function arg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const ingestion = app.get(IngestionService);
  const bank = arg('bank', 'tavan_mellat');
  const mode = arg('mode', 'nightly') === 'intraday' ? 'intraday' : 'nightly';
  const days = Number(arg('days', '0'));
  const explicitDay = arg('day', '');

  try {
    if (days > 0) {
      for (let i = days; i >= 1; i--) {
        const day = tehranJalali(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
        const result = await ingestion.runDay(bank, day, 'nightly');
        console.log('✅', JSON.stringify(result));
      }
    } else {
      const result = await ingestion.runDay(bank, explicitDay || undefined, mode);
      console.log('✅', JSON.stringify(result));
    }
  } catch (error) {
    console.error('❌', (error as any)?.message ?? error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
