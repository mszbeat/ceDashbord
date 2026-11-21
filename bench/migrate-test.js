'use strict';
/** آزمون مهاجرت: v1 پر → اجرای v1→v2 → مقایسه با مسیر مستقیم v2 + تست rollback */
const fs=require('node:fs'), path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const common=require('./common');
const {loadEvaluator,readSamples,makeRows,TABLES,UPSERT_COLUMNS,dbAdapter}=common;
const BACKEND = process.env.CE_BACKEND || require('node:path').join(__dirname, '..', 'backend');
const {V1ToV2Migration}=require(BACKEND + '/services/db/migrate-v2');
const {V2Dialect}=require(BACKEND + '/services/db/dialect-v2');
const {SummaryService}=require(BACKEND + '/services/summary/summary.service');
const {buildRuntimeRegistry}=require(BACKEND + '/services/db/schema-registry');
const {buildReport}=require(BACKEND + '/services/legacy-report/report-builder');

const JSON_COL=new Set(['flags','cats','counters','metrics','paths','services','credit_alerts','display_extras']);
const perBank=Number(process.env.PER_BANK||200);
// `generatedAt` طبیعتاً بین دو اجرا فرق می‌کند؛ برای مقایسه نرمال می‌شود
const stable=(v)=>JSON.stringify(v,(k,x)=>k==='generatedAt'?'<ts>':(x&&typeof x==='object'&&!Array.isArray(x))?Object.fromEntries(Object.keys(x).sort().map(kk=>[kk,x[kk]])):x);

(async()=>{
const ev=loadEvaluator();
const {registry,banksSpecs}=buildRuntimeRegistry(ev);
const samples=readSamples();
const db=new PGlite();
const a={query:(s,p)=>db.query(s,p),exec:(s)=>db.exec(s)};
await db.exec(fs.readFileSync(path.join(BACKEND,'services/db/schema.sql'),'utf8'));
const rowsByBank={};
for (const [bankKey,base] of Object.entries(samples)) {
  const rows=makeRows(ev,bankKey,base,perBank).map(r=>{ if(r.display_extras?.base) r.display_extras.base['وضعیت']=r.is_success?'موفق':'ناموفق'; return r; });
  rowsByBank[bankKey]=rows;
  const table=TABLES[bankKey];
  for(let i=0;i<rows.length;i+=200){
    const chunk=rows.slice(i,i+200); const values=[]; const params=[];
    chunk.forEach((row,ri)=>{ values.push(`(${UPSERT_COLUMNS.map((_,c)=>`$${ri*UPSERT_COLUMNS.length+c+1}`).join(',')})`);
      for(const col of UPSERT_COLUMNS){const v=row[col]; params.push(JSON_COL.has(col)&&v!=null?JSON.stringify(v):v);} });
    await db.query(`INSERT INTO ${table} (${UPSERT_COLUMNS.join(',')}) VALUES ${values.join(',')}`,params);
  }
  await db.query(`INSERT INTO day_runs(bank,day,mode,status,updated_at) SELECT $1::text, day, 'nightly','complete', now() FROM (SELECT DISTINCT day FROM ${table}) d ON CONFLICT DO NOTHING`,[bankKey]);
}
await db.query('ANALYZE');
const golden={};
const svcV1=new SummaryService(dbAdapter(db),ev);
for (const bankKey of Object.keys(samples)) {
  golden[bankKey]={
    summary:stable(await svcV1.summary(bankKey,'1405-08-01','1405-09-30')),
    list:stable(await svcV1.list({bank:bankKey,from:'1405-08-01',to:'1405-09-30',type:'all',limit:100})),
    report:(await svcV1.report(bankKey,'1405-08-01','1405-09-30',20)).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g,'<ts>'),
  };
}

// ── مهاجرت ──
const migration=new V1ToV2Migration(a,{registry,banksSpecs,logger:{info:()=>{}}});
const stats=await migration.execute();
console.log('migration stats:', JSON.stringify(stats.banks));

// ── خواندن با v2 و مقایسه ──
const listSpecs={}; for(const bankKey of Object.keys(registry)) listSpecs[bankKey]=(ev.getBank(bankKey).lists||[]).map(l=>l.title);
const dialect=new V2Dialect(a,{registry,listSpecs}); await dialect.ready();
const svcV2=new SummaryService(a,ev,{dialect});
const out={};
for (const bankKey of Object.keys(samples)) {
  const s2=await svcV2.summary(bankKey,'1405-08-01','1405-09-30');
  const l2=await svcV2.list({bank:bankKey,from:'1405-08-01',to:'1405-09-30',type:'all',limit:100});
  const r2=(await svcV2.report(bankKey,'1405-08-01','1405-09-30',20)).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g,'<ts>');
  out[bankKey]={summary:stable(s2)===golden[bankKey].summary, list:stable(l2)===golden[bankKey].list, report:r2===golden[bankKey].report, stats:s2.stats};
  if (!out[bankKey].summary) {
    const A=JSON.parse(golden[bankKey].summary), B=JSON.parse(stable(s2));
    const diffs=[];
    const walk=(x,y,p)=>{ if(diffs.length>8) return; if(typeof x==='number'&&typeof y==='number'){ if(x!==y) diffs.push(`${p}: ${x}!=${y}`); return;}
      if(x&&y&&typeof x==='object'&&typeof y==='object'){ for(const k of new Set([...Object.keys(x),...Object.keys(y)])) walk(x[k],y[k],`${p}.${k}`); return;}
      if(JSON.stringify(x)!==JSON.stringify(y)) diffs.push(`${p}: ${JSON.stringify(x)?.slice(0,60)}!=${JSON.stringify(y)?.slice(0,60)}`); };
    walk(A,B,''); out[bankKey].summaryDiffs=diffs;
  }
}
console.log('parity after migration:', JSON.stringify(out,null,1).slice(0,1500));

// ── rollback ──
const rb=await migration.rollback();
const tables=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'samples%' ORDER BY 1")).rows.map(r=>r.table_name);
console.log('rollback restored:', JSON.stringify(rb), '| tables:', tables.join(','));
const back=await svcV1.summary('tavan_mellat','1405-08-01','1405-09-30');
console.log('v1 works after rollback:', stable(back)===golden.tavan_mellat.summary);
})().catch(e=>{console.error('ERR',e.message,e.stack?.split('\n').slice(0,5).join('\n'));process.exit(1)});
