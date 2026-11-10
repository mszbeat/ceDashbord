'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { get } = require('../banks/_helpers');
const { record, COMMON_CATS, COMMON_METRICS, COMMON_TOPICS, ROTBE_DEFAULT } = require('./common');

function finalize(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('برای هر بانک id معتبر الزامی است.');
  if (typeof raw.collected !== 'function') throw new Error(`بانک ${raw.id}: تابع collected تعریف نشده است.`);
  if (raw.creditSources && (typeof raw.creditSources.facilities !== 'function' || typeof raw.creditSources.cheques !== 'function')) {
    throw new Error(`بانک ${raw.id}: مسیرهای facilities و cheques برای شاخص‌های اعتباری باید تابع باشند.`);
  }
  const bank = { ...raw, key: raw.id.trim().toLowerCase(), label: raw.label || raw.id,
    rootLabel: raw.rootLabel || 'داده‌های ورودی' };
  for (const key of ['flags', 'cross', 'categories', 'counters', 'metrics', 'lists', 'topics', 'expectedServices']) {
    bank[key] = [...(raw[key] || [])];
  }
  bank.paths = (raw.paths || []).map((item) => typeof item === 'string'
    ? { key: item, label: `${bank.rootLabel}.${item}`, get: (c) => get(c, item) }
    : { ...item, key: item.key || item.label });
  for (const spec of COMMON_CATS) if (!bank.categories.some((x) => x.id === spec.id)) bank.categories.push(spec);
  for (const spec of COMMON_METRICS) {
    if (!(bank.omitCommonMetrics || []).includes(spec.id) && !bank.metrics.some((x) => x.id === spec.id)) bank.metrics.push({ ...spec });
  }
  require('./facilities').attachFacilities(bank);
  require('./loan-delays').attachDelays(bank);
  require('./data-monitoring').attachDataMonitoring(bank);
  require('./resalat-deposits').attachResalatDeposits(bank);
  for (const metric of bank.metrics) {
    if (['lnAvgInstallments', 'avg36', 'depAvg36'].includes(metric.id)) metric.derived = true;
    if (['pd', 'rPd', 'postPd'].includes(metric.id)) metric.preserveFraction = true;
    if (metric.id === 'totalTime') metric.summaryDecimals = 2;
    if (['tavan_mellat','tavan_postbank'].includes(bank.key) && ['pd','postPd'].includes(metric.id)) {
      metric.hist = { bins: [
        { min:0, max:.1, label:'۰٫۰۰ تا کمتر از ۰٫۱۰' },
        ...[[.1,.2],[.2,.3],[.3,.4],[.4,.5]].map(([min,max]) => ({min,max,label:`${min.toFixed(2)} تا کمتر از ${max.toFixed(2)}`})),
        { value:.5, label:'دقیقاً ۰٫۵۰' },
        { min:.5, max:.6, excludeMin:true, label:'بیشتر از ۰٫۵۰ تا کمتر از ۰٫۶۰' },
        { min:.6, max:.8, label:'۰٫۶۰ تا کمتر از ۰٫۸۰' },
        { min:.8, max:1, includeMax:true, label:'۰٫۸۰ تا ۱٫۰۰' },
      ] };
      if (bank.key === 'tavan_postbank') metric.histNote = 'در مدل no_strategy مقدار ۰٫۵ پیش‌فرض است و لزوماً برآورد ریسک مدل نیست. ردیف دقیقاً ۰٫۵۰ تمام گزارش‌های دارای این مقدار را می‌شمارد؛ از مقدار ۰٫۵ به‌تنهایی نام مدل استنباط نمی‌شود. این مقدار در آمار عددی احتمال نکول باقی می‌ماند.';
      else metric.histNote = 'مقدار دقیق ۰٫۵ در ردیف مستقل «دقیقاً ۰٫۵۰» شمرده می‌شود و در بازه‌های مجاور قرار نمی‌گیرد. مقایسه بر مقدار خام، پیش از گردکردن نمایش است؛ این مقدار از آمار عددی حذف نمی‌شود.';
    }
  }
  if (bank.key === 'tavan_resalat') for (const [id, path, label] of [
    ['negativeLastYear', 'output.num_negative_status_last_year', 'وضعیت‌های منفی سال اخیر'],
    ['negativePreviousYear', 'output.num_negative_status_1_2years', 'وضعیت‌های منفی یک تا دو سال اخیر'],
  ]) bank.flags.push({ id, topic: 'features', label,
    test: (_c, s) => require('../banks/_helpers').num(get(s, path)) > 0,
    row: (_c, s) => ({ 'تعداد وضعیت‌های منفی': require('../banks/_helpers').num(get(s, path)) }) });
  bank.catById = record();
  for (const spec of bank.categories) bank.catById[spec.id] = spec;
  bank.rotbePath = bank.schema?.rotbe || raw.rotbePath || ROTBE_DEFAULT;
  for (const key of ['flags', 'cross', 'categories', 'counters', 'metrics', 'topics']) {
    const seen = new Set();
    for (const spec of bank[key]) {
      if (!/^[a-z][\w-]*$/i.test(spec.id) || seen.has(spec.id)) throw new Error(`بانک ${bank.id}: شناسهٔ تکراری یا نامعتبر در ${key}: ${spec.id}`);
      seen.add(spec.id);
    }
  }
  for (const topic of bank.topics) if (COMMON_TOPICS[topic.id]) throw new Error(`بانک ${bank.id}: بخش ${topic.id} از قبل تعریف شده است.`);
  return bank;
}

function loadBanks({ minNull }) {
  const banks = record();
  const dir = path.join(__dirname, '..', 'banks');
  for (const filename of fs.readdirSync(dir).sort()) {
    if (!filename.endsWith('.js') || filename.startsWith('_')) continue;
    const loaded = require(path.join(dir, filename));
    const bank = finalize(typeof loaded === 'function' ? loaded({ minNull }) : loaded);
    if (banks[bank.key]) throw new Error(`banks/${filename}: شناسهٔ ${bank.id} تکراری است.`);
    banks[bank.key] = bank;
  }
  return banks;
}

function autoBank(method) {
  const id = method || '(بدون input.method)';
  return finalize({ id, label: id, auto: true, rootLabel: 'دادهٔ جمع‌آوری‌شده', showKeys: true,
    collected: (sample) => get(sample, 'input.data.collectedData') ?? get(sample, 'collectedData') ?? get(sample, 'input.data'),
  });
}
module.exports = { loadBanks, autoBank };
