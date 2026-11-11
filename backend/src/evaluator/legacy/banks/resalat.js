'use strict';
const { normalizeFacilities, hasFacilities } = require('../src/facility-items');
// رسالت: خروجی مدل نسبت به بانک‌های دیگر ساختار متفاوتی دارد.
const { get, num, asList, isFullArray, isFullList, meanInstallments, declaredInstallments,
  isRotbeNullData, ROTBE_CHECK_KEYS } = require('./_helpers');
const { nf, TIERS } = require('../src/common');
const { installmentDelays } = require('../src/loan-delays');
const collected = (s) => get(s, 'input.data.collectedData');
const tashilat = (c) => get(c, 'samatFacilities.tashilat.TashilatItem');
const rotbeData = (c) => get(c, 'rotbebandiStandard.data');
const outOf = (s, key) => get(s, `output.${key}`);
const pdOf = (s) => num(outOf(s, 'requested_loan.base_loan.base_pd_default'));
const thresholdOf = (s) => num(outOf(s, 'model_default_threshold'));
const upperEdge = (text) => { const match = typeof text === 'string' ? text.match(/\d+/g) : null; return match ? Number(match.at(-1)) : null; };

module.exports = function createResalat({ minNull = 3 } = {}) {
  const loansCache = new WeakMap(), depositCache = new WeakMap();
  function loanStats(c) {
    if (c && typeof c === 'object' && loansCache.has(c)) return loansCache.get(c);
    const rawLoans = get(c, 'historicalLoans');
    const loans = (Array.isArray(rawLoans) ? rawLoans : [])
      .filter((loan) => loan && typeof loan === 'object' && !Array.isArray(loan) && Object.keys(loan).length);
    const delay = installmentDelays(loans, 'tavan_resalat');
    const result = { loans: loans.length, maxDelay: delay.max, delayed: delay.delayed };
    if (c && typeof c === 'object') loansCache.set(c, result);
    return result;
  }
  function depositInfo(c, sample) {
    if (depositCache.has(sample)) return depositCache.get(sample);
    const value = get(c, 'depositAverage');
    const accounts = Array.isArray(value) ? value.filter((a) => a && typeof a === 'object' && !Array.isArray(a)) : [];
    const result = { accounts: accounts.length, present: accounts.length > 0 };
    depositCache.set(sample, result);
    return result;
  }
  return {
    id: 'tavan_resalat', label: 'رسالت', rootLabel: 'input.data.collectedData',
    omitCommonMetrics: ['scoreReq'],
    collected, rotbePath: 'input.data.collectedData.rotbebandiStandard.data', rotbeGet: rotbeData,
    creditSources: { facilities: tashilat, cheques: (c) => get(c, 'samatCheque.chequeList') },
    expectedServices: ['iran'],
    // اطلاعات داخلی مدل در جزئیات گزارش و گزارش خروجی قرار نمی‌گیرند.
    sanitizeSample: (sample) => {
      if (!sample.output || typeof sample.output !== 'object' || Array.isArray(sample.output)) return sample;
      const safe = { ...sample, output: { ...sample.output } };
      delete safe.output.features;
      delete safe.output.description;
      return safe;
    },
    summaryCols: (sample) => {
      const pd = pdOf(sample), score = num(outOf(sample, 'requested_loan.score.score_value'));
      const ability = num(outOf(sample, 'suggested_tavan_bazpardakht'));
      return { model_name: outOf(sample, 'model_name') ?? '—', PD: pd === null ? '—' : String(pd),
        'امتیاز': score === null ? '—' : score, 'توان بازپرداخت پیشنهادی': ability === null ? '—' : nf(ability) };
    },
    viewer: (_c, sample) => {
      const pd = pdOf(sample), score = outOf(sample, 'requested_loan.score') || {};
      const ability = num(outOf(sample, 'suggested_tavan_bazpardakht')), threshold = thresholdOf(sample), cards = [];
      if (pd !== null) cards.push(['احتمال نکول پایه', String(pd), 'hot']);
      if (score.score_value != null) cards.push(['امتیاز و رده', `${score.score_value} — ${score.category ?? 'نامشخص'}`, 'hot']);
      if (ability !== null) cards.push(['توان بازپرداخت پیشنهادی', nf(ability), 'hot']);
      if (threshold !== null) cards.push(['آستانهٔ نکول مدل', threshold]);
      if (outOf(sample, 'model_name')) cards.push(['نام مدل', outOf(sample, 'model_name')]);
      if (num(outOf(sample, 'adj_max_installment')) !== null) cards.push(['سقف قسط تعدیل‌شده', nf(num(outOf(sample, 'adj_max_installment')))]);
      const ranges = outOf(sample, 'credit_categories_amount');
      const tables = ranges && typeof ranges === 'object' ? [{ title: 'مرز رده‌های توان بازپرداخت',
        head: ['رده', 'بازه (ریال)'], rows: TIERS.filter(([key]) => ranges[key] !== undefined)
          .map(([key, fa]) => [`${fa} (${key})`, String(ranges[key]).replace(/\d+/g, (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ','))]) }] : [];
      return { cards, tables };
    },
    topics: [
      { id: 'rotbe', icon: '✦', label: 'رتبه‌بندی', desc: 'کامل بودن رتبه‌بندی در کنار اطلاعات تسهیلات و سوابق وام',
        details: `اگر رتبه‌بندی null باشد یا دست‌کم <b>${minNull}</b> کلید از ${ROTBE_CHECK_KEYS.length} کلید اصلی آن null باشند، فاقد داده محسوب می‌شود. تسهیلات در <code>samatFacilities.tashilat.TashilatItem</code> بررسی می‌شود.` },
      { id: 'loans', icon: '▤', label: 'سوابق وام', desc: 'گزارش‌های دارای سابقه یا بدون سابقهٔ ثبت‌شده، تأخیر و تعداد اقساط وام‌های قبلی',
        details: 'وجود سابقه از فهرست <code>historicalLoans</code> تعیین می‌شود؛ «بدون سابقه وام» فقط برای آرایهٔ صریحاً خالی است و فهرست غایب یا نامعتبر در این دو گروه وارد نمی‌شود. این شاخص اثبات نداشتن وام در واقعیت نیست. تأخیر در این بخش تعداد روزهای دیرکرد پرداخت قسطِ ثبت‌شده در <code>historicalLoans[*].delay_dayes_*</code> است. بیشترین تأخیر هر گزارش تعیین می‌کند که در کدام بازهٔ بدون هم‌پوشانی قرار بگیرد: ۳۰ تا کمتر از ۶۰، ۶۰ تا ۹۰ (شامل ۹۰)، یا بیشتر از ۹۰ روز. شاخص «میانگین تعداد اقساط وام‌های قبلی» برای هر گزارش، میانگین مقدار معتبر <code>count_installment</code> وام‌های آن گزارش است؛ گزارش‌های بدون مقدار معتبر از این شاخص عددی کنار می‌روند.' },
      { id: 'deposit', icon: '▥', label: 'سپرده‌ها', desc: 'تعداد حساب‌ها در همهٔ گزارش‌ها، میانگین‌های مدل و اثر سپرده بر بازپرداخت',
        details: 'سپردهٔ این بانک سری ماهانه نیست. تعداد حساب‌ها از تعداد اعضای <code>depositAverage</code> خوانده می‌شود. هر گزارش در شاخص تعداد حساب‌ها یک مقدار دارد؛ برای گزارش بدون حساب صفر ثبت می‌شود و چارک‌ها و میانگین روی کل گزارش‌های محدودهٔ انتخاب‌شده محاسبه می‌شوند. حسابی با <code>dep_avg = 0</code> همچنان یک حساب است. میانگین‌های ۶ و ۳۶ ماهه از خروجی مدل خوانده می‌شوند؛ <code>output.deposit_ok = 1</code> به معنی اثر مستقیم سپرده بر توان بازپرداخت است.' },
      { id: 'features', icon: '◈', label: 'خروجی مدل', desc: 'ردهٔ امتیاز، آستانهٔ نکول و سایر خروجی‌های قابل مقایسه',
        details: 'شاخص «احتمال نکول بالاتر از آستانه» زمانی فعال است که <code>base_pd_default</code> از <code>model_default_threshold</code> بزرگ‌تر باشد. ویژگی‌های داخلی مدل در گزارش جزئیات نمایش داده نمی‌شوند.' },
    ],
    paths: [
      { key: 'tashilat', label: 'داده‌های تسهیلات (TashilatItem)', displayPath: 'input.data.collectedData.samatFacilities.tashilat.TashilatItem', get: (c) => tashilat(c) },
      { key: 'samatChequeList', label: 'فهرست چک‌های برگشتی', displayPath: 'input.data.collectedData.samatCheque.chequeList', get: (c) => get(c, 'samatCheque.chequeList') },
      'meratInformation', 'depositAverage', 'historicalLoans',
    ],
    flags: [
      { id:'zeroRepayment', topic:'overview', label:'توان بازپرداخت صفر', inspect:true, card:'neutral',
        subtitle:'فقط صفر ثبت‌شده؛ مقدار غایب یا null در این شاخص نیست',
        test: (_c,s) => num(outOf(s,'suggested_tavan_bazpardakht')) === 0 },
      { id: 'rotbeNull', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده است', short: 'رتبه‌بندی فاقد داده', card: 'normal', daily: true, test: (c) => isRotbeNullData(rotbeData(c), minNull) },
      { id: 'tashilatFull', inspect: false, topic: 'rotbe', label: 'اطلاعات تسهیلات موجود است', test: (c) => hasFacilities(tashilat(c)) },
      { id: 'loansFull', inspect: false, topic: 'rotbe', label: 'سوابق وام موجود است', test: (c) => isFullArray(get(c, 'historicalLoans')) },
      { id: 'rotbeNullTashilat', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما تسهیلات موجود است', short: 'رتبه‌بندی ناقص / تسهیلات موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.tashilatFull },
      { id: 'rotbeNullLoans', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما سوابق وام موجود است', short: 'رتبه‌بندی ناقص / وام موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.loansFull },
      { id: 'rotbeNullBoth', topic: 'rotbe', label: 'رتبه‌بندی فاقد داده، اما تسهیلات و سوابق وام موجودند', short: 'رتبه‌بندی ناقص / هر دو موجود', card: 'warn', daily: true, test: (_c, _s, f) => f.rotbeNull && f.tashilatFull && f.loansFull },
      { id: 'hasLoan', inspect: false, topic: 'loans', label: 'دارای سابقه وام', card: 'normal', test: (c) => loanStats(c).loans > 0 },
      { id: 'noLoan', inspect: false, topic: 'loans', label: 'بدون سابقه وام', card: 'neutral',
        test: (c) => Array.isArray(get(c, 'historicalLoans')) && get(c, 'historicalLoans').length === 0 },
      { id: 'delay30', topic: 'loans',
        row: (c) => ({ 'بیشترین تأخیر قسط این گزارش (روز)': loanStats(c).maxDelay }), label: 'تأخیر از ۳۰ تا کمتر از ۶۰ روز', short: 'تأخیر از ۳۰ تا کمتر از ۶۰ روز', card: 'warn', daily: true, test: (c) => loanStats(c).maxDelay >= 30 && loanStats(c).maxDelay < 60 },
      { id: 'delay60', topic: 'loans',
        row: (c) => ({ 'بیشترین تأخیر قسط این گزارش (روز)': loanStats(c).maxDelay }), label: 'تأخیر از ۶۰ تا ۹۰ روز', short: 'تأخیر از ۶۰ تا ۹۰ روز', card: 'warn', daily: true,
        test: (c) => loanStats(c).maxDelay >= 60 && loanStats(c).maxDelay <= 90 },
      { id: 'delay90', topic: 'loans',
        row: (c) => ({ 'بیشترین تأخیر قسط این گزارش (روز)': loanStats(c).maxDelay }), label: 'تأخیر بیشتر از ۹۰ روز', short: 'تأخیر بیش از ۹۰ روز', card: 'warn', daily: true,
        test: (c) => (loanStats(c).maxDelay ?? 0) > 90 },
      { id: 'depositPresent', topic: 'deposit', label: 'دست‌کم یک حساب سپرده وجود دارد', inspect: false,
        test: (c, s) => depositInfo(c, s).present },
      { id: 'depositEmpty', topic: 'deposit', label: 'گزارش‌های بدون حساب', short: 'بدون حساب', card: 'neutral', daily: true, test: (c, s) => !depositInfo(c, s).present },
      { id: 'pdAboveThr', topic: 'features', label: 'احتمال نکول از آستانهٔ مدل بیشتر است', short: 'نکول بالاتر از آستانه', card: 'warn', daily: true,
        test: (_c, s) => pdOf(s) !== null && thresholdOf(s) !== null && pdOf(s) > thresholdOf(s) },
    ],
    cross: [{ id: 'rotbe', topic: 'rotbe', title: 'ارتباط رتبه‌بندی با تسهیلات و سوابق وام', row: 'rotbeNull',
      rowHeader: 'وضعیت رتبه‌بندی', rowYes: 'رتبه‌بندی فاقد داده', rowNo: 'رتبه‌بندی دارای داده',
      cols: [{ flag: 'tashilatFull', name: 'تسهیلات' }, { flag: 'loansFull', name: 'سوابق وام' }] }],
    categories: [
      { id: 'scoreCategory', topic: 'features', label: 'ردهٔ امتیاز مدل', classify: (_c, s) => String(outOf(s, 'requested_loan.score.category') ?? 'رده ثبت نشده') },
      { id: 'scoreRange', topic: 'features', label: 'بازهٔ امتیاز مدل', classify: (_c, s) => String(outOf(s, 'requested_loan.score.category_range') ?? 'بازه ثبت نشده') },
      { id: 'depositOk', topic: 'deposit', label: 'اثر مستقیم سپرده بر توان بازپرداخت (deposit_ok)',
        alertSummaryValues: ['undefined'],
        values: { 0: '۰ — بدون اثر مستقیم', 1: '۱ — دارای اثر مستقیم', undefined: 'وضعیت ثبت نشده' },
        classify: (_c, s) => { const value = outOf(s, 'deposit_ok'); return value == null || !String(value).trim() || String(value).trim().toLowerCase() === 'null' ? 'undefined' : String(value); } },
    ],
    metrics: [
      { id: 'rPd', topic: 'overview', label: 'احتمال نکول پایهٔ وام', format: nf,
        hist: { bins: [
          { min: 0, max: .1, label: '۰ تا کمتر از ۰٫۱۰' }, { min: .1, max: .2, label: '۰٫۱۰ تا کمتر از ۰٫۲۰' },
          { min: .2, max: .3, label: '۰٫۲۰ تا کمتر از ۰٫۳۰' }, { min: .3, max: .4, label: '۰٫۳۰ تا کمتر از ۰٫۴۰' },
          { min: .4, max: .5, label: '۰٫۴۰ تا کمتر از ۰٫۵۰' }, { value: .5, label: '۰٫۵۰ — بدون استراتژی' },
          { min: .5, max: .6, excludeMin: true, label: 'بیشتر از ۰٫۵۰ تا کمتر از ۰٫۶۰' },
          { min: .6, max: .7, label: '۰٫۶۰ تا کمتر از ۰٫۷۰' }, { min: .7, max: .8, label: '۰٫۷۰ تا کمتر از ۰٫۸۰' },
          { min: .8, max: .9, label: '۰٫۸۰ تا کمتر از ۰٫۹۰' }, { min: .9, max: 1.0000001, label: '۰٫۹۰ تا ۱' },
        ] }, value: (_c, s) => pdOf(s) },
      { id: 'rScore', topic: 'overview', label: 'امتیاز اعتبارسنجی', hist: { bins: [
        { min: 300, max: 401, label: '۳۰۰ تا ۴۰۰ — خیلی بد' }, { min: 401, max: 451, label: '۴۰۱ تا ۴۵۰ — بد' },
        { min: 451, max: 501, label: '۴۵۱ تا ۵۰۰ — متوسط رو به بد' }, { min: 501, max: 551, label: '۵۰۱ تا ۵۵۰ — متوسط' },
        { min: 551, max: 601, label: '۵۵۱ تا ۶۰۰ — متوسط رو به خوب' }, { min: 601, max: 651, label: '۶۰۱ تا ۶۵۰ — خوب' },
        { min: 651, max: 751, label: '۶۵۱ تا ۷۵۰ — خیلی خوب' }, { min: 751, max: 801, label: '۷۵۱ تا ۸۰۰ — عالی' },
      ] }, value: (_c, s) => num(outOf(s, 'requested_loan.score.score_value')) },
      { id: 'rTavan', topic: 'overview', label: 'توان بازپرداخت پیشنهادی (ریال)', format: nf,
        hist: { omitUnmatched: true, omitAbove: 1e9, bins: [
          { min: 0, max: 1e7, label: '۰ تا ۱۰ میلیون' }, { min: 1e7, max: 2e7, label: '۱۰ تا ۲۰ میلیون' },
          { min: 2e7, max: 3e7, label: '۲۰ تا ۳۰ میلیون' }, { min: 3e7, max: 5e7, label: '۳۰ تا ۵۰ میلیون' },
          { min: 5e7, max: 7.5e7, label: '۵۰ تا ۷۵ میلیون' }, { min: 7.5e7, max: 1e8, label: '۷۵ تا ۱۰۰ میلیون' },
          { min: 1e8, max: 1.5e8, label: '۱۰۰ تا ۱۵۰ میلیون' }, { min: 1.5e8, max: 2e8, label: '۱۵۰ تا ۲۰۰ میلیون' },
          { min: 2e8, max: 3e8, label: '۲۰۰ تا ۳۰۰ میلیون' }, { min: 3e8, max: 5e8, label: '۳۰۰ تا ۵۰۰ میلیون' },
          { min: 5e8, max: 7.5e8, label: '۵۰۰ تا ۷۵۰ میلیون' },
          { min: 7.5e8, max: 1e9, includeMax: true, label: '۷۵۰ تا ۱٬۰۰۰ میلیون (تا سقف)' },
        ] }, value: (_c, s) => num(outOf(s, 'suggested_tavan_bazpardakht')) },
      { id: 'rAdjMax', topic: 'overview', label: 'سقف قسط تعدیل‌شده', format: nf, value: (_c, s) => num(outOf(s, 'adj_max_installment')) },
      { id: 'rGuar', topic: 'overview', label: 'ظرفیت ضمانت تأییدشده', format: nf, value: (_c, s) => num(outOf(s, 'approved_guarantee_capacity')) },
      ...TIERS.map(([key, fa]) => ({ id: `cca_${key}`, topic: 'overview',
        group: 'سبد تسهیلات بر اساس ریسک: مرز بالای هر رده', label: `ردهٔ «${fa}» (${key})`, format: nf,
        groupNote: 'این جدول مرز عددی بازهٔ مبلغ هر رده را از output.credit_categories_amount همان رده می‌خواند؛ نه تعداد وام، جمع تسهیلات دریافتی یا مبلغ مصوب. مثلاً از متن 10000000 - 20000000 عدد 20000000 استخراج می‌شود؛ سپس کمینه، میانگین، میانه و چارک‌های این مرزها بین گزارش‌ها محاسبه می‌شوند. هر گزارش برای هر رده حداکثر یک مقدار دارد؛ تعداد گزارش معتبر در رده‌ها ممکن است متفاوت باشد. در بازهٔ باز مثل >20000000، عدد 20000000 مرز شروع بازه است، نه سقف واقعی؛ آمار چنین رده‌ای را سقف وام تلقی نکنید. استخراج فعلی آخرین دنبالهٔ رقم از رشته است و اعتبار کل قالب بازه را تضمین نمی‌کند؛ null، کلید غایب و متن بدون عدد وارد آمار نمی‌شوند. اعداد در همان واحد خروجی و بدون تبدیل واحد هستند.',
        value: (_c, s) => upperEdge(outOf(s, `credit_categories_amount.${key}`)) })),
      { id: 'oCompleted', topic: 'features', group: 'سایر خروجی‌های مدل', label: 'وام‌های تکمیل‌شده در هفت سال اخیر', value: (_c, s) => num(outOf(s, 'completed_loans_last_7_years')) },
      { id: 'oNegYear', topic: 'features', group: 'سایر خروجی‌های مدل', label: 'وضعیت‌های منفی سال اخیر', value: (_c, s) => num(outOf(s, 'num_negative_status_last_year')) },
      { id: 'oNeg12', topic: 'features', group: 'سایر خروجی‌های مدل', label: 'وضعیت‌های منفی یک تا دو سال اخیر', value: (_c, s) => num(outOf(s, 'num_negative_status_1_2years')) },
      { id: 'oAdjExist', topic: 'features', group: 'سایر خروجی‌های مدل', label: 'سقف قسط وام‌های جاری', format: nf, value: (_c, s) => num(outOf(s, 'adj_max_installment_exist_loans')) },
      { id: 'oAdjLost', topic: 'features', group: 'سایر خروجی‌های مدل', label: 'سقف قسط وام‌های تسویه‌شده', format: nf, value: (_c, s) => num(outOf(s, 'adj_max_installment_lost_loans')) },
      { id: 'lnCount', topic: 'loans', label: 'تعداد وام‌های قبلی (گزارش‌های دارای وام)', value: (c) => loanStats(c).loans || null },
      { id: 'lnMaxDelay', topic: 'loans', label: 'بیشترین تأخیر یک قسط (روز)', value: (c) => loanStats(c).maxDelay },
      { id: 'lnDelayed', topic: 'loans', label: 'تعداد اقساط دارای تأخیر', value: (c) => loanStats(c).loans ? loanStats(c).delayed : null },
      { id: 'lnAvgInstallments', topic: 'loans', label: 'میانگین تعداد اقساط وام‌های قبلی',
        value: (c) => meanInstallments(get(c, 'historicalLoans'), declaredInstallments) },
      { id: 'dpAccounts', topic: 'deposit', label: 'تعداد حساب‌ها به‌ازای هر گزارش (کل گزارش‌ها؛ بدون حساب = صفر)',
        value: (c, s) => depositInfo(c, s).accounts },
      { id: 'dp36', topic: 'deposit', label: 'میانگین سپردهٔ ۳۶ ماهه در خروجی مدل', format: nf, value: (_c, s) => num(outOf(s, 'average_deposit_36_month')) },
      { id: 'dp6', topic: 'deposit', label: 'میانگین سپردهٔ ۶ ماهه در خروجی مدل', format: nf, value: (_c, s) => num(outOf(s, 'average_deposit_6_month')) },
    ],
    lists: [
      { title: 'رتبه‌بندی فاقد داده با وجود سوابق وام', when: (f) => f.rotbeNullLoans,
        row: (c) => ({ 'تعداد وام‌ها': asList(get(c, 'historicalLoans')).length, 'تعداد تسهیلات': normalizeFacilities(tashilat(c)).items.length }) },
    ],
  };
};
