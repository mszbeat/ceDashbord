#!/usr/bin/env node
/**
 * مقایسهٔ عددی دقیق: همان نمونهها یکبار با خط لولهٔ قدیمی
 * (scan → analyzeOne → bump) و یکبار با خط لولهٔ زنده
 * (normalizeSample → evaluate → DB → consumeRow → bump) تحلیل میشوند.
 *
 * اجرا: node scripts/numeric-parity.js   (بعد از npm run build)
 */
'use strict';
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const LEGACY = path.join(ROOT, 'src', 'evaluator', 'legacy', 'src');
const { loadBanks } = require(path.join(LEGACY, 'banks'));
const { scan } = require(path.join(LEGACY, 'scan'));
const { analyze } = require(path.join(LEGACY, 'analyze'));
const { quantile } = require(path.join(ROOT, 'src', 'legacy-report', 'render'));
const { EvaluatorService } = require(path.join(ROOT, 'dist', 'evaluator', 'evaluator.service'));
const { SummaryService } = require(path.join(ROOT, 'dist', 'summary', 'summary.service'));

const DAY = '1405-08-19';
const clone = (v) => JSON.parse(JSON.stringify(v));
const base = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '..', 'ceDashbord', 'samples', 'mellat.json'), 'utf8'));

function makeSamples(count) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const s = clone(base);
    s.requestId = `parity-${String(i).padStart(4, '0')}`;
    s.input.uniqueKey = `uk-${i}`;
    s.insertDate_full = `14050819${String(4 + (i % 20)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}${String((i * 7) % 60).padStart(2, '0')}001`;
    s.output.Credit_Basket = 11_000_000 + (i * 123_457) % 489_000_000;
    s.output.PD = Number((0.01 + (i % 75) / 100).toFixed(4));
    s.output.total_time = Number((0.01 + (i % 811) / 100).toFixed(2));
    s.output.Tavan_Baz_Pardakht = {
      Excellent: { max: 62_000_000 + i }, Very_Good: { max: 93_000_000 + i },
      Good: { max: 111_000_000 + i }, Medium_Good: { max: 124_000_000 + i },
      Medium: { max: 161_000_000 + i }, Medium_Bad: { max: 198_000_000 + i },
      Bad: { max: 223_000_000 + i }, Very_Bad: { max: 223_000_000 + i },
    };
    const items = new Array(i % 8).fill(null).map((_, k) => ({ AmOriginal: 1000 + k, AmBenefit: 100, AmBedehiKol: 900 + k,
      AmMoavagh: 0, AmSarResid: 0, AmMashkuk: 0, bankCode: 'IRR', BankCode: 1 }));
    s.input.data.samatFacilities = i % 11 === 0 ? { TashilatItem: null }
      : { TashilatItem: items.length === 1 ? items[0] : items };
    // پیامهای قالبی شناختهشده تا متنشان دقیقاً با message_dict یکی باشد.
    s.output.message = i % 9 === 0
      ? { fa: 'شناسه یکتا تکراری است!', en: 'duplicate UniqueKey!' }
      : { fa: 'درخواست اعتبارسنجی با موفقیت انجام شد.', en: 'Validation was successful.' };
    samples.push(s);
  }
  return samples;
}

function statsOf(group) {
  const out = {};
  for (const [id, values] of Object.entries(group.metrics || {})) {
    const sorted = [...values].sort((a, b) => a - b);
    out[id] = {
      count: sorted.length,
      min: sorted[0] ?? null,
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
      p75: quantile(sorted, 0.75),
      max: sorted.length ? sorted[sorted.length - 1] : null,
    };
  }
  return out;
}

const UPSERT_COLUMNS = [
  'request_id', 'day', 'inserted_at', 'stamp_key', 'unique_key', 'is_success', 'model_name', 'status_code',
  'error_code', 'message_key', 'total_time_s', 'pd', 'suggested_amount', 'amount_kind', 'score_req',
  'credit_basket', 'avg36', 'ln_avg_installments', 'rotbe', 'flags', 'cats', 'counters', 'metrics',
  'paths', 'services', 'credit_alerts', 'display_extras', 'analysis_version',
];
const JSON_COLUMNS = new Set(['flags', 'cats', 'counters', 'metrics', 'paths', 'services', 'credit_alerts', 'display_extras']);

(async () => {
  const samples = makeSamples(Number(process.env.PARITY_N || 120));
  // reportProcess.js قدیمی پیش از نوشتن فایلها applyAiInput/Output را اجرا میکند؛
  // برای مقایسهٔ منصفانه همان نمونههای نرمالشده به هر دو مسیر داده میشود.
  const normalizer = new EvaluatorService();
  const processed = samples.map((s) => normalizer.normalizeSample(s));

  // ۱) مسیر قدیمی
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-parity-'));
  const okDir = path.join(tmp, DAY, 'success'), failDir = path.join(tmp, DAY, 'fail');
  fs.mkdirSync(okDir, { recursive: true }); fs.mkdirSync(failDir, { recursive: true });
  const evaluatorForSplit = new EvaluatorService();
  const success = [], fail = [];
  for (const s of processed) (evaluatorForSplit.isReportSuccess(s) ? success : fail).push(s);
  fs.writeFileSync(path.join(okDir, '1.json'), JSON.stringify(success));
  fs.writeFileSync(path.join(failDir, '1.json'), JSON.stringify(fail));
  const banks = loadBanks({ minNull: 3 });
  const scanned = scan(tmp, banks);
  const legacyData = analyze(scanned, { rowsCap: 100 });
  const legacy = {
    group: legacyData.groups.ALL,
    metrics: statsOf(legacyData.groups.ALL),
    ranges: legacyData.ranges,
    processedSamples: legacyData.processedSamples,
  };

  // ۲) مسیر جدید
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  const evaluator = new EvaluatorService();
  const templates = new Map();
  const rows = processed.map((normalized) => {
    const ok = evaluator.isReportSuccess(normalized);
    const template = evaluator.messageTemplateOf(normalized, ok);
    if (template) templates.set(template.key, template.text);
    return evaluator.evaluate(normalized, ok, DAY, 'tavan_mellat');
  });
  const values = [], params = [];
  rows.forEach((row, index) => {
    const offset = index * UPSERT_COLUMNS.length;
    values.push(`(${UPSERT_COLUMNS.map((_, i) => `$${offset + i + 1}`).join(',')})`);
    for (const c of UPSERT_COLUMNS) params.push(JSON_COLUMNS.has(c) && row[c] != null ? JSON.stringify(row[c]) : row[c]);
  });
  await pg.query(`INSERT INTO samples_mellat (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
  if (templates.size) await pg.query(
    `INSERT INTO message_dict(message_key, label, topic, message_text)
     SELECT k, k, 'other', t FROM unnest($1::text[], $2::text[]) AS x(k, t)
     ON CONFLICT (message_key) DO UPDATE SET message_text=EXCLUDED.message_text`,
    [[...templates.keys()], [...templates.values()]],
  );
  const db = {
    async query(text, p = []) {
      const r = await pg.query(text, p);
      return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows || []).length };
    },
    async getClient() { return { query: this.query.bind(this), release() {} }; },
  };
  const svc = new SummaryService(db, evaluator);
  const live = await svc.summary('tavan_mellat', DAY, DAY);
  const liveHtml = await svc.report('tavan_mellat', DAY, DAY);

  // ۳) مقایسه
  const problems = [];
  const close = (a, b) => (a === b) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);
  const legacyMetricIds = Object.keys(legacy.metrics).sort();
  const liveMetricIds = Object.keys(live.metrics).sort();
  if (legacyMetricIds.join('|') !== liveMetricIds.join('|')) {
    problems.push(`فهرست شاخصها فرق دارد: قدیم=${legacyMetricIds.join(',')} جدید=${liveMetricIds.join(',')}`);
  }
  for (const id of legacyMetricIds) {
    const a = legacy.metrics[id], b = live.metrics[id];
    if (!b) { problems.push(`شاخص ${id} در جدید وجود ندارد`); continue; }
    for (const key of ['count', 'min', 'p25', 'median', 'mean', 'p75', 'max']) {
      if (!close(a[key], b[key])) problems.push(`${id}.${key}: قدیم=${a[key]} جدید=${b[key]}`);
    }
  }
  const built = await svc.buildDashboard('tavan_mellat', DAY, DAY, 100);
  const liveGroup = built.data.groups.ALL;
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
    return value;
  };
  for (const key of ['flags', 'cats', 'catTotals', 'counters', 'services', 'paths']) {
    const a = JSON.stringify(canonical(legacy.group[key] ?? {}));
    const b = JSON.stringify(canonical(liveGroup[key] ?? {}));
    if (a !== b) {
      const aa = legacy.group[key] ?? {}, bb = liveGroup[key] ?? {};
      const diffs = [...new Set([...Object.keys(aa), ...Object.keys(bb)])]
        .filter((k) => JSON.stringify(aa[k]) !== JSON.stringify(bb[k]))
        .slice(0, 6).map((k) => `${k}: قدیم=${JSON.stringify(aa[k])} جدید=${JSON.stringify(bb[k])}`);
      problems.push(`گروه ${key} فرق دارد → ${diffs.join(' | ')} (ترتیب کلیدها نادیده گرفته شد)`);
    }
  }
  if (legacy.group.total !== liveGroup.total) problems.push(`total: قدیم=${legacy.group.total} جدید=${liveGroup.total}`);
  if (legacy.group.byStatus.success !== liveGroup.byStatus.success || legacy.group.byStatus.fail !== liveGroup.byStatus.fail) {
    problems.push(`byStatus: قدیم=${JSON.stringify(legacy.group.byStatus)} جدید=${JSON.stringify(liveGroup.byStatus)}`);
  }
  const first = liveHtml.match(/<span>اولین درخواست<\/span><b[^>]*>([^<]*)<\/b>/);
  const last = liveHtml.match(/<span>آخرین درخواست<\/span><b[^>]*>([^<]*)<\/b>/);
  // ۴) اگر display_extras.stamp پاک شود، باز هم زمان از inserted_at ساخته شود.
  await pg.query(`UPDATE samples_mellat SET display_extras = display_extras - 'stamp' WHERE request_id = $1`, [rows[0].request_id]);
  const fallbackHtml = await svc.report('tavan_mellat', DAY, DAY);
  const fallbackTime = /<span>اولین درخواست<\/span><b[^>]*>([^<]*)<\/b>/.exec(fallbackHtml)?.[1] || '';
  if (!fallbackTime.includes(':')) problems.push(`بازسازی ساعت از inserted_at کار نکرد: ${fallbackTime}`);

  const report = {
    samples: samples.length,
    legacyProcessed: legacy.processedSamples,
    liveTotal: live.stats.total,
    legacyRanges: { first: legacy.ranges.first?.display, last: legacy.ranges.last?.display },
    liveRanges: { first: first?.[1], last: last?.[1] },
    metricIds: legacyMetricIds.length,
    fallbackTime,
    problems,
  };
  console.log(JSON.stringify(report, null, 2));
  if (problems.length || !report.liveRanges.first?.includes(':')) process.exitCode = 1;
  fs.rmSync(tmp, { recursive: true, force: true });
  await pg.close();

})().catch((error) => { console.error(error); process.exit(1); });
