'use strict';
const { config } = require('../config');
const { getActionLogger } = require('../logger/action-logger.service');

class DatabaseService {
  constructor(customConnectionString) {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString: customConnectionString || config.databaseUrl,
      max: 10,
    });
    this.pool.on('error', (error) => {
      getActionLogger().error({
        category: 'db',
        action: 'db.pool.error',
        errorCode: error?.code || 'PG_POOL_ERROR',
        message: error?.message || 'PostgreSQL pool error',
        stack: error?.stack,
      });
    });
  }

  query(text, params) {
    return this.pool.query(text, params);
  }

  getClient() {
    return this.pool.connect();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { DatabaseService };
