const asciiDigits = (value: any): string => String(value ?? '')
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

export function tehranJalali(date: Date): string {
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month').padStart(2, '0')}-${pick('day').padStart(2, '0')}`;
}

export function gregorianDateToJalaliStamp(date: Date): string | null {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', {
    timeZone: 'Asia/Tehran',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const y = pick('year');
  if (!/^1[34]\d{2}$/.test(y)) return null;
  const m = pick('month').padStart(2, '0');
  const d = pick('day').padStart(2, '0');
  const hh = pick('hour').padStart(2, '0');
  const mm = pick('minute').padStart(2, '0');
  const ss = pick('second').padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}${m}${d}${hh}${mm}${ss}${ms}`;
}

/**
 * استخراج رشتهٔ ۱۲ تا ۱۷ رقمی تاریخ و ساعت شمسی برای stampOf قدیمی:
 * - ارقام پیوسته فقط اگر سال شمسی معتبر (13xx/14xx) و ساعت/دقیقه معتبر داشته باشند پذیرفته میشوند؛
 * - تاریخهای شمسی جدانویسیشده (1405/08/19 10:20:30) نرمال میشوند؛
 * - تاریخهای میلادی ISO (2026-11-10T06:50:30Z) به معادل شمسی تهران تبدیل میشوند تا سال 2026 به اشتباه شمسی فرض نشود.
 */
export function jalaliStampDigitsOf(value: any): string | null {
  const text = asciiDigits(value).trim();
  if (!text) return null;

  if (/^\d{12,23}$/.test(text)) {
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6));
    const day = Number(text.slice(6, 8));
    const hour = Number(text.slice(8, 10));
    const minute = Number(text.slice(10, 12));
    const second = text.length >= 14 ? Number(text.slice(12, 14)) : 0;
    if (year >= 1300 && year <= 1499 && month >= 1 && month <= 12 && day >= 1 && day <= 31
      && hour <= 23 && minute <= 59 && second <= 59) {
      return text.slice(0, 17);
    }
    return null;
  }

  const jalaliMatch = text.match(
    /^(1[34]\d{2})[/.-](\d{1,2})[/.-](\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/,
  );
  if (jalaliMatch) {
    const [, y, mo, da, hh, mm, ss = '00', frac = ''] = jalaliMatch;
    const month = Number(mo), day = Number(da), hour = Number(hh), minute = Number(mm), second = Number(ss);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59) {
      const ms = frac ? frac.slice(0, 3).padEnd(3, '0') : '';
      return `${y}${mo.padStart(2, '0')}${da.padStart(2, '0')}${hh.padStart(2, '0')}${mm.padStart(2, '0')}${ss.padStart(2, '0')}${ms}`;
    }
    return null;
  }

  const gregMatch = text.match(
    /^((?:19|20)\d{2})[-/.](\d{1,2})[-/.](\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?$/i,
  );
  if (gregMatch) {
    const [, y, mo, da, hh, mm, ss = '00', frac = '0', tz] = gregMatch;
    const ms = frac.slice(0, 3).padEnd(3, '0');
    const offset = tz ? (tz.length === 3 ? `${tz}:00` : tz) : '+03:30';
    const iso = `${y}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}.${ms}${offset}`;
    return gregorianDateToJalaliStamp(new Date(iso));
  }

  return null;
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
