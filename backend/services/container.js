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
  const admin = new AdminService(db, ingestion);
  const cronScheduler = new CronSchedulerService(admin);
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
    async close() {
      cronScheduler.stop();
      logger.info({
        category: 'system',
        action: 'services.closing',
        message: 'Closing backend domain services',
      });
      if (typeof logger.flush === 'function') {
        await logger.flush().catch(() => {});
      }
      if (typeof db.close === 'function') await db.close();
      else if (typeof db.onModuleDestroy === 'function') await db.onModuleDestroy();
    },
  };
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
