/* CLI اجرای Ingestion:
   npm run ingest -- --bank=tavan_mellat --mode=nightly
   npm run ingest -- --mode=intraday
   npm run ingest -- --days=7                          (بکفیل ۷ روز قبل تا دیروز)
   npm run ingest -- --day=1405-08-19 --rebuild       (پاک کردن کامل آن روز و ساخت دوباره)
   npm run ingest -- --days=7 --rebuild               (بازسازی کامل ۷ روز)
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

/** پذیرش --flag، --flag=true و --flag=1؛ --flag=false خاموشش میکند. */
function flag(name: string): boolean {
  const prefix = `--${name}`;
  return process.argv.slice(2).some((a) => {
    if (a === prefix) return true;
    if (!a.startsWith(`${prefix}=`)) return false;
    return /^(true|1|yes)$/i.test(a.slice(prefix.length + 1));
  });
}

function help(): void {
  console.log(`استفاده: npm run ingest -- [گزینهها]

  --bank=KEY       tavan_mellat | tavan_resalat | tavan_postbank  (پیشفرض: tavan_mellat)
  --day=YYYY-MM-DD روز شمسی مورد نظر؛ بدون آن nightly = دیروز، intraday = امروز
  --mode=MODE      nightly (پیشفرض) | intraday
  --days=N         بکفیل N روز قبل تا دیروز (جای --day)
  --rebuild        ردیفهای همان روز را پیش از ورود پاک میکند و دوباره میسازد
  --help           همین راهنما

  --rebuild حتماً با --day یا --days همراه باشد. حذف و ورود مجدد در یک تراکنش است:
  اگر API در حین کار خراب شود، همهچیز برگردانده میشود و دادههای قدیمی سالم میمانند.
  اگر API برای آن روز هیچ رکوردی برنگرداند، پیش از هر حذفی اجرا لغو میشود.

مثالها:
  npm run ingest -- --bank=tavan_mellat --day=1405-08-19 --rebuild
  ./ingest.sh --bank=tavan_resalat --day=1405-08-19 --rebuild
  ./ingest.sh --days=7 --rebuild`);
}

(async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { help(); return; }
  const bank = arg('bank', 'tavan_mellat');
  const mode = arg('mode', 'nightly') === 'intraday' ? 'intraday' : 'nightly';
  const days = Number(arg('days', '0'));
  const explicitDay = arg('day', '');
  const rebuild = flag('rebuild');

  if (rebuild && !explicitDay && !(days > 0)) {
    console.error('❌ --rebuild نیاز به --day=YYYY-MM-DD یا --days=N دارد (جلوگیری از پاک شدن ناخواستهٔ دیروز).');
    console.error('   مثال: ./ingest.sh --bank=tavan_mellat --day=1405-08-19 --rebuild');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const ingestion = app.get(IngestionService);

  try {
    if (days > 0) {
      for (let i = days; i >= 1; i--) {
        const day = tehranJalali(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
        const result = await ingestion.runDay(bank, day, 'nightly', { rebuild });
        console.log('✅', JSON.stringify(result));
      }
    } else {
      const result = await ingestion.runDay(bank, explicitDay || undefined, mode, { rebuild });
      console.log('✅', JSON.stringify(result));
    }
  } catch (error) {
    console.error('❌', (error as any)?.message ?? error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
})();
