'use strict';
// مشخصات بانک ملت؛ موتور گزارش برای هر بانک فقط این قرارداد را می‌شناسد.
const { get, num, isFullArray, meanInstallments,
  isRotbeNullData, ROTBE_CHECK_KEYS, ymIndex, ymFmt, validationIdx } = require('./_helpers');
const { nf, COMMON_METRICS } = require('../src/common');
const { normalizeFacilities, hasFacilities } = require('../src/facility-items');
const N_MONTH = 36;
const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

function pickDeposit(c) {
  const value = get(c, 'depositAverage');
  return { records: Array.isArray(value) ? value : [] };
}
const lengthClass = (info) => !info.present ? 'empty' : info.rawCount < N_MONTH ? 'lt36' : info.rawCount === N_MONTH ? 'eq36' : 'gt36';
function windowClass(info) {
  if (!info.present) return 'noDeposit';
  if (info.minIdx === null) return 'badDates';
  if (info.vmIdx === null) return 'noValDate';
  const gap = info.vmIdx - info.minIdx;
  return gap === N_MONTH ? 'minIs36' : gap < N_MONTH ? 'minNewer' : 'minOlder';
}

module.exports = function createMellat({ minNull = 3 } = {}) {
  const cache = new WeakMap();
  const diag = { badReports: 0 };
  function depositInfo(c, sample) {
    if (cache.has(sample)) return cache.get(sample);
    const dep = pickDeposit(c, sample);
    const records = dep.records.filter((rec) => rec && typeof rec === 'object' && !Array.isArray(rec));
    const months = records.map((rec) => {
      const raw = rec.yeaR_MONTH;
      return { idx: ymIndex(raw), raw, amount: num(rec.avR_AMOUNT) };
    });
    const idxs = months.map(({ idx }) => idx).filter((idx) => idx !== null);
    const byMonth = new Map();
    for (const month of months) {
      // دو تاریخ در یک ماه (حتی با روز متفاوت) فقط یک ماه سپرده هستند.
      const key = month.idx === null ? `raw:${digitsOf(month.raw) || String(month.raw)}` : `month:${month.idx}`;
      if (!byMonth.has(key)) byMonth.set(key, month);
    }
    const messageOk = true; // آرایهٔ قطعی سپرده پیام سرویس ندارد؛ شرط پیام اعمال نمی‌شود.
    const invalid = records.length !== dep.records.length || months.some((m) => m.idx === null || m.amount === null || m.amount < 0);
    let avg36 = null;
    if (records.length && !invalid) {
      const amounts = [...byMonth.values()].sort((a, b) => {
        if (a.idx !== null && b.idx !== null) return b.idx - a.idx;
        if (a.idx !== null) return -1;
        if (b.idx !== null) return 1;
        return Number(digitsOf(b.raw)) - Number(digitsOf(a.raw)) || 0;
      }).slice(0, N_MONTH).map(({ amount }) => amount);
      while (amounts.length < N_MONTH) amounts.push(0);
      avg36 = amounts.reduce((sum, amount) => sum + amount, 0) / N_MONTH;
    }
    if (months.some(({ idx }) => idx === null)) diag.badReports++;
    const info = { rawCount: records.length, validMonthCount: new Set(idxs).size, uniqueCount: byMonth.size, present: records.length > 0,
      messageOk, minIdx: idxs.length ? Math.min(...idxs) : null,
      maxIdx: idxs.length ? Math.max(...idxs) : null, vmIdx: validationIdx(sample), avg36, records, invalid };
    cache.set(sample, info);
    return info;
  }
  // سابقهٔ ثبت‌شده، نه تعداد وام فعال؛ کد وضعیت تفسیر نمی‌شود.
  const validLoans = (c) => {
    const loans = get(c, 'historicalLoans');
    return Array.isArray(loans) && loans.every((loan) => loan && typeof loan === 'object'
      && !Array.isArray(loan) && Object.keys(loan).length) ? loans : null;
  };
  const rotbeNull = (c) => isRotbeNullData(get(c, 'rotbebandiStandard.data'), minNull);
  return {
    id: 'tavan_mellat', label: 'ملت', rootLabel: 'input.data', expectedServices: ['iran'], diag,
    collected: (sample) => get(sample, 'input.data'),
    creditSources: { facilities: (c) => get(c, 'samatFacilities.TashilatItem'), cheques: (c) => get(c, 'samatCheque.chequeList') },
    // فقط معنای نمایشی اصلاح می‌شود: کلیدها برای سازگاری با داده‌های وابسته دست‌نخورده‌اند.
    overviewNote: 'در دادهٔ خروجی ملت، نام دو کلید جابه‌جا ثبت شده است: output.Credit_Basket توان بازپرداخت (ریال) و output.Tavan_Baz_Pardakht سبد اعتباری به تفکیک رده است. نام کلیدهای خام تغییر نمی‌کند.',
    summaryCols: (sample) => {
      const pd = num(get(sample, 'output.PD'));
      const ability = num(get(sample, 'output.Credit_Basket'));
      return { model_name: get(sample, 'output.model_name') ?? '—', PD: pd === null ? '—' : String(pd),
        'توان بازپرداخت (ریال)': ability === null ? '—' : nf(ability) };
    },
    topics: [
      { id: 'rotbe', icon: '✦', label: 'رتبه‌بندی', desc: 'ارزیابی کامل بودن رتبه‌بندی و ارتباط آن با تسهیلات و سوابق وام',
        details: `اگر دادهٔ رتبه‌بندی null باشد یا دست‌کم <b>${minNull}</b> کلید از ${ROTBE_CHECK_KEYS.length} کلید اصلی آن null باشند، «رتبه‌بندی فاقد داده» در نظر گرفته می‌شود. تاریخ استعلام و کلیدهای فرعی در این محاسبه لحاظ نمی‌شوند.` },
      { id: 'loans', icon: '▤', label: 'سوابق وام', desc: 'وجود سابقه، تعداد وام‌ها و میانگین اقساط قراردادی',
        details: 'وجود سابقه از آرایهٔ input.data.historicalLoans خوانده می‌شود: آرایهٔ غیرخالی دارای سابقه و آرایهٔ صریحاً خالی بدون سابقه است. کلید غایب یا نامعتبر در هیچ‌کدام شمرده نمی‌شود. تعداد وام‌های ثبت‌شده برابر طول آرایهٔ سالم است؛ آرایهٔ خالی صفر و آرایهٔ غایب یا دارای ردیف نامعتبر از آمار عددی خارج است. میانگین اقساط قراردادی هر گزارش فقط از installmentCount صحیح و نامنفی وام‌های همان گزارش به دست می‌آید؛ طول installments یا approvedDuration جایگزین نیست. مقدار صفرِ ثبت‌شده معتبر است، ولی null صفر فرض نمی‌شود. گزارش بدون تعداد اقساط معتبر از میانگین حذف می‌شود. آمار جدول روی مقدار هر گزارش است، نه تک‌تک وام‌ها. این شاخص‌ها به معنای تعداد وام فعال یا اقساط باقی‌مانده نیستند. به علت نبود روز تأخیر معتبر، آمار تأخیر ملت همچنان نمایش داده نمی‌شود و کد status تفسیر نمی‌شود.' },
      { id: 'deposit', icon: '▥', label: 'سپرده‌ها', desc: 'پوشش ماهانه، کیفیت تاریخ‌ها و میانگین سپردهٔ ۳۶ ماهه',
        details: `کلید قطعی <code>yeaR_MONTH</code> تاریخ شمسی هشت‌رقمی مانند <code>14030930</code> را نگه می‌دارد و مبلغ فقط از <code>avR_AMOUNT</code> خوانده می‌شود؛ برای آمار ماهانه فقط سال و ماه آن به کار می‌رود. میانگین ${N_MONTH} ماهه از ماه‌های یکتا (با حفظ نخستین تکرار)، به ترتیب جدید به قدیم، محاسبه می‌شود. کمبود تعداد ماه‌های موجود تا ${N_MONTH} با صفر تکمیل می‌شود؛ این متد پنجرهٔ تقویمی پیوسته نمی‌سازد. تاریخ یا مبلغ نامعتبر، منفی یا نامعلوم در هر ردیف باعث کنارگذاشتن گزارش از میانگین می‌شود، نه تبدیل مبلغ به صفر. منبع قطعی آرایهٔ <code>input.data.depositAverage</code> است؛ نبود پیام سرویس، میانگین را صفر نمی‌کند.`,
        extraHtml: () => !diag.badReports ? '' : `<div class="alert"><strong>نیاز به بررسی تاریخ سپرده:</strong> در ${diag.badReports} گزارش، دست‌کم یک تاریخ ماه سپرده قابل خواندن نبود. سال‌وماه (مانند <code>140309</code>) یا سال‌وماه‌وروز (مانند <code>14030930</code>) پذیرفته می‌شود؛ مقدارهای خام فقط در پنجرهٔ جزئیات همان گزارش، پس از دریافت از API اصلی، در دسترس‌اند.</div>` },
    ],
    paths: ['samatFacilities.TashilatItem',
      { key: 'samatChequeList', label: 'فهرست چک‌های برگشتی', displayPath: 'input.data.samatCheque.chequeList', get: (c) => get(c, 'samatCheque.chequeList') },
      'historicalLoans', 'depositAverage'],
    flags: [
      { id: 'rotbeNull', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده است', short: 'رتبه‌بندی فاقد داده', card: 'normal', daily: true, test: rotbeNull },
      { id: 'tashilatFull', inspect: false, topic: 'rotbe', label: 'اطلاعات تسهیلات (TashilatItem) موجود است', test: (c) => hasFacilities(get(c, 'samatFacilities.TashilatItem')) },
      { id: 'loansFull', inspect: false, topic: 'rotbe', label: 'سوابق وام (historicalLoans) موجود است', test: (c) => isFullArray(get(c, 'historicalLoans')) },
      { id: 'rotbeNullTashilat', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما اطلاعات تسهیلات موجود است', short: 'رتبه‌بندی ناقص / تسهیلات موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.tashilatFull },
      { id: 'rotbeNullLoans', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما سوابق وام موجود است', short: 'رتبه‌بندی ناقص / وام موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.loansFull },
      { id: 'rotbeNullBoth', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما تسهیلات و سوابق وام موجودند', short: 'رتبه‌بندی ناقص / هر دو موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.tashilatFull && f.loansFull },
      { id: 'hasLoan', inspect: false, topic: 'loans', label: 'دارای سابقه وام', card: 'normal', test: (c) => isFullArray(get(c, 'historicalLoans')) },
      { id: 'noLoan', inspect: true, topic: 'loans', label: 'بدون سابقه وام', card: 'neutral',
        test: (c) => Array.isArray(get(c, 'historicalLoans')) && get(c, 'historicalLoans').length === 0 },
      { id: 'depositPresent', inspect: false, topic: 'deposit', label: 'دست‌کم یک ماه سپرده ثبت شده است', test: (c, s) => depositInfo(c, s).present },
      { id: 'depositEmpty', topic: 'deposit', label: 'بدون سپرده', short: 'بدون سپرده', card: 'warn', daily: true, test: (c, s) => !depositInfo(c, s).present },
      { id: 'deposit36', inspect: false, topic: 'deposit', label: 'دقیقاً ۳۶ ردیف ماهانهٔ سپرده وجود دارد', short: 'سپردهٔ ۳۶ ماهه', card: 'normal', daily: true, test: (c, s) => depositInfo(c, s).rawCount === N_MONTH },
    ],
    cross: [{ id: 'rotbe', topic: 'rotbe', title: 'ارتباط رتبه‌بندی با تسهیلات و سوابق وام', row: 'rotbeNull',
      rowHeader: 'وضعیت رتبه‌بندی', rowYes: 'رتبه‌بندی فاقد داده', rowNo: 'رتبه‌بندی دارای داده',
      cols: [{ flag: 'tashilatFull', name: 'تسهیلات' }, { flag: 'loansFull', name: 'سوابق وام' }] }],
    categories: [
      { id: 'depositLength', topic: 'deposit', label: 'تعداد ماه‌های سپرده',
        values: { empty: 'سپرده ثبت نشده', lt36: 'کمتر از ۳۶ ماه', eq36: 'دقیقاً ۳۶ ماه', gt36: 'بیش از ۳۶ ماه' },
        classify: (c, s) => lengthClass(depositInfo(c, s)) },
      { id: 'depositWindow', inspectValues: ['minNewer'], topic: 'deposit', label: 'قدیمی‌ترین ماه نسبت به زمان اعتبارسنجی',
        note: 'برای هر گزارش، قدیمی‌ترین سال/ماه معتبر از ردیف‌های سپرده با سال/ماه تاریخ اعتبارسنجی مقایسه می‌شود؛ فاصلهٔ دقیقاً ۳۶ ماه، کمتر از ۳۶ یا بیشتر از ۳۶ ماه جداست. تاریخ اعتبارسنجی از ai_input.current_loan.date_granted، سپس output.date_granted و سپس زمان ثبت گزارش خوانده می‌شود. گزارش بدون سپرده جداست؛ «قالب تاریخ ماه‌ها نامعتبر» فقط وقتی است که ردیف سپرده وجود دارد ولی هیچ تاریخ ماه معتبری خوانده نمی‌شود. درصدها از تمام گزارش‌های محدوده هستند. ستون تعداد ماه‌های تاریخچه در فهرست زیر، تعداد سال/ماه‌های معتبر و یکتای موجود است؛ تکرار یک ماه یک‌بار شمرده و تاریخ نامعتبر حذف می‌شود. این تعداد با فاصلهٔ تقویمی تا اعتبارسنجی متفاوت است و به معنی پیوسته بودن ماه‌ها نیست.',
        values: { noDeposit: 'سپرده ثبت نشده', minIs36: 'دقیقاً ۳۶ ماه قبل (مطابق انتظار)', minNewer: 'تاریخچه کوتاه‌تر از ۳۶ ماه',
          minOlder: 'قدیمی‌تر از ۳۶ ماه', noValDate: 'تاریخ اعتبارسنجی نامشخص', badDates: 'قالب تاریخ ماه‌ها نامعتبر' },
        classify: (c, s) => windowClass(depositInfo(c, s)),
        row: (c, s) => ({ 'تعداد ماه‌های تاریخچه': depositInfo(c, s).validMonthCount }) },
    ],
    metrics: [
      { id: 'lnCount', topic: 'loans', label: 'تعداد وام‌های ثبت‌شده در هر گزارش',
        value: (c) => validLoans(c)?.length ?? null },
      { id: 'lnAvgInstallments', topic: 'loans', label: 'میانگین تعداد اقساط قراردادی هر گزارش',
        value: (c) => { const loans = validLoans(c); return loans === null ? null : meanInstallments(loans, (loan) => num(loan.installmentCount)); } },
      { ...COMMON_METRICS.find((spec) => spec.id === 'creditBasket'), label: 'توان بازپرداخت',
        pathNote: 'output.Credit_Basket', histTitle: 'توزیع توان بازپرداخت (ریال)' },
      ...COMMON_METRICS.filter((spec) => spec.id.startsWith('tbp_'))
        .map((spec) => ({ ...spec, group: 'سبد اعتباری: سقف هر رده' })),
      { id: 'depositCount', topic: 'deposit', label: 'تعداد ردیف‌های ماهانه (فقط گزارش‌های دارای سپرده)', value: (c, s) => { const i = depositInfo(c, s); return i.present ? i.rawCount : null; } },
      { id: 'depositMin', topic: 'deposit', label: 'قدیمی‌ترین ماه سپرده', display: 'monthRange', hideIfEmpty: true,
        format: ymFmt, value: (c, s) => depositInfo(c, s).minIdx },
      { id: 'depositMax', topic: 'deposit', label: 'جدیدترین ماه سپرده', display: 'monthRange', hideIfEmpty: true,
        format: ymFmt, value: (c, s) => depositInfo(c, s).maxIdx },
      { id: 'avg36', topic: 'deposit', label: 'میانگین ۳۶ ماههٔ سپردهٔ موجود', value: (c, s) => { const i = depositInfo(c, s); return i.present && i.messageOk ? i.avg36 : null; } },
    ],
    lists: [{ title: 'رتبه‌بندی فاقد داده با وجود اطلاعات تسهیلات', when: (f) => f.rotbeNullTashilat,
      row: (c) => ({ 'تعداد تسهیلات': normalizeFacilities(get(c, 'samatFacilities.TashilatItem')).items.length,
        'تعداد سوابق وام': (get(c, 'historicalLoans') || []).length }) }],
  };
};
