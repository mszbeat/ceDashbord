'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMON_CATS, providerErrorsOf, PROVIDER_NONE } = require('../services/evaluator/legacy/src/common');
const { baseRow } = require('../services/evaluator/legacy/src/analyze');
const { table } = require('../services/evaluator/legacy/src/render');
const mirror = require('../services/legacy-report/common');

const errorEntry = (overrides = {}) => ({
  meta: { timestamp: '2026-11-20T20:28:44.634+0000' },
  data: {
    additionalInfo: {
      timestamp: '2026-11-20T20:28:44.634+0000',
      path: '/service/ob/connector/login',
      status: 503,
      message: 'Unable to find instance for obConnector',
      error: 'Service Unavailable',
      ...(overrides.additionalInfo || {}),
    },
    message: { fa: 'خطای سرویس بانک!', en: 'Bank service Error!', ...(overrides.message || {}) },
  },
});

const byId = (id) => COMMON_CATS.find((spec) => spec.id === id);

test('خطاهای سرویس‌های بیرونی به‌تفکیک سرویس دسته‌بندی می‌شوند', () => {
  const collected = {
    postBankLoansDataError: errorEntry(),
    postBankDepositAverageError: errorEntry({
      additionalInfo: { path: '/service/ob/deposit', status: 504, message: 'Gateway Timeout', error: 'Timeout' },
      message: { fa: 'مهلت پاسخ سرویس سپرده تمام شد', en: 'Deposit service timeout' },
    }),
    samatChequeError: errorEntry({ additionalInfo: { status: 500 }, message: { fa: 'خطای چک', en: 'Cheque error' } }),
  };

  const found = providerErrorsOf(collected);
  assert.equal(found.length, 3);

  const loans = byId('providerError_historical_loans');
  const deposit = byId('providerError_averageDeposit');
  const cheque = byId('providerError_chequeList');

  assert.equal(loans.classify(collected), 'HTTP 503 · خطای سرویس بانک!');
  assert.equal(deposit.classify(collected), 'HTTP 504 · مهلت پاسخ سرویس سپرده تمام شد');
  assert.equal(cheque.classify(collected), 'HTTP 500 · خطای چک');

  // هر سرویس فقط خطای خودش را می‌بیند، نه خطاهای بقیه را.
  assert.equal(deposit.classify({ postBankLoansDataError: errorEntry() }), PROVIDER_NONE);
  assert.equal(loans.classify({ postBankDepositAverageError: errorEntry() }), PROVIDER_NONE);

  // فقط مسیر و پیام فارسی نمایش داده می‌شوند؛ جزئیات فنی و شناسهٔ کلید حذف‌اند.
  const row = loans.row(collected);
  assert.deepEqual(Object.keys(row), ['مسیر سرویس', 'پیام سرویس']);
  assert.equal(row['مسیر سرویس'], '/service/ob/connector/login');
  assert.equal(row['پیام سرویس'], 'خطای سرویس بانک!');
  assert.doesNotMatch(row['پیام سرویس'], /Bank service Error/);
});

test('کلید ناشناختهٔ خطا هم نمایش داده می‌شود و در جمع سرویس‌های شناخته‌شده نمی‌آید', () => {
  const collected = { mysteryError: errorEntry({ message: { fa: 'خطای ناشناخته' } }) };
  assert.equal(byId('providerError_other').classify(collected), 'HTTP 503 · خطای ناشناخته');
  for (const service of ['EstelamAsliRows', 'chequeList', 'iran', 'historical_loans', 'averageDeposit']) {
    assert.equal(byId(`providerError_${service}`).classify(collected), PROVIDER_NONE);
  }
});

test('ردیف درخواست ناموفق ستون‌های خروجی مدل را حذف می‌کند و جدول جزئیات جمع‌وجور می‌ماند', () => {
  const sample = { input: { uniqueKey: 'key-123' }, requestId: 'req-123',
    output: { model_name: 'model-v2', PD: 0.28, Credit_Basket: 2500000 } };
  const bank = { key: 'tavan_mellat' };
  const stamp = { rowDisplay: '1405/09/07 10:29' };
  const failed = baseRow(bank, sample, { status: 'fail' }, 'sid-fail', stamp);
  assert.equal(failed.model_name, undefined);
  assert.equal(failed.PD, undefined);
  assert.equal(failed.Credit_Basket, undefined);
  const succeeded = baseRow(bank, sample, { status: 'success' }, 'sid-ok', stamp);
  assert.equal(succeeded.model_name, 'model-v2');
  assert.equal(succeeded.PD, '0.28');

  const html = table([{ '#': 1, ...failed, 'مسیر سرویس': '/service/ob/check', 'پیام سرویس': 'خطای فارسی' }], {
    className: 'message-table request-review-table', multiline: ['پیام سرویس'], code: ['uniqueKey'],
  });
  assert.match(html, /class="message-table request-review-table"/);
  assert.doesNotMatch(html, /model_name|Credit_Basket|>PD</);
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname,
    '../services/legacy-report/assets/style.css'), 'utf8');
  assert.match(css, /\.message-table \.message-stack[\s\S]*?-webkit-line-clamp:\s*2/);
  assert.match(css, /\.message-table\.request-review-table th:first-child\s*\{\s*width:\s*34px/);
});

test('گزارش بدون خطای سرویس در هیچ دستهٔ خطایی شمرده نمی‌شود', () => {
  const collected = { samatFacilitiesResult: { meta: {}, data: {} } };
  assert.deepEqual(providerErrorsOf(collected), []);
  for (const spec of COMMON_CATS.filter((entry) => entry.id.startsWith('providerError_'))) {
    assert.equal(spec.classify(collected), PROVIDER_NONE, spec.id);
  }
});

test('نسخهٔ آینه‌ای common در legacy-report همان دسته‌ها را می‌سازد', () => {
  const ids = (list) => list.map((spec) => spec.id).join(',');
  assert.equal(ids(mirror.COMMON_CATS), ids(COMMON_CATS));
  const collected = { postBankLoansDataError: errorEntry() };
  assert.equal(mirror.COMMON_CATS.find((s) => s.id === 'providerError_historical_loans').classify(collected),
    'HTTP 503 · خطای سرویس بانک!');
});
