'use strict';
const { loadBanks } = require('./legacy/src/banks');
const {
  createEvaluator,
  publicIdentifiers,
  stampOf,
  baseRow,
  serviceState,
  SERVICE_KINDS,
} = require('./legacy/src/analyze');
const { get, num } = require('./legacy/banks/_helpers');
const { SERVICE_FA, nf, messageOf } = require('./legacy/src/common');
const BuildAiInput = require('./legacy-report/buildAiInput');
const { messageKeyOf, sanitizeMessageTemplate } = require('../message-dict');
const { jalaliStampDigitsOf } = require('../utils/date');
const { getActionLogger } = require('../logger/action-logger.service');

const SUCCESS_MESSAGES = [
  'You currently have overdue debt.please improve your credit behavior and try again.',
  'Validation was successful.',
  'Your historical data is not enough.',
  'You still have bounced check. please improve your credit behavior and try again.',
];

const plain = (value) => JSON.parse(JSON.stringify(value ?? {}));
const tryCall = (fn, name, fallback = null) => {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (error) {
    getActionLogger().warn({
      category: 'evaluator',
      action: 'evaluator.callback_error',
      message: error?.message ?? String(error),
      meta: { name },
    });
    return fallback;
  }
};

function extractStampDigits(sample) {
  const candidates = [
    sample?.insertDate_full,
    get(sample, 'output.insertDate_full'),
    get(sample, 'input.insertDate_full'),
    get(sample, 'data.insertDate_full'),
    sample?.insertDate,
    sample?.insertDateTime,
  ];
  for (const candidate of candidates) {
    const digits = jalaliStampDigitsOf(candidate);
    if (digits) return digits;
  }
  return null;
}

function extractInsertDate(sample) {
  const stampDigits = extractStampDigits(sample);
  if (stampDigits) return stampDigits;
  const fallback = sample?.insertDate_full ?? sample?.insertDate_yearMonthDay ?? sample?.insertDate ?? null;
  return fallback !== null && fallback !== undefined && String(fallback).trim() ? String(fallback).trim() : null;
}

function isFinalizedAiInput(aiInput) {
  if (!aiInput || typeof aiInput !== 'object' || Array.isArray(aiInput)) return false;
  if (!aiInput.current_loan || typeof aiInput.current_loan !== 'object' || Array.isArray(aiInput.current_loan)) {
    return false;
  }
  return ['iran', 'EstelamAsliRows', 'chequeList', 'historical_loans', 'averageDeposit'].every(
    (key) =>
      aiInput[key] &&
      typeof aiInput[key] === 'object' &&
      !Array.isArray(aiInput[key]) &&
      typeof aiInput[key].status === 'string',
  );
}

function serviceKeysOf(sample, expected) {
  const input = sample?.ai_input;
  const keys = new Set(expected);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (Object.prototype.hasOwnProperty.call(SERVICE_FA, key)) keys.add(key);
      else if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, 'status')
      ) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

class EvaluatorService {
  constructor() {
    this.runtimes = {};
    const banks = loadBanks({ minNull: 3 });
    this.builder = new BuildAiInput();
    for (const [key, bank] of Object.entries(banks)) {
      const selectedServices = [...new Set([...bank.expectedServices, ...Object.keys(SERVICE_FA)])].sort();
      const analyzeOne = createEvaluator(bank, selectedServices, (name, error) =>
        getActionLogger().warn({
          category: 'evaluator',
          action: 'evaluator.metric_error',
          message: error?.message ?? String(error),
          meta: { bank: key, name },
        }),
      );
      this.runtimes[key] = {
        key,
        bank,
        selectedServices,
        analyzeOne,
        version: `${key.replace('tavan_', '')}-1.0.0`,
      };
    }
    if (!this.runtimes.tavan_mellat) throw new Error('بانک ملت (tavan_mellat) لود نشد — M0 را بررسی کن');
  }

  keys() {
    return Object.keys(this.runtimes);
  }

  runtime(bankKey = 'tavan_mellat') {
    const found = this.runtimes[bankKey];
    if (!found) throw new Error(`بانک پشتیبانیشده نیست: ${bankKey}`);
    return found;
  }

  getBank(bankKey = 'tavan_mellat') {
    return this.runtime(bankKey).bank;
  }

  getSelectedServices(bankKey = 'tavan_mellat') {
    return [...this.runtime(bankKey).selectedServices];
  }

  versionOf(bankKey = 'tavan_mellat') {
    return this.runtime(bankKey).version;
  }

  getServiceKinds() {
    return [...SERVICE_KINDS];
  }

  bankKeyOfSample(sample) {
    const method = String(get(sample, 'input.method') ?? '').trim().toLowerCase();
    return this.runtimes[method] ? method : 'tavan_mellat';
  }

  normalizeSample(raw, options = {}) {
    const sample = structuredClone(raw);
    if (sample.input?.ai_input) {
      sample.ai_input = sample.input.ai_input;
      sample.input = sample.input.bankInput;
    } else if (options.fromApi || !isFinalizedAiInput(sample.ai_input)) {
      sample.ai_input = this.builder.buildFromReport(sample);
    }
    if (sample.output?.ai_output) {
      sample.ai_output = sample.output.ai_output;
      sample.output = sample.output.legacyOutput;
    }
    return sample;
  }

  isReportSuccess(sample) {
    return SUCCESS_MESSAGES.includes(get(sample, 'output.message.en'));
  }

  analyzeLegacy(sample, isSuccess, bankKey = 'tavan_mellat') {
    return this.runtime(bankKey).analyzeOne(sample, isSuccess ? 'success' : 'fail');
  }

  creditAlertsOf(result) {
    const risk = result.creditAlerts;
    const overdue = risk?.overdue ?? null;
    const cheque = risk?.cheque ?? null;
    if (!overdue && !cheque) return { value: null, rows: {} };
    const pack = (item) =>
      item
        ? {
            bool: true,
            totalAmount: item.totalAmount ?? null,
            totalIssue: item.totalIssue ?? null,
            currency: item.currency ?? null,
            count: Array.isArray(item.items) ? item.items.length : 0,
          }
        : null;
    const display = (item, amountTitle) =>
      item
        ? {
            [amountTitle]:
              item.totalAmount === null || item.totalAmount === undefined
                ? item.totalIssue ?? 'قابل محاسبه نیست'
                : nf(Math.round(item.totalAmount)),
            واحد: item.currency ?? 'واحد ثبت نشده',
          }
        : {};
    return {
      value: { overdue: pack(overdue), cheque: pack(cheque) },
      rows: {
        overdue: display(overdue, 'جمع بدهی معوق'),
        cheque: display(cheque, 'جمع مبلغ چک‌های برگشتی'),
      },
    };
  }

  buildDisplayExtras(bank, selectedServices, sample, result, day, isSuccess) {
    const status = isSuccess ? 'success' : 'fail';
    const file = { status, day };
    const stampDigits = extractStampDigits(sample);
    const stamp = stampOf({ insertDate_full: stampDigits ?? '' }, day);
    const baseFull = baseRow(bank, sample, file, undefined, stamp);
    const base = Object.fromEntries(Object.entries(baseFull).filter(([key]) => key !== '__sid'));

    const serviceStates = {};
    for (const key of selectedServices) serviceStates[key] = serviceState(sample, key);

    const flagRows = {};
    const ranks = {};
    for (const spec of bank.flags) {
      if (typeof spec.row === 'function') {
        flagRows[spec.id] = tryCall(() => spec.row(result.collected, sample, result), `flags.${spec.id}.row`, {});
      }
      if (typeof spec.sortValue === 'function') {
        ranks[spec.id] = tryCall(() => spec.sortValue(result.collected, sample), `flags.${spec.id}.sortValue`, null);
      }
    }

    const catRows = {};
    for (const spec of bank.categories) {
      if (typeof spec.row === 'function') {
        catRows[spec.id] = tryCall(() => spec.row(result.collected, sample, result), `categories.${spec.id}.row`, {});
      }
    }

    const listRows = {};
    const listMatches = [];
    bank.lists.forEach((spec, index) => {
      listMatches[index] = !!tryCall(() => spec.when(result.flags, result), `lists.${index}.when`, false);
      listRows[String(index)] =
        typeof spec.row === 'function'
          ? tryCall(() => spec.row(result.collected, sample, result.flags, result.categories), `lists.${index}.row`, {})
          : {};
    });

    const credit = this.creditAlertsOf(result);
    return {
      extras: {
        base,
        stamp,
        serviceKeys: serviceKeysOf(sample, bank.expectedServices),
        serviceStates,
        flagRows,
        ranks,
        catRows,
        listRows,
        listMatches,
        creditAlertRows: credit.rows,
        badReports: 0,
      },
      creditAlerts: credit.value,
    };
  }

  messageTemplateOf(sample) {
    const rawText = messageOf(sample);
    const sanitized = sanitizeMessageTemplate(rawText);
    const key = messageKeyOf(sanitized);
    if (!sanitized || key === 'MSG_UNKNOWN') return null;
    return { key, text: sanitized };
  }

  evaluate(sample, isSuccess, day, bankKey = 'tavan_mellat') {
    const runtime = this.runtime(bankKey);
    const { bank, selectedServices } = runtime;
    const diagBefore = Number(bank.diag?.badReports ?? 0);
    const result = runtime.analyzeOne(sample, isSuccess ? 'success' : 'fail');
    const badReports = Number(bank.diag?.badReports ?? 0) - diagBefore;
    const ids = publicIdentifiers(bank, sample);
    const requestId =
      ids.requestId && ids.requestId !== '—' ? String(ids.requestId) : String(sample.requestId ?? '');
    if (!requestId) throw new Error('نمونه بدون requestId است');
    const uniqueKey = ids.uniqueKey && ids.uniqueKey !== '—' ? String(ids.uniqueKey) : null;

    const cats = {};
    for (const [id, value] of Object.entries(result.categories)) {
      cats[id] = id === 'messageSuccess' || id === 'messageFail' ? messageKeyOf(String(value)) : String(value);
    }

    const services = {};
    for (const [key, state] of Object.entries(result.services)) {
      services[key] = state?.kind ?? 'missingService';
    }

    const { extras, creditAlerts } = this.buildDisplayExtras(bank, selectedServices, sample, result, day, isSuccess);
    extras.badReports = badReports;
    const abilityPath = bank.key === 'tavan_mellat' ? 'output.Credit_Basket' : 'output.suggested_tavan_bazpardakht';
    const ability = num(get(sample, abilityPath));
    const statusCode = String(result.categories.statusCode ?? '');
    const errorCode = String(result.categories.errorCode ?? '');
    const modelName = String(result.categories.modelName ?? '');

    return {
      request_id: requestId,
      day,
      inserted_at: extractInsertDate(sample),
      stamp_key: extras.stamp?.key ?? null,
      unique_key: uniqueKey,
      is_success: isSuccess,
      model_name: modelName && modelName !== 'نام مدل ثبت نشده است' ? modelName : null,
      status_code: statusCode && statusCode !== 'ثبت نشده' ? statusCode : null,
      error_code: errorCode && errorCode !== 'کد خطا ثبت نشده است' ? errorCode : null,
      message_key: cats[isSuccess ? 'messageSuccess' : 'messageFail'] ?? null,
      total_time_s: result.metrics.totalTime ?? null,
      pd: result.metrics.pd ?? null,
      suggested_amount: ability != null ? String(Math.round(ability)) : null,
      amount_kind: bank.key === 'tavan_postbank' ? 'suggested_loan' : 'repayment_capacity',
      score_req: result.metrics.scoreReq ?? null,
      credit_basket: null,
      avg36: result.metrics.avg36 ?? null,
      ln_avg_installments: result.metrics.lnAvgInstallments ?? null,
      rotbe: result.rotbe ?? null,
      flags: plain(result.flags),
      cats,
      counters: plain(result.counters),
      metrics: plain(result.metrics),
      paths: plain(result.pathKinds),
      services,
      credit_alerts: creditAlerts,
      display_extras: extras,
      analysis_version: runtime.version,
    };
  }

  specs(bankKey = 'tavan_mellat') {
    const bank = this.getBank(bankKey);
    const map = (items) =>
      items.map((s) => ({
        id: s.id,
        label: s.label,
        topic: s.topic ?? null,
        group: s.group ?? null,
        card: s.card ?? null,
        daily: !!s.daily,
        inspect: s.inspect !== false,
        onlyStatus: s.onlyStatus ?? null,
        excludeValues: s.excludeValues ?? [],
        hist: s.hist ?? null,
        format: s.format ? s.format.name : null,
        preserveFraction: !!s.preserveFraction,
        summaryDecimals: s.summaryDecimals ?? null,
      }));
    return {
      bank: { id: bank.id, label: bank.label, key: bank.key, overviewNote: bank.overviewNote },
      topics: [...bank.topics].map((t) => ({ id: t.id, label: t.label, desc: t.desc, icon: t.icon })),
      flags: map(bank.flags),
      categories: map(bank.categories),
      counters: map(bank.counters),
      metrics: map(bank.metrics),
      paths: bank.paths.map((p) => ({ key: p.key, label: p.label })),
      expectedServices: [...bank.expectedServices],
    };
  }
}

module.exports = { EvaluatorService };
