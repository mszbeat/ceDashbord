/**
 * فهرست یکتای پیامهای قالبی خروجی (PRD §8 / §12 / D-05).
 * متن پیام در ردیف نمونهها ذخیره نمیشود؛ فقط کلید آن نگهداری میشود.
 * برای تطابق دقیق با report.html، متن کامل همان پیام در message_dict است.
 */

import * as crypto from 'node:crypto';

export const MESSAGE_RULES: Array<[string, RegExp]> = [
  ['MSG_VALIDATION_SUCCESS', /validation was successful/i],
  ['MSG_HISTORY_NOT_ENOUGH', /historical data is not enough/i],
  ['MSG_OVERDUE_DEBT', /overdue debt/i],
  ['MSG_BOUNCED_CHECK', /bounced check/i],
  ['MSG_DUPLICATE_UNIQUE_KEY', /duplicate UniqueKey|شناسه یکتا تکراری/i],
];

export const MESSAGE_TEXT: Record<string, string> = {
  MSG_VALIDATION_SUCCESS: 'درخواست اعتبارسنجی با موفقیت انجام شد.\nValidation was successful.',
  MSG_HISTORY_NOT_ENOUGH: 'اطلاعات تاریخچه اعتباری شما کافی نیست.\nYour historical data is not enough.',
  MSG_OVERDUE_DEBT: 'شما در حال حاضر بدهی معوق دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.\nYou currently have overdue debt.please improve your credit behavior and try again.',
  MSG_BOUNCED_CHECK: 'شما همچنان چک برگشتی دارید. لطفا رفتار اعتباری خود را بهبود بخشید و دوباره امتحان کنید.\nYou still have bounced check. please improve your credit behavior and try again.',
  MSG_DUPLICATE_UNIQUE_KEY: 'شناسه یکتا تکراری است!\nduplicate UniqueKey!',
  MSG_NO_MESSAGE: 'پیامی ثبت نشده است',
  MSG_UNKNOWN: 'سایر پیامها',
};

export const MESSAGE_DICT_ROWS = [
  ['MSG_VALIDATION_SUCCESS', 'اعتبارسنجی موفق', 'success'],
  ['MSG_HISTORY_NOT_ENOUGH', 'سابقه اعتباری کافی نیست', 'success'],
  ['MSG_OVERDUE_DEBT', 'بدهی معوق', 'success'],
  ['MSG_BOUNCED_CHECK', 'چک برگشتی', 'success'],
  ['MSG_DUPLICATE_UNIQUE_KEY', 'شناسه یکتا تکراری', 'fail'],
  ['MSG_NO_MESSAGE', 'پیامی ثبت نشده است', 'other'],
  ['MSG_UNKNOWN', 'سایر پیامها', 'other'],
] as const;

const CANONICAL_BY_TEXT = new Map<string, string>(
  Object.entries(MESSAGE_TEXT)
    .filter(([key]) => key !== 'MSG_UNKNOWN')
    .map(([key, text]) => [text, key]),
);

/** نرمالسازی خطوط پیام دقیقاً مطابق trim در firstString/messageOf قدیمی. */
export function normalizeMessageText(raw: string): string {
  const lines = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.join('\n');
}

/**
 * ماسک کردن رشتههای عددی حساس احتمالی (کد ملی، شماره حساب/کارت/شبا/تلفن ۸+ رقمی)
 * پیش از ثبت در جدول واژگان message_dict تا ضمن حفظ تفکیک پیامهای متمایز، دادهٔ شخصی ذخیره نشود.
 */
export function sanitizeMessageTemplate(raw: string): string {
  const normalized = normalizeMessageText(raw);
  if (!normalized || normalized === 'پیامی ثبت نشده است') return 'پیامی ثبت نشده است';
  return normalized
    .replace(/\bIR\d{10,26}\b/gi, 'IR***')
    .replace(/[0-9۰-۹٠-٩]{8,}/g, '***');
}

const hash12 = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

export function messageKeyOf(rawText: string): string {
  const sanitized = sanitizeMessageTemplate(rawText);
  const exact = CANONICAL_BY_TEXT.get(sanitized);
  if (exact) return exact;
  for (const [key, pattern] of MESSAGE_RULES) {
    if (pattern.test(sanitized)) return `${key}:${hash12(sanitized)}`;
  }
  return `MSG_CUSTOM:${hash12(sanitized)}`;
}

export function messageLabel(key: string): string {
  if (MESSAGE_TEXT[key]) return MESSAGE_TEXT[key];
  const baseKey = key.split(':')[0];
  if (MESSAGE_TEXT[baseKey] && baseKey !== 'MSG_UNKNOWN') return MESSAGE_TEXT[baseKey];
  if (key.startsWith('MSG_UNKNOWN:') || key.startsWith('MSG_CUSTOM:')) return `سایر پیامها (${key.split(':')[1] ?? ''})`;
  return key;
}

export function seedMessageDictSql(): string {
  const values = MESSAGE_DICT_ROWS.map(([key, label, topic]) => {
    const text = MESSAGE_TEXT[key] ?? label;
    const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;
    return `(${esc(key)}, ${esc(label)}, ${esc(topic)}, ${esc(text)})`;
  }).join(',\n  ');
  return `INSERT INTO message_dict(message_key, label, topic, message_text) VALUES\n  ${values}\nON CONFLICT (message_key) DO UPDATE SET label=EXCLUDED.label, topic=EXCLUDED.topic, message_text=EXCLUDED.message_text;`;
}
