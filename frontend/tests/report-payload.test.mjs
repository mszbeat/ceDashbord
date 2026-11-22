// باگ «استایل‌ها لود نشدند» — پوشش JSON نباید به‌عنوان HTML به مرورگر برسد.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractHtmlDocument,
  isHtmlDocument,
  looksLikeJsonEnvelope,
  peekStream,
  readText,
} from '../lib/report-payload.mjs';

const REPORT = '<!doctype html><html dir="rtl"><head><style>body{color:red}</style></head>'
  + '<body><div class="page"><h1>گزارش</h1></div></body></html>';

test('پوشش { data } که ترنسپورت partFramework می‌سازد باز می‌شود', () => {
  const envelope = JSON.stringify({ data: REPORT });
  assert.equal(looksLikeJsonEnvelope(envelope), true);
  assert.equal(extractHtmlDocument(envelope), REPORT);
});

test('بدنهٔ HTML سالم دست‌نخورده می‌ماند (مسیر جریانی F1)', () => {
  assert.equal(looksLikeJsonEnvelope(REPORT), false);
  assert.equal(isHtmlDocument(REPORT), true);
  assert.equal(extractHtmlDocument(REPORT), REPORT);
});

test('پوشش تودرتو / آرایه / کلید غیر‌معمول هم باز می‌شود', () => {
  assert.equal(extractHtmlDocument(JSON.stringify({ data: { result: REPORT } })), REPORT);
  assert.equal(extractHtmlDocument(JSON.stringify([{ body: REPORT }])), REPORT);
  assert.equal(extractHtmlDocument(JSON.stringify({ payload: { html: REPORT } })), REPORT);
});

test('BOM و فاصلهٔ ابتدای بدنه تشخیص را خراب نمی‌کند', () => {
  assert.equal(looksLikeJsonEnvelope('\uFEFF\n  {"data":"x"}'), true);
  assert.equal(isHtmlDocument('\uFEFF\n ' + REPORT), true);
});

test('JSON نامعتبر یا بدنهٔ غیر-HTML ⇒ null (مسیر خطا فعال می‌شود)', () => {
  assert.equal(extractHtmlDocument('{"data": "not html"}'), null);
  assert.equal(extractHtmlDocument('{"data": '), null);
  assert.equal(extractHtmlDocument('{"message":{"fa":"خطا"}}'), null);
});

test('peekStream استریم را کامل و بی‌کم‌وکاست برمی‌گرداند', async () => {
  const payload = new TextEncoder().encode(REPORT.repeat(50)); // > 64 بایت
  const source = new ReadableStream({
    start(controller) {
      // تکه‌تکه بفرست تا رفتار واقعی شبکه شبیه‌سازی شود
      for (let i = 0; i < payload.length; i += 16) controller.enqueue(payload.slice(i, i + 16));
      controller.close();
    },
  });
  const { head, stream } = await peekStream(source, 64);
  assert.match(head, /^<!doctype html>/);
  const reader = stream.getReader();
  let total = 0;
  let text = '';
  // دیکودر جریانی: تکه‌ها ممکن است وسط یک کاراکتر فارسی بریده باشند
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read(); // eslint-disable-line no-await-in-loop
    if (done) break;
    total += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  assert.equal(total, payload.length, 'هیچ بایتی از دست نرفت');
  assert.equal(text, REPORT.repeat(50));
});

test('readText پوشش JSON را از استریم peek‌شده کامل بازیابی می‌کند', async () => {
  // همان خطای سرتاسری: بعد از peek، response.text() خطای «Body is unusable» می‌داد
  const envelope = JSON.stringify({ data: REPORT });
  const bytes = new TextEncoder().encode(envelope);
  const source = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 8) controller.enqueue(bytes.slice(i, i + 8));
      controller.close();
    },
  });

  const { head, stream } = await peekStream(source, 32);
  assert.equal(looksLikeJsonEnvelope(head), true, 'پوشش تشخیص داده شد');

  const { text } = await readText(stream);
  assert.equal(text, envelope, 'بدنه بی‌کم‌وکاست بازیابی شد');
  assert.equal(extractHtmlDocument(text), REPORT, 'HTML از پوشش بیرون آمد');
});
