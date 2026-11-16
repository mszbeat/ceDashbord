'use strict';
const { get, num } = require('../banks/_helpers');
// فقط روزهای ثبت‌شده؛ هیچ تفاضل تاریخ یا صفرسازیِ null انجام نمی‌شود.
function installmentDelays(loans, method) {
  let max = null, observed = 0, delayed = 0;
  const accept = (values) => {
    const valid = values.map(num).filter((n) => n !== null && Number.isInteger(n) && n >= 0);
    if (!valid.length) return;
    const days = valid.reduce((m, n) => Math.max(m, n), 0);
    observed++;
    if (days > 0) delayed++;
    max = max === null ? days : Math.max(max, days);
  };
  for (const loan of Array.isArray(loans) ? loans : []) {
    if (!loan || typeof loan !== 'object' || Array.isArray(loan)) continue;
    if (method === 'tavan_resalat') {
      for (const key of Object.keys(loan)) if (/^delay_dayes_\d+$/.test(key)) accept([loan[key]]);
    } else for (const installment of Array.isArray(loan.installments) ? loan.installments : []) {
      if (!installment || typeof installment !== 'object') continue;
      if (method === 'tavan_postbank') accept([installment.numberOfDaysOfDelay]);
      else accept((Array.isArray(installment.installmentPayments) ? installment.installmentPayments : [])
        .map((payment) => payment?.delay));
    }
  }
  return { max, observed, delayed };
}
function attachDelays(bank) {
  if (!bank.schema || bank.key === 'tavan_mellat') return;
  const cache = new WeakMap();
  const stats = (_c, sample) => {
    if (!cache.has(sample)) cache.set(sample, installmentDelays(get(sample, bank.schema.loans), bank.key));
    return cache.get(sample);
  };
  bank.delayExplanation = `بیشترین تأخیر یک قسط، مدت دیرکرد به روز است؛ روز صفر مقدار معتبر و بدون دیرکرد است. null و مقدار نامعتبر صفر فرض نمی‌شوند. گزارش‌ها بر اساس بیشترین تأخیرشان فقط در یک بازه قرار می‌گیرند: ۳۰ تا کمتر از ۶۰، ۶۰ تا ۹۰ (شامل ۹۰)، یا بیشتر از ۹۰. هر فهرست قبل از اعمال سقف نمایش، از بیشترین تأخیر به کمترین مرتب می‌شود.`;
  const ranges = [
    ['delay30', 'تأخیر از ۳۰ تا کمتر از ۶۰ روز', (d) => d >= 30 && d < 60],
    ['delay60', 'تأخیر از ۶۰ تا ۹۰ روز', (d) => d >= 60 && d <= 90],
    ['delay90', 'تأخیر بیشتر از ۹۰ روز', (d) => d > 90],
  ];
  for (const [id, label, matches] of ranges) {
    let flag = bank.flags.find((f) => f.id === id);
    if (!flag) { flag = { id, topic: 'loans', card: 'warn' }; bank.flags.push(flag); }
    Object.assign(flag, { label, short: label,
      test: (c, s) => stats(c, s).max !== null && matches(stats(c, s).max),
      sortValue: (c, s) => stats(c, s).max,
      row: (c, s) => ({ 'بیشترین تأخیر قسط این گزارش (روز)': stats(c, s).max }) });
  }
  for (const [id, label, value] of [
    ['lnMaxDelay', 'بیشترین تأخیر یک قسط (روز)', (c, s) => stats(c, s).max],
    ['lnDelayed', 'تعداد اقساط دارای تأخیر', (c, s) => stats(c, s).observed ? stats(c, s).delayed : null],
  ]) {
    let metric = bank.metrics.find((m) => m.id === id);
    if (!metric) { metric = { id, topic: 'loans', hideIfEmpty: true }; bank.metrics.push(metric); }
    Object.assign(metric, { label, value });
  }
}
module.exports = { attachDelays, installmentDelays };
