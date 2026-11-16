'use strict';
const { get, num } = require('../banks/_helpers');
const { nf } = require('./common');
const { SCHEMAS } = require('./schema');
const { normalizeFacilities, facilityKind } = require('./facility-items');
const FIELDS = [
  ['AmOriginal', 'اصل تسهیلات، بدون سود'], ['AmBenefit', 'سود تسهیلات'], ['AmBedehiKol', 'بدهی کل'],
  ['AmMoavagh', 'بدهی معوق'], ['AmSarResid', 'بدهی سررسیدگذشته'], ['AmMashkuk', 'مطالبات مشکوک‌الوصول'],
];
const TOTALS = { AmOriginal: 'TotalAmTashilat', AmBedehiKol: 'TotalAmBedehi',
  AmMoavagh: 'TotalAmMoavagh', AmSarResid: 'TotalAmSarResid', AmMashkuk: 'TotalAmMashkuk' };
const validItem = (x) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length > 0;
const visibleCode = (x) => x != null && /^\d+$/.test(String(x).trim());
const amount = (x) => { const n = num(x); return n !== null && n >= 0 ? n : null; };
function arrayKind(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (!Array.isArray(value)) return 'invalidArray';
  if (!value.length) return 'emptyArray';
  return value.every(validItem) ? null : 'invalidItems';
}
function attachFacilities(bank) {
  const schema = SCHEMAS[bank.key];
  if (!schema) return;
  bank.schema = schema;
  const cache = new WeakMap();
  function info(_c, sample) {
    if (cache.has(sample)) return cache.get(sample);
    const {kind,items} = normalizeFacilities(get(sample, schema.facilities));
    const units = new Set(items.map((item) => {
      const unit = item[schema.currency];
      return typeof unit === 'string' && /^[A-Za-z]{3}$/.test(unit.trim()) ? unit.trim().toUpperCase() : 'unknown';
    }));
    const currency = !items.length ? 'noItems' : units.has('unknown') ? 'unknown' : units.size > 1 ? 'mixed'
      : units.has('IRR') ? 'irr' : 'other';
    const sums = {}, positive = {}, invalid = {};
    for (const [key] of FIELDS) {
      const numbers = items.map((item) => amount(item[key]));
      positive[key] = numbers.filter((n) => n !== null && n > 0).length;
      invalid[key] = numbers.filter((n) => n === null).length;
      const sum = numbers.reduce((n, value) => n + (value || 0), 0);
      sums[key] = kind === null && currency === 'irr' && !invalid[key] && Number.isFinite(sum) ? sum : null;
    }
    // فقط گزارش‌هایی که هر دو مبلغ برای تمام تسهیلات‌شان معتبر است.
    const combined = sums.AmOriginal !== null && sums.AmBenefit !== null
      ? sums.AmOriginal + sums.AmBenefit : null;
    sums.principalAndBenefit = combined !== null && Number.isFinite(combined) ? combined : null;
    const banks = new Set(items.map((i) => i[schema.bankCode]).filter(visibleCode).map((x) => String(Number(x))));
    const result = { kind, items, currency, sums, positive, invalid, banks: banks.size };
    cache.set(sample, result);
    return result;
  }
  bank.facilityInfo = info;
  bank.facilityNote = 'اصل تسهیلات مبلغ بدون سود است؛ جمع اصل و سود از AmOriginal + AmBenefit ساخته می‌شود. اگر سودِ ثبت‌شده صفر باشد، مجموع با اصل برابر است؛ سود غایب یا null صفر فرض نمی‌شود. این مجموع جایگزین ماندهٔ بدهی یا بدهی سررسیدنشده نیست، زیرا پرداخت‌های انجام‌شده از آن کسر نشده‌اند. بدهی کل مستقیماً از AmBedehiKol خوانده می‌شود و سود دوباره به آن اضافه نمی‌شود. تعداد گزارش معتبرِ ردیف اصل، سود و مجموع ممکن است متفاوت باشد.';
  const mellat = bank.key === 'tavan_mellat';
  bank.topics.push({ id: 'facilities', icon: '▣', label: 'تسهیلات سمات',
    desc: 'تعداد تسهیلات، اجزای بدهی، پوشش مبلغ و کیفیت دادهٔ سمات',
    details: `منبع قطعی: <code>${schema.facilities}</code>. در هر سه بانک، null صریح یا [] در همین کلید یعنی بدون تسهیلات؛ یک شیء غیرخالی یک تسهیلات و آرایهٔ اشیا چند تسهیلات است. کلید غایب، آبجکت خالی و ساختار نامعتبر بدون تسهیلات فرض نمی‌شوند. تبدیل شکل داده فقط در محاسبه است و JSON خام تغییر نمی‌کند. هر گزارش یک‌بار در هر شاخص شمرده می‌شود؛ وجود مبلغ مثبت در دست‌کم یک تسهیلات کافی است. این بخش فقط دادهٔ سمات را توصیف می‌کند و برخلاف هشدار تأییدشدهٔ بدهی، نیازمند پیام خروجی نیست. جمع‌ها به‌ازای هر گزارش و فقط برای آیتم منفرد یا آرایهٔ سالم، مبالغ کامل و نامنفی و واحد IRR در تمام ردیف‌ها محاسبه می‌شوند. null، دادهٔ پوشانده‌شده و واحد نامعلوم صفر یا ریال فرض نمی‌شوند. جمع اجزای بدهی به‌عنوان بدهی کل استفاده نمی‌شود؛ AmBedehiKol مستقیماً خوانده می‌شود. «تعداد بانک‌های شناسایی‌شده» یعنی تعداد بانک‌های متفاوت بر اساس کد بانک در تسهیلات این گزارش؛ کد تکراری یک‌بار شمرده می‌شود و کد نامعلوم کنار می‌رود. ${mellat ? 'در ملت، نبود شناسه، شعبه، Status یا سایر داده‌های پوشانده‌شده به‌تنهایی نقص مالی یا وضعیت نامطلوب نیست؛ صفر بودن دیرکرد هم از null نتیجه نمی‌شود.' : 'نام و شناسهٔ اشخاص، قرارداد، درخواست، بانک و شعبه در جدول عمومی ردیف‌ها منتشر نمی‌شوند.'}` });
  const countRow = (c, s) => ({ 'تعداد تسهیلات قابل خواندن': info(c, s).items.length });
  bank.flags.push(
    { id: 'facilityEmpty', topic: 'facilities', label: 'بدون تسهیلات', inspect: false, card: 'neutral', test: (c, s) => ['emptyArray','null'].includes(info(c, s).kind) },
    { id: 'facilityPresent', topic: 'facilities', label: 'دارای تسهیلات', inspect: false, card: 'normal', test: (c, s) => info(c, s).items.length > 0 },
    ...[['AmMoavagh', 'facilityOverdue', 'بدهی معوق مثبت در تسهیلات'], ['AmSarResid', 'facilityPastDue', 'بدهی سررسیدگذشتهٔ مثبت در تسهیلات'], ['AmMashkuk', 'facilityDoubtful', 'مطالبات مشکوک‌الوصول مثبت در تسهیلات']].map(([field, id, label]) => ({
      id, label, topic: 'facilities', card: 'warn', daily: true,
      test: (c, s) => info(c, s).positive[field] > 0,
      row: (c, s) => ({ ...countRow(c, s), 'تعداد تسهیلات مشمول این شاخص': info(c, s).positive[field] }),
    })),
  );
  bank.metrics.push(
    { id: 'facilityCount', topic: 'facilities', label: 'تعداد تسهیلات هر گزارش', pathNote: schema.facilities,
      value: (c, s) => [null, 'emptyArray', 'null'].includes(info(c, s).kind) ? info(c, s).items.length : null },
    { id: 'facilityBankCount', topic: 'facilities', label: 'تعداد بانک‌های شناسایی‌شده', sourcePath: `${schema.facilities}[*].${schema.bankCode}`,
      value: (c, s) => info(c, s).banks || null },
    ...FIELDS.flatMap(([field, title]) => [
      { id: `facilitySum${field}`, topic: 'facilities', group: 'جمع‌های ریالی به‌ازای هر گزارش',
        label: `جمع ${title} در هر گزارش (ریال)`, pathNote: `${schema.facilities}[*].${field}`, format: nf, derived: true, hideIfEmpty: true,
        value: (c, s) => info(c, s).sums[field] },
      ...(field === 'AmBenefit' ? [{ id:'facilityPrincipalAndBenefit', topic:'facilities', group:'جمع‌های ریالی به‌ازای هر گزارش',
        label:'جمع اصل و سود تسهیلات در هر گزارش (ریال)',
        pathNote:`${schema.facilities}[*]: AmOriginal + AmBenefit`, format:nf, derived:true, hideIfEmpty:true,
        value:(c,s)=>info(c,s).sums.principalAndBenefit }] : []),
    ]),
  );
  // کنترل‌های کیفیت، خود آرایه را می‌خوانند، نه پوشش data/meta یا نسخهٔ جایگزین.
  const core = [
    ['tashilat', 'آیتم یا آرایهٔ تسهیلات سمات', schema.facilities], ['samatChequeList', 'آرایهٔ چک‌های برگشتی', schema.cheques],
    ['historicalLoans', 'آرایهٔ سابقهٔ وام', schema.loans], ['depositRecords', 'آرایهٔ سپرده', schema.deposit],
  ];
  bank.paths = core.map(([key, label, displayPath]) => ({ key, label, displayPath,
    get: (_c, s) => get(s, displayPath), kind: key === 'tashilat' ? facilityKind : arrayKind }));
  if (bank.key === 'tavan_resalat') bank.paths.push({ key: 'meratInformation', label: 'اطلاعات مرآت',
    displayPath: `${schema.root}.meratInformation`, get: (_c, s) => get(s, `${schema.root}.meratInformation`) });
  bank.rotbePath = schema.rotbe;
}
module.exports = { attachFacilities, arrayKind, FIELDS, TOTALS };
