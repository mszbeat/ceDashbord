'use strict';

const Program = require('./Program');
const projectConfig = require('./project-config');
const { getActionLogger } = require('./services/logger/action-logger.service');

const rawEnv = process.env.MODE || process.env.mode || process.env.NODE_ENV || 'dev';
const env = rawEnv === 'production' ? 'prod' : rawEnv === 'development' ? 'dev' : rawEnv;

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : null;
  getActionLogger().error({
    category: 'system',
    action: 'system.unhandled_rejection',
    errorCode: err?.code || 'UNHANDLED_REJECTION',
    message: err?.message || String(reason),
    stack: err?.stack,
  });
});

process.on('uncaughtException', (err) => {
  const logger = getActionLogger();
  logger.error({
    category: 'system',
    action: 'system.uncaught_exception',
    errorCode: err?.code || 'UNCAUGHT_EXCEPTION',
    message: err?.message || String(err),
    stack: err?.stack,
  });
  Promise.resolve(logger.flush()).finally(() => {
    process.exit(1);
  });
});

(async () => {
  try {
    const program = new Program(projectConfig[env] || projectConfig.dev);
    await program.run();
  } catch (err) {
    const logger = getActionLogger();
    logger.error({
      category: 'system',
      action: 'system.startup.failed',
      errorCode: err?.code || 'STARTUP_FAILED',
      message: err?.message || String(err),
      stack: err?.stack,
    });
    await logger.flush();
    process.exit(1);
  }
})();
