import { Injectable } from '@nestjs/common';

/* قواعد تحلیل بازنویسی نشدهاند؛ مستقیماً از banks/*.js و src/*.js قدیمی استفاده میشود (M0/M1). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadBanks } = require('./legacy/src/banks');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  createEvaluator, publicIdentifiers, stampOf, baseRow, serviceState, SERVICE_KINDS,
} = require('./legacy/src/analyze');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { get, num } = require('./legacy/banks/_helpers');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SERVICE_FA, nf } = require('./legacy/src/common');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BuildAiInput = require('./legacy-report/buildAiInput');
import { messageKeyOf } from '../message-dict';

const SUCCESS_MESSAGES = [
  'You currently have overdue debt.please improve your credit behavior and try again.',
  'Validation was successful.',
  'Your historical data is not enough.',
  'You still have bounced check. please improve your credit behavior and try again.',
];

export interface AnalyzedRow {
  request_id: string;
  day: string;
  inserted_at: string | null;
  stamp_key: string | null;
  unique_key: string | null;
  is_success: boolean;
  model_name: string | null;
  status_code: string | null;
  error_code: string | null;
  message_key: string | null;
  total_time_s: number | null;
  pd: number | null;
  suggested_amount: string | null;
  amount_kind: string | null;
  score_req: number | null;
  credit_basket: string | null;
  avg36: number | null;
  ln_avg_installments: number | null;
  rotbe: string | null;
  flags: Record<string, boolean>;
  cats: Record<string, string>;
  counters: Record<string, number>;
  metrics: Record<string, number | null>;
  paths: Record<string, string | null>;
  services: Record<string, string>;
  credit_alerts: Record<string, any> | null;
  display_extras: Record<string, any>;
  analysis_version: string;
}

interface BankRuntime {
  key: string;
  bank: any;
  selectedServices: string[];
  analyzeOne: (sample: any, folderStatus: 'success' | 'fail') => any;
  version: string;
}

const plain = (value: any) => JSON.parse(JSON.stringify(value ?? {}));
const tryCall = (fn: () => any, name: string, fallback: any = null): any => {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (error) {
    console.warn(`[evaluator] ${name}: ${(error as any)?.message ?? error}`);
    return fallback;
  }
};

@Injectable()
export class EvaluatorService {
  private runtimes: Record<string, BankRuntime> = {};
  private builder: any;

  constructor() {
    const banks = loadBanks({ minNull: 3 });
    this.builder = new BuildAiInput();
    for (const [key, bank] of Object.entries(banks) as Array<[string, any]>) {
      const selectedServices = [...new Set([...bank.expectedServices, ...Object.keys(SERVICE_FA)])].sort();
      const analyzeOne = createEvaluator(bank, selectedServices, (name: string, error: any) =>
        console.warn(`[evaluator:${key}] ${name}: ${error?.message ?? error}`),
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

  keys(): string[] { return Object.keys(this.runtimes); }
  private runtime(bankKey = 'tavan_mellat'): BankRuntime {
    const found = this.runtimes[bankKey];
    if (!found) throw new Error(`بانک پشتیبانیشده نیست: ${bankKey}`);
    return found;
  }
  getBank(bankKey = 'tavan_mellat'): any { return this.runtime(bankKey).bank; }
  getSelectedServices(bankKey = 'tavan_mellat'): string[] { return [...this.runtime(bankKey).selectedServices]; }
  versionOf(bankKey = 'tavan_mellat'): string { return this.runtime(bankKey).version; }
  getServiceKinds() { return [...SERVICE_KINDS]; }

  bankKeyOfSample(sample: any): string {
    const method = String(get(sample, 'input.method') ?? '').trim().toLowerCase();
    return this.runtimes[method] ? method : 'tavan_mellat';
  }

  /** همان نرمالسازی report/src/services/reportProcess.js + buildAiInput.js */
  normalizeSample(raw: any): any {
    const sample = structuredClone(raw);
    if (sample.output?.ai_output) {
      sample.ai_output = sample.output.ai_output;
      sample.output = sample.output.legacyOutput;
    }
    if (sample.input?.ai_input) {
      sample.ai_input = sample.input.ai_input;
      sample.input = sample.input.bankInput;
    } else if (!sample.ai_input) {
      sample.ai_input = this.builder.buildFromReport(sample);
    }
    return sample;
  }

  /** همان isReportSuccess در reportProcess.js */
  isReportSuccess(sample: any): boolean {
    return SUCCESS_MESSAGES.includes(get(sample, 'output.message.en'));
  }

  /** خروجی خام ارزیاب قدیمی (برای جزئیات نمونه / viewer) */
  analyzeLegacy(sample: any, isSuccess: boolean, bankKey = 'tavan_mellat'): any {
    return this.runtime(bankKey).analyzeOne(sample, isSuccess ? 'success' : 'fail');
  }

  private creditAlertsOf(result: any): { value: Record<string, any> | null; rows: Record<string, any> } {
    const risk = result.creditAlerts;
    const overdue = risk?.overdue ?? null;
    const cheque = risk?.cheque ?? null;
    if (!overdue && !cheque) return { value: null, rows: {} };
    const pack = (item: any) => item ? {
      bool: true,
      totalAmount: item.totalAmount ?? null,
      totalIssue: item.totalIssue ?? null,
      currency: item.currency ?? null,
      count: Array.isArray(item.items) ? item.items.length : 0,
    } : null;
    const display = (item: any, amountTitle: string) => item ? {
      [amountTitle]: item.totalAmount === null || item.totalAmount === undefined
        ? (item.totalIssue ?? 'قابل محاسبه نیست')
        : nf(Math.round(item.totalAmount)),
      'واحد': item.currency ?? 'واحد ثبت نشده',
    } : {};
    return {
      value: { overdue: pack(overdue), cheque: pack(cheque) },
      rows: {
        overdue: display(overdue, 'جمع بدهی معوق'),
        cheque: display(cheque, 'جمع مبلغ چک‌های برگشتی'),
      },
    };
  }

  private buildDisplayExtras(bank: any, selectedServices: string[], sample: any, result: any,
                             day: string, isSuccess: boolean): any {
    const status = isSuccess ? 'success' : 'fail';
    const file = { status, day };
    const stamp = stampOf(sample, day);
    const baseFull = baseRow(bank, sample, file, undefined, stamp);
    const base: Record<string, any> = Object.fromEntries(
      Object.entries(baseFull).filter(([key]) => key !== '__sid'),
    );

    const serviceStates: Record<string, any> = {};
    for (const key of selectedServices) serviceStates[key] = serviceState(sample, key);

    const flagRows: Record<string, any> = {};
    const ranks: Record<string, any> = {};
    for (const spec of bank.flags) {
      if (typeof spec.row === 'function') flagRows[spec.id] = tryCall(() => spec.row(result.collected, sample, result), `flags.${spec.id}.row`, {});
      if (typeof spec.sortValue === 'function') ranks[spec.id] = tryCall(() => spec.sortValue(result.collected, sample), `flags.${spec.id}.sortValue`, null);
    }

    const catRows: Record<string, any> = {};
    for (const spec of bank.categories) {
      if (typeof spec.row === 'function') catRows[spec.id] = tryCall(() => spec.row(result.collected, sample, result), `categories.${spec.id}.row`, {});
    }

    const listRows: Record<string, any> = {};
    const listMatches: boolean[] = [];
    bank.lists.forEach((spec: any, index: number) => {
      listMatches[index] = !!tryCall(() => spec.when(result.flags, result), `lists.${index}.when`, false);
      listRows[String(index)] = typeof spec.row === 'function'
        ? tryCall(() => spec.row(result.collected, sample, result.flags, result.categories), `lists.${index}.row`, {})
        : {};
    });

    const credit = this.creditAlertsOf(result);
    return {
      extras: {
        base,
        stamp,
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

  evaluate(sample: any, isSuccess: boolean, day: string, bankKey = 'tavan_mellat'): AnalyzedRow {
    const runtime = this.runtime(bankKey);
    const { bank, selectedServices } = runtime;
    const diagBefore = Number(bank.diag?.badReports ?? 0);
    const result = runtime.analyzeOne(sample, isSuccess ? 'success' : 'fail');
    const badReports = Number(bank.diag?.badReports ?? 0) - diagBefore;
    const ids = publicIdentifiers(bank, sample);
    const requestId = ids.requestId && ids.requestId !== '—' ? String(ids.requestId) : String(sample.requestId ?? '');
    if (!requestId) throw new Error('نمونه بدون requestId است');
    const uniqueKey = ids.uniqueKey && ids.uniqueKey !== '—' ? String(ids.uniqueKey) : null;

    const cats: Record<string, string> = {};
    for (const [id, value] of Object.entries(result.categories)) {
      // اصل PRD: متن آزاد پیام ذخیره نشود؛ فقط کلید پایدار پیام.
      cats[id] = id === 'messageSuccess' || id === 'messageFail'
        ? messageKeyOf(String(value))
        : String(value);
    }

    const services: Record<string, string> = {};
    for (const [key, state] of Object.entries(result.services)) {
      services[key] = (state as any)?.kind ?? 'missingService';
    }

    const { extras, creditAlerts } = this.buildDisplayExtras(bank, selectedServices, sample, result, day, isSuccess);
    extras.badReports = badReports;
    const abilityPath = bank.key === 'tavan_mellat'
      ? 'output.Credit_Basket' : 'output.suggested_tavan_bazpardakht';
    const ability = num(get(sample, abilityPath));
    const statusCode = String(result.categories.statusCode ?? '');
    const errorCode = String(result.categories.errorCode ?? '');
    const modelName = String(result.categories.modelName ?? '');

    return {
      request_id: requestId,
      day,
      inserted_at: sample.insertDate_full != null ? String(sample.insertDate_full) : null,
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
    const map = (items: any[]) => items.map((s) => ({
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
      topics: [...bank.topics].map((t: any) => ({ id: t.id, label: t.label, desc: t.desc, icon: t.icon })),
      flags: map(bank.flags),
      categories: map(bank.categories),
      counters: map(bank.counters),
      metrics: map(bank.metrics),
      paths: bank.paths.map((p: any) => ({ key: p.key, label: p.label })),
      expectedServices: [...bank.expectedServices],
    };
  }
}
