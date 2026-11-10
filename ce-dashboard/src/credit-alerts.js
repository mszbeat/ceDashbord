'use strict';
/** تطبیق پیام خروجی با دادهٔ ساختاریافتهٔ سمات؛ فقط برای گزارش‌های موفق فراخوانی می‌شود. */
const { get, num } = require('../banks/_helpers');
const { normalizeFacilities } = require('./facility-items');

const tidy = (value) => String(value ?? '').replace(/ي|ى/g, 'ی').replace(/ك/g, 'ک')
  .replace(/[\u200c\u200d]/g, ' ').replace(/\s+/g, ' ').trim();
const masked = (value) => !value || /^[*＊xX#._\s-]+$/.test(value) || value === 'null';

function messages(sample) {
  const values = ['output.message.fa', 'output.message.en', 'output.data.message.fa', 'output.data.message.en',
    'output.message', 'output.data.message'].map((key) => get(sample, key));
  return values.filter((value) => typeof value === 'string' && value.trim()).map(tidy);
}
function messageMatches(sample) {
  const values = messages(sample);
  return {
    overdue: values.some((value) => /(?:بدهی\s+معوق\s+دارید|دارای\s+بدهی\s+معوق\s+هستید|you\s+(?:currently\s+)?have\s+overdue\s+debts?)/i.test(value)),
    cheque: values.some((value) => /(?:چک\s+برگشتی\s+دارید|دارای\s+چک\s+برگشتی\s+هستید|you\s+(?:still\s+)?have\s+(?:a\s+)?bounced\s+che(?:ck|que)s?)/i.test(value)),
  };
}
function branchInfo(item, fields) {
  const choices = fields.map((field) => ({ field, value: tidy(item[field]) }))
    .filter(({ value }) => value && value !== 'null');
  const found = choices.find(({ value }) => !masked(value)) || choices[0];
  const raw = found?.value || '';
  const match = raw.match(/بانک\s+(.+?)(?=\s*(?:[-–—/،]|شعبه(?:\s|$))|$)/);
  return { bank: match && !masked(match[1]) ? `بانک ${match[1].trim()}` : 'نام بانک مشخص نیست',
    branch: !raw ? 'شعبه ثبت نشده' : masked(raw) ? 'نام شعبه پوشانده شده' : raw,
    field: found?.field || 'ثبت نشده' };
}
function currencyOf(item) {
  const value = ['ArzCode', 'ArzCD', 'currencyCode', 'currency'].map((key) => item[key])
    .find((entry) => entry != null && tidy(entry) && !masked(tidy(entry)));
  const text = tidy(value);
  return text === 'IRR' || text === 'ریال' ? 'ریال' : text || 'واحد ثبت نشده';
}
function chequCEdashboardte(value) {
  const text = tidy(value);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}/${text.slice(4, 6)}/${text.slice(6, 8)}` : text || 'ثبت نشده';
}
// جمع هر گزارش تنها برای مبلغ‌های کامل با واحد یکسان مجاز است؛ واحد نامشخص
// هرگز به‌صورت خودکار ریال فرض نمی‌شود و در کنار جمع با همان عنوان درج می‌شود.
function summarizeAmounts(items) {
  const units = new Set(items.map((item) => item.currency));
  const currency = units.size === 1 ? items[0].currency : 'واحدهای متفاوت یا نامشخص';
  if (items.some((item) => item.amount === null || item.amount < 0)) {
    return { totalAmount: null, currency, totalIssue: 'مبلغ یک یا چند مورد نامعتبر یا ثبت‌نشده است' };
  }
  if (units.size !== 1) return { totalAmount: null, currency, totalIssue: 'واحد مبالغ یکسان نیست' };
  const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);
  return Number.isFinite(totalAmount) ? { totalAmount, currency, totalIssue: null }
    : { totalAmount: null, currency, totalIssue: 'مجموع مبالغ معتبر نیست' };
}
function detectCreditAlerts(bank, collected, sample) {
  if (!bank.creditSources) return { overdue: null, cheque: null };
  const match = messageMatches(sample);
  let overdue = null, cheque = null;
  if (match.overdue) {
    const source = bank.creditSources.facilities(collected, sample);
    const items = normalizeFacilities(source).items.flatMap((facility) => {
      if (!facility || typeof facility !== 'object' || Array.isArray(facility)) return [];
      const amount = num(facility.AmMoavagh);
      if (amount === null || amount <= 0) return [];
      return [{ amount, ...branchInfo(facility, ['ShobeName', 'BnkShb', 'BankName', 'BranchName']),
        currency: currencyOf(facility) }];
    });
    if (items.length) overdue = { items, ...summarizeAmounts(items) };
  }
  if (match.cheque) {
    const source = bank.creditSources.cheques(collected, sample);
    const items = (Array.isArray(source) ? source : []).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.keys(entry).length) return [];
      return [{ amount: num(entry.amountCheque), ...branchInfo(entry, ['bankBranch', 'ShobeName', 'BnkShb']),
        currency: currencyOf(entry), date: chequCEdashboardte(entry.dateBackCheque) }];
    });
    if (items.length) cheque = { items, ...summarizeAmounts(items) };
  }
  return { overdue, cheque };
}
module.exports = { detectCreditAlerts, messageMatches, branchInfo };
