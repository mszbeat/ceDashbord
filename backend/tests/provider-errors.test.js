'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMON_CATS, providerErrorsOf, PROVIDER_NONE } = require('../services/evaluator/legacy/src/common');
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

  // ستون‌های ریز خطا از همان کلید خوانده می‌شوند.
  const row = loans.row(collected);
  assert.equal(row['کد وضعیت سرویس'], '503');
  assert.equal(row['مسیر سرویس'], '/service/ob/connector/login');
  assert.equal(row['کلید خطا'], 'postBankLoansDataError');
  assert.match(row['پیام سرویس'], /خطای سرویس بانک!/);
});

test('کلید ناشناختهٔ خطا هم نمایش داده می‌شود و در جمع سرویس‌های شناخته‌شده نمی‌آید', () => {
  const collected = { mysteryError: errorEntry({ message: { fa: 'خطای ناشناخته' } }) };
  assert.equal(byId('providerError_other').classify(collected), 'HTTP 503 · خطای ناشناخته');
  for (const service of ['EstelamAsliRows', 'chequeList', 'iran', 'historical_loans', 'averageDeposit']) {
    assert.equal(byId(`providerError_${service}`).classify(collected), PROVIDER_NONE);
  }
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
