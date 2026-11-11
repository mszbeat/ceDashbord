/**
 * فهرست یکتای پیامهای قالبی خروجی (PRD §8 / §12 / D-05).
 * متن پیام در ردیف نمونهها ذخیره نمیشود؛ فقط کلید آن نگهداری میشود.
 * برای تطابق دقیق با report.html، متن کامل همان پیام در message_dict است.
 */

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
  MSG_UNKNOWN: 'سایر پیامها',
};

export const MESSAGE_DICT_ROWS = [
  ['MSG_VALIDATION_SUCCESS', 'اعتبارسنجی موفق', 'success'],
  ['MSG_HISTORY_NOT_ENOUGH', 'سابقه اعتباری کافی نیست', 'success'],
  ['MSG_OVERDUE_DEBT', 'بدهی معوق', 'success'],
  ['MSG_BOUNCED_CHECK', 'چک برگشتی', 'success'],
  ['MSG_DUPLICATE_UNIQUE_KEY', 'شناسه یکتا تکراری', 'fail'],
  ['MSG_UNKNOWN', 'سایر پیامها', 'other'],
] as const;

export function messageKeyOf(text: string): string {
  for (const [key, pattern] of MESSAGE_RULES) if (pattern.test(text)) return key;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto');
  return `MSG_UNKNOWN:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

export function messageLabel(key: string): string {
  if (MESSAGE_TEXT[key]) return MESSAGE_TEXT[key];
  if (key.startsWith('MSG_UNKNOWN:')) return `سایر پیامها (${key.slice(12)})`;
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
