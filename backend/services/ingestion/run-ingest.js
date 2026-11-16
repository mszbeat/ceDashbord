#!/usr/bin/env node
/* CLI اجرای Ingestion روی backend (partFramework):
   npm run ingest -- --bank=tavan_mellat --mode=nightly
   npm run ingest -- --mode=intraday
   npm run ingest -- --days=7
   npm run ingest -- --day=1405-08-19 --rebuild
*/
'use strict';
const { createServices } = require('../container');
const { tehranJalali } = require('../utils/date');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function flag(name) {
  const prefix = `--${name}`;
  return process.argv.slice(2).some((a) => {
    if (a === prefix) return true;
    if (!a.startsWith(`${prefix}=`)) return false;
    return /^(true|1|yes)$/i.test(a.slice(prefix.length + 1));
  });
}

function help() {
  console.log(`استفاده: npm run ingest -- [گزینهها]

  --bank=KEY       tavan_mellat | tavan_resalat | tavan_postbank  (پیشفرض: tavan_mellat)
  --day=YYYY-MM-DD روز شمسی مورد نظر؛ بدون آن nightly = دیروز، intraday = امروز
  --mode=MODE      nightly (پیشفرض) | intraday
  --days=N         بکفیل N روز قبل تا دیروز (جای --day)
  --rebuild        ردیفهای همان روز را پیش از ورود پاک میکند و دوباره میسازد
  --help           همین راهنما`);
}

(async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    help();
    return;
  }
  const bank = arg('bank', 'tavan_mellat');
  const mode = arg('mode', 'nightly') === 'intraday' ? 'intraday' : 'nightly';
  const days = Number(arg('days', '0'));
  const explicitDay = arg('day', '');
  const rebuild = flag('rebuild');

  if (rebuild && !explicitDay && !(days > 0)) {
    console.error('❌ --rebuild نیاز به --day=YYYY-MM-DD یا --days=N دارد (جلوگیری از پاک شدن ناخواستهٔ دیروز).');
    process.exitCode = 1;
    return;
  }

  const services = createServices({ enableCron: false });
  try {
    if (days > 0) {
      for (let i = days; i >= 1; i--) {
        const day = tehranJalali(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
        const result = await services.ingestion.runDay(bank, day, 'nightly', { rebuild });
        console.log('✅', JSON.stringify(result));
      }
    } else {
      const result = await services.ingestion.runDay(bank, explicitDay || undefined, mode, { rebuild });
      console.log('✅', JSON.stringify(result));
    }
  } catch (error) {
    console.error('❌', error?.message ?? error);
    process.exitCode = 1;
  } finally {
    await services.close();
  }
})();
