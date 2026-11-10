'use strict';
const { hasFacilities, facilityKind } = require('../src/facility-items');
// پست‌بانک: collectedData در ریشهٔ گزارش قرار دارد.
const { get, num, isFullArray, isFullList, meanInstallments, isRotbeNullData,
  ROTBE_CHECK_KEYS, ymIndex, ymFmt } = require('./_helpers');
const { nf, COMMON_METRICS } = require('../src/common');
const N_MONTH = 36;
const rotbce-dashboardta = (c) => get(c, 'rotbebandiStandardResult.data');
const tashilat = (c) => get(c, 'samatFacilitiesResult.data.ReturnValue.TashilatItem');
const STATUS_LABELS = {
  ok: 'تمام وام‌ها اقساط غیرخالی دارند', partial: 'فقط بخشی از وام‌ها اقساط غیرخالی دارند',
  noneFullMissing: 'هیچ قسط غیرخالی ثبت نشده؛ کلید برخی وام‌ها موجود نیست',
  noneFullEmpty: 'همهٔ آرایه‌های اقساط خالی هستند', resultDataEmpty: 'فهرست وام‌ها خالی است',
  resultDataMissing: 'فهرست وام‌ها موجود نیست یا null است',
};
module.exports = function createPostbank({ minNull = 3 } = {}) {
  const depositCache = new WeakMap(), loansCache = new WeakMap();
  function loanStats(c) {
    if (c && typeof c === 'object' && loansCache.has(c)) return loansCache.get(c);
    const data = get(c, 'postBankLoansDataResult.data.resultData');
    let result;
    if (!Array.isArray(data)) result = { kind: 'rdMissing' };
    else if (!data.length) result = { kind: 'rdEmpty' };
    else {
      let full = 0, empty = 0, missing = 0;
      for (const loan of data) {
        const installments = loan && loan.installments;
        if (Array.isArray(installments)) installments.length ? full++ : empty++;
        else missing++;
      }
      result = { kind: 'loans', total: data.length, full, empty, missing };
    }
    if (c && typeof c === 'object') loansCache.set(c, result);
    return result;
  }
  function installmentsStatus(c) {
    const info = loanStats(c);
    if (info.kind === 'rdMissing') return 'resultDataMissing';
    if (info.kind === 'rdEmpty') return 'resultDataEmpty';
    if (info.full === info.total) return 'ok';
    if (info.full) return 'partial';
    return info.missing ? 'noneFullMissing' : 'noneFullEmpty';
  }
  function depositInfo(c, sample) {
    if (depositCache.has(sample)) return depositCache.get(sample);
    const value = get(c, 'postBankDepositAverageResult.data.averageList');
    const accounts = Array.isArray(value) ? value.filter((a) => a && typeof a === 'object' && !Array.isArray(a)) : [];
    const months = new Map(), types = new Set(), dateIndices = new Set();
    const accountsKnown = Array.isArray(value) && accounts.length === value.length;
    let monthsKnown = accountsKnown;
    let invalid = Array.isArray(value) && accounts.length !== value.length;
    for (const account of accounts) {
      if (account.type) types.add(String(account.type));
      if (!account.average || typeof account.average !== 'object' || Array.isArray(account.average)) { invalid = true; monthsKnown = false; continue; }
      const seen = new Set();
      for (const [month, rawAmount] of Object.entries(account.average)) {
        const index = ymIndex(month), amount = num(rawAmount);
        if (index !== null) dateIndices.add(index);
        if (index === null || amount === null || amount < 0) { invalid = true; continue; }
        if (seen.has(index)) continue;
        seen.add(index);
        months.set(index, (months.get(index) || 0) + amount);
      }
    }
    const indices = [...dateIndices];
    let avg36 = null;
    if (months.size && !invalid) {
      const values = [...months].sort((a, b) => b[0] - a[0]).slice(0, N_MONTH).map(([, value]) => value);
      avg36 = values.reduce((sum, value) => sum + value, 0) / N_MONTH;
    }
    const info = { accounts: accounts.length, accountsKnown, monthsKnown, types: [...types], months: indices.length, present: indices.length > 0,
      minIdx: indices.length ? Math.min(...indices) : null, maxIdx: indices.length ? Math.max(...indices) : null,
      avg36, invalid };
    depositCache.set(sample, info);
    return info;
  }
  return {
    omitCommonMetrics: ['pd', 'creditBasket', 'scoreReq', ...COMMON_METRICS.filter((x) => x.id.startsWith('tbp_')).map((x) => x.id)],
    summaryCols: (s) => ({ model_name: get(s, 'output.model_name') ?? '—',
      'احتمال نکول': num(get(s, 'output.pd_default')) ?? '—',
      'مبلغ وام پیشنهادی (ریال)': num(get(s, 'output.suggested_tavan_bazpardakht')) === null ? '—' : nf(get(s, 'output.suggested_tavan_bazpardakht')) }),
    viewer: (_c, s) => ({ cards: [
      ['احتمال نکول (pd_default)', num(get(s, 'output.pd_default')), 'hot'],
      ['مبلغ وام پیشنهادی (ریال)', num(get(s, 'output.suggested_tavan_bazpardakht')) === null ? null : nf(get(s, 'output.suggested_tavan_bazpardakht')), 'hot'],
      ['نام مدل', get(s, 'output.model_name')], ['زمان اجرای مدل (ثانیه)', num(get(s, 'output.total_time'))],
    ] }),
    id: 'tavan_postbank', label: 'پست‌بانک', rootLabel: 'collectedData', showKeys: false,
    rotbePath: 'collectedData.rotbebandiStandardResult.data', rotbeGet: rotbce-dashboardta,
    expectedServices: ['iran'], collected: (sample) => get(sample, 'collectedData'),
    creditSources: { facilities: tashilat, cheques: (c) => get(c, 'samatChequeResult.data.chequeList') },
    topics: [
      { id: 'rotbe', icon: '✦', label: 'رتبه‌بندی', desc: 'کامل بودن رتبه‌بندی در کنار اطلاعات تسهیلات و وام‌ها',
        details: `دادهٔ رتبه‌بندی زمانی فاقد داده محسوب می‌شود که null باشد یا دست‌کم <b>${minNull}</b> کلید از ${ROTBE_CHECK_KEYS.length} کلید اصلی آن null باشند. منبع تسهیلات فقط کلید TashilatItem در data.ReturnValue است: null یا [] بدون تسهیلات، شیء غیرخالی یک آیتم و آرایهٔ اشیا چند آیتم. پوشش meta جزو ردیف‌ها نیست.` },
      { id: 'loans', icon: '▤', label: 'وام‌ها و اقساط', desc: 'وجود سابقهٔ وام، وضعیت اقساط و میانگین تعداد اقساط وام‌های قبلی',
        details: 'فهرست وام‌ها از <code>postBankLoansDataResult.data.resultData</code> خوانده می‌شود. آرایهٔ خالی به معنی «بدون سابقه وام» و فهرست غایب/نامعتبر با توضیح «خطا در دریافت داده از بانک» نمایش دارد؛ این دو یکسان شمرده نمی‌شوند. «سالم» یعنی تمام وام‌های فهرست، آرایهٔ اقساط غیرخالی داشته باشند. میانگین تعداد اقساط برای هر گزارش، میانگین طول آرایه‌های <code>installments</code> وام‌های همان گزارش است؛ آرایهٔ خالی مقدار صفر دارد و کلید غایب وارد میانگین نمی‌شود.' },
      { id: 'deposit', icon: '▥', label: 'سپرده‌ها', desc: 'تعداد حساب‌ها در همهٔ گزارش‌ها، پوشش زمانی و میانگین مجموع سپرده‌ها',
        details: `تعداد حساب‌ها از averageList و تعداد ماه‌های تاریخچه از سال/ماه‌های معتبر یکتای کل حساب‌ها خوانده می‌شود. برای هرکدام تعداد گزارش معتبر، کمینه، چارک اول، میانه، میانگین، چارک سوم و بیشینه جداگانه نمایش دارد؛ آرایهٔ حساب خالی صفر است و آرایهٔ غایب یا نامعتبر از آمار حذف می‌شود. برای شمار ماه، وجود ساختار average در همهٔ حساب‌ها لازم است؛ مبلغ نامعتبر، تاریخ معتبر را از شمار ماه حذف نمی‌کند. حسابِ بدون ماه ثبت‌شده همچنان شمرده می‌شود؛ «بدون حساب» با «بدون ماه سپرده» متفاوت است. مبلغ هر ماه برابر مجموع حساب‌ها در همان ماه است. میانگین ${N_MONTH} ماهه از جدیدترین ماه‌ها محاسبه می‌شود و در صورت کمبود ماه، با صفر تکمیل می‌گردد؛ این متد به معنی ساخت پنجرهٔ تقویمی پیوسته نیست. تاریخ یا مبلغ نامعتبر در هر حساب باعث حذف آن گزارش از میانگین می‌شود، نه تبدیل مبلغ نامعتبر به صفر. ردیف‌های meta در تعداد حساب‌ها یا ماه‌ها شمرده نمی‌شوند.` },
    ],
    paths: [
      { key: 'tashilat', label: 'collectedData.samatFacilitiesResult.data.ReturnValue.TashilatItem', get: (c) => tashilat(c),
        kind: facilityKind },
      { key: 'samatChequeList', label: 'فهرست چک‌های برگشتی', displayPath: 'collectedData.samatChequeResult.data.chequeList',
        get: (c) => get(c, 'samatChequeResult.data.chequeList') },
      'postBankLoansDataResult.data.resultData',
      { key: 'dep', label: 'collectedData.postBankDepositAverageResult.data.averageList', get: (c) => get(c, 'postBankDepositAverageResult.data.averageList') },
    ],
    flags: [
      { id: 'rotbeNull', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده است', short: 'رتبه‌بندی فاقد داده', card: 'normal', daily: true, test: (c) => isRotbeNullData(rotbce-dashboardta(c), minNull) },
      { id: 'tashilatFull', inspect: false, topic: 'rotbe', label: 'اطلاعات تسهیلات (TashilatItem) موجود است', test: (c) => hasFacilities(tashilat(c)) },
      { id: 'loansFull', inspect: false, topic: 'rotbe', label: 'فهرست وام‌ها (resultData) موجود است', test: (c) => loanStats(c).kind === 'loans' },
      { id: 'rotbeNullTashilat', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما تسهیلات موجود است', short: 'رتبه‌بندی ناقص / تسهیلات موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.tashilatFull },
      { id: 'rotbeNullLoans', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما وام موجود است', short: 'رتبه‌بندی ناقص / وام موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.loansFull },
      { id: 'rotbeNullBoth', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما تسهیلات و وام موجودند', short: 'رتبه‌بندی ناقص / هر دو موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.tashilatFull && f.loansFull },
      { id: 'hasLoan', inspect: false, topic: 'loans', label: 'دارای سابقه وام', card: 'normal', test: (c) => loanStats(c).kind === 'loans' },
      { id: 'noLoan', inspect: false, topic: 'loans', label: 'بدون سابقه وام', card: 'neutral', test: (c) => loanStats(c).kind === 'rdEmpty' },
      { id: 'unknownLoanHistory', topic: 'loans', label: 'فهرست سابقهٔ وام نامشخص است', subtitle: 'خطا در دریافت داده از بانک', card: 'neutral', test: (c) => loanStats(c).kind === 'rdMissing' },
      { id: 'installmentsOk', inspect: false, topic: 'loans', label: 'اقساط تمام وام‌ها غیرخالی است', short: 'اقساط سالم', card: 'normal', daily: true, test: (c) => installmentsStatus(c) === 'ok' },
      { id: 'installmentsBad', topic: 'loans', label: 'اقساط دست‌کم یک وام ناقص است', short: 'اقساط ناقص', card: 'warn', daily: true, test: (_c, _s, f) => !f.installmentsOk && !f.noLoan },
      { id: 'depositPresent', inspect: false, topic: 'deposit', label: 'دست‌کم یک ماه سپرده ثبت شده است', test: (c, s) => depositInfo(c, s).present },
      { id: 'noAccounts', topic: 'deposit', label: 'گزارش‌های بدون حساب', short: 'بدون حساب', card: 'neutral',
        test: (c, s) => depositInfo(c, s).accountsKnown && depositInfo(c, s).accounts === 0 },
      { id: 'depositMulti', inspect: false, topic: 'deposit', label: 'بیش از یک حساب سپرده وجود دارد', test: (c, s) => depositInfo(c, s).accounts > 1 },
    ],
    cross: [{ id: 'rotbe', topic: 'rotbe', title: 'ارتباط رتبه‌بندی با تسهیلات و وام‌ها', row: 'rotbeNull',
      rowHeader: 'وضعیت رتبه‌بندی', rowYes: 'رتبه‌بندی فاقد داده', rowNo: 'رتبه‌بندی دارای داده',
      cols: [{ flag: 'tashilatFull', name: 'تسهیلات' }, { flag: 'loansFull', name: 'وام‌ها' }] }],
    categories: [
      { id: 'installmentsStatus', topic: 'loans', label: 'وضعیت اقساط در فهرست وام‌ها', values: STATUS_LABELS, classify: (c) => installmentsStatus(c) },
    ],
    counters: [
      { id: 'loansTotal', topic: 'loans', label: 'تعداد کل وام‌ها', value: (c) => loanStats(c).total || 0 },
      { id: 'loansFull', inspect: false, topic: 'loans', label: 'وام‌های دارای اقساط غیرخالی', value: (c) => loanStats(c).full || 0 },
      { id: 'loansEmpty', topic: 'loans', label: 'وام‌های دارای آرایهٔ اقساط خالی', value: (c) => loanStats(c).empty || 0 },
      { id: 'loansMissing', topic: 'loans', label: 'وام‌های فاقد کلید اقساط', value: (c) => loanStats(c).missing || 0 },
    ],
    metrics: [
      { id: 'postPd', topic: 'overview', label: 'احتمال نکول (pd_default)', pathNote: 'output.pd_default',
        hist: COMMON_METRICS.find((x) => x.id === 'pd').hist, value: (_c, s) => num(get(s, 'output.pd_default')) },
      { id: 'postTavan', topic: 'overview', label: 'مبلغ وام پیشنهادی (ریال)', pathNote: 'output.suggested_tavan_bazpardakht', format: nf,
        histNote: 'واحد بازه‌ها میلیون ریال است: ۱۲۰ میلیون ریال = ۱۲ میلیون تومان و ۳٬۰۰۰ میلیون ریال = ۳۰۰ میلیون تومان. دو سر بازه مستقل‌اند؛ مقادیر خام تبدیل یا محدود نمی‌شوند.',
        hist: { outsideNote:true, bins: [
          {value:120e6,label:'دقیقاً ۱۲۰ میلیون ریال'},
          {min:120e6,max:300e6,excludeMin:true,label:'بیشتر از ۱۲۰ تا کمتر از ۳۰۰ میلیون ریال'},
          ...[[300,500],[500,750],[750,1000],[1000,1500],[1500,2000],[2000,2500],[2500,3000]]
            .map(([lo,hi])=>({min:lo*1e6,max:hi*1e6,label:`${nf(lo)} تا کمتر از ${nf(hi)} میلیون ریال`})),
          {value:3000e6,label:'دقیقاً ۳٬۰۰۰ میلیون ریال'},
        ] }, value: (_c, s) => num(get(s, 'output.suggested_tavan_bazpardakht')) },
      { id: 'lnAvgInstallments', topic: 'loans', label: 'میانگین تعداد اقساط وام‌های قبلی',
        value: (c) => meanInstallments(get(c, 'postBankLoansDataResult.data.resultData'),
          (loan) => Array.isArray(loan.installments) ? loan.installments.length : null) },
      { id: 'depAccounts', topic: 'deposit', label: 'تعداد حساب‌های سپرده در هر گزارش', group: 'تعداد حساب‌ها و ماه‌های تاریخچه',
        value: (c, s) => { const i=depositInfo(c,s); return i.accountsKnown ? i.accounts : null; } },
      { id: 'depMonths', topic: 'deposit', label: 'تعداد ماه‌های معتبر و یکتای تاریخچه', group: 'تعداد حساب‌ها و ماه‌های تاریخچه', value: (c,s) => { const i=depositInfo(c,s); return i.monthsKnown ? i.months : null; } },
      { id: 'depMin', topic: 'deposit', label: 'قدیمی‌ترین ماه سپرده', display: 'monthRange', hideIfEmpty:true, stats: ['count', 'min', 'max'], format: ymFmt, value: (c, s) => depositInfo(c, s).minIdx },
      { id: 'depMax', topic: 'deposit', label: 'جدیدترین ماه سپرده', display: 'monthRange', hideIfEmpty:true, stats: ['count', 'min', 'max'], format: ymFmt, value: (c, s) => depositInfo(c, s).maxIdx },
      { id: 'depAvg36', topic: 'deposit', label: 'میانگین ۳۶ ماههٔ مجموع سپرده‌ها', format: (n) => Math.round(n).toLocaleString('en-US'),
        value: (c, s) => { const i = depositInfo(c, s); return i.present ? i.avg36 : null; } },
    ],
    lists: [{ title: 'وام‌های دارای اطلاعات اقساط ناقص', when: (f) => f.installmentsBad,
      row: (c) => { const i = loanStats(c); return { 'نوع نقص': STATUS_LABELS[installmentsStatus(c)],
        'تعداد وام‌ها': i.total || 0, 'وام با اقساط غیرخالی': i.full || 0 }; } }],
  };
};
