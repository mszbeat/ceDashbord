'use strict';
const fs = require('node:fs'), path = require('node:path');
const { RANKING_NULL_THRESHOLD } = require('../src/config');
const { loadBanks } = require('../src/banks');
const { ROTBE_CHECK_KEYS } = require('../banks/_helpers');
const { FIELDS } = require('../src/facilities');
const { COMMON_TOPICS } = require('../src/common');
const dir = path.join(__dirname, '..', 'docs'); fs.mkdirSync(dir, { recursive: true });
const outputPaths = {
 rPd: 'output.requested_loan.base_loan.base_pd_default', rScore: 'output.requested_loan.score.score_value',
 rTavan: 'output.suggested_tavan_bazpardakht', rAdjMax: 'output.adj_max_installment', rGuar: 'output.approved_guarantee_capacity',
 oCompleted: 'output.completed_loans_last_7_years', oNegYear: 'output.num_negative_status_last_year', oNeg12: 'output.num_negative_status_1_2years',
 oAdjExist: 'output.adj_max_installment_exist_loans', oAdjLost: 'output.adj_max_installment_lost_loans',
 dp36: 'output.average_deposit_36_month', dp6: 'output.average_deposit_6_month',
 pd: 'output.PD', creditBasket: 'output.Credit_Basket', scoreReq: 'output.score_for_requested_loan', totalTime: 'output.total_time',
 postPd: 'output.pd_default', postTavan: 'output.suggested_tavan_bazpardakht',
};
function source(bank, spec) {
  if (spec.sourcePath || spec.pathNote) return spec.sourcePath || spec.pathNote;
  if (spec.id === 'zeroRepayment') return 'output.suggested_tavan_bazpardakht';
  if (spec.id === 'negativeLastYear') return 'output.num_negative_status_last_year';
  if (spec.id === 'negativePreviousYear') return 'output.num_negative_status_1_2years';
  if (/^delay(?:30|60|90|Observed|Unobserved)$/.test(spec.id) || ['lnMaxDelay', 'lnDelayed'].includes(spec.id)) {
    return bank.schema.loans + (bank.key === 'tavan_resalat' ? '[*].delay_dayes_*' : bank.key === 'tavan_postbank' ? '[*].installments[*].numberOfDaysOfDelay' : '[*].installments[*].installmentPayments[*].delay');
  }
  if (spec.id === 'lnAvgInstallments') return bank.schema.loans + (bank.key === 'tavan_resalat' ? '[*].count_installment' : bank.key === 'tavan_mellat' ? '[*].installmentCount' : '[*].installments');

  if (outputPaths[spec.id]) return outputPaths[spec.id];
  if (spec.id.startsWith('tbp_')) return `output.Tavan_Baz_Pardakht.${spec.id.slice(4)}.max`;
  if (spec.id.startsWith('cca_')) return `output.credit_categories_amount.${spec.id.slice(4)}`;
  if (spec.id === 'pdAboveThr') return 'output.requested_loan.base_loan.base_pd_default ; output.model_default_threshold';
  if (spec.id === 'depositOk') return 'output.deposit_ok';
  if (spec.id === 'scoreCategory') return 'output.requested_loan.score.category';
  if (spec.id === 'scoreRange') return 'output.requested_loan.score.category_range';
  if (spec.id === 'modelName') return 'output.model_name';
  if (spec.topic === 'status') return spec.id === 'statusCode' ? 'output.statusCode' : spec.id === 'errorCode' ? 'output.meta.code' : 'output.message.fa/en ; output.data.message.fa/en ; output.message ; output.data.message';
  if (spec.topic === 'rotbe') return `${bank.schema.rotbe} ; ${bank.schema.facilities} ; ${bank.schema.loans}`;
  if (spec.topic === 'facilities') return bank.schema.facilities;
  if (spec.topic === 'loans') return bank.schema.loans;
  if (spec.topic === 'deposit') return bank.schema.deposit;
  if (spec.id === 'depositError') return 'collectedData.postBankDepositAverageError';
  return bank.schema.root;
}
function formula(bank, spec, type) {
  if (spec.formula) return spec.formula;
  const id = spec.id;
  if (/^delay(30|60|90)$/.test(id)) return ({delay30:'۳۰ <= D < ۶۰',delay60:'۶۰ <= D <= ۹۰',delay90:'D > ۹۰'})[id] + '؛ D بیشترین تأخیر گزارش است. فهرست نزولی قبل از سقف انتخاب می‌شود.';
  if (id === 'facilityPrincipalAndBenefit') return 'sum(AmOriginal + AmBenefit) در تسهیلات همان گزارش؛ تنها وقتی هر دو فیلد در تمام ردیف‌ها معتبر و نامنفی، آیتم منفرد یا آرایه سالم و واحد همه IRR باشد. سود صفر معتبر و null نامعلوم است. بدون کسر پرداخت؛ نه مانده بدهی. AmBedehiKol تغییر نمی‌کند.';
  if (id.startsWith('facilitySum')) return `sum(${id.slice(11)}) در ردیف‌های همان گزارش؛ فقط آیتم منفرد یا آرایهٔ سالم پس از یکسان‌سازی شکل داده، همهٔ مبالغ معتبر و نامنفی و همهٔ واحدها IRR.`;
  if (id.startsWith('tbp_')) return 'مقدار عددی max همان رده، سپس آمار بین گزارش‌ها؛ min در این شاخص وارد نمی‌شود.';
  if (id.startsWith('cca_')) return 'آخرین دنبالهٔ رقم در متن بازه، به عدد تبدیل می‌شود؛ برای بازهٔ باز مانند >X این مقدار مرز رده است، نه سقف واقعی.';
  const formulas = {
    zeroRepayment: 'مقدار عددی output.suggested_tavan_bazpardakht دقیقاً صفر؛ رشتهٔ عددی صفر پذیرفته است، null، غیاب، خالی، غیرعددی و boolean حذف؛ هر گزارش یک بار، در همهٔ وضعیت‌ها، فهرست قابل بررسی دارد.',
    negativeLastYear: 'output.num_negative_status_last_year معتبر و >۰؛ تعداد همان گزارش در ردیف نمایش داده می‌شود.',
    negativePreviousYear: 'output.num_negative_status_1_2years معتبر و >۰؛ تعداد همان گزارش در ردیف نمایش داده می‌شود.',
    lnCount: bank.key === 'tavan_mellat' ? 'طول آرایهٔ سالم سابقهٔ وام؛ خالی=۰؛ غایب/نامعتبر یا دارای ردیف غیرشیء/خالی حذف می‌شود. همهٔ وضعیت‌ها، نه فقط وام فعال.' : 'تعداد اشیای غیرخالی در آرایهٔ سابقهٔ وام؛ فقط مقدار مثبت وارد جدول می‌شود.',
    lnAvgInstallments: bank.key === 'tavan_mellat' ? 'mean(installmentCount) در آرایهٔ سالم روی وام‌های دارای عدد صحیح نامنفی؛ صفر معتبر، null حذف؛ بدون عدد معتبر=null؛ طول installments و approvedDuration جایگزین نیستند. آمار بین گزارش‌ها با وزن یکسان است.' : bank.key === 'tavan_postbank' ? 'mean(length(installments)) روی وام‌های دارای آرایهٔ اقساط؛ خالی=۰ و کلید غایب حذف می‌شود.' : 'mean(count_installment) روی وام‌های دارای عدد صحیح نامنفی.',
    lnMaxDelay: 'بیشینهٔ روز تأخیر معتبرِ اقساط گزارش؛ گزارش بدون عدد معتبر حذف می‌شود.',
    lnDelayed: 'تعداد اقساط با روز تأخیر معتبر >۰؛ فقط گزارش دارای حداقل یک روز معتبر وارد محاسبه می‌شود.',
    dpAccounts: 'تعداد اشیای حساب در آرایهٔ قطعی سپرده؛ حساب با dep_avg=۰ نیز شمرده می‌شود؛ برای بدون حساب صفر.',
    depAccounts: 'تعداد حساب در averageList معتبر؛ [] صفر، غایب/نامعتبر حذف؛ count/min/p25/median/mean/p75/max بین گزارش‌های دارای دادهٔ معتبر.',
    depositCount: 'تعداد ردیف‌های شیء در آرایهٔ ماهانه؛ فقط گزارش‌های دارای ردیف وارد می‌شوند؛ نه تعداد حساب یا ماه یکتا.',
    depMonths: 'تعداد تاریخ‌های ماه معتبر یکتا در اجتماع average حساب‌ها، مستقل از مبلغ؛ [] صفر، حساب/average نامعلوم حذف؛ count/min/p25/median/mean/p75/max بین گزارش‌های دارای دادهٔ معتبر.',
    depositMin: 'min(year×۱۲+month−۱) بین تاریخ‌های معتبر هر گزارش؛ فقط count/min/max بین گزارش‌ها.',
    depositMax: 'max(year×۱۲+month−۱) بین تاریخ‌های معتبر هر گزارش؛ فقط count/min/max بین گزارش‌ها.',
    depMin: 'کمترین شاخص ماه معتبر در ماه‌های حساب‌های گزارش؛ count/min/max بین گزارش‌ها.',
    depMax: 'بزرگ‌ترین شاخص ماه معتبر در ماه‌های حساب‌های گزارش؛ count/min/max بین گزارش‌ها.',
    avg36: 'sum(مبلغ حداکثر ۳۶ ماه یکتای جدیدتر)/۳۶؛ گردکردن فقط در نمایش؛ اولین تکرار ماه حفظ می‌شود؛ گزارش دارای هر تاریخ/مبلغ نامعتبر حذف می‌شود.',
    depAvg36: 'ابتدا جمع مبالغ حساب‌ها در هر ماه؛ سپس sum(حداکثر ۳۶ ماه یکتای جدیدتر)/۳۶؛ گردکردن فقط در نمایش؛ هر مقدار نامعتبر گزارش را از میانگین حذف می‌کند.',
    rotbeNull: 'دادهٔ رتبه‌بندی غایب/null/غیرشیء، یا تعداد کلیدهای اصلی null/غایب >= ۳ (آستانهٔ ثابت داخلی).',
    tashilatFull: 'حداقل یک آیتم شیء غیرخالی در مسیر قطعی TashilatItem؛ آبجکت منفرد یک آیتم و آرایه فهرست آیتم‌هاست. null یا [] بدون تسهیلات؛ غیاب/ساختار نامعتبر وجود تسهیلات را اثبات نمی‌کند. فهرست عادی حذف مانده است.',
    loansFull: 'آرایهٔ قطعی سابقهٔ وام غیرخالی است؛ شمارش حفظ و فهرست عادی حذف شده است.',
    rotbeNullTashilat: 'rotbeNull AND tashilatFull', rotbeNullLoans: 'rotbeNull AND loansFull',
    rotbeNullBoth: 'rotbeNull AND tashilatFull AND loansFull',
    facilityOverdue: 'حداقل یک ردیف شیء با AmMoavagh معتبر >۰؛ مستقل از پیام و وضعیت success/fail.',
    facilityPastDue: 'حداقل یک ردیف شیء با AmSarResid معتبر >۰.', facilityDoubtful: 'حداقل یک ردیف شیء با AmMashkuk معتبر >۰.',
    facilityMissing: 'کلید قطعی تسهیلات غایب یا دارای نوع نامعتبر است؛ null طبق قرارداد هر سه بانک بدون تسهیلات است، نه کلید غایب.',
    facilityInvalidItems: 'آرایه موجود است ولی حداقل یک عضو، شیء غیرخالی نیست.',
    facilityEmpty: 'در هر سه بانک، null صریح یا [] در مسیر قطعی TashilatItem یعنی بدون تسهیلات؛ کلید غایب، آبجکت خالی یا نوع نامعتبر مشمول نیست.',
    facilityPresent: 'حداقل یک شیء غیرخالی تسهیلات وجود دارد.',
    facilityAmountsIncomplete: `حداقل یکی از ${FIELDS.map(([f]) => f).join('، ')} در یک ردیف، نامعتبر/غایب/منفی است.`,
    facilityCurrencyUnknown: `حداقل یک ${bank.schema.currency} در ردیف‌های قابل خواندن، کد سه‌حرفی معتبر ندارد.`,
    facilityMixedCurrency: 'همهٔ واحدها معلوم‌اند و بیش از یک واحد وجود دارد.',
    facilityTotalsDiffer: 'برای هر یک از پنج مبلغ با جمع ریالی کامل و جمع اعلامی معتبر، abs(sum−Total)>۰٫۰۱؛ یک اختلاف برای علامت‌گذاری گزارش کافی است.',
    facilityCount: 'در هر سه بانک: null یا [] مقدار صفر؛ آبجکت آیتم غیرخالی مقدار یک؛ آرایهٔ سالم طول آرایه. کلید غایب، آبجکت خالی، نوع نامعتبر یا آرایهٔ دارای عضو نامعتبر از آمار شمار کل حذف می‌شود. تغییر شکل فقط محاسباتی و بدون تغییر JSON خام است.',
    facilityBankCount: `count(distinct ${bank.schema.bankCode}) فقط کدهای رقمی خوانا با نرمال‌سازی صفر ابتدایی؛ بدون کد معتبر حذف می‌شود.`,
    facilityCurrency: 'بدون ردیف / حداقل یک واحد ناشناخته / چند واحد شناخته‌شده / همه IRR / یک واحد غیرریالی.',
    depositInvalid: 'حداقل یک ردیف یا ساختار حساب/ماه یا تاریخ/مبلغ نامعتبر؛ مبلغ منفی نیز نامعتبر است.',
    depositLength: bank.key === 'tavan_mellat' ? 'تعداد ردیف ماهانه: صفر، <۳۶، =۳۶، >۳۶؛ این دسته بر اساس ردیف است، نه ماه یکتا.' : 'تعداد ماه معتبر یکتا: صفر، <۳۶، =۳۶، >۳۶.',
    depositWindow: 'بدون ردیف ⇒ noDeposit؛ بدون هیچ تاریخ ماه معتبر ⇒ badDates؛ تاریخ اعتبارسنجی نامعلوم ⇒ noValDate؛ وگرنه gap=ماه اعتبارسنجی−قدیمی‌ترین ماه: =۳۶ / <۳۶ / >۳۶.',
    depositLast: 'بدون ماه ⇒ noDeposit؛ تاریخ سپرده/اعتبارسنجی نامعلوم ⇒ unknown؛ gap=ماه اعتبارسنجی−آخرین ماه: <=۰ / =۱ / >۱.',
  };
  if (formulas[id]) return formulas[id];
  if (type === 'metrics' && outputPaths[id]) return 'خواندن مستقیم مقدار عددی از مسیر؛ سپس count/min/Q1/median/mean/Q3/max بین گزارش‌های دارای مقدار معتبر.';
  return String(spec.test || spec.value || spec.classify || spec.when || '');
}
const registry = { version: require('../package.json').version, rankingNullThreshold: RANKING_NULL_THRESHOLD, configurableViaCli: false, rotbeKeys: ROTBE_CHECK_KEYS, banks: [] };
for (const bank of Object.values(loadBanks({ minNull: RANKING_NULL_THRESHOLD }))) {
  const entry = { id: bank.key, label: bank.label, schema: bank.schema,
    sections: [{ id: 'overview', ...COMMON_TOPICS.overview }, ...bank.topics.map(({ id, label, desc, details }) => ({ id, label, desc, details })),
      ...['risk', 'status', 'model', 'empty', 'lists', 'daily'].map((id) => ({ id, ...COMMON_TOPICS[id] }))], paths: bank.paths.map(({ key, label, displayPath }) => ({ key, label, path: displayPath })), definitions: {} };
  for (const type of ['flags', 'metrics', 'categories', 'counters']) entry.definitions[type] = bank[type].map((spec) => ({
    id: spec.id, label: spec.label, topic: spec.topic, derived: !!spec.derived, preserveFraction: !!spec.preserveFraction, summaryDecimals: spec.summaryDecimals, display: spec.display, stats: spec.stats, note: spec.histNote || spec.subtitle || spec.groupNote || spec.note, source: source(bank, spec), formula: formula(bank, spec, type),
    code: String(spec.test || spec.value || spec.classify || ''), onlyStatus: spec.onlyStatus || 'ALL',
    ...(type === 'flags' ? { inspect: spec.inspect !== false, daily: !!spec.daily } : {}),
    ...(spec.values ? { categories: spec.values } : {}), ...(spec.hist ? { histogram: spec.hist } : {}),
  }));
  entry.cross = bank.cross; entry.lists = bank.lists.map((x) => ({ title: x.title, filter: String(x.when), row: String(x.row) }));
  registry.banks.push(entry);
}
fs.writeFileSync(path.join(dir, 'indicator-registry.json'), JSON.stringify(registry, (_key, value) => value === Infinity ? 'Infinity' : value, 2));
console.log('Exported', registry.banks.reduce((sum, b) => sum + Object.values(b.definitions).reduce((n, a) => n + a.length, 0), 0), 'indicator definitions.');
