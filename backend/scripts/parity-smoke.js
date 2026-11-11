#!/usr/bin/env node
/* تست تطبیق صفحهٔ زنده برای هر سه بانک: evaluator + buildHtml قدیمی، ورودی از DB شبیهسازیشده. */
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const { EvaluatorService } = require('../dist/evaluator/evaluator.service');
const { SummaryService } = require('../dist/summary/summary.service');

const SAMPLES = {
  tavan_mellat: process.env.CE_MELLAT_SAMPLE || '/home/user/ceDashbord/samples/mellat.json',
  tavan_resalat: process.env.CE_RESALAT_SAMPLE || '/home/user/ceDashbord/samples/s.json',
  tavan_postbank: process.env.CE_POSTBANK_SAMPLE || '/home/user/ceDashbord/samples/postbank.json',
};
const TABLES = {
  tavan_mellat: 'samples_mellat',
  tavan_resalat: 'samples_resalat',
  tavan_postbank: 'samples_postbank',
};
const GOLDEN_PATH = process.env.CE_GOLDEN || '/home/user/ceDashbord/report.html';
const OUT_DIR = process.env.CE_SMOKE_OUT_DIR || path.join(__dirname, '..', 'test-data');

const dict = [
  ['MSG_VALIDATION_SUCCESS', 'درخواست اعتبارسنجی با موفقیت انجام شد.\nValidation was successful.'],
  ['MSG_HISTORY_NOT_ENOUGH', 'اطلاعات تاریخچه اعتباری شما کافی نیست.\nYour historical data is not enough.'],
  ['MSG_OVERDUE_DEBT', 'شما در حال حاضر بدهی معوق دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.\nYou currently have overdue debt.please improve your credit behavior and try again.'],
  ['MSG_BOUNCED_CHECK', 'شما همچنان چک برگشتی دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.\nYou still have bounced check. please improve your credit behavior and try again.'],
  ['MSG_DUPLICATE_UNIQUE_KEY', 'شناسه یکتا تکراری است!\nduplicate UniqueKey!'],
  ['MSG_UNKNOWN', 'سایر پیامها'],
].map(([message_key, text]) => ({ message_key, text }));

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makeRows(evaluator, bankKey, file) {
  const day = '1405-08-18';
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const success = clone(base);
  success.requestId = `${bankKey}-11111111-1111-1111-1111-111111111111`;
  if (success.input && typeof success.input === 'object') success.input.uniqueKey = 'uk-success-1';
  success.insertDate_full = '14050818100000001';

  const fail = clone(base);
  fail.requestId = `${bankKey}-22222222-2222-2222-2222-222222222222`;
  if (fail.input && typeof fail.input === 'object') fail.input.uniqueKey = 'uk-fail-1';
  fail.insertDate_full = '14050818110000002';
  fail.output.message = { fa: 'شناسه یکتا تکراری است!', en: 'duplicate UniqueKey!' };
  fail.output.statusCode = '500';
  fail.output.meta = { code: 'duplicate UniqueKey!' };

  const second = clone(base);
  second.requestId = `${bankKey}-33333333-3333-3333-3333-333333333333`;
  if (second.input && typeof second.input === 'object') second.input.uniqueKey = 'uk-success-2';
  second.insertDate_full = '14050818120000003';
  if (second.output) {
    second.output.PD = second.output.PD ?? 0.5;
    second.output.total_time = 4.25;
  }

  return [success, fail, second].map((raw) => {
    const sample = evaluator.normalizeSample(raw);
    const ok = evaluator.isReportSuccess(sample);
    return evaluator.evaluate(sample, ok, day, bankKey);
  }).sort((a, b) => String(a.stamp_key).localeCompare(String(b.stamp_key)));
}

function fakeDb(rowsByTable) {
  const served = new Set();
  const runRows = Object.keys(TABLES).map((bank) => ({ bank, day: '1405-08-18', mode: 'nightly',
    status: 'complete', updated_at: new Date().toISOString() }));
  const tableOf = (sql) => {
    const match = sql.match(/FROM (samples_\w+)/);
    return match ? match[1] : null;
  };
  return {
    async query(sql, params = []) {
      const table = tableOf(sql);
      if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total: rowsByTable[table]?.length ?? 0 }], rowCount: 1 };
      if (/SELECT DISTINCT day/.test(sql)) return { rows: [{ day: '1405-08-18' }], rowCount: 1 };
      if (/FROM day_runs/.test(sql)) {
        const bank = params[0];
        const rows = bank ? runRows.filter((r) => r.bank === bank) : runRows;
        return { rows, rowCount: rows.length };
      }
      if (/FROM message_dict/.test(sql)) return { rows: dict, rowCount: dict.length };
      if (/SELECT \* FROM samples_\w+/.test(sql)) {
        if (served.has(table)) return { rows: [], rowCount: 0 };
        served.add(table);
        const rows = rowsByTable[table] || [];
        return { rows, rowCount: rows.length };
      }
      if (/SELECT \* FROM day_runs ORDER BY/.test(sql)) return { rows: runRows, rowCount: runRows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

const sectionIds = (text) => [...text.matchAll(/id="panel-([\w-]+)"/g)].map((m) => m[1]);

(async () => {
  const evaluator = new EvaluatorService();
  const rowsByTable = {};
  for (const [bankKey, table] of Object.entries(TABLES)) {
    rowsByTable[table] = makeRows(evaluator, bankKey, SAMPLES[bankKey]);
  }
  const svc = new SummaryService(fakeDb(rowsByTable), evaluator);
  const golden = fs.existsSync(GOLDEN_PATH) ? fs.readFileSync(GOLDEN_PATH, 'utf8') : '';
  const goldenSections = golden ? sectionIds(golden) : [];
  const results = {};

  for (const [bankKey, table] of Object.entries(TABLES)) {
    const html = await svc.report(bankKey, '1405-08-18', '1405-08-18', 100);
    const out = path.join(OUT_DIR, `live-parity-${bankKey}.html`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(out, html, 'utf8');
    results[bankKey] = {
      out,
      htmlBytes: html.length,
      doctype: html.startsWith('<!doctype html><html lang="fa" dir="rtl">'),
      style: html.includes('color-scheme: light') && html.includes('.ce-live-bar'),
      viewer: html.includes('window.renderSampleViewer'),
      client: html.includes('data-scope="ALL"') && html.includes('themeToggle'),
      apiMode: html.includes('"mode":"api"'),
      apiSampleFetch: html.includes('/api/sample/'),
      noPrivateFile: !html.includes('__CE_DASHBOARD_PRIVATE__') && !html.includes('reports/_ce-dashboard-private'),
      noOfflineCapText: !html.includes('MAX_ROWS') && !html.includes('HTML را دوباره بسازید'),
      controls: html.includes('id="ce-live-controls"') && html.includes('name="bank"')
        && html.includes('value="tavan_mellat"') && html.includes('value="tavan_resalat"') && html.includes('value="tavan_postbank"'),
      sidRequestId: html.includes(`data-sid="${bankKey}-11111111-1111-1111-1111-111111111111"`),
      sections: sectionIds(html),
      messageRestored: html.includes('Validation was successful.') || html.includes('Your historical data is not enough.')
        || html.includes('You currently have overdue debt.')
        || html.includes('duplicate UniqueKey!'),
      dailyPanel: html.includes('panel-daily'),
    };
    if (bankKey === 'tavan_resalat' && goldenSections.length) {
      results[bankKey].sectionsMatchGolden = JSON.stringify(results[bankKey].sections) === JSON.stringify(goldenSections);
      results[bankKey].featuresPanel = html.includes('panel-features');
    }
  }

  console.log(JSON.stringify(results, null, 2));
  const required = ['doctype', 'style', 'viewer', 'client', 'apiMode', 'apiSampleFetch',
    'noPrivateFile', 'noOfflineCapText', 'controls', 'sidRequestId', 'messageRestored', 'dailyPanel'];
  const failed = [];
  for (const [bankKey, check] of Object.entries(results)) {
    for (const key of required) if (!check[key]) failed.push(`${bankKey}.${key}`);
    if (bankKey === 'tavan_resalat' && goldenSections.length) {
      if (!check.sectionsMatchGolden) failed.push('tavan_resalat.sectionsMatchGolden');
      if (!check.featuresPanel) failed.push('tavan_resalat.featuresPanel');
    }
  }
  if (failed.length) { console.error('❌ تست تطبیق ناموفق:', failed.join(', ')); process.exit(1); }
  console.log('✅ تست تطبیق صفحهٔ زنده برای هر سه بانک موفق:', OUT_DIR);
})().catch((error) => { console.error(error); process.exit(1); });
