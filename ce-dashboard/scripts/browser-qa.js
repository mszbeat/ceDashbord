'use strict';
// Optional developer QA: npm install --no-save playwright; npx playwright install chromium
const { chromium } = require('playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
(async () => {
 const browser = await chromium.launch({ args: ['--no-sandbox'] });
 const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
 const errors = []; context.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e))));
 const shots = process.env.QA_SCREENSHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
 try {
  for (const [bank, filename] of [['resalat','report.html'],['mellat','examples/mellat/report.html'],['postbank','examples/postbank/report.html']]) {
   const page = await context.newPage();
   await page.goto(pathToFileURL(path.join(ROOT,filename)).href);
   await page.locator('[data-topic="empty"]').click();
   const quality = page.locator('#panel-empty .scope-ALL');
   const paths = await quality.locator('td.cell-code').allTextContents();
   assert(paths.length >= 5 && paths.every((p) => !p.includes('|')));
   await page.locator('[data-topic="status"]').click();
   const heads = await page.locator('#panel-status .scope-ALL .service-table th').allTextContents();
   for (const gone of ['کلید سرویس غایب','status ناقص / نامعتبر','سایر وضعیت‌ها']) assert(!heads.includes(gone));
   await page.locator('[data-topic="facilities"]').click();
   assert((await page.locator('#panel-facilities .scope-ALL').innerText()).includes('تعداد تسهیلات هر گزارش'));
   if (shots) await page.screenshot({ path:path.join(shots,`${bank}-facilities.png`), fullPage:false });
   await page.locator('[data-topic="loans"]').click();
   if (bank !== 'mellat') {
    const details=page.locator('#panel-loans .scope-ALL details.sample-details').filter({hasText:bank==='resalat'?'تأخیر بیشتر از ۹۰':'تأخیر از ۶۰ تا ۹۰'}).first();
    await details.locator('summary').click();
    assert((await details.innerText()).includes('بیشترین تأخیر قسط این گزارش (روز)'));
    const popupPromise=context.waitForEvent('page');
    await details.locator('tr[data-sid] td:not(.id-cell)').first().click();
    const popup=await popupPromise;
    await popup.locator('.cards').waitFor({timeout:10000});
    assert((await popup.locator('body').innerText()).includes('دادهٔ کامل گزارش'));
    if(bank==='postbank')assert((await popup.locator('body').innerText()).includes('مبلغ وام پیشنهادی'));
    await popup.close();
   }
   if (bank === 'mellat') {
    await page.locator('[data-topic="deposit"]').click();
    const range=page.locator('#panel-deposit .scope-ALL table').filter({hasText:'قدیمی‌ترین ماه سپرده'});
    assert.equal(await range.locator('th').count(),4);
    assert(!(await range.innerText()).includes('چارک'));
    if(shots) await range.screenshot({path:path.join(shots,'mellat-deposit-range.png')});
   }
   await page.locator('[data-topic="model"]').click();
   const model=page.locator('#panel-model .scope-ALL details.sample-details').first();await model.locator('summary').click();
   const before=await context.pages().length;
   await model.locator('button.copy-id').first().click();
   assert.equal(context.pages().length,before,'copy should not open details');
   const popupPromise=context.waitForEvent('page');await model.locator('tr[data-sid] td:not(.id-cell)').first().click();
   const popup=await popupPromise;await popup.locator('.cards').waitFor({timeout:10000});await popup.close();
   await page.locator('[data-topic="daily"]').click();
   const daily=await page.locator('#panel-daily').innerText();
   assert(daily.includes('٪')&&!daily.includes('(درصد)'));
   if(shots) await page.screenshot({path:path.join(shots,`${bank}-daily.png`),fullPage:false});
   await page.setViewportSize({width:390,height:844});
   const widths=await page.evaluate(()=>({width:document.documentElement.scrollWidth, viewport:innerWidth}));
   assert(widths.width<=widths.viewport+2,`${bank} mobile overflow: ${JSON.stringify(widths)}`);
   console.log(bank,': file://, canonical paths, compact tables, private popup, copy, mobile PASS');await page.close();
  }
  if(process.env.QA_HTTP){
   const page=await context.newPage();await page.goto(process.env.QA_HTTP);
   await page.locator('[data-topic="loans"]').click();
   const d=page.locator('#panel-loans .scope-ALL details.sample-details').filter({hasText:'تأخیر بیشتر از ۹۰'}).first();await d.locator('summary').click();
   const promise=context.waitForEvent('page');await d.locator('tr[data-sid] td:not(.id-cell)').first().click();
   const popup=await promise;await popup.locator('.cards').waitFor({timeout:10000});await popup.close();await page.close();
   console.log('HTTP private detail popup PASS');
  }
  const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'bank-detached-'));
  try{
   const standalone=path.join(isolated,'report.html');fs.copyFileSync(path.join(ROOT,'report.html'),standalone);
   const page=await context.newPage();await page.goto(pathToFileURL(standalone).href);await page.locator('[data-topic="model"]').click();
   const d=page.locator('#panel-model .scope-ALL details.sample-details').first();await d.locator('summary').click();
   const promise=context.waitForEvent('page');await d.locator('tr[data-sid] td:not(.id-cell)').first().click();
   const popup=await promise;await popup.locator('body:has-text("فایل جزئیات پیدا نشد")').waitFor({timeout:10000});
   await popup.close();await page.close();console.log('Detached public HTML: expected missing-reports message PASS');
  }finally{fs.rmSync(isolated,{recursive:true,force:true});}
  assert.deepEqual(errors,[]);console.log('No browser JavaScript errors');
 }finally{await context.close();await browser.close();}
})().catch((e)=>{console.error(e);process.exitCode=1;});
