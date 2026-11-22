'use strict';

/**
 * ساخت ردیف‌های مصنوعی برای آزمون‌های یکپارچه — بدون وابستگی به PGlite یا fixture واقعی.
 * همان شکل `evaluator.evaluate()` را می‌سازد.
 */
function makeRows(evaluator, bankKey, count, { days = 5 } = {}) {
  const rows = [];
  const prefix = { tavan_mellat: '11', tavan_resalat: '22', tavan_postbank: '33' }[bankKey] || '99';
  const okFlags = { noLoan: false, hasLoan: true, depositEmpty: true, facilityPresent: true };
  for (let index = 0; index < count; index += 1) {
    const dayIndex = index % days;
    const day = `1405-08-${String(dayIndex + 1).padStart(2, '0')}`;
    const stamp = `1405080${dayIndex + 1}${String(index % 24).padStart(2, '0')}${String(index % 60).padStart(2, '0')}000`;
    const isSuccess = index % 7 !== 0;
    rows.push({
      // UUID معتبر (۸ رقم در گروه اول) — وگرنه ingest طبق B4 ردیف را رد می‌کند
      request_id: `${prefix}000000-${String(index).padStart(4, '0')}-4e34-aca3-4778cea7e8b9`,
      day,
      inserted_at: stamp,
      stamp_key: stamp,
      unique_key: `uk-${index}`,
      is_success: isSuccess,
      model_name: index % 3 === 0 ? 'strategy_a' : 'no_strategy',
      status_code: '200',
      error_code: isSuccess ? 'no_error' : 'provider_error',
      message_key: isSuccess ? 'MSG_VALIDATION_SUCCESS' : 'MSG_OVERDUE_DEBT',
      total_time_s: index % 5 === 0 ? 6.5 : 1.25,
      pd: index % 4 === 0 ? 0.5 : 0.125,
      suggested_amount: index % 2 === 0 ? '10000000' : '2500000',
      amount_kind: 'repayment_capacity',
      score_req: 700 + (index % 50),
      avg36: 1200000 + index,
      ln_avg_installments: 30,
      rotbe: null,
      flags: okFlags,
      cats: { statusCode: '200', modelName: index % 3 === 0 ? 'strategy_a' : 'no_strategy' },
      counters: { lnCount: 2 },
      metrics: { lnCount: 2, lnAvgInstallments: 30, pd: index % 4 === 0 ? 0.5 : 0.125 },
      paths: {},
      services: {},
      credit_alerts: index % 6 === 0 ? { overdue: { bool: true, count: 1, totalAmount: '500000' } } : null,
      display_extras: {
        stamp: { key: stamp, display: '1405/08/01 12:00:00', rowDisplay: '1405/08/01 12:00' },
        base: {},
      },
      analysis_version: 1,
    });
  }
  return rows;
}

module.exports = { makeRows };
