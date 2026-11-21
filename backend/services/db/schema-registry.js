'use strict';

/**
 * ساخت رجیستری شاخص‌ها برای اسکیمای v2.
 *
 * ترتیب شاخص‌ها (bit_pos پرچم‌ها، کد سرویس‌ها و ستون‌های متریک) باید با seed داخل
 * `indicator_registry` یکی باشد، وگرنه دادهٔ ذخیره‌شده اشتباه تفسیر می‌شود. این ماژول
 * تنها منبع ساخت رجیستری در زمان اجراست و همان ورودی‌ای را می‌دهد که migration استفاده
 * می‌کند: `evaluator.specs(bank)` + `evaluator.getSelectedServices(bank)`.
 */

const { buildRegistry } = require('./indicator-registry');

/**
 * @param {import('../evaluator/evaluator.service').EvaluatorService} evaluator
 * @returns {{registry: Record<string, object>, banksSpecs: Record<string, object>}}
 */
function buildRuntimeRegistry(evaluator) {
  const bankKeys = evaluator.keys();
  const banksSpecs = {};
  for (const bankKey of bankKeys) {
    banksSpecs[bankKey] = {
      ...evaluator.specs(bankKey),
      selectedServices: evaluator.getSelectedServices(bankKey),
      lists: evaluator.getBank(bankKey).lists || [],
    };
  }
  return { registry: buildRegistry(banksSpecs), banksSpecs, bankKeys };
}

module.exports = { buildRuntimeRegistry };
