'use strict';
const zlib = require('node:zlib');
const { get, own, emptyKind, num } = require('../banks/_helpers');
const { record, toText, ROTBE_IGNORE, nf, compareReviewRows } = require('./common');
const { parseFile, methodOf, isSample } = require('./scan');
const { detectCreditAlerts } = require('./credit-alerts');

const SERVICE_KINDS = ['ok', 'failed', 'other', 'missingStatus', 'invalidStatus', 'missingService'];
function serviceState(sample, key) {
  const input = sample.ai_input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !own(input, key)) {
    return { kind: 'missingService', reason: 'کلید سرویس موجود نیست', value: '—' };
  }
  const service = input[key];
  if (!service || typeof service !== 'object' || Array.isArray(service) || !own(service, 'status') || service.status == null || service.status === '') {
    return { kind: 'missingStatus', reason: 'کلید status موجود نیست یا خالی است', value: '—' };
  }
  if (typeof service.status !== 'string' || !service.status.trim()) {
    return { kind: 'invalidStatus', reason: 'مقدار status معتبر نیست', value: toText(service.status) };
  }
  const value = service.status.trim();
  const kind = value.toLowerCase() === 'ok' ? 'ok' : value.toLowerCase() === 'failed' ? 'failed' : 'other';
  return { kind, reason: '', value };
}
function rotbeKind(sample, bank, collected) {
  const data = typeof bank.rotbeGet === 'function' ? bank.rotbeGet(collected, sample) : get(sample, bank.rotbePath);
  if (data === undefined) return 'missing';
  if (data === null) return 'null';
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) return data.length ? null : 'emptyArray';
  const keys = Object.keys(data);
  if (!keys.length) return 'emptyObject';
  const main = keys.filter((key) => !ROTBE_IGNORE.has(key));
  return main.every((key) => data[key] == null) ? 'allKeysNull' : null;
}
const newStats = () => ({ total: 0, byStatus: { success: 0, fail: 0 }, paths: record(),
  flags: record(), cats: record(), catTotals: record(), catSplit: record(), catAlerts: record(), cross: record(),
  counters: record(), metrics: record(), services: record() });

function bump(stats, bank, result, status, serviceKeys, light) {
  stats.total++;
  stats.byStatus[status]++;
  for (const [key, value] of Object.entries(result.flags)) if (value) stats.flags[key] = (stats.flags[key] || 0) + 1;
  if (light) return;
  for (const spec of bank.paths) {
    const kind = result.pathKinds[spec.key];
    const entry = stats.paths[spec.key] ||= { empty: 0, kinds: record() };
    if (kind) { entry.empty++; entry.kinds[kind] = (entry.kinds[kind] || 0) + 1; }
  }
  const rotbe = stats.paths.__rotbe ||= { empty: 0, kinds: record() };
  if (result.rotbe) { rotbe.empty++; rotbe.kinds[result.rotbe] = (rotbe.kinds[result.rotbe] || 0) + 1; }
  for (const [id, value] of Object.entries(result.categories)) {
    const spec = bank.catById[id];
    if ((spec.onlyStatus && spec.onlyStatus !== status) || spec.excludeValues?.includes(value)) continue;
    stats.catTotals[id] = (stats.catTotals[id] || 0) + 1;
    const values = stats.cats[id] ||= record();
    values[value] = (values[value] || 0) + 1;
    const statuses = (stats.catSplit[id] ||= record())[value] ||= { success: 0, fail: 0 };
    statuses[status]++;
    if (spec.alertSummaryValues?.includes(value)) {
      const alerts = (stats.catAlerts[id] ||= record())[value] ||= { overdue: 0, cheque: 0, both: 0 };
      const risk = result.creditAlerts;
      if (risk?.overdue) alerts.overdue++;
      if (risk?.cheque) alerts.cheque++;
      if (risk?.overdue && risk?.cheque) alerts.both++;
    }
  }
  for (const spec of bank.cross) {
    const key = `${result.flags[spec.row] ? 1 : 0}|${spec.cols.map((col) => result.flags[col.flag] ? 1 : 0).join('')}`;
    const values = stats.cross[spec.id] ||= record();
    values[key] = (values[key] || 0) + 1;
  }
  for (const [id, value] of Object.entries(result.counters)) stats.counters[id] = (stats.counters[id] || 0) + value;
  for (const [id, value] of Object.entries(result.metrics)) if (value !== null) (stats.metrics[id] ||= []).push(value);
  for (const key of serviceKeys) {
    const values = stats.services[key] ||= { ok: 0, failed: 0, other: 0, missingStatus: 0, invalidStatus: 0, missingService: 0 };
    values[result.services[key].kind]++;
  }
}

function stampOf(sample, day) {
  const value = toText(get(sample, 'insertDate_full'));
  const hour = Number(value.slice(8, 10)), minute = Number(value.slice(10, 12));
  const seconds = value.slice(12, 14);
  if (/^\d{12,17}$/.test(value) && hour < 24 && minute < 60 && (!seconds || Number(seconds) < 60)) {
    const date = `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
    const hourMinute = `${value.slice(8, 10)}:${value.slice(10, 12)}`;
    return { key: value.padEnd(17, '0'), display: `${date} ${hourMinute}:${value.slice(12, 14) || '00'}`,
      rowDisplay: `${date} ${hourMinute}` };
  }
  const date = day.replace(/-/g, '/');
  return { key: day.replace(/\D/g, '').padEnd(17, '0'), display: date,
    rowDisplay: `${date} —:—` };
}
function publicIdentifiers(bank, sample) {
  return { ...(bank.key === 'tavan_postbank' ? {} : { uniqueKey: get(sample, 'input.uniqueKey') ?? '—' }),
    requestId: sample.requestId ?? get(sample, 'ai_input.requestId') ?? '—' };
}
function baseRow(bank, sample, file, sid, stamp) {
  const pd = num(get(sample, 'output.PD'));
  const credit = num(get(sample, 'output.Credit_Basket'));
  const summary = typeof bank.summaryCols === 'function' ? bank.summaryCols(sample) : {
    model_name: get(sample, 'output.model_name') ?? '—', PD: pd === null ? '—' : String(pd),
    Credit_Basket: credit === null ? '—' : nf(credit),
  };
  return { __sid: sid, __st: file.status, ...publicIdentifiers(bank, sample),
    'تاریخ و ساعت': stamp.rowDisplay, 'وضعیت': file.status === 'success' ? 'موفق' : 'ناموفق', ...summary };
}

function analyze(scanResult, { rowsCap }) {
  const { bank, selectedMethod, selectedFiles, selectedServices } = scanResult;
  const groups = record(), details = record(), flags = record(), lists = record(), serviceRows = record();
  const categoryRows = record(), timeReview = { total: 0, byStatus: { success: 0, fail: 0 }, rows: [] };
  const creditAlerts = { total: 0, overdue: 0, cheque: 0, both: 0, overdueRows: [], chequeRows: [] };
  const ranges = { first: null, last: null }, evaluatorErrors = record(), runtimeErrors = [];
  let sidNumber = 0, processedFiles = 0, processedSamples = 0, sequence = 0;
  const sidOf = new WeakMap();
  const log = (name, error) => {
    const entry = evaluatorErrors[name] ||= { count: 0, message: String(error?.message ?? error) };
    entry.count++;
  };
  const group = (key) => groups[key] ||= newStats();
  if (!bank) return { groups, details, flags, lists, serviceRows, categoryRows, timeReview, creditAlerts,
    ranges, evaluatorErrors, runtimeErrors, processedFiles, processedSamples };

  // Only the top candidates retain their source records; materialize private payloads after ranking.
  function retainRanked(rows, rank, order, makeRow) {
    if (rows.length >= rowsCap && compareReviewRows({ __rank: rank, __order: order }, rows.at(-1)) >= 0) return;
    rows.push(makeRow()); rows.sort(compareReviewRows);
    if (rows.length > rowsCap) rows.pop();
  }
  const analyzeOne = createEvaluator(bank, selectedServices, log);
  function detail(sample, result, file) {
    if (sidOf.has(sample)) return sidOf.get(sample);
    const sid = `s${++sidNumber}`;
    let safeSample = sample, viewer;
    try { if (bank.sanitizeSample) safeSample = bank.sanitizeSample(sample); }
    catch (error) { log('sanitizeSample', error); safeSample = sample; }
    try { if (bank.viewer) viewer = bank.viewer(result.collected, sample); }
    catch (error) { log('viewer', error); }
    const national = get(sample, 'input.data.nationalCode');
    const meta = { bank: bank.label, method: bank.id, methodKey: bank.key, day: file.day,
      status: file.status, ...publicIdentifiers(bank, sample),
      flags: bank.flags.filter((spec) => result.flags[spec.id]).map((spec) => spec.label),
      ...(bank.key === 'tavan_resalat' || bank.key === 'tavan_postbank' ? { nationalCode: !toText(national).trim() ? 'ثبت نشده' : toText(national) } : {}),
      ...(viewer ? { viewer } : {}),
      ...(result.creditAlerts?.overdue || result.creditAlerts?.cheque ? { creditAlerts: result.creditAlerts } : {}),
    };
    details[sid] = zlib.gzipSync(Buffer.from(JSON.stringify({ meta, sample: safeSample })), { level: 6 }).toString('base64');
    sidOf.set(sample, sid);
    return sid;
  }
  for (const file of selectedFiles) {
    let samples;
    try { samples = parseFile(file.full); }
    catch (error) { runtimeErrors.push({ file: file.relative, error: error.message }); continue; }
    processedFiles++;
    for (const sample of samples) {
      if (!isSample(sample) || methodOf(sample) !== selectedMethod) continue;
      processedSamples++;
      const order = sequence++;
      const stamp = stampOf(sample, file.day);
      if (!ranges.first || stamp.key < ranges.first.key) ranges.first = stamp;
      if (!ranges.last || stamp.key > ranges.last.key) ranges.last = stamp;
      const result = analyzeOne(sample, file.status);
      bump(group('ALL'), bank, result, file.status, selectedServices, false);
      bump(group(file.status), bank, result, file.status, selectedServices, false);
      bump(group(`day:${file.day}`), bank, result, file.status, selectedServices, true);
      const risk = result.creditAlerts;
      if (risk?.overdue || risk?.cheque) {
        creditAlerts.total++;
        if (risk.overdue && risk.cheque) creditAlerts.both++;
        const riskRow = () => ({ __sid: detail(sample, result, file), __st: file.status, __order: order,
          ...publicIdentifiers(bank, sample), 'تاریخ و ساعت': stamp.rowDisplay });
        if (risk.overdue) {
          creditAlerts.overdue++;
          if (creditAlerts.overdueRows.length < rowsCap) creditAlerts.overdueRows.push({ ...riskRow(),
            'جمع بدهی معوق': risk.overdue.totalAmount === null ? risk.overdue.totalIssue : nf(Math.round(risk.overdue.totalAmount)),
            'واحد': risk.overdue.currency });
        }
        if (risk.cheque) {
          creditAlerts.cheque++;
          if (creditAlerts.chequeRows.length < rowsCap) creditAlerts.chequeRows.push({ ...riskRow(),
            'جمع مبلغ چک‌های برگشتی': risk.cheque.totalAmount === null ? risk.cheque.totalIssue : nf(Math.round(risk.cheque.totalAmount)),
            'واحد': risk.cheque.currency });
        }
      }
      const totalTime = result.metrics.totalTime;
      if (totalTime !== null && totalTime > 4) {
        timeReview.total++;
        timeReview.byStatus[file.status]++;
        retainRanked(timeReview.rows, totalTime, order, () => ({
          ...baseRow(bank, sample, file, undefined, stamp), __rank: totalTime, __order: order,
          __pending: { sample, result, file }, 'زمان اجرای مدل (ثانیه)': nf(totalTime) }));
      }
      for (const spec of bank.categories) {
        const value = result.categories[spec.id];
        if (!(spec.inspectAll || spec.inspectValues?.includes(value)) || spec.excludeValues?.includes(value) || spec.inspectExcept?.includes(value)
          || (spec.onlyStatus && spec.onlyStatus !== file.status)) continue;
        const entry = (categoryRows[spec.id] ||= record())[value] ||= {
          total: 0, byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } },
        };
        entry.total++;
        const bucket = entry.byStatus[file.status];
        bucket.total++;
        if (bucket.rows.length < rowsCap) {
          let extra = {};
          try { if (spec.row) extra = spec.row(result.collected, sample, result) || {}; }
          catch (error) { log(`categories.${spec.id}.row`, error); }
          bucket.rows.push({ ...baseRow(bank, sample, file, detail(sample, result, file), stamp), ...extra, __order: order });
        }
      }
      for (const spec of bank.flags) {
        if (!result.flags[spec.id] || spec.inspect === false) continue;
        const entry = flags[spec.id] ||= { total: 0, byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } } };
        entry.total++;
        const bucket = entry.byStatus[file.status];
        bucket.total++;
        const makeRow = () => {
          let extra = {};
          try { if (spec.row) extra = spec.row(result.collected, sample, result) || {}; }
          catch (error) { log(`flags.${spec.id}.row`, error); }
          return { ...baseRow(bank, sample, file, undefined, stamp), ...extra, __order: order,
            __pending: { sample, result, file } };
        };
        if (spec.sortValue) {
          const rank = spec.sortValue(result.collected, sample);
          retainRanked(bucket.rows, rank, order, () => ({ ...makeRow(), __rank: rank }));
        } else if (bucket.rows.length < rowsCap) bucket.rows.push(makeRow());
      }
      for (let index = 0; index < bank.lists.length; index++) {
        const spec = bank.lists[index];
        let matched;
        try { matched = !!spec.when(result.flags, result); }
        catch (error) { log(`lists.${index}.when`, error); continue; }
        if (!matched) continue;
        const entry = lists[index] ||= { total: 0, rows: [] };
        const sid = entry.rows.length < rowsCap ? detail(sample, result, file) : undefined;
        let extra = {};
        try { if (spec.row) extra = spec.row(result.collected, sample, result.flags, result.categories) || {}; }
        catch (error) { log(`lists.${index}.row`, error); }
        entry.rows.push({ ...baseRow(bank, sample, file, sid, stamp), ...extra });
        entry.total++;
      }
      for (const key of selectedServices) {
        const state = result.services[key];
        if (state.kind === 'ok' || state.kind === 'failed' || state.kind === 'other') continue;
        const entry = serviceRows[key] ||= { total: 0, byStatus: { success: { total: 0, rows: [] }, fail: { total: 0, rows: [] } } };
        entry.total++;
        const bucket = entry.byStatus[file.status];
        bucket.total++;
        if (bucket.rows.length < rowsCap) {
          bucket.rows.push({ __sid: detail(sample, result, file), __st: file.status, __order: order,
            'نوع نقص': state.reason, 'مسیر': `ai_input.${key}.status`, ...publicIdentifiers(bank, sample),
            'تاریخ و ساعت': stamp.rowDisplay, 'وضعیت': file.status === 'success' ? 'موفق' : 'ناموفق' });
        }
      }
    }
  }
  for (const row of [...timeReview.rows, ...Object.values(flags).flatMap((entry) =>
    [...entry.byStatus.success.rows, ...entry.byStatus.fail.rows])]) {
    if (!row.__pending) continue;
    const { sample, result, file } = row.__pending;
    row.__sid = detail(sample, result, file); delete row.__pending;
  }
  return { groups, details, flags, lists, serviceRows, categoryRows, timeReview, creditAlerts, ranges,
    evaluatorErrors, runtimeErrors, processedFiles, processedSamples };
}

/**
 * M1: استخراج تابع analyzeOne به عنوان کتابخانه ارزیاب.
 * بدنه دقیقاً همان قواعد legacy است؛ فقط قابل فراخوانی از بیرون شده است.
 */
function createEvaluator(bank, selectedServices = [], log = () => {}) {
  return function analyzeOne(sample, folderStatus) {
    let collected;
    try { collected = bank.collected(sample); } catch (error) { log('collected', error); }
    const result = { sample, collected, flags: record(), categories: record(), counters: record(),
      metrics: record(), pathKinds: record(), services: record(), rotbe: null, creditAlerts: null };
    for (const spec of bank.flags) {
      try { result.flags[spec.id] = !!spec.test(collected, sample, result.flags); }
      catch (error) { log(`flags.${spec.id}`, error); result.flags[spec.id] = false; }
    }
    for (const spec of bank.categories) {
      try { result.categories[spec.id] = String(spec.classify(collected, sample, folderStatus)); }
      catch (error) { log(`categories.${spec.id}`, error); result.categories[spec.id] = 'خطا در محاسبه'; }
    }
    for (const spec of bank.counters) {
      try { result.counters[spec.id] = num(spec.value(collected, sample)) ?? 0; }
      catch (error) { log(`counters.${spec.id}`, error); result.counters[spec.id] = 0; }
    }
    for (const spec of bank.metrics) {
      try { result.metrics[spec.id] = num(spec.value(collected, sample)); }
      catch (error) { log(`metrics.${spec.id}`, error); result.metrics[spec.id] = null; }
    }
    try { result.rotbe = rotbeKind(sample, bank, collected); }
    catch (error) { log('rotbe', error); result.rotbe = 'missing'; }
    for (const spec of bank.paths) {
      try { result.pathKinds[spec.key] = (spec.kind || emptyKind)(spec.get(collected, sample)); }
      catch (error) { log(`paths.${spec.key}`, error); result.pathKinds[spec.key] = 'missing'; }
    }
    for (const key of selectedServices) result.services[key] = serviceState(sample, key);
    if (folderStatus === 'success' && bank.creditSources) {
      try { result.creditAlerts = detectCreditAlerts(bank, collected, sample); }
      catch (error) { log('creditAlerts', error); }
    }
    return result;
  };
}

module.exports = { analyze, createEvaluator, serviceState, publicIdentifiers, stampOf, rotbeKind, SERVICE_KINDS };
