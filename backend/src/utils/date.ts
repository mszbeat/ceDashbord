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

export function tehranToday(baseDate: Date = new Date()): string {
  return tehranJalali(baseDate);
}

export function tehranDaysAgo(daysAgo: number, baseDate: Date = new Date()): string {
  const safeOffset = Math.max(0, Math.floor(Number(daysAgo) || 0));
  return tehranJalali(new Date(baseDate.getTime() - safeOffset * 24 * 60 * 60 * 1000));
}

export function tehranYesterday(baseDate: Date = new Date()): string {
  return tehranDaysAgo(1, baseDate);
}

export function normalizeDay(day: string): string {
  const clean = asciiDigits(day).replace(/\//g, '-').trim();
  const match = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new Error(`فرمت روز نامعتبر است: ${day} (مثال 1405-08-18)`);
  const [, y, m, d] = match;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export function toApiDate(day: string): string {
  return normalizeDay(day).replace(/-/g, '/');
}

export function defaultRange(days = 30): { from: string; to: string } {
  const today = new Date();
  return {
    to: tehranJalali(today),
    from: tehranJalali(new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1000)),
  };
}

/** تبدیل یک تاریخ شمسی YYYY-MM-DD به ظهر همان روز به وقت تهران، همراه با اعتبارسنجی تقویمی دقیق (کبیسه و ۳۰/۳۱ روزه). */
export function jalaliToTehranNoon(dayInput: string): Date {
  const target = normalizeDay(dayInput);
  const [jy, jm, jd] = target.split('-').map(Number);
  if (jy < 1300 || jy > 1500 || jm < 1 || jm > 12 || jd < 1 || jd > 31) {
    throw new Error(`تاریخ شمسی خارج از محدودهٔ مجاز است: ${dayInput}`);
  }
  const approxDaysFromEpoch = (jy - 1348) * 365.2422 + (jm - 10) * 30.5 + (jd - 11);
  let cursorMs = Math.round(approxDaysFromEpoch) * 86_400_000 + 8.5 * 3_600_000;
  for (let step = 0; step < 20; step++) {
    const cur = tehranJalali(new Date(cursorMs));
    if (cur === target) return new Date(cursorMs);
    cursorMs += (cur < target ? 1 : -1) * 86_400_000;
  }
  // گام دقیق اطراف تقریب برای تشخیص تاریخهای ناموجود مثل ۳۱ مهر یا ۳۰ اسفند سال غیرکبیسه
  for (let delta = -5; delta <= 5; delta++) {
    const probe = new Date(cursorMs + delta * 86_400_000);
    if (tehranJalali(probe) === target) return probe;
  }
  throw new Error(`تاریخ شمسی نامعتبر است (چنین روزی در تقویم وجود ندارد): ${target}`);
}

export function enumerateJalaliDays(fromInput: string, toInput: string, maxDays = 90): string[] {
  const from = normalizeDay(fromInput);
  const to = normalizeDay(toInput);
  if (from > to) throw new Error(`تاریخ شروع (${from}) نمیتواند بعد از تاریخ پایان (${to}) باشد.`);
  const startNoon = jalaliToTehranNoon(from);
  jalaliToTehranNoon(to);
  const days: string[] = [];
  let cursorMs = startNoon.getTime();
  while (days.length <= maxDays) {
    const current = tehranJalali(new Date(cursorMs));
    days.push(current);
    if (current === to) return days;
    cursorMs += 86_400_000;
  }
  throw new Error(`بازهٔ انتخابی بیش از سقف مجاز (${maxDays} روز) است.`);
}

export interface TehranClockParts {
  jalaliDay: string;
  gregorianMonth: number;
  gregorianDay: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday (استاندارد کران)
  slotKey: string;   // YYYY-MM-DD HH:mm (شمسی تهران)
  display: string;   // YYYY/MM/DD HH:mm:ss
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function tehranClockParts(date: Date = new Date()): TehranClockParts {
  const jalaliDay = tehranJalali(date);
  const gregParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran',
    month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string) => gregParts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(pick('hour'));
  const minute = Number(pick('minute'));
  const second = Number(pick('second'));
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return {
    jalaliDay,
    gregorianMonth: Number(pick('month')),
    gregorianDay: Number(pick('day')),
    hour,
    minute,
    second,
    dayOfWeek: WEEKDAY_INDEX[pick('weekday')] ?? 0,
    slotKey: `${jalaliDay} ${hh}:${mm}`,
    display: `${jalaliDay.replace(/-/g, '/')} ${hh}:${mm}:${ss}`,
  };
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) return null;
    const [rangePart, stepPart, extra] = trimmed.split('/');
    if (extra !== undefined) return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) return null;

    let start = min;
    let end = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [a, b, rest] = rangePart.split('-');
        if (rest !== undefined) return null;
        start = Number(a);
        end = Number(b);
      } else {
        start = Number(rangePart);
        end = stepPart === undefined ? start : max;
      }
    }
    if (max === 7 && start === 7) start = 0;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      return null;
    }
    for (let v = start; v <= end; v += step) {
      out.add(max === 7 && v === 7 ? 0 : v);
    }
  }
  return out.size ? out : null;
}

export function validateCronExpr(expr: string): { valid: boolean; error?: string } {
  const clean = asciiDigits(expr).trim().replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  if (parts.length !== 5) {
    return { valid: false, error: 'عبارت کران باید دقیقاً ۵ بخش داشته باشد (دقیقه ساعت روزِماه ماه روزِهفته)، مثلاً: 0 2 * * *' };
  }
  const specs: Array<[string, number, number, string]> = [
    [parts[0], 0, 59, 'دقیقه (0-59)'],
    [parts[1], 0, 23, 'ساعت (0-23)'],
    [parts[2], 1, 31, 'روز ماه (1-31)'],
    [parts[3], 1, 12, 'ماه (1-12)'],
    [parts[4], 0, 7, 'روز هفته (0-7)'],
  ];
  for (const [raw, min, max, label] of specs) {
    if (!parseCronField(raw, min, max)) {
      return { valid: false, error: `مقدار نامعتبر در بخش «${label}»: ${raw}` };
    }
  }
  return { valid: true };
}

export function matchesCronExpr(expr: string, date: Date): boolean {
  const clean = asciiDigits(expr).trim().replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  if (parts.length !== 5) return false;
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 7);
  if (!minutes || !hours || !doms || !months || !dows) return false;

  const clock = tehranClockParts(date);
  const [, jMonthStr, jDayStr] = clock.jalaliDay.split('-');
  const jMonth = Number(jMonthStr);
  const jDay = Number(jDayStr);
  return (
    minutes.has(clock.minute)
    && hours.has(clock.hour)
    && doms.has(jDay)
    && months.has(jMonth)
    && dows.has(clock.dayOfWeek)
  );
}

export function nextCronRun(
  schedule: string | { scheduleMode?: string; hour: number; minute: number; cronExpr?: string | null },
  fromDate: Date = new Date(),
): { iso: string; jalaliDay: string; time: string; jalaliDisplay: string } | null {
  const expr = typeof schedule === 'string'
    ? asciiDigits(schedule).trim()
    : schedule.scheduleMode === 'cron' && schedule.cronExpr?.trim()
      ? asciiDigits(schedule.cronExpr).trim()
      : `${Number(schedule.minute) || 0} ${Number(schedule.hour) || 0} * * *`;
  const clean = expr.replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  if (parts.length !== 5) return null;
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 7);
  if (!minutes || !hours || !doms || !months || !dows) return null;

  let cursorMs = Math.floor(fromDate.getTime() / 60_000) * 60_000 + 60_000;
  const limitMs = cursorMs + 370 * 86_400_000;
  while (cursorMs <= limitMs) {
    const c = tehranClockParts(new Date(cursorMs));
    const [, jMonthStr, jDayStr] = c.jalaliDay.split('-');
    const jMonth = Number(jMonthStr);
    const jDay = Number(jDayStr);
    if (!months.has(jMonth) || !doms.has(jDay) || !dows.has(c.dayOfWeek)) {
      // پرش به ابتدای روز بعد در تهران
      const remMinutesInDay = (23 - c.hour) * 60 + (60 - c.minute);
      cursorMs += Math.max(1, remMinutesInDay) * 60_000;
      continue;
    }
    if (!hours.has(c.hour)) {
      // پرش به ابتدای ساعت بعد
      cursorMs += Math.max(1, 60 - c.minute) * 60_000;
      continue;
    }
    if (!minutes.has(c.minute)) {
      cursorMs += 60_000;
      continue;
    }
    const time = `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
    return {
      iso: new Date(cursorMs).toISOString(),
      jalaliDay: c.jalaliDay,
      time,
      jalaliDisplay: `${c.jalaliDay.replace(/-/g, '/')} ساعت ${time}`,
    };
  }
  return null;
}
