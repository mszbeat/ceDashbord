'use strict';
const { config } = require('../config');
const { getActionLogger } = require('../logger/action-logger.service');

/**
 * دو استخر جدا برای خواندن و نوشتن (فاز ۳).
 *
 * چرا: ingestion دسته‌های بزرگ و تراکنش‌های طولانی دارد و اگر با استخر داشبورد مشترک باشد،
 * همهٔ اتصال‌ها را می‌گیرد و صفحهٔ داشبورد به‌خاطر یک import قفل می‌شود. جداسازی، سقف
 * صریح برای هر کدام می‌دهد و `statement_timeout` جلوی کوئری سرگردان را می‌گیرد.
 *
 * متغیرها (همه اختیاری):
 *   CE_DB_POOL_MAX_READ / CE_DB_POOL_MAX_WRITE  — اندازهٔ استخر (پیش‌فرض ۱۰ / ۴)
 *   CE_DB_STATEMENT_TIMEOUT_MS                  — سقف زمان هر کوئری خواندن (پیش‌فرض ۳۰۰۰۰)
 *   CE_DB_IDLE_TIMEOUT_MS                       — بستن اتصال بیکار (پیش‌فرض ۳۰۰۰۰)
 */
function numeric(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class DatabaseService {
  /**
   * @param {string} [customConnectionString]
   * @param {{role?: 'read'|'write'|'shared', max?: number, statementTimeoutMs?: number}} [options]
   */
  constructor(customConnectionString, options = {}) {
    const { Pool } = require('pg');
    const role = options.role || 'shared';
    const readMax = numeric('CE_DB_POOL_MAX_READ', 10);
    const writeMax = numeric('CE_DB_POOL_MAX_WRITE', 4);
    const max = options.max ?? (role === 'write' ? writeMax : role === 'read' ? readMax : readMax + writeMax);

    this.role = role;
    this.pool = new Pool({
      connectionString: customConnectionString || config.databaseUrl,
      max,
      idleTimeoutMillis: numeric('CE_DB_IDLE_TIMEOUT_MS', 30000),
      connectionTimeoutMillis: numeric('CE_DB_CONNECT_TIMEOUT_MS', 5000),
      application_name: `ce-${role}`,
      // سقف زمان دستور: جلوی کوئری سرگردان (مثلاً بازهٔ بسیار بزرگ) را می‌گیرد
      statement_timeout: options.statementTimeoutMs
        ?? (role === 'write' ? numeric('CE_DB_WRITE_STATEMENT_TIMEOUT_MS', 120000) : numeric('CE_DB_STATEMENT_TIMEOUT_MS', 30000)),
    });
    this.pool.on('error', (error) => {
      getActionLogger().error({
        category: 'db',
        action: 'db.pool.error',
        errorCode: error?.code || 'PG_POOL_ERROR',
        message: error?.message || 'PostgreSQL pool error',
        stack: error?.stack,
        meta: { role },
      });
    });
  }

  query(text, params) {
    return this.pool.query(text, params);
  }

  getClient() {
    return this.pool.connect();
  }

  /** اندازهٔ استخر (برای /healthz و متریک) */
  stats() {
    return {
      role: this.role,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      max: this.pool.options?.max ?? null,
    };
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async close() {
    await this.pool.end();
  }
}

/** کارخانهٔ استخرها — خواندن و نوشتن جدا، بدون ساخت اتصال اضافه در تست‌ها */
function createPools(connectionString) {
  return {
    read: new DatabaseService(connectionString, { role: 'read' }),
    write: new DatabaseService(connectionString, { role: 'write' }),
  };
}

module.exports = { DatabaseService, createPools };
