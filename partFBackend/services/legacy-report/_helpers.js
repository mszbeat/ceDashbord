'use strict';

// مسیرهای JSON فقط از کلیدهای خود شیء خوانده می‌شوند (نه زنجیرهٔ prototype).
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const get = (obj, dottedPath) => String(dottedPath).split('.').reduce(
  (value, key) => value != null && own(Object(value), key) ? value[key] : undefined,
  obj,
);

function emptyKind(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? null : 'emptyArray';
  if (typeof value === 'object') return Object.keys(value).length ? null : 'emptyObject';
  if (typeof value === 'string' && !value.trim()) return 'emptyString';
  return null;
}

function num(value) {
  if (value == null || !['number', 'string'].includes(typeof value)) return null;
  let text;
  try { text = String(value).trim(); } catch { return null; }
  if (!text || text.toLowerCase() === 'null') return null;
  const result = Number(text);
  return Number.isFinite(result) ? result : null;
}

const isFullArray = (value) => Array.isArray(value) && value.length > 0;
const asList = (value) => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
const isFullList = (value) => asList(value).length > 0 && (Array.isArray(value) || Object.keys(value).length > 0);

// هر گزارش یک میانگین از وام‌های قبلیِ دارای تعداد اقساط معتبر می‌سازد؛ سپس
// چارک‌ها و میانگین جدول عددی بر اساس «گزارش»، نه تک‌تک وام‌ها، محاسبه می‌شوند.
function meanInstallments(value, countOf) {
  const counts = asList(value).filter((loan) => loan && typeof loan === 'object' && !Array.isArray(loan))
    .map(countOf).filter((count) => Number.isSafeInteger(count) && count >= 0);
  return counts.length ? counts.reduce((sum, count) => sum + count, 0) / counts.length : null;
}
function declaredInstallments(loan) {
  const count = num(loan.count_installment);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

const ROTBE_CHECK_KEYS = [
  'personRoles', 'personInformation', 'reportUniqueId',
  'summaryInformationRelatedToContractsSum',
  'summaryInformationRelatedToContractsSumWithRoleType',
  'summaryInformationRelatedToContracts',
  'summaryInformationRelatedToContractsWithRoleType',
  'inquiryStats', 'directContracts', 'personNegativeStatus',
];

function isRotbeNullData(data, minNull = 3) {
  if (data === null || data === undefined || typeof data !== 'object') return true;
  return ROTBE_CHECK_KEYS.filter((key) => data[key] == null).length >= minNull;
}

// سال/ماه شمسی، سال/ماه/روز (مثل 14030631) و ارقام فارسی/عربی را می‌پذیریم.
const asciiDigits = (value) => String(value ?? '')
  .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
  .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
function ymIndex(value) {
  const text = asciiDigits(value).trim();
  let year, month, day;
  if (/^\d{6}(?:\d{2})?$/.test(text)) {
    year = Number(text.slice(0, 4)); month = Number(text.slice(4, 6));
    if (text.length === 8) day = Number(text.slice(6, 8));
  } else {
    const parts = text.match(/^(\d{4})[\s/._-]+(\d{1,2})(?:[\s/._-]+(\d{1,2}))?$/);
    if (!parts) return null;
    year = Number(parts[1]); month = Number(parts[2]);
    if (parts[3] !== undefined) day = Number(parts[3]);
  }
  if (year < 1300 || year > 1500 || month < 1 || month > 12) return null;
  if (day !== undefined && (day < 1 || day > (month <= 6 ? 31 : 30))) return null;
  return year * 12 + month - 1;
}
const ymFmt = (index) => `${Math.floor(index / 12)}/${String(index % 12 + 1).padStart(2, '0')}`;

function validationIdx(sample) {
  for (const path of ['ai_input.current_loan.date_granted', 'output.date_granted', 'insertDate_yearMonthDay', 'insertDate_full']) {
    const text = asciiDigits(get(sample, path)).trim();
    const direct = ymIndex(text);
    if (direct !== null) return direct;
    // insertDate_full علاوه بر روز، ساعت و دقیقه/ثانیه نیز دارد؛ فقط تاریخ را بخوان.
    if (!/^\d{4}/.test(text)) continue;
    const digits = text.replace(/\D/g, '');
    if (digits.length > 8 && digits.length <= 17) {
      const index = ymIndex(digits.slice(0, 8));
      if (index !== null) return index;
    }
  }
  return null;
}

module.exports = { get, own, emptyKind, num, isFullArray, asList, isFullList,
  meanInstallments, declaredInstallments, ROTBE_CHECK_KEYS, isRotbeNullData, ymIndex, ymFmt, validationIdx };
