'use strict';
const { get, own, num, ymIndex, ymFmt } = require('../banks/_helpers');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonemptyObject = value => object(value) && Object.keys(value).length > 0;
const digits = value => String(value ?? '').replace(/[۰-۹]/g, d => String(d.charCodeAt(0)-0x06f0)).replace(/[٠-٩]/g, d => String(d.charCodeAt(0)-0x0660));
// Only the declared request timestamp; no substitution from service or loan dates.
function requestMonth(sample) {
  const text = digits(get(sample, 'insertDate_full')).trim();
  const direct = ymIndex(text);
  if (direct !== null) return direct;
  if (/^\d{12,17}$/.test(text)) return ymIndex(text.slice(0,8));
  const match = text.match(/^(\d{4}[/.-]\d{1,2}[/.-]\d{1,2})[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/);
  return match ? ymIndex(match[1]) : null;
}
function dateState(record, key) {
  if (!object(record) || !own(record,key)) return 'missing';
  const value = record[key];
  if (value === null) return 'null';
  // Presence monitoring, not proof that the supplied date is valid or a payment occurred.
  if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))) return 'value';
  return 'invalid';
}
function attachDataMonitoring(bank) {
  const post = bank.key === 'tavan_postbank', mellat = bank.key === 'tavan_mellat';
  if (!post && !mellat) return;
  const loanCache = new WeakMap(), depositCache = new WeakMap();
  const paths = post ? [{id:'paymentDate',label:'تاریخ پرداخت قسط',key:'installmentPaymentDate',suffix:'.installments[*].installmentPaymentDate'}] : [
    {id:'deliveryDate',label:'deliveryDate',key:'deliveryDate',suffix:'.installments[*].deliveryDate'},
    {id:'paymentEntriesDate',label:'installmentPayments.date',nested:true,suffix:'.installments[*].installmentPayments[*].date'},
  ];
  function loans(_c,sample) {
    if (loanCache.has(sample)) return loanCache.get(sample);
    const raw = get(sample, bank.schema.loans);
    const result = {total:0,eligible:0,corona:0,approvedZero:0,approvedNull:0,paths:{}};
    for (const p of paths) result.paths[p.id] = {allNull:0,withValue:0,installments:0,nullInstallments:0,valueInstallments:0};
    for (const loan of Array.isArray(raw) ? raw : []) {
      if (!nonemptyObject(loan)) continue;
      result.total++;
      if (num(loan.loanTypeCode) === 221) result.corona++;
      if (own(loan,'approvedAmount') && num(loan.approvedAmount) === 0) result.approvedZero++;
      if (own(loan,'approvedAmount') && loan.approvedAmount === null) result.approvedNull++;
      const items = Array.isArray(loan.installments) ? loan.installments : [];
      const local = Object.fromEntries(paths.map(p=>[p.id,{nulls:0,values:0}]));
      let readable = 0;
      // One cached traversal of installments for both Mellat paths and all new indicators.
      for (const item of items) {
        if (!nonemptyObject(item)) continue;
        readable++;
        for (const p of paths) {
          let allNull, withValue;
          if (p.nested) {
            const payments = item.installmentPayments;
            allNull = Array.isArray(payments) && payments.length > 0;
            withValue = false;
            for (const payment of Array.isArray(payments) ? payments : []) {
              const state = dateState(payment,'date');
              if (state !== 'null') allNull = false;
              if (state === 'value') withValue = true;
            }
          } else {
            const state = dateState(item,p.key);allNull = state === 'null';withValue = state === 'value';
          }
          if (allNull) local[p.id].nulls++;
          if (withValue) local[p.id].values++;
        }
      }
      const eligible = items.length > 0 && readable === items.length;
      if (eligible) result.eligible++;
      for (const p of paths) {
        const aggregate = result.paths[p.id], current = local[p.id];
        aggregate.installments += readable;
        aggregate.nullInstallments += current.nulls;
        aggregate.valueInstallments += current.values;
        if (eligible && current.nulls === items.length) aggregate.allNull++;
        if (current.values > 0) aggregate.withValue++;
      }
    }
    loanCache.set(sample,result);return result;
  }
  bank.loanMonitoring = { paths };
  bank.monitorNotes = { loans:'پایش پوشش داده، نه تشخیص بدحسابی: تاریخ پرداخت null برای قسط آینده یا پرداخت‌نشده می‌تواند طبیعی باشد. «تمام تاریخ‌ها null» فقط برای وام دارای آرایهٔ اقساط غیرخالی و سالم و null صریح در تمام اقساطِ موجود در پاسخ است (نه اثبات دریافت تمام اقساط قراردادی)؛ کلید غایب، آرایهٔ خالی و ساختار نامعتبر null شمرده نمی‌شوند. «مقدار غیرتهی» صرفاً پرشدن فیلد رشته‌ای/عددی است، نه تأیید اعتبار تاریخ یا وقوع پرداخت. کارت‌ها درصد گزارش‌ها را نشان می‌دهند؛ جدول پایش، تعداد و درصد وام‌ها را با مخرج مشخص نشان می‌دهد. یک گزارش چندوامی می‌تواند در چند شاخص باشد. شمار وام‌ها، شمار رخدادهای وام در گزارش‌هاست، نه وام‌های یکتای مشتریان.' };
  const counter = (id,label,value,sourcePath,formula) => bank.counters.push({id,label,topic:'loans',display:'paymentCoverage',value,sourcePath,formula});
  counter('monitorLoanTotal','کل وام‌های قابل خواندن',(_c,s)=>loans(_c,s).total,bank.schema.loans,'تعداد اشیای غیرخالی وام در مسیر قطعی؛ بدون حذف وام کرونا یا مبلغ صفر/null؛ بدون یکتاسازی بین گزارش‌ها.');
  counter('monitorLoanEligible','وام‌های دارای اقساط غیرخالی و سالم',(_c,s)=>loans(_c,s).eligible,bank.schema.loans+'[*].installments','تعداد وام‌هایی که installments آرایهٔ غیرخالی و تمام اعضای آن شیء غیرخالی است؛ مخرج درصد تمام تاریخ‌ها null.');
  for (const p of paths) {
    const sourcePath = bank.schema.loans+'[*]'+p.suffix;
    const row = (c,s) => {
      const info=loans(c,s),v=info.paths[p.id];return {'مسیر تاریخ':p.label,'کل وام‌های قابل خواندن':info.total,'وام با اقساط قابل بررسی':info.eligible,
        'وام با تمام تاریخ‌ها null':v.allNull,'وام دارای مقدار غیرتهی':v.withValue,'تعداد اقساط قابل خواندن':v.installments,
        'اقساط با تاریخ‌های صریحاً null':v.nullInstallments,'اقساط دارای مقدار غیرتهی':v.valueInstallments};
    };
    for (const [suffix,key,label,tone] of [['AllNull','allNull',`وام با تمام تاریخ‌های ${p.label} برابر null`,'neutral'],['HasValue','withValue',`وجود مقدار غیرتهی در ${p.label}`,'normal']]) {
      bank.flags.push({id:p.id+suffix,topic:'loans',label,card:tone,inspect:true,sourcePath,
        subtitle:suffix==='AllNull'?'هشدار پوشش داده؛ لزوماً خطا یا بدحسابی نیست.':'برای رصد شروع یا تغییر داده‌دهی؛ اعتبار تاریخ تأیید نمی‌شود.',
        formula:suffix==='AllNull'?`حداقل یک وام دارای اقساط سالم و غیرخالی که تمام ${p.nested?'اقساطش آرایهٔ installmentPayments سالم و غیرخالی دارند و همهٔ dateها':'کلیدهای '+p.key+' اقساطش'} صریحاً null باشند. غیاب/خالی/نامعتبر پذیرفته نیست. هر گزارش یک بار.`:`حداقل یک مقدار رشته‌ای غیرخالی یا عدد متناهی در ${sourcePath}؛ این پایشِ وجود داده است نه صحت تاریخ. هر گزارش یک بار.`,
        test:(c,s)=>loans(c,s).paths[p.id][key]>0,row});
      counter(p.id+suffix+'Loans',label+' — تعداد وام', (c,s)=>loans(c,s).paths[p.id][key],sourcePath,
        suffix==='AllNull'?'تعداد وام‌های دارای تمام تاریخ‌های صریحاً null؛ درصد در نمایش = مجموع این شمارنده / مجموع monitorLoanEligible × ۱۰۰.':'تعداد وام‌های دارای حداقل یک مقدار غیرتهی در این مسیر؛ هر وام در یک گزارش یک بار.');
    }
  }
  if (!post) return;
  for (const [id,key,label,field,formula] of [
    ['coronaLoan','corona','دارای وام کرونا — کد ۲۲۱','loanTypeCode','حداقل یک وام با loanTypeCode عددی یا رشتهٔ عددی برابر ۲۲۱؛ تعریف عملیاتی اعلام‌شدهٔ کاربر، بدون استنباط از مبلغ/تاریخ/نام وام و بدون حذف وام از آمار.'],
    ['loanApprovedZero','approvedZero','دارای وام با مبلغ مصوب صفر','approvedAmount','حداقل یک وام با approvedAmount عددی صفر یا رشتهٔ عددی صفر؛ null، کلید غایب، خالی، boolean و غیرعددی مشمول نیستند؛ مستقل از کد وام.'],
    ['loanApprovedNull','approvedNull','دارای وام با مبلغ مصوب null','approvedAmount','حداقل یک وام با کلید موجود approvedAmount و مقدار دقیقاً null؛ غایب یا رشتهٔ null مشمول نیست؛ مستقل از کد وام.'],
  ]) bank.flags.push({id,topic:'loans',label,card:'neutral',inspect:true,sourcePath:bank.schema.loans+'[*].'+field,formula,
    test:(c,s)=>loans(c,s)[key]>0,row:(c,s)=>{const i=loans(c,s);return {'کل وام‌های قابل خواندن':i.total,'وام‌های کد ۲۲۱':i.corona,'وام‌های با مبلغ مصوب صفر':i.approvedZero,'وام‌های با مبلغ مصوب null':i.approvedNull};}});
  function deposits(_c,sample) {
    if (depositCache.has(sample)) return depositCache.get(sample);
    const raw=get(sample,bank.schema.deposit),month=requestMonth(sample);
    const result={month,accounts:0,stale:0,placeholder:0,unknown:0,future:0,maxGap:null,oldLatest:null,invalidArray:!Array.isArray(raw)};
    for (const account of Array.isArray(raw)?raw:[]) {
      if (!object(account)) {result.invalidArray=true;continue;}
      result.accounts++;
      const average=account.average;
      if (object(average)&&Object.keys(average).length===1&&own(average,'undefined')&&average.undefined===null) result.placeholder++;
      const indices=object(average)?Object.keys(average).map(ymIndex).filter(n=>n!==null):[];
      if (month===null||!indices.length) {result.unknown++;continue;}
      const latest=Math.max(...indices),gap=month-latest;
      if (gap<0) result.future++;
      if (gap>1) {
        result.stale++;
        if (result.maxGap===null||gap>result.maxGap) {result.maxGap=gap;result.oldLatest=latest;}
      }
    }
    depositCache.set(sample,result);return result;
  }
  bank.monitorNotes.deposit='قدیمی بودن، مستقل از طول تاریخچه است: جدیدترین ماه معتبرِ هر حساب با ماه insertDate_full مقایسه می‌شود؛ فاصلهٔ بیش از یک ماه در حداقل یک حساب، گزارش را مشمول می‌کند. حساب تازه، حساب قدیمی دیگر را پنهان نمی‌کند. تاریخ درخواست غایب/نامعتبر یا حساب بدون ماه معتبر، نامشخص است نه قدیمی؛ تاریخ آینده نیز نشانهٔ تازه و معتبر بودن تلقی نمی‌شود. تاریخ معتبر مستقل از اعتبار مبلغ بررسی می‌شود. ساختار دقیق average با تنها کلید undefined و مقدار null جدا شمرده می‌شود؛ حساب وجود دارد، اما این شاخص دادهٔ آن را صفر نمی‌کند و محاسبهٔ میانگین قبلی را تغییر نمی‌دهد.';
  const row=(c,s)=>{const i=deposits(c,s);return {'ماه ثبت درخواست':i.month===null?'—':ymFmt(i.month),'تعداد حساب‌ها':i.accounts,'حساب‌های دارای تاریخچهٔ قدیمی':i.stale,
    'بیشترین فاصلهٔ آخرین داده (ماه)':i.maxGap??'—','آخرین ماه حساب با بیشترین فاصله':i.oldLatest===null?'—':ymFmt(i.oldLatest),
    'حساب‌های با undefined:null':i.placeholder,'حساب‌های با زمان نامشخص':i.unknown,'حساب‌های دارای ماه آینده':i.future};};
  for (const [id,label,card,test,formula,sourcePath] of [
    ['depositStale','دارای حساب با تاریخچهٔ سپردهٔ قدیمی','warn',(c,s)=>deposits(c,s).stale>0,
      'برای هر حساب: gap=ماه insertDate_full − max(ماه‌های معتبر کلیدهای average). اگر حداقل یک gap>۱ باشد، گزارش یک بار شمرده می‌شود. حساب بدون تاریخ معتبر یا درخواست بدون تاریخ قابل مقایسه، قدیمی فرض نمی‌شود؛ ماه‌های آینده نیز مشمول نیستند. مستقل از مبلغ و طول تاریخچه.',bank.schema.deposit+'[*].average ; insertDate_full'],
    ['depositUndefinedBalance','حساب با ماندهٔ ثبت‌نشده — undefined:null','neutral',(c,s)=>deposits(c,s).placeholder>0,
      'حداقل یک حساب که average شیء با دقیقاً یک کلید خودی undefined و مقدار صریح null باشد. وجود depositNumber شرط تشخیص ساختار نیست. average خالی، null، رشتهٔ null یا دارای کلید اضافه مشمول نیست. هیچ صفرسازی یا تغییر میانگین انجام نمی‌شود.',bank.schema.deposit+'[*].average'],
    ['depositRecencyUnknown','تازگی دادهٔ سپرده قابل تشخیص نیست','neutral',(c,s)=>{const i=deposits(c,s);return i.invalidArray||i.unknown>0;},
      'آرایهٔ حساب غایب/نامعتبر یا دارای عضو غیرشیء؛ یا حداقل یک حساب بدون ماه معتبر یا بدون ماه درخواست معتبر. [] بدون حساب است و مشمول این شاخص نیست. می‌تواند همراه شاخص قدیمی در یک گزارش چندحسابی رخ دهد.',bank.schema.deposit+'[*].average ; insertDate_full'],
  ]) bank.flags.push({id,topic:'deposit',label,card,inspect:true,test,formula,sourcePath,row});
}
module.exports={attachDataMonitoring,requestMonth,dateState};
