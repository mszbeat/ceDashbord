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
 *   CE_DB_POOL_ACQUIRE_TIMEOUT_MS               — سقف انتظار برای گرفتن اتصال آزاد (پیش‌فرض ۱۰۰۰۰)
 *   CE_DB_QUERY_TIMEOUT_MS                      — سقف سمت کلاینت برای هر کوئری (پیش‌فرض ۳۵۰۰۰)
 *
 * ⚠️ چرا acquire/query timeout لازم شد (باگ «صفحه لود نمی‌شود»):
 *   `pg` به‌طور پیش‌فرض برای «گرفتن اتصال آزاد از استخر» هیچ مهلتی ندارد. اگر همهٔ
 *   اتصال‌ها مشغول باشند (مثلاً یک ingest طولانی یا یک اتصال جامانده)، هر درخواست
 *   **بی‌نهایت** منتظر می‌ماند: صفحهٔ گزارش با ۵۰۲ «سرور پاسخ نداد» و پنل ادمین با
 *   اسپینر همیشگی «در حال بررسی سطح دسترسی…» — بدون هیچ خطایی در لاگ.
 *   با این دو مهلت، همان شرایط به خطای صریح و ۵۰۳ تبدیل می‌شود.
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
      // سقف سمت کلاینت: اگر سرور پاسخ ندهد (نه حتی خطا)، کوئری رها نمی‌شود
      query_timeout: numeric('CE_DB_QUERY_TIMEOUT_MS', 35000),
      // D5: اتصال رمزنگاری‌شده به دیتابیس در production
      ssl: String(process.env.CE_DB_SSL || '').toLowerCase() === 'true'
        ? { rejectUnauthorized: String(process.env.CE_DB_SSL_STRICT || 'true').toLowerCase() !== 'false' }
        : undefined,
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

  /**
   * سقف انتظار برای گرفتن اتصال آزاد از استخر.
   *
   * بدون این، `pool.query`/`pool.connect` وقتی همهٔ اتصال‌ها مشغول‌اند **بی‌نهایت**
   * منتظر می‌مانند و هیچ لاگی هم ثبت نمی‌شود — همان چیزی که صفحهٔ گزارش را به
   * «سرور پاسخ نداد» و پنل ادمین را به اسپینر همیشگی تبدیل می‌کرد.
   * حالا با خطای صریح `DB_POOL_ACQUIRE_TIMEOUT` و پیام «کارِ بعدی» برمی‌گردد.
   */
  #acquireTimeoutMs() {
    return numeric('CE_DB_POOL_ACQUIRE_TIMEOUT_MS', 10000);
  }

  async #withAcquireTimeout(promise, onLateResolve) {
    const limit = this.#acquireTimeoutMs();
    let timer;
    let timedOut = false;
    // pool.connect() cannot be cancelled. If it resolves after our timeout, release
    // the newly acquired client rather than leaking a pool slot indefinitely.
    const observed = Promise.resolve(promise).then((value) => {
      if (timedOut) {
        try { onLateResolve?.(value); } catch {}
        return undefined;
      }
      return value;
    });
    try {
      return await Promise.race([
        observed,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            const error = new Error(
              `هیچ اتصال آزادی از استخر دیتابیس در ${limit}ms آزاد نشد ` +
                `(role=${this.role}, max=${this.pool.options?.max ?? '?'}, waiting=${this.pool.waitingCount}). ` +
                'معمولاً یعنی یک عملیات طولانی (import/تحلیل) همهٔ اتصال‌ها را گرفته است؛ ' +
                'یا `CE_DB_POOL_MAX_READ` را بالا ببرید یا بعد از پایان آن دوباره تلاش کنید.',
            );
            error.code = 'DB_POOL_ACQUIRE_TIMEOUT';
            error.statusCode = 503;
            reject(error);
          }, limit);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async query(text, params) {
    const client = await this.getClient();
    let queryError;
    try {
      return await client.query(text, params);
    } catch (error) {
      queryError = error;
      throw error;
    } finally {
      // Passing an error lets pg discard a potentially unhealthy connection.
      client.release(queryError);
    }
  }

  getClient() {
    return this.#withAcquireTimeout(this.pool.connect(), (client) => client?.release?.());
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
