'use strict';

/**
 * رجیستری شاخص‌ها — «نام‌ها فقط یک‌بار، نه در هر ردیف».
 *
 * نقش‌ها:
 *  - `flag`: جایگاه بیت پایدار (bit_pos) در ستون `flags bigint`. هرگز دوباره استفاده نمی‌شود؛
 *    شاخص حذف‌شده فقط `active=false` می‌شود تا دادهٔ قدیمی معنی‌اش را از دست ندهد.
 *  - `cat` / `path` / `service` / `counter` / `metric`: شناسهٔ عددی (`code`) که در ردیف ذخیره می‌شود.
 *
 * منبع حقیقت: spec هر بانک در `services/evaluator` (همان رجیستری قدیمی banks/*.js).
 * این ماژول فقط «ترتیب پایدار» می‌سازد و آن را به جدول `indicator_registry` می‌ریزد.
 */

const KIND = {
  FLAG: 'flag',
  CAT: 'cat',
  PATH: 'path',
  SERVICE: 'service',
  COUNTER: 'counter',
  METRIC: 'metric',
  ROTBE: 'rotbe',
};

// کدهای وضعیت سرویس (۳ بیت برای هر سرویس در ستون service_kinds)
const SERVICE_KIND_CODE = {
  ok: 1,
  failed: 2,
  other: 3,
  missingStatus: 4,
  invalidStatus: 5,
  missingService: 6,
};

const ROTBE_KINDS = ['missing', 'null', 'emptyArray', 'emptyObject', 'allKeysNull'];

// «نوع خالی بودن» مسیرها؛ ۲ بیت برای هر مسیر در ستون path_bits
const PATH_KINDS = ['emptyArray', 'emptyObject', 'allKeysNull'];

/** حداکثر تعداد شاخص قابل پشتیبانی با یک bigint (۶۳ بیت علامت‌دار) */
const MAX_FLAGS = 63;

/**
 * رجیستری هر بانک را از spec های ارزیاب می‌سازد.
 * @param {Record<string, {flags?: Array, categories?: Array, counters?: Array, metrics?: Array, paths?: Array, expectedServices?: string[]}>} banksSpecs
 */
function buildRegistry(banksSpecs) {
  const out = {};
  for (const [bankKey, spec] of Object.entries(banksSpecs)) {
    const registry = {
      flag: [],
      cat: [],
      path: [],
      service: [],
      counter: [],
      metric: [],
      rotbe: [],
    };
    const push = (kind, id) => {
      if (id === undefined || id === null || id === '') return;
      if (registry[kind].includes(id)) return;
      registry[kind].push(id);
    };

    for (const item of spec.flags || []) push(KIND.FLAG, item.id);
    for (const item of spec.categories || []) push(KIND.CAT, item.id);
    for (const item of spec.paths || []) push(KIND.PATH, item.key);
    push(KIND.PATH, '__rotbe');
    // فهرست سرویس‌های گزارش = expectedServices ∪ کلیدهای SERVICE_FA در evaluator
    // (`getSelectedServices`)؛ اگر فقط expectedServices را برداریم، ستون service_kinds ناقص می‌شود.
    for (const item of spec.selectedServices || spec.expectedServices || []) push(KIND.SERVICE, item);
    for (const item of spec.counters || []) push(KIND.COUNTER, item.id);
    for (const item of spec.metrics || []) push(KIND.METRIC, item.id);
    for (const kind of ROTBE_KINDS) push(KIND.ROTBE, kind);

    if (registry.flag.length > MAX_FLAGS) {
      throw new Error(
        `بانک ${bankKey}: ${registry.flag.length} شاخص بیش از ظرفیت ${MAX_FLAGS} بیت یک bigint است`,
      );
    }
    out[bankKey] = registry;
  }
  return out;
}

/** نام ستون typed یک متریک/کانتر در جدول نمونه‌ها */
function columnName(kind, id) {
  const prefix = kind === KIND.METRIC ? 'm' : 'c';
  const slug = String(id)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${prefix}_${slug}`;
}

/** ماسک بیت هر flag */
function flagMasks(registry) {
  const out = {};
  registry.flag.forEach((id, index) => {
    out[id] = 1n << BigInt(index);
  });
  return out;
}

/** شناسهٔ عددی (۱-پایه) هر مقدار در یک نوع */
function codeMap(registry, kind) {
  const out = {};
  (registry[kind] || []).forEach((id, index) => {
    out[id] = index + 1;
  });
  return out;
}

/**
 * بسته‌بندی وضعیت همهٔ سرویس‌ها در یک bigint (۳ بیت برای هر سرویس).
 * @param {object} registry
 * @param {Record<string, string>} services map: serviceKey → kind
 */
function packServiceKinds(registry, services) {
  let bits = 0n;
  registry.service.forEach((id, index) => {
    // در خروجی evaluator مقدار سرویس رشتهٔ ساده است (`'ok'`)، در مسیرهای دیگر آبجکت `{kind}`
    const entry = services?.[id];
    const rawKind = (entry && typeof entry === 'object' ? entry.kind : entry) ?? 'missingService';
    const code = SERVICE_KIND_CODE[rawKind] || SERVICE_KIND_CODE.missingService;
    bits |= BigInt(code) << (BigInt(index) * 3n);
  });
  return bits;
}

/** بازکردن بیت‌های سرویس‌ها برای گزارش */
function unpackServiceKinds(registry, bits) {
  const value = BigInt(bits ?? 0);
  const out = {};
  for (const [kind, code] of Object.entries(SERVICE_KIND_CODE)) {
    registry.service.forEach((id, index) => {
      const got = Number((value >> (BigInt(index) * 3n)) & 0b111n);
      if (got === code) out[id] = kind;
    });
  }
  return out;
}

/** مجموعهٔ بیت‌های روشن یک ردیف */
function flagIdsOf(registry, bits) {
  const value = BigInt(bits ?? 0);
  const out = [];
  registry.flag.forEach((id, index) => {
    if ((value >> BigInt(index)) & 1n) out.push(id);
  });
  return out;
}

module.exports = {
  KIND,
  PATH_KINDS,
  SERVICE_KIND_CODE,
  ROTBE_KINDS,
  MAX_FLAGS,
  buildRegistry,
  columnName,
  flagMasks,
  codeMap,
  packServiceKinds,
  unpackServiceKinds,
  flagIdsOf,
};
