'use strict';
const {h,nf,pct}=require('./common');
const COLORS=['var(--green)','var(--chart-purple)','var(--amber)','#3d95cf','#e16d80','#5aabaa','#b58c57','#b374ce'];
const colorAt=i=>COLORS[i]||`hsl(${(i*137.508)%360},55%,50%)`;
const frame=(kind,title,note,body)=>`<figure class="insight-chart ${kind}"><figcaption><span class="chart-kicker">نمای تصویری</span><h3>${h(title)}</h3><p>${h(note)}</p></figcaption>${body}</figure>`;
function tipAttrs(key,title,rows,total,unit='گزارش',footnote='',direction='auto',subtitle=''){
 const payload={title,direction,subtitle,rows:rows.map(r=>({label:r.label||'',count:nf(r.count),percent:pct(r.count,total)})),countLabel:'تعداد '+unit,footnote:footnote||`مبنای درصد: ${nf(total)} ${unit}`};
 const accessible=`${title}${subtitle?" — "+subtitle:""}؛ `+payload.rows.map(r=>`${r.label} ${r.count} ${unit}، ${r.percent}`).join('؛ ');
 return `data-chart-key="${h(key)}" data-chart-tip="${h(JSON.stringify(payload))}" tabindex="0" role="img" aria-label="${h(accessible)}"`;
}
// Real arcs, not overlapping dashed circles: hit-testing must identify the visible slice.
function ringSegment(start,share,color,attrs,extra=''){
 if(share<=0)return '';
 const common=`class="chart-mark ring-segment" fill="none" stroke="${color}" stroke-width="27" ${extra} ${attrs}`;
 if(share>=1)return `<circle cx="110" cy="110" r="76" ${common}/>`;
 const point=f=>[110+76*Math.cos(f*2*Math.PI-Math.PI/2),110+76*Math.sin(f*2*Math.PI-Math.PI/2)];
 const [x1,y1]=point(start),[x2,y2]=point(start+share);
 return `<path d="M ${x1} ${y1} A 76 76 0 ${share>.5?1:0} 1 ${x2} ${y2}" ${common}/>`;
}
function ringChart(kind,title,note,entries,unit='گزارش',center='گزارش',model=false){
 const total=entries.reduce((s,e)=>s+e.count,0);if(!total)return '';
 let offset=0;
 const slices=entries.map((e,i)=>{const attrs=tipAttrs(String(i),title,[{count:e.count}],total,unit,'','auto',e.label),share=e.count/total,color=e.color||colorAt(i);
  const shape=ringSegment(offset,share,color,attrs,`${model?`data-model="${h(e.label)}" `:''}data-count="${e.count}"`);offset+=share;
  return {e,attrs,color,shape};});
 const body=`<div class="deposit-chart-layout ${model?'model-chart-layout':''}"><svg class="interactive-ring" viewBox="0 0 220 220" role="group" aria-label="${h(title)}؛ ${nf(total)} ${h(unit)}">${slices.map(s=>s.shape).join('')}<text x="110" y="110" class="ring-total" text-anchor="middle">${nf(total)}</text><text x="110" y="134" class="ring-center-label" text-anchor="middle">${h(center)}</text></svg><div class="deposit-chart-legend model-chart-legend">${slices.map(({e,attrs,color})=>`<div class="chart-mark chart-legend-item" ${attrs}><span dir="auto"><i style="background:${color}"></i>${h(e.label)}</span><strong>${nf(e.count)}</strong><bdi dir="ltr">${pct(e.count,total)}</bdi></div>`).join('')}</div></div>`;
 return frame(kind,title,note,body);
}
function barChart(kind,title,note,entries,total,unit='گزارش'){
 if(!total)return '';
 const rows=entries.map((e,i)=>`<div class="facility-bar-row chart-mark" data-count="${e.count}" ${tipAttrs(String(i),title,[{count:e.count}],total,unit,'',e.direction||'auto',e.label)}><strong dir="${e.direction||'auto'}">${h(e.label)}</strong><span class="facility-bar-track" aria-hidden="true"><i style="width:${Math.min(100,e.count/total*100)}%;--bar-color:${e.color||'var(--accent)'}"></i></span><bdi dir="ltr">${nf(e.count)} ${h(unit)}</bdi><bdi dir="ltr">${pct(e.count,total)}</bdi></div>`).join('');
 return frame(kind,title,note,`<div class="facility-bars">${rows}</div>`);
}
function dailyChart(days,groups){
 const rows=days.map(day=>({day,stats:groups['day:'+day]})).filter(x=>x.stats);if(!rows.length)return '';
 const width=Math.max(720,rows.length*44+100),height=270,left=65,right=25,top=20,bottom=215,plot=width-left-right;
 const rawMax=rows.reduce((m,x)=>Math.max(m,x.stats.total),1),max=Math.ceil(rawMax/4)*4,unit=plot/rows.length,bar=Math.min(36,unit*.65),step=Math.max(1,Math.ceil(96/unit));
 let drawing='';
 for(let n=0;n<=4;n++){const value=max*n/4,y=bottom-(bottom-top)*n/4;drawing+=`<line class="chart-grid" x1="${left}" x2="${width-right}" y1="${y}" y2="${y}"/><text x="${left-10}" y="${y+4}" text-anchor="end">${h(nf(value))}</text>`;}
 rows.forEach(({day,stats},i)=>{const ok=stats.byStatus.success||0,fail=stats.byStatus.fail||0,x=left+unit*(i+.5)-bar/2,okH=ok/max*(bottom-top),failH=fail/max*(bottom-top);
  drawing+=`<g class="chart-mark daily-mark" data-day="${h(day)}" data-success="${ok}" data-fail="${fail}" ${tipAttrs(String(i),'گزارش‌های روزانه',[{label:'موفق',count:ok},{label:'ناموفق',count:fail}],stats.total,'گزارش','کل گزارش‌های این روز: '+nf(stats.total),'ltr',day)}><rect class="chart-success" x="${x}" y="${bottom-okH}" width="${bar}" height="${okH}"/><rect class="chart-fail" x="${x}" y="${bottom-okH-failH}" width="${bar}" height="${failH}"/></g>`;
  if((i%step===0&&rows.length-1-i>=step)||i===rows.length-1)drawing+=`<text class="chart-day" x="${x+bar/2}" y="240" text-anchor="middle">${h(day)}</text>`;
 });
 const total=rows.reduce((s,x)=>s+x.stats.total,0);
 const body=`<div class="chart-legend"><span><i class="legend-success"></i>موفق</span><span><i class="legend-fail"></i>ناموفق</span><span>${nf(total)} گزارش در ${nf(rows.length)} روز</span></div><div class="chart-scroll" tabindex="0" aria-label="نمودار روزانه؛ در بازه‌های طولانی افقی پیمایش کنید"><svg class="daily-svg" style="min-width:${width}px" viewBox="0 0 ${width} ${height}" role="group" aria-label="تعداد گزارش‌های موفق و ناموفق در هر روز">${drawing}</svg></div>`;
 return frame('daily-stacked','حجم و ترکیب گزارش‌ها در روزهای مختلف','ستون‌های انباشته: تعداد موفق و ناموفق، نه درصد. ترتیب زمانی از چپ به راست است؛ روزهای فاقد پوشه صفر فرض نمی‌شوند. روی ستون مکث کنید، با صفحه‌کلید آن را انتخاب کنید یا در موبایل لمس کنید.',body);
}
function depositTypeChart(stats){
 const entries=[['natural','حقیقی','var(--green)'],['legal','حقوقی','var(--chart-purple)'],['unknown','غیرقابل‌تشخیص','var(--amber)']].map(([key,label,color])=>({label,color,count:stats.counters['depositType_'+key]||0}));
 return ringChart('deposit-ring','ترکیب ردیف‌های سپردهٔ رسالت','مخرج: ردیف‌های آرایهٔ سپرده، نه گزارش‌ها یا حساب‌های یکتا. تکرار حساب در چند گزارش دوباره شمرده می‌شود. فهرست غایب/نامعتبر وارد این مخرج نیست و در شاخص نوع نامشخص قابل بررسی است.',entries,'ردیف','ردیف سپرده');
}
function facilityCountChart(values){
 const a=(values||[]).filter(n=>Number.isSafeInteger(n)&&n>=0);
 const bins=[{label:'بدون تسهیلات',count:0},{label:'۱ تسهیلات',count:0},{label:'۲ تا ۳ تسهیلات',count:0},{label:'۴ تا ۵ تسهیلات',count:0},{label:'۶ تسهیلات و بیشتر',count:0}];
 for(const n of a)bins[n===0?0:n===1?1:n<=3?2:n<=5?3:4].count++;
 return barChart('facility-count-chart','توزیع تعداد تسهیلات سمات',`${nf(a.length)} گزارش با تعداد تسهیلات معلوم؛ هر گزارش فقط در یک بازه است. null صریح یا آرایهٔ خالی، صفر تسهیلات است؛ شمار نامشخص وارد نمودار نمی‌شود.`,bins,a.length);
}
function modelChart(stats){
 const entries=Object.entries(stats.cats.modelName||{}).filter(([,count])=>count>0).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([label,count])=>({label,count}));
 return ringChart('model-ring','سهم مدل‌های اجراشده در گزارش‌های موفق','مخرج فقط گزارش‌های موفق دارای آبجکت خروجی و نام مدل غیرخالی است؛ ناموفق‌ها و موارد بدون خروجی/نام مدل کنار گذاشته می‌شوند. نام مدل مستقیماً از output.model_name خوانده می‌شود.',entries,'گزارش','گزارش موفق',true);
}
function categoryChart(spec,stats){
 if(!['statusCode','scoreCategory','scoreRange'].includes(spec.id))return '';
 const entries=Object.entries(stats.cats[spec.id]||{}).filter(([,count])=>count>0).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([key,count],i)=>({label:spec.values?.[key]||key,count,direction:spec.id==='scoreRange'&&/[0-9۰-۹٠-٩]/.test(key)?'ltr':'auto',color:/ثبت نشده/.test(key)?'var(--subtle)':colorAt(i)}));
 const total=stats.catTotals[spec.id]||0;
 if(spec.id==='statusCode')return ringChart('status-code-ring','ترکیب کدهای وضعیت خروجی','تفکیک کد وضعیت در همین محدودهٔ انتخابی؛ مخرج و قواعد کدهای ثبت‌نشده دقیقاً همان جدول این بخش است. برچسب موفق/ناموفق گزارش مستقل از این کد است.',entries);
 const title=spec.id==='scoreCategory'?'توزیع ردهٔ امتیاز مدل':'توزیع بازهٔ امتیاز مدل';
 return barChart(spec.id==='scoreCategory'?'score-category-chart':'score-range-chart',title,`${nf(total)} گزارش در دسته‌بندی همین بخش؛ طول نوار سهم از کل این مجموعه است و ترتیب بر اساس فراوانی است، نه شدت ریسک. گروه «ثبت نشده» نیز، در صورت وجود، جدا نمایش داده می‌شود.`,entries,total);
}
module.exports={dailyChart,depositTypeChart,facilityCountChart,modelChart,categoryChart};
