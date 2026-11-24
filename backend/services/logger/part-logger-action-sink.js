'use strict';

const { getActionLogger } = require('./action-logger.service');

/**
 * Resolver کوچک برای دریافت نمونهٔ PartLogger از DI فریم‌ورک و اتصال آن به
 * ActionLoggerService. خود PartLogger در این لایه ساخته نمی‌شود؛ ساخت و config
 * آن بر عهدهٔ partFramework و partLoggerConfig است.
 */
class PartLoggerActionSink {
  constructor(partLogger) {
    this.partLogger = partLogger || null;
    getActionLogger().setPartLogger(this.partLogger);
  }
}

module.exports = PartLoggerActionSink;
