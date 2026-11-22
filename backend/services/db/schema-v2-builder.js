'use strict';

/**
 * سازندهٔ DDL اسکیمای v2 و seed رجیستری.
 *
 * چرا در Node و نه فقط SQL؟ چون ستون‌های typed متریک/کانتر برای هر بانک متفاوت‌اند و
 * تعدادشان از رجیستری می‌آید. این ماژول همان چیزی را می‌سازد که `schema-v2.sql` توضیح می‌دهد،
 * به‌صورت idempotent (قابل اجرای چندباره) و بدون `LIKE ... INCLUDING ALL`.
 *
 * استفاده:
 *   const { applySchemaV2 } = require('./schema-v2-builder');
 *   await applySchemaV2(db, { registry });
 */

const fs = require('node:fs');
const path = require('node:path');

const { KIND, columnName } = require('./indicator-registry');

const SAMPLE_COLUMNS_PREFIX = {
  tavan_mellat: 'samples_mellat',
  tavan_resalat: 'samples_resalat',
  tavan_postbank: 'samples_postbank',
};

/**
 * ستون‌های پایهٔ هر ردیف نمونه.
 * ترتیب مهم است: ابتدا ستون‌های با عرض ثابت (بدون padding)، بعد ستون‌های nullable
 * با عرض متغیر (بدون alignment)، تا ساختار ردیف بهینه بماند.
 */
const BASE_COLUMNS = [
  // ── ۸ بایت ──
  // B4: `ts` همیشه مقدار دارد (بدون COALESCE در ترتیب/keyset)
  ['ts', 'bigint', 'NOT NULL'],
  ['flags', 'bigint', 'NOT NULL DEFAULT 0'],
  ['service_kinds', 'bigint', 'NOT NULL DEFAULT 0'],
  ['path_bits', 'bigint', 'NOT NULL DEFAULT 0'],
  // کدام شمارنده‌ها در این ردیف **وجود داشتند** (حتی با مقدار ۰) — مسیر قدیمی کلید صفر
  // را هم می‌ساخت، پس SUM تنها کافی نیست و حضور باید ذخیره شود
  ['counter_present', 'bigint', 'NOT NULL DEFAULT 0'],
  ['total_time_s', 'double precision', ''],
  ['pd', 'double precision', ''],
  ['score_req', 'double precision', ''],
  ['avg36', 'double precision', ''],
  ['ln_avg_installments', 'double precision', ''],
  // ── ۴ و ۲ بایت ──
  ['day', 'date', 'NOT NULL'],
  ['suggested_amount', 'bigint', ''],
  ['overdue_amount', 'numeric(20,0)', ''],
  ['cheque_amount', 'numeric(20,0)', ''],
  ['request_id', 'uuid', 'NOT NULL'],
  ['model_code', 'smallint', ''],
  ['status_code', 'smallint', ''],
  ['error_code', 'smallint', ''],
  ['message_code', 'smallint', ''],
  ['rotbe_code', 'smallint', ''],
  ['amount_kind', 'smallint', ''],
  ['overdue_count', 'smallint', ''],
  ['cheque_count', 'smallint', ''],
  ['analysis_version', 'smallint', ''],
  ['is_success', 'boolean', 'NOT NULL'],
  ['has_overdue', 'boolean', ''],
  ['has_cheque', 'boolean', ''],
  ['bad_reports', 'smallint', ''],
  // ── عرض متغیر ──
  ['unique_key', 'text', ''],
  ['cat_codes', 'smallint[]', "NOT NULL DEFAULT '{}'"],
  ['service_text_codes', 'smallint[]', "NOT NULL DEFAULT '{}'"],
  ['created_at', 'timestamptz', 'NOT NULL DEFAULT now()'],
];

function tableNameOf(bankKey) {
  const table = SAMPLE_COLUMNS_PREFIX[bankKey];
  if (!table) throw new Error(`بانک ناشناخته: ${bankKey}`);
  return table;
}

/** ستون‌های typed هر بانک را از رجیستری می‌سازد (بدون تکرار نام در ردیف) */
function typedColumnsOf(registry) {
  const metrics = registry.metric.map((id) => [columnName(KIND.METRIC, id), 'double precision', '']);
  const counters = registry.counter.map((id) => [columnName(KIND.COUNTER, id), 'integer', '']);
  // double (۸ بایت، بدون padding) قبل از integer (۴ بایت) → هیچ حفره‌ای بین ستون‌ها نمی‌افتد
  return [...metrics, ...counters];
}

function createTableSql(bankKey, registry) {
  const table = tableNameOf(bankKey);
  const columns = [...BASE_COLUMNS, ...typedColumnsOf(registry)]
    .map(([name, type, extra]) => `  ${name} ${type}${extra ? ` ${extra}` : ''}`)
    .join(',\n');
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    columns,
    '  , PRIMARY KEY (day, request_id)',
    ') PARTITION BY RANGE (day)',
  ].join('\n');
}

/**
 * ایندکس‌ها — دقیقاً ۲ ایندکس ثانویه، همان‌هایی که کد فعلی واقعاً استفاده می‌کند:
 *  * `(request_id)` برای `/api/sample/:id` و جست‌وجوی uuid
 *  * `(day, ts, request_id)` برای صفحه‌بندی cursor و بازهٔ روز
 */
function createIndexesSql(bankKey, registry) {
  const table = tableNameOf(bankKey);
  const prefix = table.replace('samples_', '');
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_request_id ON ${table} (request_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_day_ts ON ${table} (day, ts, request_id)`,
    // فیلترهای پرکاربرد `/api/list` (۳ شاخص پرتکرار هر بانک) — ایندکس جزئی، نه GIN
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_slow ON ${table} (day, total_time_s DESC)
       WHERE total_time_s > 4`,
    `CREATE INDEX IF NOT EXISTS idx_${prefix}_credit ON ${table} (day, ts)
       WHERE has_overdue OR has_cheque`,
  ];
  const hotFlags = ((registry && registry.flag) || []).slice(0, 3);
  hotFlags.forEach((id, index) => {
    indexes.push(
      `CREATE INDEX IF NOT EXISTS idx_${prefix}_flag${index} ON ${table} (day, ts)
         WHERE (flags & ${1n << BigInt(index)}) <> 0`,
    );
    void id;
  });
  return indexes;
}

/** پارتیشن ماهانه (idempotent) — نام پارتیشن بر اساس بازهٔ میلادی */
function createMonthlyPartitionSql(bankKey, from, to) {
  const table = tableNameOf(bankKey);
  const suffix = `${from.replace(/-/g, '_')}_${to.replace(/-/g, '_')}`;
  return `CREATE TABLE IF NOT EXISTS ${table}_${suffix} PARTITION OF ${table} FOR VALUES FROM ('${from}') TO ('${to}')`;
}

function ensureDefaultPartitionSql(bankKey) {
  const table = tableNameOf(bankKey);
  return `CREATE TABLE IF NOT EXISTS ${table}_pdefault PARTITION OF ${table} DEFAULT`;
}

/**
 * ساخت پارتیشن‌های ماهانه برای بازه‌ای از روزها (میلادی `YYYY-MM-DD`).
 * فراخوانی از مسیر ingestion قبل از درج + از cron شبانه.
 */
async function ensureMonthlyPartitions(db, bankKey, fromIso, toIso) {
  const table = tableNameOf(bankKey);
  const start = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  const created = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const limit = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= limit) {
    const from = cursor.toISOString().slice(0, 10);
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const to = next.toISOString().slice(0, 10);
    const name = `${table}_${from.replace(/-/g, '_')}_${to.replace(/-/g, '_')}`;
    await db.query(createMonthlyPartitionSql(bankKey, from, to));
    created.push(name);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  // پارتیشن default باید همیشه وجود داشته باشد تا درج روز خارج از بازه شکست نخورد
  await db.query(ensureDefaultPartitionSql(bankKey));
  return created;
}

/**
 * اجرای کامل اسکیمای v2 به‌صورت idempotent.
 * @param {{query: Function, exec?: Function}} db
 * @param {{registry: Record<string, object>, banks?: string[]}} options
 */
async function applySchemaV2(db, { registry, banks }) {
  const sqlFile = fs.readFileSync(path.join(__dirname, 'schema-v2.sql'), 'utf8');
  // اسکریپت چنددستوری است؛ اگر آداپتور `exec` داشته باشد از آن استفاده می‌شود
  if (typeof db.exec === 'function') await db.exec(sqlFile);
  else await db.query(sqlFile);
  const keys = banks || Object.keys(registry);
  const skipped = [];
  for (const bankKey of keys) {
    const table = tableNameOf(bankKey);
    // محافظ: اگر جدول موجود نسخهٔ v1 باشد (ستون `ts` را ندارد)، ساخت ایندکس v2 شکست می‌خورد.
    // در آن حالت به‌جای خطای مبهم، صریح گزارش می‌دهیم تا migration ابتدا پشتیبان بگیرد.
    const exists = await db.query(
      "SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='ts'",
      [table],
    );
    const hasV2Shape = Number(exists.rows[0]?.n ?? 0) > 0;
    const tableExists = await db.query(
      "SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
      [table],
    );
    if (Number(tableExists.rows[0]?.n ?? 0) > 0 && !hasV2Shape) {
      skipped.push(table);
      continue;
    }
    await db.query(createTableSql(bankKey, registry[bankKey]));
    for (const sql of createIndexesSql(bankKey, registry[bankKey])) await db.query(sql);
    await db.query(ensureDefaultPartitionSql(bankKey));
  }
  if (skipped.length) {
    throw new Error(
      `applySchemaV2: این جدول‌ها هنوز اسکیمای v1 دارند و باید ابتدا مهاجرت/تغییر نام شوند: ${skipped.join(', ')}`,
    );
  }
  /**
   * D3 — `schema_migrations` فقط یک مالک دارد: `services/db/migrations.js`.
   *
   * پیش‌تر این‌جا (و در `migrate-v2.js`) ردیف با نام‌های `v2`/`v2-data` و **بدون**
   * `name`/`checksum` درج می‌شد. روی دیتابیسی که مهاجرت نسخه‌دار را اجرا کرده، همان جدول
   * ستون‌های `name NOT NULL` دارد ⇒ خطای
   * «null value in column "name" of relation "schema_migrations"» و توقف مهاجرت v2.
   * حالا نسخهٔ اسکیمای v2 با یک ردیف سازگار و checksum‌دار ثبت می‌شود.
   */
  await db.query(
    `INSERT INTO schema_migrations(version, name, checksum, duration_ms)
     VALUES('002a-v2-schema-builder', 'schema-v2-builder (typed tables)', 'runtime-builder', 0)
     ON CONFLICT (version) DO NOTHING`,
  );
}

/**
 * seed رجیستری از spec فعلی بانک‌ها. `meta` شامل پرچم‌های رفتاری است که `summary`
 * لازم دارد (inspect، sortValue، onlyStatus، …) تا دیگر در ردیف ذخیره نشوند.
 */
async function seedRegistry(db, { registry, banksSpecs }) {
  for (const [bankKey, bankRegistry] of Object.entries(registry)) {
    const specs = banksSpecs[bankKey] || {};

    const rows = [];
    const flagSpecs = new Map((specs.flags || []).map((item) => [item.id, item]));
    bankRegistry.flag.forEach((id, index) => {
      const spec = flagSpecs.get(id) || {};
      rows.push([
        bankKey, KIND.FLAG, index + 1, id, spec.label ?? id, spec.topic ?? null,
        JSON.stringify({
          inspect: spec.inspect !== false,
          daily: !!spec.daily,
          sortValue: typeof spec.sortValue === 'function',
          card: spec.card ?? null,
          short: spec.short ?? null,
          hasRow: typeof spec.row === 'function',
        }),
      ]);
    });

    const sourceOf = {
      [KIND.CAT]: specs.categories,
      [KIND.PATH]: specs.paths,
      [KIND.COUNTER]: specs.counters,
      [KIND.METRIC]: specs.metrics,
      [KIND.SERVICE]: null,
      [KIND.ROTBE]: null,
    };
    const idOf = (item, kind) => (kind === KIND.PATH ? item.key : item.id);
    for (const kind of [KIND.CAT, KIND.PATH, KIND.SERVICE, KIND.COUNTER, KIND.METRIC, KIND.ROTBE]) {
      const source = sourceOf[kind] || [];
      bankRegistry[kind].forEach((id, index) => {
        const spec = source.find((item) => idOf(item, kind) === id) || {};
        rows.push([
          bankKey, kind, index + 1, id,
          spec.label ?? (kind === KIND.SERVICE ? id : id),
          spec.topic ?? null,
          JSON.stringify({
            inspect: spec.inspect !== false,
            inspectAll: !!spec.inspectAll,
            onlyStatus: spec.onlyStatus ?? null,
            inspectValues: spec.inspectValues ?? null,
            excludeValues: spec.excludeValues ?? null,
            inspectExcept: spec.inspectExcept ?? null,
            hasRow: typeof spec.row === 'function',
            daily: !!spec.daily,
          }),
        ]);
      });
    }

    for (const [bank, kind, code, id, label, topic, meta] of rows) {
      await db.query(
        `INSERT INTO indicator_registry(bank, kind, code, id, label, topic, meta)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (bank, kind, code) DO UPDATE
           SET id=EXCLUDED.id, label=EXCLUDED.label, topic=EXCLUDED.topic, meta=EXCLUDED.meta, active=true`,
        [bank, kind, code, id, label, topic, meta],
      );
    }
  }
}

/** فهرست پیکربندی «لیست‌ها» (title و ترتیب) — چون در ردیف ذخیره نمی‌شود */
async function seedListSpecs(db, { banksSpecs }) {
  for (const [bankKey, specs] of Object.entries(banksSpecs)) {
    const lists = specs.lists || [];
    for (let index = 0; index < lists.length; index++) {
      const spec = lists[index];
      await db.query(
        `INSERT INTO list_specs(bank, index, title, meta) VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT (bank, index) DO UPDATE SET title=EXCLUDED.title, meta=EXCLUDED.meta`,
        [bankKey, index, spec.title ?? `list-${index}`, JSON.stringify({ hasRow: typeof spec.row === 'function' })],
      );
    }
  }
}

/**
 * دیکشنری دسته‌بندی‌ها در حافظه + ثبت مقادیر تازه در `cat_dict`.
 * کدها پایدارند (هر مقدار یک‌بار) و باید با `cat_code` رجیستری کلید بخورند.
 */
function createCatDict(db) {
  const known = new Map(); // `${bank}:${catCode}` → Map(value → code)
  const reverse = new Map(); // `${bank}:${catCode}` → Map(code → value)
  const maxCode = new Map();

  const remember = (bank, catCode, value, code) => {
    const key = `${bank}:${catCode}`;
    if (!known.has(key)) known.set(key, new Map());
    if (!reverse.has(key)) reverse.set(key, new Map());
    known.get(key).set(value, Number(code));
    reverse.get(key).set(Number(code), value);
    maxCode.set(key, Math.max(maxCode.get(key) || 0, Number(code)));
  };

  return {
    async load(bank) {
      const result = await db.query(
        bank ? 'SELECT bank, cat_code, value, value_code FROM cat_dict WHERE bank=$1'
          : 'SELECT bank, cat_code, value, value_code FROM cat_dict',
        bank ? [bank] : [],
      );
      for (const row of result.rows) remember(row.bank, Number(row.cat_code), row.value, row.value_code);
    },
    /** @param {number} catCode کد cat در رجیستری (۱-پایه) */
    codeOf(bank, catCode, value) {
      const key = `${bank}:${catCode}`;
      const map = known.get(key) || new Map();
      known.set(key, map);
      const text = value === undefined || value === null ? 'null' : String(value);
      if (map.has(text)) return map.get(text);
      const code = (maxCode.get(key) || 0) + 1;
      reverse.get(key) || reverse.set(key, new Map());
      if (code > 127) {
        throw new Error(`دستهٔ ${catCode} بانک ${bank} از ۱۲۷ مقدار بیشتر شد؛ ستون cat_codes باید به int[] مهاجرت کند`);
      }
      map.set(text, code);
      reverse.get(key).set(code, text);
      maxCode.set(key, code);
      return code;
    },
    /** code → value با نقشهٔ معکوس (O(1)، نه پیمایش خطی) */
    valueOf(bank, catCode, code) {
      const map = reverse.get(`${bank}:${catCode}`);
      return map ? map.get(Number(code)) : undefined;
    },
    async flush(bank) {
      let inserted = 0;
      for (const [key, map] of known) {
        const [keyBank, catCode] = key.split(':');
        if (bank && keyBank !== bank) continue;
        if (!map.size) continue;
        const rows = [...map.entries()];
        for (let start = 0; start < rows.length; start += 200) {
          const chunk = rows.slice(start, start + 200);
          const values = chunk
            .map((_, index) => `($1,$${index * 3 + 2},$${index * 3 + 3},$${index * 3 + 4})`)
            .join(',');
          const params = [keyBank];
          for (const [value, code] of chunk) params.push(Number(catCode), code, value);
          const result = await db.query(
            `INSERT INTO cat_dict(bank, cat_code, value_code, value) VALUES ${values}
             ON CONFLICT (bank, cat_code, value_code) DO NOTHING`,
            params,
          );
          inserted += result.rowCount ?? chunk.length;
        }
      }
      return inserted;
    },
  };
}

module.exports = {
  createCatDict,
  SAMPLE_COLUMNS_PREFIX,
  BASE_COLUMNS,
  tableNameOf,
  typedColumnsOf,
  createTableSql,
  createIndexesSql,
  createMonthlyPartitionSql,
  ensureDefaultPartitionSql,
  ensureMonthlyPartitions,
  applySchemaV2,
  seedRegistry,
  seedListSpecs,
};
