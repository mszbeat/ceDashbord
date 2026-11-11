import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';

/* قواعد تحلیل بازنویسی نشدهاند؛ مستقیماً از کد legacy استفاده میشود (M1). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadBanks } = require('./legacy/src/banks');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createEvaluator, publicIdentifiers } = require('./legacy/src/analyze');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { get, num } = require('./legacy/banks/_helpers');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SERVICE_FA } = require('./legacy/src/common');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BuildAiInput = require('./legacy-report/buildAiInput');

const SUCCESS_MESSAGES = [
  'You currently have overdue debt.please improve your credit behavior and try again.',
  'Validation was successful.',
  'Your historical data is not enough.',
  'You still have bounced check. please improve your credit behavior and try again.',
];

const MESSAGE_RULES: Array<[string, RegExp]> = [
  ['MSG_VALIDATION_SUCCESS', /validation was successful/i],
  ['MSG_HISTORY_NOT_ENOUGH', /historical data is not enough/i],
  ['MSG_OVERDUE_DEBT', /overdue debt/i],
  ['MSG_BOUNCED_CHECK', /bounced check/i],
];

export interface AnalyzedRow {
  request_id: string;
  day: string;
  inserted_at: string | null;
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
  analysis_version: string;
}

const plain = (value: any) => JSON.parse(JSON.stringify(value ?? {}));

@Injectable()
export class EvaluatorService {
  readonly analysisVersion = 'mellat-1.0.0';
  private bank: any;
  private analyzeOne: (sample: any, folderStatus: 'success' | 'fail') => any;
  private builder: any;

  constructor() {
    const banks = loadBanks({ minNull: 3 });
    this.bank = banks['tavan_mellat'];
    if (!this.bank) throw new Error('بانک ملت (tavan_mellat) لود نشد — M0 را بررسی کن');
    const services = [...new Set([...this.bank.expectedServices, ...Object.keys(SERVICE_FA)])];
    this.analyzeOne = createEvaluator(this.bank, services, (name: string, error: any) =>
      console.warn(`[evaluator] ${name}: ${error?.message ?? error}`),
    );
    this.builder = new BuildAiInput();
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

  private messageKeyOf(text: string): string {
    for (const [key, pattern] of MESSAGE_RULES) if (pattern.test(text)) return key;
    return `MSG_UNKNOWN:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  }

  private creditAlertsOf(result: any): Record<string, any> | null {
    const risk = result.creditAlerts;
    if (!risk?.overdue && !risk?.cheque) return null;
    return {
      overdue: !!risk.overdue,
      cheque: !!risk.cheque,
      overdue_total: risk.overdue?.totalAmount ?? null,
      overdue_currency: risk.overdue?.currency ?? null,
      cheque_total: risk.cheque?.totalAmount ?? null,
      cheque_currency: risk.cheque?.currency ?? null,
      // نام شعبه / نام بانک / ردیفهای خام عمداً ذخیره نمیشود.
    };
  }

  evaluate(sample: any, isSuccess: boolean, day: string): AnalyzedRow {
    const result = this.analyzeOne(sample, isSuccess ? 'success' : 'fail');
    const ids = publicIdentifiers(this.bank, sample);
    const requestId = ids.requestId && ids.requestId !== '—' ? String(ids.requestId) : String(sample.requestId ?? '');
    if (!requestId) throw new Error('نمونه بدون requestId است');

    const cats: Record<string, string> = {};
    for (const [id, value] of Object.entries(result.categories)) {
      // اصل PRD: متن آزاد پیام ذخیره نشود؛ فقط کلید پایدار پیام.
      cats[id] = id === 'messageSuccess' || id === 'messageFail'
        ? this.messageKeyOf(String(value))
        : String(value).slice(0, 200);
    }

    const services: Record<string, string> = {};
    for (const [key, state] of Object.entries(result.services)) {
      services[key] = (state as any)?.kind ?? 'missingService';
    }

    const ability = num(get(sample, 'output.Credit_Basket')); // ملت: توان بازپرداخت (ریال)
    const statusCode = String(result.categories.statusCode ?? '');
    const errorCode = String(result.categories.errorCode ?? '');
    const modelName = String(result.categories.modelName ?? '');

    return {
      request_id: requestId,
      day,
      inserted_at: sample.insertDate_full != null ? String(sample.insertDate_full) : null,
      is_success: isSuccess,
      model_name: modelName && modelName !== 'نام مدل ثبت نشده است' ? modelName : null,
      status_code: statusCode && statusCode !== 'ثبت نشده' ? statusCode : null,
      error_code: errorCode && errorCode !== 'کد خطا ثبت نشده است' ? errorCode : null,
      message_key: cats[isSuccess ? 'messageSuccess' : 'messageFail'] ?? null,
      total_time_s: result.metrics.totalTime ?? null,
      pd: result.metrics.pd ?? null,
      suggested_amount: ability != null ? String(Math.round(ability)) : null,
      amount_kind: 'repayment_capacity',
      score_req: result.metrics.scoreReq ?? null,
      credit_basket: null, // در ملت Tavan_Baz_Pardakht سبد ردهای است، نه یک عدد واحد
      avg36: result.metrics.avg36 ?? null,
      ln_avg_installments: result.metrics.lnAvgInstallments ?? null,
      rotbe: result.rotbe ?? null,
      flags: plain(result.flags),
      cats,
      counters: plain(result.counters),
      metrics: plain(result.metrics),
      paths: plain(result.pathKinds),
      services,
      credit_alerts: this.creditAlertsOf(result),
      analysis_version: this.analysisVersion,
    };
  }

  specs() {
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
      bank: { id: this.bank.id, label: this.bank.label, key: this.bank.key, overviewNote: this.bank.overviewNote },
      topics: [...this.bank.topics].map((t: any) => ({ id: t.id, label: t.label, desc: t.desc, icon: t.icon })),
      flags: map(this.bank.flags),
      categories: map(this.bank.categories),
      counters: map(this.bank.counters),
      metrics: map(this.bank.metrics),
      paths: this.bank.paths.map((p: any) => ({ key: p.key, label: p.label })),
      expectedServices: [...this.bank.expectedServices],
    };
  }
}
