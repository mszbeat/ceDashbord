'use strict';
const {get,isRotbeNullData}=require('../banks/_helpers');
const {normalizeFacilities}=require('./facility-items');
const {RANKING_NULL_THRESHOLD}=require('./config');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const digits=v=>String(v).replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-0x06f0)).replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x0660));
function identifier(value){
  if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0))return null;
  if(!['string','number'].includes(typeof value))return null;
  const text=digits(value).trim();
  return /^\d+$/.test(text)?text.replace(/^0+(?=\d)/,''):null;
}
function depositType(account){
  if(!object(account)||typeof account.deposit_number!=='string')return 'unknown';
  const parts=digits(account.deposit_number).trim().split('.');
  if(parts.length!==3||parts.some(p=>!/^\d+$/.test(p)))return 'unknown';
  const customer=identifier(account.customer_code),middle=identifier(parts[1]);
  if(customer===null||middle===null)return 'unknown';
  return customer===middle?'natural':'legal';
}
function attachResalatDeposits(bank){
  if(bank.key!=='tavan_resalat')return;
  const cache=new WeakMap();
  function info(_c,s){
    if(cache.has(s))return cache.get(s);
    const raw=get(s,bank.schema.deposit),known=Array.isArray(raw);
    const result={known,natural:0,legal:0,unknown:0,total:known?raw.length:0};
    for(const account of known?raw:[])result[depositType(account)]++;
    const facilities=normalizeFacilities(get(s,bank.schema.facilities));
    result.noFacilities=['null','emptyArray'].includes(facilities.kind);
    const loans=get(s,bank.schema.loans);
    result.noLoans=Array.isArray(loans)&&loans.length===0;
    result.noRanking=isRotbeNullData(get(s,bank.schema.rotbe),RANKING_NULL_THRESHOLD);
    result.noNatural=known&&result.unknown===0&&result.natural===0;
    result.noUsableSources=result.noFacilities&&result.noLoans&&result.noRanking&&result.noNatural;
    cache.set(s,result);return result;
  }
  bank.resalatDepositInfo=info;
  const source=bank.schema.deposit+'[*].deposit_number ; '+bank.schema.deposit+'[*].customer_code';
  const row=(c,s)=>{const i=info(c,s);return {'سپرده‌های حقیقی':i.natural,'سپرده‌های حقوقی':i.legal,'ردیف‌های غیرقابل‌تشخیص':i.unknown,'وضعیت فهرست سپرده':i.known?'آرایهٔ موجود':'نامشخص'};};
  for(const [id,label,test,formula] of [
    ['hasLegalDeposit','دارای سپردهٔ حقوقی',(c,s)=>info(c,s).legal>0,'حداقل یک ردیف سپرده که بخش میانی deposit_number سه‌بخشیِ رقمی، با customer_code رقمی متفاوت باشد؛ هر گزارش یک بار.'],
    ['onlyLegalDeposits','فقط دارای سپردهٔ حقوقی',(c,s)=>{const i=info(c,s);return i.known&&i.legal>0&&i.natural===0&&i.unknown===0;},'آرایهٔ سپرده موجود و غیرخالی؛ تمام ردیف‌ها حقوقی قابل‌تشخیص؛ هیچ حقیقی یا ردیف نامشخص وجود نداشته باشد. زیرمجموعهٔ دارای حقوقی است، نه گروه مجزا برای جمع‌زدن.'],
    ['depositTypeUnknown','نوع سپرده قابل تشخیص نیست',(c,s)=>{const i=info(c,s);return !i.known||i.unknown>0;},'فهرست سپرده غایب/نامعتبر یا حداقل یک ردیف با شماره/کد غایب، پوشانده‌شده یا نامعتبر. آرایهٔ خالی نامشخص نیست.'],
  ])bank.flags.push({id,topic:'deposit',label,card:'neutral',inspect:true,sourcePath:source,formula,test,row});
  bank.metrics.push({id:'legalDepositsPerReport',topic:'deposit',group:'تعداد سپرده‌های حقوقی در گزارش‌های دارای سپردهٔ حقوقی',label:'تعداد سپرده‌های حقوقی قابل‌تشخیص در هر گزارش',sourcePath:source,
    formula:'تعداد ردیف‌های حقوقی طبق مقایسهٔ شناسه‌ها در هر گزارش؛ تنها گزارش‌های با شمار حقوقی >۰ وارد count/min/Q1/median/mean/Q3/max می‌شوند؛ گزارش‌های بدون حقوقی با صفر به مخرج اضافه نمی‌شوند.',value:(c,s)=>info(c,s).legal||null});
  for(const [kind,label] of [['natural','ردیف‌های سپردهٔ حقیقی'],['legal','ردیف‌های سپردهٔ حقوقی'],['unknown','ردیف‌های سپردهٔ غیرقابل‌تشخیص']])bank.counters.push({id:'depositType_'+kind,topic:'deposit',display:'chartOnly',label,sourcePath:source,formula:'جمع تعداد ردیف‌های '+label+' در تمام گزارش‌های دامنه؛ رخداد ردیف‌ها، نه حساب‌های یکتای بین گزارش‌ها.',value:(c,s)=>info(c,s)[kind]});
  bank.depositTypeChart=true;
  const sourceRow=(c,s)=>{const i=info(c,s);return {...row(c,s),'بدون تسهیلات قطعی':i.noFacilities?'بله':'خیر/نامشخص','بدون سابقهٔ وام قطعی':i.noLoans?'بله':'خیر/نامشخص','رتبه‌بندی فاقد داده':i.noRanking?'بله':'خیر'};};
  bank.flags.push({id:'noUsableCreditSources',topic:'overview',label:'فاقد منابع اطلاعاتی مورد بررسی',card:'neutral',inspect:true,
    subtitle:'بدون تسهیلات و سابقهٔ وام؛ رتبه‌بندی فاقد داده و بدون سپردهٔ حقیقی.',
    sourcePath:bank.schema.facilities+' ; '+bank.schema.loans+' ; '+bank.schema.rotbe+' ; '+source,
    formula:'TashilatItem صریحاً null یا []؛ historicalLoans=[]؛ رتبه‌بندی فاقد داده طبق آستانهٔ ثابت ۳؛ و آرایهٔ سپردهٔ موجود با شمار حقیقی و نامشخص هر دو صفر. فقط وضعیت ورودی‌های مورد بررسی؛ بدون نتیجه‌گیری دربارهٔ نام مدل یا مبلغ خروجی.',
    test:(c,s)=>info(c,s).noUsableSources,row:sourceRow});
}
module.exports={attachResalatDeposits,depositType,identifier};
