export function tehranJalali(date: Date): string {
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month').padStart(2, '0')}-${pick('day').padStart(2, '0')}`;
}

export function tehranToday(): string {
  return tehranJalali(new Date());
}

export function tehranYesterday(): string {
  return tehranJalali(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

export function normalizeDay(day: string): string {
  const value = day.replace(/\//g, '-').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`فرمت روز نامعتبر است: ${day} (مثال 1405-08-18)`);
  return value;
}

export function toApiDate(day: string): string {
  return day.replace(/-/g, '/');
}

export function defaultRange(days = 30): { from: string; to: string } {
  const today = new Date();
  return {
    to: tehranJalali(today),
    from: tehranJalali(new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1000)),
  };
}
