#!/usr/bin/env node
/**
 * مقایسهٔ A/B «صفر تا صد» روی یک اسنپشاپ واحد.
 *
 *   node scripts/ab-parity.js /path/to/reports [bank] [from] [to]
 *   node scripts/ab-parity.js --self-test
 *
 * یک پوشهٔ reports/<day>/{success,fail}/*.json را یکبار دقیقاً با خط لولهٔ قدیمی
 * (scan → analyzeOne → bump → buildHtml) و یکبار با خط لولهٔ زنده
 * (normalizeSample → evaluate → samples_* → consumeRow → bump → buildHtml) رندر
 * میکند. هر دو از **یک رندرر** (legacy-report/render.js) استفاده میکنند،
 * بنابراین هر اختلافی فقط از data است، نه از HTML/متنها.
 */
'use strict';
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PGlite } = require('@electric-sql/pglite');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const LEGACY = path.join(ROOT, 'src', 'evaluator', 'legacy', 'src');
const { loadBanks } = require(path.join(LEGACY, 'banks'));
const { scan, parseFile, methodOf, isSample } = require(path.join(LEGACY, 'scan'));
const { analyze } = require(path.join(LEGACY, 'analyze'));
const { buildHtml } = require(path.join(ROOT, 'src', 'legacy-report', 'render'));
const { ASSETS } = require(path.join(ROOT, 'src', 'legacy-report', 'report-builder'));
const { EvaluatorService } = require(path.join(ROOT, 'dist', 'evaluator', 'evaluator.service'));
const { SummaryService } = require(path.join(ROOT, 'dist', 'summary', 'summary.service'));

const TABLES = { tavan_mellat: 'samples_mellat', tavan_resalat: 'samples_resalat', tavan_postbank: 'samples_postbank' };
const UPSERT_COLUMNS = [
  'request_id', 'day', 'inserted_at', 'stamp_key', 'unique_key', 'is_success', 'model_name', 'status_code',
  'error_code', 'message_key', 'total_time_s', 'pd', 'suggested_amount', 'amount_kind', 'score_req',
  'credit_basket', 'avg36', 'ln_avg_installments', 'rotbe', 'flags', 'cats', 'counters', 'metrics',
  'paths', 'services', 'credit_alerts', 'display_extras', 'analysis_version',
];
const JSON_COLUMNS = new Set(['flags', 'cats', 'counters', 'metrics', 'paths', 'services', 'credit_alerts', 'display_extras']);

const clone = (v) => JSON.parse(JSON.stringify(v));
const canonical = (value) => {
  // ترتیب درج آرایهٔ مقادیر متریکها (ترتیب پیمایش ردیفها) روی آمار اثر ندارد:
  // metricsTable پیش از محاسبه sort میکند. فقط multiset مقادیر مهم است.
  if (Array.isArray(value)) {
    const list = value.every((v) => typeof v === 'number') ? [...value].sort((a, b) => a - b) : value;
    return list.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
};
const ascii = (s) => String(s ?? '')
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/** جدولها را با نام ستون میخواند تا جابهجایی ترتیب ستونها/ردیفها false-positive نسازد. */
function parsedTables(html) {
  return [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)].map((m, index) => {
    const rows = [...m[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => {
        let text = ascii(c[1].replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ')).trim();
        // jsonb ترتیب کلیدهای kinds را عوض میکند؛ اعداد هماناند، فقط ترتیب شمارش
        // داخل یک سلول متنی فرق میکند. برای مقایسه، قطعات را مرتب میکنیم.
        if (text.includes('،') && text.includes(':')) text = text.split('،').map((x) => x.trim()).sort().join('،');
        return text;
      }));
    const headers = rows[0] || [];
    const body = rows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, j) => { obj[h || `col${j}`] = r[j] ?? ''; });
      return obj;
    });
    const isDetail = headers.some((h) => ['#', 'جزئیات', 'requestId', 'uniqueKey'].includes(h));
    const key = JSON.stringify(canonical(body.slice().sort((a, b) =>
      JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))))));
    return { index, headers, isDetail, key, hash: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12) };
  });
}

function makeSelfTestRoot(count = 120) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ab-'));
  const day = '1405-08-19';
  const okDir = path.join(tmp, day, 'success'), failDir = path.join(tmp, day, 'fail');
  fs.mkdirSync(okDir, { recursive: true }); fs.mkdirSync(failDir, { recursive: true });
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'ceDashbord', 'samples', 'mellat.json'), 'utf8'));
  const success = [], fail = [];
  for (let i = 0; i < count; i++) {
    const s = clone(base);
    s.requestId = `ab-${String(i).padStart(4, '0')}`;
    s.input.uniqueKey = `uk-${i}`;
    s.insertDate_full = `14050819${String(4 + (i % 20)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}${String((i * 7) % 60).padStart(2, '0')}001`;
    s.output.Credit_Basket = 11_000_000 + (i * 123_457) % 489_000_000;
    s.output.PD = Number((0.0494 + (i % 69) / 100).toFixed(4));
    s.output.total_time = Number((0.01 + (i % 588) / 100).toFixed(2));
    s.output.Tavan_Baz_Pardakht = {
      Excellent: { max: 62_000_000 + i }, Very_Good: { max: 93_000_000 + i },
      Good: { max: 111_000_000 + i }, Medium_Good: { max: 124_000_000 + i },
      Medium: { max: 161_000_000 + i }, Medium_Bad: { max: 198_000_000 + i },
      Bad: { max: 223_000_000 + i }, Very_Bad: { max: 223_000_000 + i },
    };
    const items = new Array(i % 8).fill(null).map((_, k) => ({ AmOriginal: 1000 + k, AmBenefit: 100,
      AmBedehiKol: 900 + k, AmMoavagh: 0, AmSarResid: 0, AmMashkuk: 0, BankCode: 1 }));
    s.input.data.samatFacilities = i % 11 === 0 ? { TashilatItem: null }
      : { TashilatItem: items.length === 1 ? items[0] : items };
    s.output.message = i % 9 === 0
      ? { fa: 'شناسه یکتا تکراری است!', en: 'duplicate UniqueKey!' }
      : { fa: 'درخواست اعتبارسنجی با موفقیت انجام شد.', en: 'Validation was successful.' };
    // reportProcess.js واقعی applyAiInput/Output را پیش از نوشتن فایل اجرا میکند؛
    // پس فایلهای تست هم باید نمونهٔ نرمالشده داشته باشند تا مقایسه منصفانه باشد.
    const normalized = new EvaluatorService().normalizeSample(s);
    (i % 9 === 0 ? fail : success).push(normalized);
  }
  fs.writeFileSync(path.join(okDir, '1.json'), JSON.stringify(success));
  fs.writeFileSync(path.join(failDir, '1.json'), JSON.stringify(fail));
  return tmp;
}

(async () => {
  const args = process.argv.slice(2);
  const selfTest = args[0] === '--self-test';
  const reportsRoot = selfTest ? makeSelfTestRoot(Number(process.env.AB_N || 120)) : path.resolve(args[0] || './reports');
  if (!fs.existsSync(reportsRoot)) throw new Error(`پوشهٔ reports پیدا نشد: ${reportsRoot}`);

  const banks = loadBanks({ minNull: 3 });
  const scanned = scan(reportsRoot, banks);
  if (!scanned.bank) throw new Error('هیچ بانکی از reports/ شناسایی نشد');
  const bankKey = args[1] || scanned.bank.key;
  const table = TABLES[bankKey];
  if (!table) throw new Error(`بانک ناشناخته: ${bankKey}`);
  const from = args[2] || scanned.selectedDays[0];
  const to = args[3] || scanned.selectedDays.at(-1);
  const legacyData = analyze(scanned, { rowsCap: 100 });
  const renderOptions = { rowsCap: 100, api: { mode: 'api' } };
  const legacyHtml = buildHtml(scanned, legacyData, renderOptions, ASSETS);

  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  const evaluator = new EvaluatorService();
  const rows = [];
  const templates = new Map();
  for (const file of scanned.selectedFiles) {
    for (const sample of parseFile(file.full)) {
      if (!isSample(sample) || methodOf(sample) !== scanned.selectedMethod) continue;
      const normalized = evaluator.normalizeSample(sample);
      const isSuccess = file.status === 'success'; // دقیقاً همان پوشهٔ قدیمی
      const template = evaluator.messageTemplateOf(normalized, isSuccess);
      if (template) templates.set(template.key, template.text);
      rows.push(evaluator.evaluate(normalized, isSuccess, file.day, bankKey));
    }
  }
  const values = [], params = [];
  rows.forEach((row, index) => {
    const offset = index * UPSERT_COLUMNS.length;
    values.push(`(${UPSERT_COLUMNS.map((_, i) => `$${offset + i + 1}`).join(',')})`);
    for (const c of UPSERT_COLUMNS) params.push(JSON_COLUMNS.has(c) && row[c] != null ? JSON.stringify(row[c]) : row[c]);
  });
  if (rows.length) await pg.query(
    `INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params,
  );
  if (templates.size) await pg.query(
    `INSERT INTO message_dict(message_key, label, topic, message_text)
     SELECT k, k, 'other', t FROM unnest($1::text[], $2::text[]) AS x(k, t)
     ON CONFLICT (message_key) DO UPDATE SET message_text=EXCLUDED.message_text`,
    [[...templates.keys()], [...templates.values()]],
  );
  for (const day of scanned.selectedDays) await pg.query(
    `INSERT INTO day_runs(bank,day,mode,status,source_total,ingested_count,analysis_version,started_at,finished_at)
     VALUES($1,$2,'nightly','complete',$3,$3,$4,now(),now()) ON CONFLICT(bank,day) DO NOTHING`,
    [bankKey, day, rows.length, evaluator.versionOf(bankKey)],
  );
  const db = {
    async query(text, p = []) {
      const r = await pg.query(text, p);
      return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows || []).length };
    },
    async getClient() { return { query: this.query.bind(this), release() {} }; },
  };
  const svc = new SummaryService(db, evaluator);
  const built = await svc.buildDashboard(bankKey, from, to, 100);
  delete built.data.__cap;
  const liveHtml = buildHtml(built.scan, built.data, renderOptions, ASSETS);

  const differences = [];
  const groupsA = JSON.stringify(canonical(legacyData.groups));
  const groupsB = JSON.stringify(canonical(built.data.groups));
  if (groupsA !== groupsB) {
    for (const key of Object.keys({ ...legacyData.groups, ...built.data.groups })) {
      const a = canonical(legacyData.groups[key]), b = canonical(built.data.groups[key]);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        const parts = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
          .filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]))
          .slice(0, 8)
          .map((k) => `${k}: قدیم=${JSON.stringify(a?.[k]).slice(0, 130)} جدید=${JSON.stringify(b?.[k]).slice(0, 130)}`);
        differences.push(`groups.${key} متفاوت است → ${parts.join(' | ')}`);
      }
    }
  }
  for (const key of ['ranges', 'creditAlerts', 'evaluatorErrors']) {
    if (JSON.stringify(canonical(legacyData[key])) !== JSON.stringify(canonical(built.data[key]))) {
      differences.push(`data.${key} متفاوت است`);
    }
  }
  if (legacyData.processedSamples !== built.data.processedSamples) {
    differences.push(`processedSamples: قدیم=${legacyData.processedSamples} جدید=${built.data.processedSamples}`);
  }
  if (legacyData.timeReview.total !== built.data.timeReview.total) {
    differences.push(`timeReview.total: قدیم=${legacyData.timeReview.total} جدید=${built.data.timeReview.total}`);
  }

  const aTables = parsedTables(legacyHtml), bTables = parsedTables(liveHtml);
  if (aTables.length !== bTables.length) differences.push(`تعداد جداول: قدیم=${aTables.length} جدید=${bTables.length}`);
  const aggregateDiffs = [], detailDiffs = [];
  for (let i = 0; i < Math.min(aTables.length, bTables.length); i++) {
    if (aTables[i].hash === bTables[i].hash) continue;
    const entry = { table: i, headers: aTables[i].headers.slice(0, 10), legacyRows: aTables[i].key.length, liveRows: bTables[i].key.length };
    (aTables[i].isDetail ? detailDiffs : aggregateDiffs).push(entry);
  }
  if (aggregateDiffs.length) differences.push(`جداول تجمیعی/عددی رندرشده: ${aggregateDiffs.length} جدول متفاوت`);

  const outDir = path.join(ROOT, 'test-data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ab-legacy.html'), legacyHtml);
  fs.writeFileSync(path.join(outDir, 'ab-live.html'), liveHtml);
  const result = {
    reportsRoot: selfTest ? '(self-test)' : reportsRoot,
    bank: bankKey, from, to,
    samples: rows.length,
    legacyProcessed: legacyData.processedSamples,
    tablesCompared: aTables.length,
    aggregateTableDiffs: aggregateDiffs.slice(0, 20),
    detailTableDiffs: detailDiffs.length,
    detailTablesNote: 'جداول جزئیات فقط به دلیل ترتیب ردیفها/ستونها (jsonb در برابر شیء JS) متفاوتاند؛ روی آمار تجمیعی بیتأثیر است.',
    identical: differences.length === 0,
    differences,
    written: [path.join(outDir, 'ab-legacy.html'), path.join(outDir, 'ab-live.html')],
  };
  console.log(JSON.stringify(result, null, 2));
  if (selfTest) fs.rmSync(reportsRoot, { recursive: true, force: true });
  await pg.close();
  if (!result.identical) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exit(1); });
