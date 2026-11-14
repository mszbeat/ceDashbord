#!/usr/bin/env node
/**
 * تست رگرسیون ۵ باگ اصلاحشدهٔ سرور (با PGlite واقعی):
 *   ۱) عدم کرش بچ روی request_id تکراری همصفحه + عدم بازنویسی روزهای قبلی + مهاجرت کلید اصلی قدیمی
 *   ۲) جلوگیری از حلقهٔ بینهایت در صفحهبندی ناقص/resume + پوشش رکوردهای جدید صدر لیست در حالت زنده
 *   ۳) اجرای کامل BuildAiInput در normalizeSample حتی در حضور ai_input خام/ناقص
 *   ۴) تطابق دقیق trim، «پیامی ثبت نشده است»، تفکیک پیامهای خطای متفاوت و ماسک اعداد حساس
 *   ۵) تبدیل درست تاریخ میلادی ISO به شمسی تهران در استخراج زمان ثبت (اولین/آخرین درخواست)
 */
'use strict';
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const { EvaluatorService } = require(path.join(ROOT, 'dist', 'evaluator', 'evaluator.service'));
const { IngestionService } = require(path.join(ROOT, 'dist', 'ingestion', 'ingestion.service'));
const { SummaryService } = require(path.join(ROOT, 'dist', 'summary', 'summary.service'));

const baseSample = JSON.parse(
  fs.readFileSync(path.join(ROOT, '..', 'samples', 'mellat.json'), 'utf8'),
);
const clone = (v) => JSON.parse(JSON.stringify(v));

function wrapDb(pg) {
  return {
    async query(text, params = []) {
      const r = await pg.query(text, params);
      return { rows: r.rows || [], rowCount: r.affectedRows ?? (r.rows || []).length };
    },
    async getClient() {
      return { query: this.query.bind(this), release() {} };
    },
  };
}

function makeRaw(id, overrides = {}) {
  const s = clone(baseSample);
  s.requestId = id;
  s.input.uniqueKey = `uk-${id}`;
  s.insertDate_full = '14050819091500001';
  s.output.Credit_Basket = 25_000_000;
  s.output.PD = 0.25;
  s.output.total_time = 0.5;
  s.output.message = {
    fa: 'درخواست اعتبارسنجی با موفقیت انجام شد.',
    en: 'Validation was successful.',
  };
  return Object.assign(s, overrides);
}

(async () => {
  const schemaSql = fs.readFileSync(path.join(ROOT, 'src', 'db', 'schema.sql'), 'utf8');

  // ─── ۱) باگ ۱: تکراری داخل یک بچ + عدم بازنویسی بین دو روز + مهاجرت PK قدیمی ───
  {
    const pg = new PGlite();
    // شبیهسازی دیتابیس قدیمی که PK فقط روی request_id بوده است
    await pg.exec(`
      CREATE TABLE samples_mellat (
        request_id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        inserted_at TEXT, stamp_key TEXT, unique_key TEXT,
        is_success BOOLEAN NOT NULL, model_name TEXT, status_code TEXT, error_code TEXT, message_key TEXT,
        total_time_s DOUBLE PRECISION, pd DOUBLE PRECISION, suggested_amount NUMERIC(20,0), amount_kind TEXT,
        score_req DOUBLE PRECISION, credit_basket NUMERIC(20,0), avg36 DOUBLE PRECISION,
        ln_avg_installments DOUBLE PRECISION, rotbe TEXT,
        flags JSONB NOT NULL DEFAULT '{}'::jsonb, cats JSONB NOT NULL DEFAULT '{}'::jsonb,
        counters JSONB NOT NULL DEFAULT '{}'::jsonb, metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        paths JSONB NOT NULL DEFAULT '{}'::jsonb, services JSONB NOT NULL DEFAULT '{}'::jsonb,
        credit_alerts JSONB, display_extras JSONB NOT NULL DEFAULT '{}'::jsonb,
        analysis_version TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pg.exec(schemaSql);

    const db = wrapDb(pg);
    const ev = new EvaluatorService();
    const svc = new IngestionService(db, ev);

    // الف) دو رکورد همشناسه داخل یک صفحهٔ واحد نباید خطای PostgreSQL بدهد
    const dup1 = makeRaw('shared-req-1');
    dup1.output.Credit_Basket = 10_000_000;
    const dup2 = makeRaw('shared-req-1');
    dup2.output.Credit_Basket = 30_000_000;
    svc.sourceTotal = async () => 3;
    svc.fetchPage = async () => ({ count: 3, reportResults: [dup1, dup2, makeRaw('unique-req-2')] });
    await svc.runDay('tavan_mellat', '1405-08-18', 'nightly');

    const day1Count = (await pg.query(`SELECT COUNT(*)::int AS c FROM samples_mellat WHERE day='1405-08-18'`)).rows[0].c;
    assert.equal(day1Count, 2, 'بچ دارای request_id تکراری بدون کرش ذخیره شود');

    // ب) همان request_id در روز بعدی نباید ردیف روز 1405-08-18 را حذف/جابهجا کند
    svc.sourceTotal = async () => 1;
    svc.fetchPage = async () => ({ count: 1, reportResults: [makeRaw('shared-req-1')] });
    await svc.runDay('tavan_mellat', '1405-08-19', 'nightly');

    const day1After = (await pg.query(`SELECT COUNT(*)::int AS c FROM samples_mellat WHERE day='1405-08-18'`)).rows[0].c;
    const day2After = (await pg.query(`SELECT COUNT(*)::int AS c FROM samples_mellat WHERE day='1405-08-19'`)).rows[0].c;
    assert.equal(day1After, 2, 'آمار روز قبلی نباید با تکرار request_id در روز جدید تغییر کند');
    assert.equal(day2After, 1, 'ردیف روز جدید مستقل ذخیره شود');
    await pg.close();
    console.log('✅ باگ ۱ تایید شد: عدم کرش بچ تکراری، حفظ استقلال روزها و مهاجرت PK قدیمی');
  }

  // ─── ۲) باگ ۲: جلوگیری از حلقهٔ بینهایت + دریافت رکوردهای جدید صدر لیست در حالت زنده ───
  {
    const pg = new PGlite();
    await pg.exec(schemaSql);
    const db = wrapDb(pg);
    const ev = new EvaluatorService();
    const svc = new IngestionService(db, ev);

    // الف) sourceTotal اولیه ۶۵ است ولی API در مجموع ۵۳ رکورد دارد (صفحه ۲ فقط ۳ رکورد دارد)
    const p1 = Array.from({ length: 50 }, (_, i) => makeRaw(`p1-${i}`));
    const p2 = Array.from({ length: 3 }, (_, i) => makeRaw(`p2-${i}`));
    let calls = 0;
    svc.sourceTotal = async () => 65;
    svc.fetchPage = async (page) => {
      calls++;
      if (calls > 10) throw new Error('حلقهٔ بینهایت تشخیص داده شد!');
      return { count: 65, reportResults: page === 1 ? p1 : page === 2 ? p2 : [] };
    };
    const resShort = await svc.runDay('tavan_mellat', '1405-08-18', 'nightly');
    assert.equal(calls, 2, 'وقتی صفحهٔ آخر کمتر از ۵۰ آیتم دارد بلافاصله متوقف شود');
    assert.equal(resShort.checkpoint, 53);

    // ب) در حین خواندن صفحات (ترتیب نزولی API)، ۳ رکورد جدید به ابتدای صفحهٔ ۱ اضافه میشوند
    const initial55 = Array.from({ length: 55 }, (_, i) => makeRaw(`init-${i}`));
    const fresh3 = Array.from({ length: 3 }, (_, i) => makeRaw(`fresh-head-${i}`));
    let dynamicList = [...initial55];
    svc.sourceTotal = async () => 55;
    svc.fetchPage = async (page, limit) => {
      if (page === 2 && dynamicList.length === 55) {
        // هنگام رفتن به صفحهٔ ۲، ۳ رکورد تازه به اول لیست اضافه میشوند (shift در صفحات)
        dynamicList = [...fresh3, ...initial55];
      }
      const start = (page - 1) * limit;
      return { count: dynamicList.length, reportResults: dynamicList.slice(start, start + limit) };
    };
    await svc.runDay('tavan_mellat', '1405-08-19', 'intraday');
    const liveTotalInDb = (await pg.query(`SELECT COUNT(*)::int AS c FROM samples_mellat WHERE day='1405-08-19'`)).rows[0].c;
    assert.equal(liveTotalInDb, 58, 'رکوردهای تازهٔ صدر لیست و انتهای لیست هر دو بدون جاماندگی ثبت شوند');
    await pg.close();
    console.log('✅ باگ ۲ تایید شد: توقف امن حلقهٔ صفحهبندی و پوشش کامل رشد زندهٔ لیست');
  }

  // ─── ۳) باگ ۳: اجرای BuildAiInput در normalizeSample حتی اگر ai_input خام/ناقص باشد ───
  {
    const ev = new EvaluatorService();
    const rawWithBrokenAiInput = makeRaw('broken-ai-input', {
      insertDate_yearMonthDay: '14050819',
      ai_input: { somethingRaw: true },
    });
    const normApi = ev.normalizeSample(rawWithBrokenAiInput, { fromApi: true });
    const normAuto = ev.normalizeSample(rawWithBrokenAiInput);
    assert.equal(typeof normApi.ai_input?.iran?.status, 'string', 'وضعیت سرویس iran در حالت fromApi ساخته شود');
    assert.equal(typeof normAuto.ai_input?.iran?.status, 'string', 'وضعیت سرویس iran برای ai_input ناقص بازسازی شود');
    assert.equal(normApi.ai_input?.current_loan?.date_granted, '14050819', 'تاریخ اعتبارسنجی current_loan ساخته شود');
    console.log('✅ باگ ۳ تایید شد: بازسازی کامل ai_input در normalizeSample');
  }

  // ─── ۴) باگ ۴: trim پیامها، «پیامی ثبت نشده است»، تفکیک خطاهای ناموفق و ماسک اعداد حساس ───
  {
    const pg = new PGlite();
    await pg.exec(schemaSql);
    const db = wrapDb(pg);
    const ev = new EvaluatorService();
    const ingest = new IngestionService(db, ev);
    const summary = new SummaryService(db, ev);

    const sTrim = makeRaw('msg-trim');
    sTrim.output.message = {
      fa: '  درخواست اعتبارسنجی با موفقیت انجام شد.   ',
      en: 'Validation was successful.',
    };
    const sOverdue1 = makeRaw('msg-overdue-1');
    sOverdue1.output.message = {
      fa: 'شما در حال حاضر بدهی معوق دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.',
      en: 'You currently have overdue debt.please improve your credit behavior and try again.',
    };
    const sOverdue2 = makeRaw('msg-overdue-2');
    sOverdue2.output.message = {
      fa: 'مشتری دارای بدهی معوق ثبتشده در شبکه بانکی است.',
      en: 'You currently have overdue debt.please improve your credit behavior and try again.',
    };
    const sEmpty = makeRaw('msg-empty');
    sEmpty.output.message = {};
    const sErr1 = makeRaw('msg-err-1');
    sErr1.output.message = { fa: 'خطا در فراخوانی سرویس سمات', en: 'Samat gateway timeout' };
    const sErr2 = makeRaw('msg-err-2');
    sErr2.output.message = { fa: 'خطا در سرویس رتبهبندی برای کد 0012345678', en: 'Ranking failed' };

    ingest.sourceTotal = async () => 6;
    ingest.fetchPage = async () => ({ count: 6, reportResults: [sTrim, sOverdue1, sOverdue2, sEmpty, sErr1, sErr2] });
    await ingest.runDay('tavan_mellat', '1405-08-19', 'nightly');

    // بررسی عدم ذخیرهٔ متن پیام یا کد ملی در خود جدول samples_mellat
    const rawRowJson = JSON.stringify((await pg.query(`SELECT cats FROM samples_mellat WHERE day='1405-08-19'`)).rows);
    assert.ok(!rawRowJson.includes('0012345678'), 'کد ملی در ردیف ذخیره نشود');
    assert.ok(!rawRowJson.includes('سمات'), 'متن آزاد در ردیف ذخیره نشود');

    const dictJson = JSON.stringify((await pg.query(`SELECT * FROM message_dict`)).rows);
    assert.ok(!dictJson.includes('0012345678'), 'کد ملی در message_dict ماسک شده باشد');

    const built = await summary.summary('tavan_mellat', '1405-08-19', '1405-08-19');
    const successMsgs = built.categories.messageSuccess.map((x) => x.value);
    const failMsgs = built.categories.messageFail.map((x) => x.value);
    assert.equal(successMsgs.length, 3, 'پیام موفق استاندارد و دو گونهٔ متفاوت بدهی معوق نباید روی هم بازنویسی شوند');
    assert.ok(
      successMsgs.includes('درخواست اعتبارسنجی با موفقیت انجام شد.\nValidation was successful.'),
      'فاصلههای اضافی پیام موفق trim و به کلید استاندارد نگاشت شود',
    );
    assert.equal(failMsgs.length, 3, 'سه پیام ناموفق متفاوت نباید در یک ردیف «سایر پیامها» ادغام شوند');
    assert.ok(failMsgs.includes('پیامی ثبت نشده است'), 'پیام خالی به «پیامی ثبت نشده است» نگاشت شود');
    assert.ok(failMsgs.some((m) => m.includes('Samat gateway timeout')), 'پیام خطای اول مجزا بماند');
    assert.ok(failMsgs.some((m) => m.includes('***') && m.includes('Ranking failed')), 'پیام خطای دوم مجزا و ماسکشده بماند');
    await pg.close();
    console.log('✅ باگ ۴ تایید شد: trim، حفظ تفکیک پیامها و ماسک اعداد حساس');
  }

  // ─── ۵) باگ ۵: تبدیل درست تاریخ میلادی ISO به شمسی تهران ───
  {
    const pg = new PGlite();
    await pg.exec(schemaSql);
    const db = wrapDb(pg);
    const ev = new EvaluatorService();
    const ingest = new IngestionService(db, ev);
    const summary = new SummaryService(db, ev);

    const isoSample = makeRaw('iso-date-1');
    delete isoSample.insertDate_full;
    isoSample.insertDate = '2026-11-10T06:50:30.000Z'; // معادل 1405/08/19 ساعت 10:20:30 به وقت تهران

    ingest.sourceTotal = async () => 1;
    ingest.fetchPage = async () => ({ count: 1, reportResults: [isoSample] });
    await ingest.runDay('tavan_mellat', '1405-08-19', 'nightly');

    const html = await summary.report('tavan_mellat', '1405-08-19', '1405-08-19');
    const firstMatch = /<span>اولین درخواست<\/span><b[^>]*>([^<]*)<\/b>/.exec(html);
    assert.equal(firstMatch?.[1], '1405/08/19 10:20:30', 'تاریخ میلادی ISO به شمسی دقیق تهران تبدیل شود، نه 2026/11/10');
    await pg.close();
    console.log('✅ باگ ۵ تایید شد: تبدیل تاریخ میلادی ISO به شمسی تهران');
  }

  console.log('🎉 هر ۵ تست رگرسیون باگهای سرور با موفقیت پاس شدند.');
})().catch((err) => {
  console.error('❌ خطا در تست باگهای سرور:', err);
  process.exit(1);
});
