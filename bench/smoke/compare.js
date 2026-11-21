'use strict';
const path = require('node:path');
const BACKEND = process.env.CE_BACKEND || path.join(__dirname, '..', '..', 'backend');
const urls = { v1: 'http://127.0.0.1:4571', v2: 'http://127.0.0.1:4572' };
// مهرهای زمانی زمان اجرا (updated_at/started_at/...) طبیعتاً بین دو پروسه فرق دارند
const TIME_KEYS = new Set(['generatedAt', 'updated_at', 'started_at', 'finished_at', 'created_at']);
const norm = (value) => JSON.stringify(value, (k, v) => (
  TIME_KEYS.has(k) && typeof v === 'string' ? '<ts>' : v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));

const cases = [];
for (const bank of ['tavan_mellat', 'tavan_resalat', 'tavan_postbank']) {
  cases.push(`/api/summary?bank=${bank}&from=1405-08-01&to=1405-09-30`);
  for (const q of [
    `type=all`, `type=slow`, `type=creditAlert`,
    `type=all&limit=10&offset=5`, `type=all&status=success`,
  ]) cases.push(`/api/list?bank=${bank}&from=1405-08-01&to=1405-09-30&${q}`);
}
cases.push('/api/banks');

(async () => {
  let failures = 0;
  for (const path of cases) {
    const [a, b] = await Promise.all(Object.values(urls).map((base) => fetch(base + path).then((r) => r.json())));
    const same = norm(a) === norm(b);
    if (!same) {
      failures += 1;
      console.log('❌', path);
      const A = norm(a); const B = norm(b);
      let i = 0; while (i < Math.min(A.length, B.length) && A[i] === B[i]) i++;
      console.log('   v1:', A.slice(Math.max(0, i - 80), i + 120));
      console.log('   v2:', B.slice(Math.max(0, i - 80), i + 120));
    } else {
      console.log('✅', path);
    }
  }
  console.log(failures ? `\n${failures} اختلاف` : '\nهمهٔ پاسخ‌های HTTP یکسان');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
