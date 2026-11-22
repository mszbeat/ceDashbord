'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SENSITIVE_KEY_RE =
  /^(?:.*(?:password|secret|cookie|authorization|national_?code|api_?key|private_?key|set-cookie|_cesetcookies).*|pass|.*token|ce_refresh)$/i;

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LEN = 1000;

function redactInlineSecrets(text) {
  return String(text)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(ce_refresh|token|password|nationalCode)=([^;\s&]+)/gi, '$1=[REDACTED]');
}

function sanitizeLogData(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function') return '[Function]';
  if (t === 'string') {
    const cleaned = redactInlineSecrets(value);
    return cleaned.length > MAX_STRING_LEN ? `${cleaned.slice(0, MAX_STRING_LEN)}…(truncated)` : cleaned;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeLogData(value.message, depth + 1, seen),
      code: value.code ?? value.meta?.code ?? undefined,
      statusCode: value.statusCode ?? undefined,
    };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  seen.add(value);

  if (Array.isArray(value)) {
    const slice = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeLogData(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      slice.push(`…(+${value.length - MAX_ARRAY_ITEMS} more)`);
    }
    return slice;
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
    } else if (val !== undefined) {
      out[key] = sanitizeLogData(val, depth + 1, seen);
    }
  }
  return out;
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return roles.map((r) => String(r).trim()).filter(Boolean);
}

const ACTION_LOG_DDL = [
  `CREATE TABLE IF NOT EXISTS backend_action_logs (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT,
    roles JSONB NOT NULL DEFAULT '[]'::jsonb,
    method TEXT,
    path TEXT,
    status_code INTEGER,
    duration_ms INTEGER,
    request_id TEXT,
    ip TEXT,
    user_agent TEXT,
    error_code TEXT,
    message TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS idx_backend_action_logs_occurred ON backend_action_logs(occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backend_action_logs_action ON backend_action_logs(action, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backend_action_logs_level ON backend_action_logs(level, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_backend_action_logs_actor ON backend_action_logs(actor, occurred_at DESC)`,
];

let auditContextGetter = null;
function registerAuditContextGetter(getter) {
  auditContextGetter = typeof getter === 'function' ? getter : null;
}

class ActionLoggerService {
  constructor(options = {}) {
    this.logDir = options.logDir || process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
    this.consoleEnabled =
      options.consoleEnabled !== undefined
        ? Boolean(options.consoleEnabled)
        : process.env.LOG_CONSOLE !== 'false';
    this.enableFiles =
      options.enableFiles !== undefined
        ? Boolean(options.enableFiles)
        : process.env.DISABLE_FILE_LOGS !== '1';
    this.enableDb =
      options.enableDb !== undefined
        ? Boolean(options.enableDb)
        : process.env.DISABLE_DB_ACTION_LOGS !== '1';
    this.db = options.db || null;
    this._tableReadyForDb = null;
    this._tablePromise = null;
    this._pending = new Set();
    this._fileQueue = Promise.resolve();
    this._lastDbWarnAt = 0;
  }

  attachDb(db) {
    if (db && db !== this.db) {
      this.db = db;
      this._tableReadyForDb = null;
      this._tablePromise = null;
    }
  }

  async #ensureTable(db) {
    if (!db) return;
    if (this._tableReadyForDb === db) return;
    if (this._tablePromise && this._tableReadyForDb === undefined) {
      return this._tablePromise;
    }
    this._tableReadyForDb = undefined;
    this._tablePromise = (async () => {
      try {
        for (const stmt of ACTION_LOG_DDL) {
          await db.query(stmt);
        }
        this._tableReadyForDb = db;
      } catch (err) {
        this._tableReadyForDb = null;
        this._tablePromise = null;
        throw err;
      }
    })();
    return this._tablePromise;
  }

  #trackPromise(p) {
    this._pending.add(p);
    p.finally(() => {
      this._pending.delete(p);
    });
    return p;
  }

  #writeFiles(entry) {
    if (!this.enableFiles) return;
    const dayStamp = entry.occurredAt.slice(0, 10);
    const line = `${JSON.stringify(entry)}\n`;
    const isErrorLine =
      entry.level === 'error' ||
      entry.level === 'warn' ||
      (typeof entry.statusCode === 'number' && entry.statusCode >= 400);

    const task = this._fileQueue.then(async () => {
      try {
        await fs.promises.mkdir(this.logDir, { recursive: true });
        await fs.promises.appendFile(path.join(this.logDir, `actions-${dayStamp}.log`), line, 'utf8');
        if (isErrorLine) {
          await fs.promises.appendFile(path.join(this.logDir, `errors-${dayStamp}.log`), line, 'utf8');
        }
      } catch {
        // ثبت فایل هرگز نباید اجرای سرویس را متوقف کند
      }
    });
    this._fileQueue = task.catch(() => {});
    this.#trackPromise(task);
  }

  #writeConsole(entry) {
    if (!this.consoleEnabled) return;
    const parts = [
      `[${entry.occurredAt}]`,
      `[${entry.level.toUpperCase()}]`,
      `[${entry.category}]`,
      entry.action,
    ];
    if (entry.method && entry.path) parts.push(`${entry.method} ${entry.path}`);
    if (entry.actor) parts.push(`actor=${entry.actor}`);
    if (typeof entry.statusCode === 'number') parts.push(`status=${entry.statusCode}`);
    if (typeof entry.durationMs === 'number') parts.push(`${entry.durationMs}ms`);
    if (entry.errorCode) parts.push(`code=${entry.errorCode}`);
    if (entry.message) parts.push(`— ${entry.message}`);
    if (entry.requestId) parts.push(`req=${entry.requestId}`);
    const text = parts.join(' ');
    if (entry.level === 'error') {
      // eslint-disable-next-line no-console
      console.error(text);
    } else if (entry.level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(text);
    } else {
      // eslint-disable-next-line no-console
      console.log(text);
    }
  }

  #writeDb(entry) {
    if (!this.enableDb || !this.db || typeof this.db.query !== 'function') return;
    const db = this.db;
    const task = (async () => {
      try {
        await this.#ensureTable(db);
        const metaPayload = entry.stack ? { ...(entry.meta || {}), stack: entry.stack } : entry.meta || {};
        await db.query(
          `INSERT INTO backend_action_logs (
            occurred_at, level, category, action, actor, roles, method, path,
            status_code, duration_ms, request_id, ip, user_agent, error_code, message, meta
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
          [
            entry.occurredAt,
            entry.level,
            entry.category,
            entry.action,
            entry.actor,
            JSON.stringify(entry.roles || []),
            entry.method,
            entry.path,
            entry.statusCode,
            entry.durationMs,
            entry.requestId,
            entry.ip,
            entry.userAgent,
            entry.errorCode,
            entry.message,
            JSON.stringify(metaPayload),
          ],
        );
      } catch (err) {
        const now = Date.now();
        if (this.consoleEnabled && now - this._lastDbWarnAt > 30_000) {
          this._lastDbWarnAt = now;
          // eslint-disable-next-line no-console
          console.warn('[action-logger] DB write skipped:', err?.code || err?.message || err);
        }
      }
    })();
    this.#trackPromise(task);
  }

  logEvent(input = {}) {
    const ctx = auditContextGetter ? auditContextGetter() : null;
    const rawLevel = String(input.level || 'info').toLowerCase();
    const level = rawLevel === 'error' || rawLevel === 'warn' ? rawLevel : 'info';

    const actorRaw = input.actor !== undefined ? input.actor : ctx?.actor ?? null;
    const rolesRaw = input.roles !== undefined ? input.roles : ctx?.roles ?? [];
    const statusCode =
      typeof input.statusCode === 'number' && Number.isFinite(input.statusCode)
        ? Math.trunc(input.statusCode)
        : null;
    const durationMs =
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
        ? Math.max(0, Math.round(input.durationMs))
        : null;

    const rawMessage = input.message !== undefined && input.message !== null ? String(input.message) : null;
    const rawStack = input.stack ? String(input.stack).slice(0, 2500) : null;

    const entry = {
      occurredAt: new Date().toISOString(),
      level,
      category: String(input.category || 'system').slice(0, 64),
      action: String(input.action || 'event').slice(0, 128),
      actor: actorRaw ? String(actorRaw).slice(0, 160) : null,
      roles: normalizeRoles(rolesRaw),
      method: input.method || ctx?.method || null,
      path: input.path || ctx?.path || null,
      statusCode,
      durationMs,
      // D8: شناسهٔ درخواست — اگر صریح داده نشود از بافت درخواست (AsyncLocalStorage) می‌آید
      requestId: input.requestId || ctx?.requestId || require('./request-context').currentId(),
      ip: input.ip !== undefined ? input.ip : ctx?.ip ?? null,
      userAgent: input.userAgent !== undefined ? (input.userAgent ? String(input.userAgent).slice(0, 300) : null) : ctx?.userAgent ?? null,
      errorCode: input.errorCode ? String(input.errorCode).slice(0, 128) : null,
      message: rawMessage ? sanitizeLogData(rawMessage) : null,
      meta: sanitizeLogData(input.meta && typeof input.meta === 'object' ? input.meta : {}),
      ...(rawStack ? { stack: sanitizeLogData(rawStack) } : {}),
    };

    this.#writeConsole(entry);
    this.#writeFiles(entry);
    this.#writeDb(entry);
    return entry;
  }

  info(input = {}) {
    return this.logEvent({ ...input, level: 'info' });
  }

  warn(input = {}) {
    return this.logEvent({ ...input, level: 'warn' });
  }

  error(input = {}) {
    return this.logEvent({ ...input, level: 'error' });
  }

  async flush() {
    while (this._pending.size > 0) {
      await Promise.allSettled([...this._pending]);
    }
  }
}

let sharedLogger = null;

function getActionLogger() {
  if (!sharedLogger) {
    sharedLogger = new ActionLoggerService();
  }
  return sharedLogger;
}

function setActionLogger(customLogger) {
  sharedLogger = customLogger;
}

module.exports = {
  ActionLoggerService,
  ACTION_LOG_DDL,
  SENSITIVE_KEY_RE,
  sanitizeLogData,
  getActionLogger,
  setActionLogger,
  registerAuditContextGetter,
};
