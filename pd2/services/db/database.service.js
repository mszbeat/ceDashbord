'use strict';
const { Pool } = require('pg');
const { config } = require('../config');

class DatabaseService {
  constructor(customConnectionString) {
    this.pool = new Pool({
      connectionString: customConnectionString || config.databaseUrl,
      max: 10,
    });
    this.pool.on('error', (error) => console.error('PostgreSQL pool error:', error.message));
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
