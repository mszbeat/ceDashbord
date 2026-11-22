'use strict';
const { DatabaseService } = require('./db/database.service');
const { EvaluatorService } = require('./evaluator/evaluator.service');
const { IngestionService } = require('./ingestion/ingestion.service');
const { SummaryService } = require('./summary/summary.service');
const { AdminService } = require('./admin/admin.service');
const { CronSchedulerService } = require('./admin/cron-scheduler.service');
const { getActionLogger } = require('./logger/action-logger.service');
const { config } = require('./config');
const { buildRuntimeRegistry } = require('./db/schema-registry');
const { V2Dialect } = require('./db/dialect-v2');
const { applySchemaV2 } = require('./db/schema-v2-builder');
const { V2Writer } = require('./db/ingest-v2');

let defaultContainer = null;

function createServices(options = {}) {
  const db = options.db || new DatabaseService();
  const logger = options.logger || getActionLogger();
  if (typeof logger.attachDb === 'function') {
    logger.attachDb(db);
  }
  const evaluator = options.evaluator || new EvaluatorService();

  /**
   * انتخاب اسکیمای داده.
   * `v1` = همان jsonb فعلی (پیش‌فرض). `v2` = جداول typed/پارتیشن‌شده.
   * در حالت v2 فقط «لایهٔ دسترسی» عوض می‌شود؛ منطق تجمیع و گزارش دست‌نخورده است
   * (برابری خروجی در `bench/golden.js` برای هر سه بانک اثبات شده).
   */
  const dbSchema = options.dbSchema || config.dbSchema;
  let dialect;
  let writer = null;
  if (dbSchema === 'v2') {
    const { registry, banksSpecs } = options.registryBundle || buildRuntimeRegistry(evaluator);
    const listSpecs = {};
    for (const bankKey of Object.keys(registry)) {
      listSpecs[bankKey] = (evaluator.getBank(bankKey).lists || []).map((list) => list.title);
    }
    dialect = new V2Dialect(db, { registry, listSpecs });
    writer = new V2Writer(db, evaluator, {
      registry,
      banksSpecs,
      analysisVersions: Object.fromEntries(Object.keys(registry).map((key) => [key, 1])),
    });
  }

  const ingestion = new IngestionService(db, evaluator, writer ? { writer } : {});
  const summary = new SummaryService(db, evaluator, dialect ? { dialect } : {});
  const admin = new AdminService(db, ingestion, { dbSchema });
  const cronScheduler = new CronSchedulerService(admin, { db });
  let initialized = false;

  return {
    db,
    logger,
    evaluator,
    ingestion,
    summary,
    dbSchema,
    dialect: dialect || null,
    writer,
    admin,
    cronScheduler,
    async init() {
      if (initialized) return;
      initialized = true;
      /**
       * D3 — در حالت v2، جداول typed/پارتیشن‌شده فقط با `applySchemaV2` ساخته می‌شوند
       * (مهاجرت‌های SQL آن‌ها را نمی‌سازند، چون ستون‌ها از رجیستری هر بانک می‌آیند).
       * بدون این فراخوانی، سرویس با `CE_DB_SCHEMA=v2` بالا می‌آمد ولی اولین کوئری با
       * «relation does not exist» یا «column does not exist» می‌شکست.
       * فراخوانی idempotent است (`CREATE TABLE/INDEX IF NOT EXISTS`).
       */
      if (dbSchema === 'v2' && dialect) {
        try {
          await ensureSchemaV2(db, writer, dialect?.registry);
        } catch (error) {
          /**
           * خطا را خفه نمی‌کنیم (ادامه با اسکیمای ناقص = خرابی خاموش)، ولی پیام باید
           * «کارِ بعدی» را بگوید. شایع‌ترین حالت: جدول‌های `samples_*` هنوز شکل v1 دارند
           * و باید یک‌بار `npm run migrate:v2` اجرا شود (غیرمخرب: به `_v1_backup` تغییر نام می‌دهد).
           */
          const needsDataMigration = /اسکیمای v1|v1 دارند/.test(error.message || '');
          const hint = needsDataMigration
            ? 'جدول‌های نمونه‌ها هنوز اسکیمای v1 دارند. یک‌بار `npm run migrate:v2 --prefix backend` '
              + '(یا در پوشهٔ backend: `npm run migrate:v2`) را اجرا کنید؛ این کار غیرمخرب است و '
              + 'جدول‌های فعلی را به `*_v1_backup` تغییر نام می‌دهد.'
            : 'اسکیمای v2 آماده نشد؛ لاگ بالا را ببینید.';
          logger.error({
            category: 'system',
            action: 'schema.v2.ensure_failed',
            message: `آماده‌سازی اسکیمای v2 شکست خورد: ${error.message} — ${hint}`,
          });
          const wrapped = new Error(`آماده‌سازی اسکیمای v2 شکست خورد: ${error.message}\n${hint}`);
          wrapped.code = 'V2_SCHEMA_NOT_READY';
          throw wrapped;
        }
      }
      await admin.onModuleInit();
      if (options.enableCron !== false) {
        cronScheduler.start();
      }
      logger.info({
        category: 'system',
        action: 'services.initialized',
        message: 'Backend domain services initialized',
        meta: { cronEnabled: options.enableCron !== false },
      });
    },
    async close(reason = 'shutdown') {
      cronScheduler.stop();
      logger.info({
        category: 'system',
        action: 'services.closing',
        message: 'Closing backend domain services',
      });
      // فاز ۴: هر اجرای ingestion که «در جریان» مانده، `interrupted` شود تا اپراتور آن را
      // اجرای موفق نپندارد و rollup روز ناقص ساخته نشود.
      try {
        const marked = await ingestion.markInterrupted(reason);
        if (marked?.marked) {
          logger.warn({
            category: 'ingestion',
            action: 'ingestion.shutdown.interrupted',
            message: `${marked.marked} اجرای نیمه‌کاره interrupted شد`,
            meta: { reason, marked: marked.marked },
          });
        }
      } catch (error) {
        logger.warn({
          category: 'ingestion',
          action: 'ingestion.shutdown.markFailed',
          message: error?.message || 'ثبت interrupted ناموفق بود',
        });
      }
      if (typeof logger.flush === 'function') {
        await logger.flush().catch(() => {});
      }
      if (typeof db.close === 'function') await db.close();
      else if (typeof db.onModuleDestroy === 'function') await db.onModuleDestroy();
    },
  };
}

/**
 * اطمینان از وجود جداول typed v2 (پارتیشن‌شده) بر اساس رجیستری هر بانک.
 * idempotent است و فقط در حالت `CE_DB_SCHEMA=v2` صدا زده می‌شود.
 */
/**
 * نگهبان: در v2، ستون `day_runs.day` **باید** از نوع date و میلادی باشد.
 *
 * اگر دیتابیس هنوز شکل v1 دارد (`day text` با مقدار شمسی)، بوت باید متوقف شود؛ وگرنه
 * کوئری‌های بازه با «operator does not exist: text >= date» یا (بدتر) با تفسیر شمسی
 * به‌عنوان میلادی، دادهٔ اشتباه برمی‌گردانند. این حالت با آزمایش واقعی دیده شد.
 */
async function assertDayRunsIsDate(db) {
  const result = await db.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'day_runs' AND column_name = 'day'`,
  );
  const dataType = String(result.rows[0]?.data_type ?? '(none)');
  if (dataType === 'date') return;
  const error = new Error(
    `ستون day_runs.day از نوع «${dataType}» است، نه date. ` +
      'برای اجرای v2 ابتدا `npm run migrate:v2` را اجرا کنید (غیرمخرب: جدول‌های فعلی به *_v1_backup تغییر نام می‌دهند).',
  );
  error.code = 'V2_SCHEMA_NOT_READY';
  throw error;
}

async function ensureSchemaV2(db, writer, registry) {
  await assertDayRunsIsDate(db);
  // `V2Writer` رجیستری را در `this.registry` نگه می‌دارد؛ منبع حقیقت همان است
  const source = registry || writer?.registry;
  if (!source) return; // رجیستری در دست نیست ⇒ چیزی برای ساختن نیست
  await applySchemaV2(db, { registry: source, banks: Object.keys(source) });
}

function getServices() {
  if (!defaultContainer) {
    defaultContainer = createServices();
  }
  return defaultContainer;
}

function setServicesForTest(customContainer) {
  defaultContainer = customContainer;
}

module.exports = {
  createServices,
  getServices,
  setServicesForTest,
};
