'use strict';
const crypto = require('node:crypto');

const MESSAGE_RULES = [
  ['MSG_VALIDATION_SUCCESS', /validation was successful/i],
  ['MSG_HISTORY_NOT_ENOUGH', /historical data is not enough/i],
  ['MSG_OVERDUE_DEBT', /overdue debt/i],
  ['MSG_BOUNCED_CHECK', /bounced check/i],
  ['MSG_DUPLICATE_UNIQUE_KEY', /duplicate UniqueKey|شناسه یکتا تکراری/i],
];

const MESSAGE_TEXT = {
  MSG_VALIDATION_SUCCESS: 'درخواست اعتبارسنجی با موفقیت انجام شد.\nValidation was successful.',
  MSG_HISTORY_NOT_ENOUGH: 'اطلاعات تاریخچه اعتباری شما کافی نیست.\nYour historical data is not enough.',
  MSG_OVERDUE_DEBT: 'شما در حال حاضر بدهی معوق دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.\nYou currently have overdue debt.please improve your credit behavior and try again.',
  MSG_BOUNCED_CHECK: 'شما همچنان چک برگشتی دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.\nYou still have bounced check. please improve your credit behavior and try again.',
  MSG_DUPLICATE_UNIQUE_KEY: 'شناسه یکتا تکراری است!\nduplicate UniqueKey!',
  MSG_NO_MESSAGE: 'پیامی ثبت نشده است',
  MSG_UNKNOWN: 'سایر پیامها',
};

const MESSAGE_DICT_ROWS = [
  ['MSG_VALIDATION_SUCCESS', 'اعتبارسنجی موفق', 'success'],
  ['MSG_HISTORY_NOT_ENOUGH', 'سابقه اعتباری کافی نیست', 'success'],
  ['MSG_OVERDUE_DEBT', 'بدهی معوق', 'success'],
  ['MSG_BOUNCED_CHECK', 'چک برگشتی', 'success'],
  ['MSG_DUPLICATE_UNIQUE_KEY', 'شناسه یکتا تکراری', 'fail'],
  ['MSG_NO_MESSAGE', 'پیامی ثبت نشده است', 'other'],
  ['MSG_UNKNOWN', 'سایر پیامها', 'other'],
];

const CANONICAL_BY_TEXT = new Map(
  Object.entries(MESSAGE_TEXT)
    .filter(([key]) => key !== 'MSG_UNKNOWN')
    .map(([key, text]) => [text, key]),
);

function normalizeMessageText(raw) {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.join('\n');
}

function sanitizeMessageTemplate(raw) {
  const normalized = normalizeMessageText(raw);
  if (!normalized || normalized === 'پیامی ثبت نشده است') return 'پیامی ثبت نشده است';
  return normalized
    .replace(/\bIR\d{10,26}\b/gi, 'IR***')
    .replace(/[0-9۰-۹٠-٩]{8,}/g, '***');
}

const hash12 = (text) =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

function messageKeyOf(rawText) {
  const sanitized = sanitizeMessageTemplate(rawText);
  const exact = CANONICAL_BY_TEXT.get(sanitized);
  if (exact) return exact;
  for (const [key, pattern] of MESSAGE_RULES) {
    if (pattern.test(sanitized)) return `${key}:${hash12(sanitized)}`;
  }
  return `MSG_CUSTOM:${hash12(sanitized)}`;
}

function messageLabel(key) {
  if (MESSAGE_TEXT[key]) return MESSAGE_TEXT[key];
  const baseKey = String(key).split(':')[0];
  if (MESSAGE_TEXT[baseKey] && baseKey !== 'MSG_UNKNOWN') return MESSAGE_TEXT[baseKey];
  if (String(key).startsWith('MSG_UNKNOWN:') || String(key).startsWith('MSG_CUSTOM:')) {
    return `سایر پیامها (${String(key).split(':')[1] ?? ''})`;
  }
  return key;
}

function seedMessageDictSql() {
  const values = MESSAGE_DICT_ROWS.map(([key, label, topic]) => {
    const text = MESSAGE_TEXT[key] ?? label;
    const esc = (v) => `'${String(v).replace(/'/g, "''")}'`;
    return `(${esc(key)}, ${esc(label)}, ${esc(topic)}, ${esc(text)})`;
  }).join(',\n  ');
  return `INSERT INTO message_dict(message_key, label, topic, message_text) VALUES\n  ${values}\nON CONFLICT (message_key) DO UPDATE SET label=EXCLUDED.label, topic=EXCLUDED.topic, message_text=EXCLUDED.message_text;`;
}

module.exports = {
  MESSAGE_RULES,
  MESSAGE_TEXT,
  MESSAGE_DICT_ROWS,
  normalizeMessageText,
  sanitizeMessageTemplate,
  messageKeyOf,
  messageLabel,
  seedMessageDictSql,
};
