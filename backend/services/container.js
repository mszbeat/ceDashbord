'use strict';
const { DatabaseService } = require('./db/database.service');
const { EvaluatorService } = require('./evaluator/evaluator.service');
const { IngestionService } = require('./ingestion/ingestion.service');
const { SummaryService } = require('./summary/summary.service');
const { AdminService } = require('./admin/admin.service');
const { CronSchedulerService } = require('./admin/cron-scheduler.service');
const { getActionLogger } = require('./logger/action-logger.service');

let defaultContainer = null;

function createServices(options = {}) {
  const db = options.db || new DatabaseService();
  const logger = options.logger || getActionLogger();
  if (typeof logger.attachDb === 'function') {
    logger.attachDb(db);
  }
  const evaluator = options.evaluator || new EvaluatorService();
  const ingestion = new IngestionService(db, evaluator);
  const summary = new SummaryService(db, evaluator);
  const admin = new AdminService(db, ingestion);
  const cronScheduler = new CronSchedulerService(admin);
  let initialized = false;

  return {
    db,
    logger,
    evaluator,
    ingestion,
    summary,
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
