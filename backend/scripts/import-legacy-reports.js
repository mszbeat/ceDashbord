#!/usr/bin/env node
/**
 * وارد کردن دقیق همان فایلهای reports/ نسخهٔ قدیمی به دیتابیس زنده،
 * تا دو خروجی از «یک اسنپشاپ» ساخته شوند و مقایسه معنیدار باشد.
 *
 *   node scripts/import-legacy-reports.js /path/to/reports [bank] [--dry-run] [--rebuild]
 *
 * متغیر DATABASE_URL از backend/.env خوانده میشود. نمونها از قبل توسط
 * reportProcess.js نرمال شدهاند؛ این اسکریپت فقط همانها را ارزیابی و UPSERT میکند.
 */
'use strict';
require('reflect-metadata');
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const LEGACY = path.join(ROOT, 'src', 'evaluator', 'legacy', 'src');
const { loadBanks } = require(path.join(LEGACY, 'banks'));
const { scan, parseFile, methodOf, isSample } = require(path.join(LEGACY, 'scan'));
const { EvaluatorService } = require(path.join(ROOT, 'dist', 'evaluator', 'evaluator.service'));

const TABLES = { tavan_mellat: 'samples_mellat', tavan_resalat: 'samples_resalat', tavan_postbank: 'samples_postbank' };
const UPSERT_COLUMNS = [
  'request_id', 'day', 'inserted_at', 'stamp_key', 'unique_key', 'is_success', 'model_name', 'status_code',
  'error_code', 'message_key', 'total_time_s', 'pd', 'suggested_amount', 'amount_kind', 'score_req',
  'credit_basket', 'avg36', 'ln_avg_installments', 'rotbe', 'flags', 'cats', 'counters', 'metrics',
  'paths', 'services', 'credit_alerts', 'display_extras', 'analysis_version',
];
const JSON_COLUMNS = new Set(['flags', 'cats', 'counters', 'metrics', 'paths', 'services', 'credit_alerts', 'display_extras']);

(async () => {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const rebuild = args.includes('--rebuild') || args.includes('--rebuild=true');
  const root = path.resolve(positional[0] || './reports');
  if (!fs.existsSync(root)) throw new Error(`پوشهٔ reports پیدا نشد: ${root}`);
  const scanned = scan(root, loadBanks({ minNull: 3 }));
  if (!scanned.bank) throw new Error('هیچ بانکی شناسایی نشد');
  const bankKey = TABLES[positional[1]] ? positional[1] : scanned.bank.key;
  const table = TABLES[bankKey];
  if (!table) throw new Error(`بانک ناشناخته: ${bankKey}`);

  const evaluator = new EvaluatorService();
  const rows = [];
  const templates = new Map();
  for (const file of scanned.selectedFiles) {
    for (const sample of parseFile(file.full)) {
      if (!isSample(sample) || methodOf(sample) !== scanned.selectedMethod) continue;
      const normalized = evaluator.normalizeSample(sample);
      const isSuccess = file.status === 'success'; // همان پوشهٔ success/fail قدیمی
      const template = evaluator.messageTemplateOf(normalized, isSuccess);
      if (template) templates.set(template.key, template.text);
      rows.push(evaluator.evaluate(normalized, isSuccess, file.day, bankKey));
    }
  }
  console.log(JSON.stringify({
    reportsRoot: root, bank: bankKey, days: scanned.selectedDays,
    files: scanned.selectedFiles.length, samples: rows.length, dryRun, rebuild,
  }, null, 2));
  if (dryRun || !rows.length) return;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (rebuild) {
      // حذف و ورود در یک تراکنش: خرابی نیمهراه دادههای قبلی را خراب نمیکند.
      await client.query('BEGIN');
      const removed = await client.query(`DELETE FROM ${table} WHERE day = ANY($1::text[])`, [scanned.selectedDays]);
      await client.query(`DELETE FROM day_runs WHERE bank=$1 AND day = ANY($2::text[])`, [bankKey, scanned.selectedDays]);
      console.log(`  🧹 --rebuild: ${removed.rowCount} ردیف قدیمی حذف شد (${scanned.selectedDays.join(', ')})`);
    }
    const chunkSize = 100;
    for (let start = 0; start < rows.length; start += chunkSize) {
      const chunk = rows.slice(start, start + chunkSize);
      const values = [], params = [];
      chunk.forEach((row, index) => {
        const offset = index * UPSERT_COLUMNS.length;
        values.push(`(${UPSERT_COLUMNS.map((_, i) => `$${offset + i + 1}`).join(',')})`);
        for (const c of UPSERT_COLUMNS) params.push(JSON_COLUMNS.has(c) && row[c] != null ? JSON.stringify(row[c]) : row[c]);
      });
      const updates = UPSERT_COLUMNS.filter((c) => c !== 'request_id')
        .map((c) => `${c}=EXCLUDED.${c}`).join(', ');
      await client.query(
        `INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}
         ON CONFLICT (request_id) DO UPDATE SET ${updates}, updated_at=now()`, params,
      );
      console.log(`  ⬆ ${Math.min(start + chunkSize, rows.length)}/${rows.length}`);
    }
    if (templates.size) await client.query(
      `INSERT INTO message_dict(message_key, label, topic, message_text)
       SELECT k, k, 'other', t FROM unnest($1::text[], $2::text[]) AS x(k, t)
       ON CONFLICT (message_key) DO UPDATE SET message_text=EXCLUDED.message_text`,
      [[...templates.keys()], [...templates.values()]],
    );
    for (const day of scanned.selectedDays) await client.query(
      `INSERT INTO day_runs(bank,day,mode,status,source_total,ingested_count,success_count,fail_count,
        checkpoint,analysis_version,started_at,finished_at)
       VALUES($1,$2,'nightly','complete',$3,$3,$4,$5,$3,$6,now(),now())
       ON CONFLICT(bank,day) DO UPDATE SET status='complete', source_total=EXCLUDED.source_total,
         ingested_count=EXCLUDED.ingested_count, success_count=EXCLUDED.success_count,
         fail_count=EXCLUDED.fail_count, checkpoint=EXCLUDED.checkpoint,
         analysis_version=EXCLUDED.analysis_version, finished_at=now(), updated_at=now()`,
      [bankKey, day, rows.length, rows.filter((r) => r.is_success).length,
        rows.filter((r) => !r.is_success).length, evaluator.versionOf(bankKey)],
    );
    if (rebuild) await client.query('COMMIT');
    console.log('✅ اسنپشاپ reports/ وارد دیتابیس شد؛ داشبورد زنده را برای همان روز باز کن.');
  } catch (error) {
    if (rebuild) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });
