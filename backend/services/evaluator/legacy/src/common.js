'use strict';
const { get, num } = require('../banks/_helpers');

const record = () => Object.create(null);
const toText = (value) => {
  if (value == null) return '';
  try { return typeof value === 'object' ? JSON.stringify(value) : String(value); }
  catch { return '[مقدار نامعتبر]'; }
};
const h = (value) => toText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// دادهٔ استخراج‌شده از JSON هرگز نباید بتواند تگ script گزارش را ببندد.
const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const nf = (value) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 20 });
const intFmt = (value) => nf(Math.round(value));
const pct = (part, total) => {
  if (!total) return '—';
  const value = part * 100 / total;
  // مقدار مثبتِ بسیار کوچک را به‌جای صفر، با کران نمایش می‌دهیم.
  return value > 0 && value < .01 ? '<0.01٪' : `${Number(value.toFixed(2))}٪`;
};
const compareReviewRows = (a, b) => (b.__rank ?? 0) - (a.__rank ?? 0) || (a.__order ?? 0) - (b.__order ?? 0);
const safeId = (value) => String(value).replace(/[^a-z0-9_-]/gi, '_');

function firstString(sample, paths) {
  for (const path of paths) {
    const value = get(sample, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
function messageOf(sample) {
  const fa = firstString(sample, ['output.message.fa', 'output.data.message.fa']);
  const en = firstString(sample, ['output.message.en', 'output.data.message.en']);
  if (fa || en) return [fa, en].filter(Boolean).join('\n');
  return firstString(sample, ['output.message', 'output.data.message']) || 'پیامی ثبت نشده است';
}

const COMMON_CATS = [
  { id: 'statusCode', topic: 'status', label: 'کد وضعیت خروجی (output.statusCode)', splitByStatus: false,
    classify: (_c, report, folderStatus) => {
      const value = get(report, 'output.statusCode');
      if (value === null || value === undefined || value === '') return folderStatus === 'success' ? '200' : 'ثبت نشده';
      return String(value) === '200' ? '200' : String(value);
    } },
  { id: 'errorCode', topic: 'status', label: 'کد خطای سرویس در گزارش‌های ناموفق (output.meta.code)', onlyStatus: 'fail',
    classify: (_c, s) => String(get(s, 'output.meta.code') ?? 'کد خطا ثبت نشده است') },
  { id: 'messageSuccess', topic: 'status', label: 'پیام‌های گزارش‌های موفق', onlyStatus: 'success', classify: (_c, s) => messageOf(s) },
  { id: 'messageFail', topic: 'status', label: 'پیام‌های گزارش‌های ناموفق', onlyStatus: 'fail', classify: (_c, s) => messageOf(s) },
  { id: 'modelName', topic: 'model', label: 'تعداد درخواست‌های موفق به تفکیک مدل', onlyStatus: 'success',
    inspectAll: true, excludeValues: ['نام مدل ثبت نشده است'], inspectExcept: ['نام مدل ثبت نشده است'],
    classify: (_c, s) => { const output = get(s, 'output'), name = get(s, 'output.model_name');
      return output && typeof output === 'object' && !Array.isArray(output) && typeof name === 'string' && name.trim() ? name.trim() : 'نام مدل ثبت نشده است'; } },
];

const TIERS = [['Excellent', 'عالی'], ['Very_Good', 'خیلی خوب'], ['Good', 'خوب'], ['Medium_Good', 'متوسط رو به خوب'],
  ['Medium', 'متوسط'], ['Medium_Bad', 'متوسط رو به بد'], ['Bad', 'بد'], ['Very_Bad', 'خیلی بد']];
const million = (low, high) => high === Infinity ? `${low / 1e6} میلیون و بیشتر` : `${low / 1e6} تا کمتر از ${high / 1e6} میلیون`;
const COMMON_METRICS = [
  { id: 'pd', common: true, topic: 'overview', label: 'احتمال نکول (PD)', format: nf,
    hist: { edges: [0, .05, .1, .2, .3, .4, .5, .6, .8, 1.0000001], fmt: (n) => n.toFixed(2) },
    value: (_c, s) => num(get(s, 'output.PD')) },
  { id: 'creditBasket', common: true, topic: 'overview', label: 'سبد اعتباری (Credit_Basket)', format: nf,
    hist: { edges: [0, 1e7, 2e7, 3e7, 5e7, 7.5e7, 1e8, 1.5e8, 2e8, 3e8, 5e8, Infinity], label: million },
    value: (_c, s) => num(get(s, 'output.Credit_Basket')) },
  { id: 'scoreReq', common: true, topic: 'overview', label: 'امتیاز وام درخواستی', format: nf,
    value: (_c, s) => num(get(s, 'output.score_for_requested_loan')) },
  { id: 'totalTime', common: true, topic: 'overview', label: 'زمان اجرای مدل (ثانیه)', format: nf,
    value: (_c, s) => num(get(s, 'output.total_time')) },
  ...TIERS.map(([key, fa]) => ({ id: `tbp_${key}`, common: true, topic: 'overview',
    group: 'توان بازپرداخت: سقف هر رده', label: `ردهٔ «${fa}» (${key})`, format: nf,
    value: (_c, s) => num(get(s, `output.Tavan_Baz_Pardakht.${key}.max`)) })),
];

const COMMON_TOPICS = {
  overview: { icon: '◈', label: 'نمای کلی', desc: 'حجم داده، نرخ موفقیت و توزیع شاخص‌های اصلی مدل' },
  risk: { icon: '⚠', label: 'بدهی معوق و چک برگشتی', desc: 'موارد تأییدشده در گزارش‌های موفق با تطبیق پیام خروجی و دادهٔ سمات' },
  status: { icon: '☷', label: 'وضعیت و پیام‌ها', desc: 'کدها، پیام‌های خروجی و کامل بودن وضعیت سرویس‌های ورودی' },
  model: { icon: '◇', label: 'مدل‌های اجراشده', desc: 'تعداد درخواست‌های موفق برای هر نام مدل' },
  empty: { icon: '◫', label: 'کیفیت کلیدها', desc: 'درصد مقدارهای خالی، کلیدهای غایب و نوع نقص داده' },
  lists: { icon: '⚑', label: 'گزارش‌های قابل بررسی', desc: 'فهرست گزارش‌های نیازمند بررسی با امکان جست‌وجو و مشاهدهٔ جزئیات' },
  daily: { icon: '▦', label: 'روند روزانه', desc: 'تعداد و نسبت شاخص‌های منتخب در هر روز' },
};
const KIND_FA = { invalidFacility: 'ساختار نامعتبر تسهیلات؛ نه آیتم و نه آرایهٔ آیتم‌ها', invalidArray: 'مقدار آرایه نیست', invalidItems: 'ردیف نامعتبر در آرایه', missing: 'کلید موجود نیست', null: 'مقدار null', emptyArray: 'آرایهٔ خالی',
  emptyObject: 'آبجکت خالی', emptyString: 'رشتهٔ خالی', allKeysNull: 'تمام کلیدهای اصلی null هستند' };
const SERVICE_FA = { EstelamAsliRows: 'استعلام سمات (تسهیلات)', chequeList: 'چک‌های برگشتی', iran: 'رتبه‌بندی (ایران)',
  historical_loans: 'سوابق وام‌های قبلی', averageDeposit: 'میانگین سپرده' };
const ROTBE_DEFAULT = 'input.data.rotbebandiStandard.data';
const ROTBE_IGNORE = new Set(['inquiryCreatedDate', 'inquiryHistories', 'indirectContracts']);

module.exports = { record, toText, h, safeJson, nf, intFmt, pct, compareReviewRows, safeId, messageOf, COMMON_CATS, COMMON_METRICS,
  COMMON_TOPICS, KIND_FA, SERVICE_FA, ROTBE_DEFAULT, ROTBE_IGNORE, TIERS };
