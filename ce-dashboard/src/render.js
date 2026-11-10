'use strict';
const { own } = require('../banks/_helpers');
const {facilityCountChart,modelChart,dailyChart,depositTypeChart,categoryChart}=require('./charts');
const { h, toText, safeJson, nf, pct, compareReviewRows, safeId, COMMON_TOPICS, KIND_FA, SERVICE_FA } = require('./common');

const empty = (text = 'داده‌ای برای نمایش وجود ندارد.') => `<p class="empty-state">${h(text)}</p>`;
const serviceLabel = (key) => own(SERVICE_FA, key) ? SERVICE_FA[key] : key;
function table(rows, { id = '', code = [], ltr = [], multiline = [], scroll = false, className = '' } = {}) {
  if (!rows.length) return empty();
  const columns = Object.keys(rows[0]).filter((key) => !key.startsWith('__'));
  const hasDetails = rows.some((row) => row.__sid);
  function cell(key, value, row) {
    const text = value == null ? '—' : typeof value === 'number' ? nf(value) : toText(value);
    if (value && typeof value === 'object' && value.__countPercent) {
      const percent = pct(value.count, value.total);
      const width = value.total ? Math.min(100, Math.max(0, value.count * 100 / value.total)) : 0;
      return `<td class="count-percent-cell"><span class="count-percent"><bdi dir="ltr">${nf(value.count)}</bdi><span class="mini-bar" aria-hidden="true"><i style="width:${width}%"></i></span><bdi dir="ltr">${h(percent)}</bdi></span></td>`;
    }
    if (key === 'شاخص' && row.__pathNote) {
      return `<td class="metric-label">${h(text)}<small>مسیر کلید <code dir="ltr">${h(row.__pathNote)}</code></small></td>`;
    }
    if (key === 'دسته / مقدار' && row.__ltrCategory) return `<td><bdi dir="ltr">${h(text)}</bdi></td>`;
    if (key === 'دسته / مقدار' && row.__subtitle) {
      return `<td class="category-label">${h(text)}<small>${h(row.__subtitle)}</small></td>`;
    }
    if (key === 'uniqueKey' || key === 'requestId') {
      if (text === '—') return `<td class="cell-code"><code dir="ltr">—</code></td>`;
      const title = key === 'uniqueKey' ? 'شناسهٔ یکتا' : 'شناسهٔ درخواست';
      return `<td class="id-cell"><button type="button" class="copy-id" data-id-kind="${key}" data-identifier="${h(text)}" title="کپی ${title}: ${h(text)}" aria-label="کپی ${title}: ${h(text)}"><code dir="ltr">${h(Array.from(text).slice(0, 8).join(''))}</code><span aria-hidden="true">⧉</span></button></td>`;
    }
    if (multiline.includes(key)) {
      const lines = text.split('\n').map((line) => `<span class="message-line" dir="auto">${h(line)}</span>`).join('');
      return `<td class="message-cell"><div class="message-stack">${lines}</div></td>`;
    }
    if (code.includes(key)) {
      const escaped = h(text);
      // شکست سطر مسیرها فقط بعد از جداکنندهٔ فنی انجام شود، نه وسط نام یک کلید.
      const content = ['مسیر', 'مسیر کلید'].includes(key) ? escaped.replace(/([./|])/g, '$1<wbr>') : escaped;
      return `<td class="cell-code"><code dir="ltr">${content}</code></td>`;
    }
    const match = /درصد/.test(key) && text.match(/^(<)?(\d+(?:\.\d+)?)٪$/);
    if (match) {
      return `<td class="percent-cell"><span class="percent-value"><span class="mini-bar" aria-hidden="true"><i style="width:${Math.min(100, +match[2])}%"></i></span><b dir="ltr">${h(text)}</b></span></td>`;
    }
    return `<td${ltr.includes(key) ? ' class="ltr"' : ''}>${ltr.includes(key) ? `<bdi dir="ltr">${h(text)}</bdi>` : h(text)}</td>`;
  }
  const head = (hasDetails ? '<th class="open-cell" scope="col"><span class="sr-only">جزئیات</span></th>' : '')
    + columns.map((key) => `<th scope="col">${h(key)}</th>`).join('');
  const body = rows.map((row) => {
    const classes = [row.__sid ? 'clickable' : '', row.__st ? `status-${row.__st}` : ''].filter(Boolean).join(' ');
    const attrs = row.__sid ? ` data-sid="${h(row.__sid)}" tabindex="0" role="button" aria-label="نمایش جزئیات گزارش در پنجرهٔ جدید" title="نمایش دادهٔ گزارش"` : '';
    return `<tr${classes ? ` class="${classes}"` : ''}${attrs}>${hasDetails ? `<td class="open-cell">${row.__sid ? '<span aria-hidden="true">↗</span>' : ''}</td>` : ''}`
      + columns.map((key) => cell(key, row[key], row)).join('') + '</tr>';
  }).join('');
  return `<div class="table-wrap${scroll ? ' table-scroll' : ''}"><table${id ? ` id="${h(id)}"` : ''}${className ? ` class="${h(className)}"` : ''}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const card = (value, label, tone = '', share = null, denominator = null, subtitle = '') => `<div class="data-card ${tone}"><div class="data-card-value" dir="auto">${h(value)}</div><div class="data-card-label">${h(label)}</div>${subtitle ? `<small class="indicator-note">${h(subtitle)}</small>` : ''}${share === null ? '' : `<div class="data-card-share"><bdi dir="ltr">${h(share)}</bdi><span>از ${h(denominator)} گزارش</span></div>`}</div>`;
const tools = (tableId) => `<div class="table-tools" data-table="${h(tableId)}"><label class="sr-only" for="q-${h(tableId)}">جست‌وجو در گزارش‌ها</label><input id="q-${h(tableId)}" type="search" placeholder="جست‌وجو در شناسه، تاریخ یا سایر ستون‌ها…" autocomplete="off"><button type="button" class="copy-button">کپی شناسه‌های نمایان</button><span class="result-count" aria-live="polite"></span></div>`;

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q, index = Math.floor(position), remainder = position - index;
  return index + 1 < sorted.length ? sorted[index] + (sorted[index + 1] - sorted[index]) * remainder : sorted[index];
}
const defaultFormat = nf;
const STAT_COLS = [['count', 'تعداد گزارش'], ['min', 'کمینه'], ['p25', 'چارک اول'], ['median', 'میانه'],
  ['mean', 'میانگین'], ['p75', 'چارک سوم'], ['max', 'بیشینه']];
function metricsTable(specs, stats) {
  const columns = STAT_COLS.filter(([key]) => specs.some(spec => !spec.stats || spec.stats.includes(key)));
  return table(specs.map((spec) => {
    const sorted = [...(stats.metrics[spec.id] || [])].sort((a, b) => a - b);
    const values = { count: sorted.length, min: sorted[0], p25: quantile(sorted, .25), median: quantile(sorted, .5),
      mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
      p75: quantile(sorted, .75), max: sorted.at(-1) };
    const selected = spec.stats || STAT_COLS.map(([key]) => key), format = spec.format || defaultFormat;
    const row = { ...(spec.pathNote ? { __pathNote: spec.pathNote } : {}), 'شاخص': spec.label };
    for (const [key, label] of columns) {
      const value = values[key];
      const derived = !spec.preserveFraction && (spec.derived || ['p25', 'median', 'mean', 'p75'].includes(key));
      row[label] = !selected.includes(key) || value == null ? '—' : key === 'count' ? nf(value)
        : spec.summaryDecimals != null && ['p25','median','mean','p75'].includes(key) ? value.toFixed(spec.summaryDecimals)
        : spec.preserveFraction && key === 'mean' ? value.toFixed(4)
        : derived ? nf(Math.round(value)) : spec.preserveFraction && ['p25','median','mean','p75'].includes(key)
          ? nf(Number(value.toPrecision(12))) : format(value);
    }
    return row;
  }));
}
function monthRangeTable(specs, stats) {
  return table(specs.map((spec) => {
    const values = stats.metrics[spec.id] || [];
    const first = values.reduce((min, value) => Math.min(min, value), Infinity);
    const last = values.reduce((max, value) => Math.max(max, value), -Infinity);
    return { 'شاخص': spec.label, 'تعداد گزارش': values.length,
      'کمینهٔ تاریخ': spec.format(first), 'بیشینهٔ تاریخ': spec.format(last) };
  }), { ltr: ['کمینهٔ تاریخ', 'بیشینهٔ تاریخ'] });
}
function histogram(spec, values) {
  const hist = spec.hist, bins = hist.bins, counts = new Array(bins ? bins.length : hist.edges.length - 1).fill(0);
  let unmatched = 0;
  for (const value of values) {
    let found = false;
    for (let index = 0; index < counts.length; index++) {
      const bin = bins?.[index];
      const match = bins ? (own(bin, 'value') ? value === bin.value
        : (bin.excludeMin ? value > bin.min : value >= bin.min) && (bin.includeMax ? value <= bin.max : value < bin.max))
        : value >= hist.edges[index] && value < hist.edges[index + 1];
      if (match) { counts[index]++; found = true; break; }
    }
    if (!found) unmatched++;
  }
  const format = hist.fmt || spec.format || defaultFormat;
  const label = hist.label || ((low, high) => high === Infinity ? `${format(low)} و بالاتر` : `${format(low)} تا ${format(high)}`);
  const denominator = hist.omitUnmatched ? values.length - unmatched : values.length;
  const percentLabel = hist.outsideNote ? 'درصد از کل مقادیر معتبر' : 'درصد از بازه‌های نمایش‌داده‌شده';
  const rows = counts.map((count, index) => ({
    'بازه': bins ? bins[index].label : label(hist.edges[index], hist.edges[index + 1]),
    'تعداد گزارش': count, [percentLabel]: pct(count, denominator),
  }));
  if (unmatched && !hist.omitUnmatched && !hist.outsideNote) rows.push({ 'بازه': 'خارج از بازه‌های تعریف‌شده', 'تعداد گزارش': unmatched,
    'درصد از بازه‌های نمایش‌داده‌شده': pct(unmatched, denominator) });
  return table(rows) + (unmatched && hist.outsideNote ? `<p class="explain histogram-outside">خارج از محدودهٔ بازه‌های بالا: <bdi dir="ltr">${nf(unmatched)}</bdi> گزارش (<bdi dir="ltr">${h(pct(unmatched,denominator))}</bdi> از کل مقادیر معتبر). این مقدارها حذف یا به مرزها تبدیل نشده‌اند و در مخرج درصدها و آمار عددی باقی‌اند.</p>` : '');
}
function renderCross(spec, stats) {
  const counts = stats.cross[spec.id] || {}, columns = spec.cols, n = columns.length;
  if (!n || n > 8) return '';
  const bits = Array.from({ length: 2 ** n }, (_, index) => index.toString(2).padStart(n, '0'));
  const count = (row, mask) => counts[`${row}|${mask}`] || 0;
  const rowTotal = (row) => bits.reduce((sum, mask) => sum + count(row, mask), 0);
  const columnTrue = (row, index) => bits.reduce((sum, mask) => sum + (mask[index] === '1' ? count(row, mask) : 0), 0);
  const yes = rowTotal(1), no = rowTotal(0), total = yes + no;
  const rows = [[1, spec.rowYes, yes], [0, spec.rowNo, no]].map(([row, label, totalRow]) => {
    const result = { [spec.rowHeader || 'گروه']: label, 'تعداد گزارش': totalRow };
    columns.forEach((col, index) => {
      const value = columnTrue(row, index);
      result[`${col.name}: دارای داده`] = `${nf(value)} (${pct(value, totalRow)})`;
      result[`${col.name}: فاقد داده`] = `${nf(totalRow - value)} (${pct(totalRow - value, totalRow)})`;
    });
    return result;
  });
  let html = `<h3>${h(spec.title)}</h3>${table(rows)}`;
  if (n >= 2) {
    const names = columns.map((col) => col.name), ones = (mask) => [...mask].filter((bit) => bit === '1').length;
    const sort = [...bits].sort((a, b) => ones(b) - ones(a) || b.localeCompare(a));
    const label = (mask) => {
      if (ones(mask) === n) return `تمام موارد (${names.join(' + ')}) دارای داده هستند`;
      if (!ones(mask)) return 'هیچ‌کدام داده ندارند';
      return `فقط ${names.filter((_, index) => mask[index] === '1').join(' و ')} دارای داده است`;
    };
    const union = yes - count(1, '0'.repeat(n));
    const detailRows = sort.map((mask) => ({ 'ترکیب داده‌ها در گروه دارای نقص رتبه‌بندی': label(mask),
      'تعداد گزارش': count(1, mask), 'درصد از این گروه': pct(count(1, mask), yes), 'درصد از کل': pct(count(1, mask), total) }));
    detailRows.push({ 'ترکیب داده‌ها در گروه دارای نقص رتبه‌بندی': 'جمع گزارش‌های یکتا با دست‌کم یک منبع داده',
      'تعداد گزارش': union, 'درصد از این گروه': pct(union, yes), 'درصد از کل': pct(union, total) });
    html += `<h3>هم‌پوشانی منابع داده</h3>${table(detailRows)}`;
    html += `<p class="explain">از ${nf(yes)} گزارش در گروه «${h(spec.rowYes)}»، تعداد ${nf(union)} گزارش دست‌کم در یکی از منابع فوق داده دارند. در محاسبهٔ این تعداد، گزارش‌های مشترک فقط یک‌بار شمرده شده‌اند.</p>`;
  }
  return html;
}
function selectedRows(entry, scope, cap) {
  if (!entry) return { total: 0, rows: [] };
  if (scope !== 'ALL') return { total: entry.byStatus[scope].total, rows: entry.byStatus[scope].rows };
  return { total: entry.total, rows: [...entry.byStatus.success.rows, ...entry.byStatus.fail.rows]
    .sort(compareReviewRows).slice(0, cap) };
}
function serviceContent(ctx, stats, scope) {
  const { scan, data, options } = ctx;
  if (!scan.selectedServices.length) return '<h3>وضعیت سرویس‌های ورودی</h3>' + empty('در ai_input هیچ سرویسی شناسایی نشده است.');
  let html = `<h3>وضعیت سرویس‌های ورودی <small>ai_input.*.status</small></h3>
    <p class="explain">هر گزارش برای هر سرویس دقیقاً یک‌بار شمارش می‌شود؛ «جمع» همهٔ گزارش‌های این بازه را شامل می‌شود، حتی اگر وضعیتشان در ستون‌های نمایش‌داده‌شده نباشد. وضعیت سرویس (ok/failed) مستقل از موفق یا ناموفق بودن گزارش است؛ موارد نیازمند بررسی، در صورت وجود، در فهرست پایین جدول قابل مشاهده‌اند.</p>`;
  const rows = scan.selectedServices.map((key) => {
    const values = stats.services[key] || { ok: 0, failed: 0, other: 0, missingStatus: 0, invalidStatus: 0, missingService: 0 };
    return { 'سرویس ورودی': serviceLabel(key), 'کلید سرویس': key,
      'موفق (ok)': values.ok, 'ناموفق (failed)': values.failed,
      'جمع': Object.values(values).reduce((a, b) => a + b, 0),
      'درصد ناموفق': pct(values.failed, stats.total) };
  });
  html += table(rows, { scroll: true, code: ['کلید سرویس'], className: 'service-table' });
  const issues = scan.selectedServices.filter((key) => {
    const values = stats.services[key] || {};
    return (values.missingService || 0) + (values.missingStatus || 0) + (values.invalidStatus || 0) > 0;
  });
  if (!issues.length) return html + '<p class="success-note">وضعیت تمام سرویس‌های شناسایی‌شده در گزارش‌های این بازه ثبت شده است.</p>';
  html += '<h3>گزارش‌های دارای سرویس یا وضعیت ناقص <small>هر ردیف را انتخاب کنید تا دادهٔ کامل آن در زبانهٔ جدید باز شود.</small></h3>';
  for (const [index, key] of issues.entries()) {
    const entry = selectedRows(data.serviceRows[key], scope, options.rowsCap);
    const tableId = `svc_${index}_${safeId(key)}_${scope}`;
    html += `<details class="sample-details"><summary><span>${h(serviceLabel(key))} <code dir="ltr">${h(key)}</code></span><span class="detail-badge">${nf(entry.total)} گزارش</span></summary>`;
    if (entry.total > entry.rows.length) html += `<p class="table-caption">نمایش ${nf(entry.rows.length)} گزارش نخست از ${nf(entry.total)} مورد در این بازه (سقف نمایش: ${nf(options.rowsCap)}).</p>`;
    html += entry.rows.length ? tools(tableId) + table(entry.rows.map((row, index) => ({ '#': index + 1, ...row })),
      { id: tableId, code: ['uniqueKey', 'requestId', 'مسیر'], ltr: ['تاریخ و ساعت'], scroll: true })
      : empty('در سقف محدودهٔ نمایش فعلی ردیفی برای این بازه ثبت نشده است.');
    html += '</details>';
  }
  return html;
}

function scopedContent(topicId, scope, ctx) {
  const { scan, data } = ctx, bank = scan.bank;
  const stats = data.groups[scope];
  if (!stats) return empty('برای این بازه گزارشی وجود ندارد.');
  let html = '';
  if (topicId === 'overview') {
    html += `<div class="cards">${card(nf(stats.total), 'کل گزارش‌ها')}${card(nf(stats.byStatus.success), 'گزارش‌های موفق', 'good')}${card(nf(stats.byStatus.fail), 'گزارش‌های ناموفق', 'warn')}</div>`;
    html += '<p class="explain">وضعیت گزارش، کد خروجی و وضعیت سرویس‌های ورودی به‌صورت جداگانه محاسبه و نمایش داده می‌شوند.</p>';
    if (bank.overviewNote) html += `<p class="explain">${h(bank.overviewNote)}</p>`;
  }
  if (topicId === 'facilities' && bank.facilityNote) html += `<p class="explain">${h(bank.facilityNote)}</p>`;
  if (bank.monitorNotes?.[topicId]) html += `<p class="explain">${h(bank.monitorNotes[topicId])}</p>`;

  const flags = bank.flags.filter((spec) => (spec.topic || 'overview') === topicId);
  if (flags.length) {
    const cards = topicId === 'loans' ? flags : flags.filter((spec) => spec.card);
    if (cards.length) html += `<div class="cards">${cards.map((spec) => card(nf(stats.flags[spec.id] || 0), spec.label,
      spec.card === 'warn' ? 'warn' : spec.card === 'normal' ? 'good' : 'neutral',
      pct(stats.flags[spec.id] || 0, stats.total), nf(stats.total), spec.subtitle)).join('')}</div>`;
    if (topicId === 'loans' && bank.delayExplanation) html += `<p class="explain loan-delay-explain">${h(bank.delayExplanation)}</p>`;
  }
  if (topicId === 'overview') html += facilityCountChart(stats.metrics.facilityCount);
  if (topicId === 'deposit' && bank.depositTypeChart) html += depositTypeChart(stats);
  if (topicId === 'model') html += modelChart(stats);
  if (flags.length && topicId !== 'loans') html += `<h3>شاخص‌های کنترلی <small>مبنای محاسبه: ${nf(stats.total)} گزارش</small></h3>`
    + table(flags.map((spec) => ({ 'شاخص': spec.label, 'تعداد گزارش': stats.flags[spec.id] || 0,
      'درصد از کل گزارش‌ها': pct(stats.flags[spec.id] || 0, stats.total) })));
  for (const spec of bank.cross.filter((entry) => entry.topic === topicId)) html += renderCross(spec, stats);
  if (topicId === 'loans' && bank.loanMonitoring) {
    html += '<h3>پایش تاریخ پرداخت در وام‌ها</h3><p class="explain">مخرج درصد: وام‌های دارای آرایهٔ اقساط غیرخالی و سالم در همین بازه؛ نه تعداد گزارش‌ها و نه تعداد اقساط. تکرار یک وام در دو گزارش دو رخداد شمرده می‌شود.</p>' + table(bank.loanMonitoring.paths.map(p => ({
      'مسیر تاریخ':p.label,
      'کل وام‌های قابل خواندن':stats.counters.monitorLoanTotal || 0,
      'وام با اقساط غیرخالی و سالم':stats.counters.monitorLoanEligible || 0,
      'وام با تمام تاریخ‌ها null':stats.counters[p.id+'AllNullLoans'] || 0,
      'درصد تمام تاریخ‌ها null':pct(stats.counters[p.id+'AllNullLoans'] || 0,stats.counters.monitorLoanEligible || 0),
      'وام دارای مقدار غیرتهی':stats.counters[p.id+'HasValueLoans'] || 0,
    })));
  }
  const counters = bank.counters.filter((spec) => spec.topic === topicId && !['paymentCoverage','chartOnly'].includes(spec.display));
  if (counters.length) html += '<h3>مجموع شمارنده‌ها در تمام گزارش‌ها</h3>' + table(counters.map((spec) => ({
    'شاخص': spec.label, 'مجموع': nf(stats.counters[spec.id] || 0) })));
  const groups = new Map();
  for (const spec of bank.metrics.filter((entry) => entry.topic === topicId && entry.display !== 'monthRange')) {
    const key = spec.group || 'شاخص‌های عددی';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(spec);
  }
  for (const [title, specs] of groups) {
    const shown = specs.filter((spec) => !((spec.common || spec.hideIfEmpty) && !(stats.metrics[spec.id] || []).length));
    if (!shown.length) continue;
    html += `<h3>${h(title)} <small>فقط گزارش‌های دارای مقدار معتبر در محاسبه وارد می‌شوند.</small></h3>`
      + [...new Set(shown.map(spec => spec.groupNote).filter(Boolean))].map(note => `<p class="explain metric-group-note">${h(note)}</p>`).join('')
      + metricsTable(shown, stats);
    for (const spec of shown) {
      const values = stats.metrics[spec.id] || [];
      const distribution = spec.hist?.omitAbove === undefined ? values : values.filter((value) => value <= spec.hist.omitAbove);
      if (spec.hist && distribution.length) html += `<h3>${h(spec.histTitle || `توزیع ${spec.label}`)} <small>${nf(distribution.length)} مقدار</small></h3>` + (spec.histNote ? `<p class="explain">${h(spec.histNote)}</p>` : '') + histogram(spec, distribution);
    }
  }
  const monthSpecs = bank.metrics.filter((spec) => spec.topic === topicId && spec.display === 'monthRange'
    && (stats.metrics[spec.id] || []).length);
  if (monthSpecs.length) html += '<h3>بازهٔ زمانی سپرده‌ها <small>تاریخ‌ها به ترتیب سال/ماه نمایش داده می‌شوند.</small></h3><p class="explain">هر سطر، کمینه و بیشینهٔ ماه متناظر را بین گزارش‌ها نشان می‌دهد؛ سطر اول برای قدیمی‌ترین ماه هر گزارش و سطر دوم برای جدیدترین ماه هر گزارش است.</p>'
    + monthRangeTable(monthSpecs, stats);
  for (const spec of bank.categories.filter((entry) => entry.topic === topicId)) {
    const total = stats.catTotals[spec.id] || 0;
    if (!total) continue;
    const hasChart = ['statusCode', 'scoreCategory', 'scoreRange'].includes(spec.id);
    html += categoryChart(spec,stats);
    const split = topicId !== 'status' && spec.splitByStatus && scope === 'ALL', message = ['messageSuccess', 'messageFail'].includes(spec.id);
    const categories = Object.entries(stats.cats[spec.id] || {}).sort((a, b) => b[1] - a[1]);
    const rows = categories.map(([key, value]) => {
      const row = { ...(spec.id === 'scoreRange' && /[0-9۰-۹٠-٩]/.test(key) ? {__ltrCategory:true}:{}), 'دسته / مقدار': spec.values && own(spec.values, key) ? spec.values[key] : key,
        'تعداد گزارش': value, 'درصد': pct(value, total) };
      if (spec.alertSummaryValues?.includes(key)) {
        const risk = stats.catAlerts[spec.id]?.[key] || { cheque: 0, overdue: 0 };
        row.__subtitle = `دارای چک برگشتی: ${nf(risk.cheque)} گزارش · دارای بدهی معوق: ${nf(risk.overdue)} گزارش (هشدارهای تأییدشده در گزارش‌های موفق)`;
      }
      if (split) {
        const status = stats.catSplit[spec.id][key];
        row['موفق'] = status.success;
        row['ناموفق'] = status.fail;
      }
      return row;
    });
    if (!hasChart) {
      html += `<h3>${h(spec.label)} <small>${nf(total)} گزارش</small></h3>`
        + (spec.note ? `<p class="explain">${h(spec.note)}</p>` : '')
        + table(rows, { multiline: message ? ['دسته / مقدار'] : [], className: message ? 'message-table' : '' });
    } else if (spec.note) {
      html += `<p class="explain">${h(spec.note)}</p>`;
    }
    const inspect = (spec.inspectAll ? categories.map(([key]) => key) : spec.inspectValues || [])
      .filter((key) => !spec.inspectExcept?.includes(key));
    for (const [index, key] of inspect.entries()) {
      const entry = selectedRows(data.categoryRows[spec.id]?.[key], scope, ctx.options.rowsCap);
      const label = spec.values && own(spec.values, key) ? spec.values[key] : key;
      const id = `cat_${safeId(spec.id)}_${index}_${scope}`;
      html += `<details class="sample-details"><summary><span>${spec.id === 'modelName' ? 'گزارش‌های مدل' : 'مشاهدهٔ گزارش‌های دستهٔ'} «${h(label)}»</span><span class="detail-badge">${nf(entry.total)} گزارش</span></summary>`;
      if (entry.total > entry.rows.length) html += `<p class="table-caption">نمایش ${nf(entry.rows.length)} مورد نخست از ${nf(entry.total)} گزارش (سقف MAX_ROWS).</p>`;
      html += entry.rows.length ? tools(id) + table(entry.rows.map((row, index) => ({ '#': index + 1, ...row })),
        { id, code: ['uniqueKey', 'requestId'], ltr: ['model_name', 'تاریخ و ساعت'], scroll: true })
        : empty('گزارشی در این دسته و محدوده وجود ندارد.');
      html += '</details>';
    }
  }
  if (topicId === 'status') html += serviceContent(ctx, stats, scope);
  if (topicId === 'empty') {
    const paths = [{ key: '__rotbe', label: 'رتبه‌بندی (داده‌های اصلی)', displayPath: bank.rotbePath }, ...bank.paths];
    html += '<h3>خالی بودن مسیرهای مهم</h3><p class="explain">در ردیف رتبه‌بندی، علاوه بر مقدار خالی، حالتی که همهٔ کلیدهای اصلی null باشند نیز نقص داده محسوب می‌شود. مسیر و شرح شاخص جدا نمایش داده شده‌اند تا متن فارسی و مسیر فنی در هم نریزند.</p>'
      + table(paths.map((spec) => {
        const value = stats.paths[spec.key] || { empty: 0, kinds: {} };
        const pathText = spec.displayPath || (/^[A-Za-z_][\w.]*$/.test(spec.label) ? spec.label : spec.key);
        const title = /[\u0600-\u06ff]/.test(spec.label) ? spec.label : spec.key.split('.').at(-1);
        return { 'شاخص': title, 'مسیر کلید': pathText, 'تعداد خالی': value.empty, 'درصد خالی': pct(value.empty, stats.total),
          'نوع خالی بودن': Object.entries(value.kinds).map(([key, count]) => `${KIND_FA[key] || key}: ${nf(count)}`).join('، ') || '—' };
      }), { code: ['مسیر کلید'], className: 'quality-table' });
  }
  return html || empty(topicId === 'model' ? 'نام مدل فقط از گزارش‌های موفق استخراج می‌شود؛ داده‌ای برای این بازه ثبت نشده است.' : 'داده‌ای برای این بخش ثبت نشده است.');
}

function flagSamples(topicId, scope, ctx) {
  const { bank } = ctx.scan;
  const relevant = bank.flags.filter((spec) => (spec.topic || 'overview') === topicId && spec.inspect !== false);
  if (!relevant.length) return '';
  let html = '<h3>مشاهدهٔ گزارش‌های هر شاخص <small>انتخاب یک ردیف، دادهٔ ذخیره‌شدهٔ همان گزارش را در زبانهٔ جدید باز می‌کند.</small></h3>'
    + `<p class="explain review-limit-note">در هر فهرستِ شاخص و محدودهٔ انتخابی، حداکثر <strong>${nf(ctx.options.rowsCap)} گزارش</strong> قابل مشاهده است؛ این سقف همان MAX_ROWS انتخاب‌شده در زمان ساخت گزارش است (پیش‌فرض: 100). عدد روی شاخص و عنوان فهرست، تعداد کل گزارش‌های واجد شرایط است، نه تعداد ردیف‌های ذخیره‌شده برای مشاهده. بنابراین کمتر بودن ردیف‌های قابل مشاهده از عدد شاخص به معنی حذف آن گزارش‌ها از شمارش و آمار نیست. برای مشاهدهٔ تعداد بیشتر، سقف را در فرمان اجرا افزایش دهید و HTML را دوباره بسازید.</p>`
    + (bank.key === 'tavan_mellat' && topicId === 'loans'
      ? '<p class="explain">فهرست‌های این بخش شامل گزارش‌های بدون سابقهٔ وام و پایش پوشش تاریخ پرداخت هستند؛ نبود سابقه یا تاریخ پرداخت null به‌تنهایی نقص داده یا وضعیت نامطلوب اعتباری نیست.</p>'
      : '<p class="explain">فهرست‌های منتخب برای بررسی گزارش‌ها در دسترس‌اند؛ شمارش وضعیت‌های عادی در جدول‌ها و کارت‌ها باقی می‌ماند. گزارش موفق نیز ممکن است دارای تأخیر یا نقص داده باشد.</p>');
  for (const spec of relevant) {
    const entry = selectedRows(ctx.data.flags[spec.id], scope, ctx.options.rowsCap);
    const id = `flag_${safeId(spec.id)}_${scope}`;
    html += `<details class="sample-details"><summary><span>${h(spec.label)}</span><span class="detail-badge">${nf(entry.total)} گزارش</span></summary>`;
    if (entry.total > entry.rows.length) html += `<p class="table-caption">نمایش ${nf(entry.rows.length)} گزارش از ${nf(entry.total)} مورد؛ سقف انتخاب‌شده: ${nf(ctx.options.rowsCap)} گزارش${spec.sortValue ? "؛ مرتب‌شده از بیشترین تأخیر به کمترین، پیش از اعمال سقف نمایش" : ""}.</p>`;
    html += entry.rows.length ? tools(id) + table(entry.rows.map((row, index) => ({ '#': index + 1, ...row })),
      { id, code: ['uniqueKey', 'requestId'], ltr: ['model_name', 'تاریخ و ساعت'], scroll: true })
      : empty('گزارشی با این شاخص ثبت نشده است.');
    html += '</details>';
  }
  return html;
}
function creditAlertsContent(ctx) {
  const { creditAlerts: matched, groups } = ctx.data;
  const folderName = 'reports';
  let html = `<p class="explain"><b>${nf(matched.total)} گزارش یکتا</b> از ${nf(groups.success?.total || 0)} گزارش موفق: بدهی معوق ${nf(matched.overdue)}، چک برگشتی ${nf(matched.cheque)}، دارای هر دو ${nf(matched.both)}. معیار هر شاخص، وجود هم‌زمان دادهٔ سمات و پیام متناظر خروجی است. در جدول عمومی «جمع مبلغ همان گزارش» و واحد آن نمایش داده می‌شود؛ اگر مبلغی ناقص باشد یا واحدها یکسان نباشند، علتِ جمع‌نشدن درج می‌شود. <b>جمع تک‌موردی معادل مبلغ همان مورد است.</b> ریزمبالغ، نام بانک و شعبه فقط در جزئیات خصوصیِ پوشهٔ <code dir="ltr">${h(folderName)}</code> دیده می‌شوند. واحد نامشخص هرگز ریال فرض نمی‌شود.</p>`;
  const tables = [
    { name: 'بدهی معوق', total: matched.overdue, rows: matched.overdueRows, id: 'risk_overdue_success' },
    { name: 'چک برگشتی', total: matched.cheque, rows: matched.chequeRows, id: 'risk_cheque_success' },
  ];
  for (const spec of tables) {
    html += `<h3>گزارش‌های دارای ${spec.name} <small>${nf(spec.total)} گزارش</small></h3>`;
    if (spec.total > spec.rows.length) html += `<p class="table-caption">نمایش ${nf(spec.rows.length)} گزارش نخست از ${nf(spec.total)} مورد؛ برای ردیف‌های بیشتر، MAX_ROWS را افزایش دهید.</p>`;
    html += spec.rows.length ? tools(spec.id) + table(spec.rows.map((row, index) => ({ '#': index + 1, ...row })),
      { id: spec.id, code: ['uniqueKey', 'requestId'], ltr: ['تاریخ و ساعت'], scroll: true,
        className: 'credit-alerts-table' }) : empty(`گزارش تأییدشده‌ای برای ${spec.name} وجود ندارد.`);
  }
  return html;
}
function listsContent(ctx) {
  const { bank } = ctx.scan, review = ctx.data.timeReview;
  const id = 'review_total_time';
  let html = `<h3>گزارش‌های با زمان اجرای مدل بیش از ۴ ثانیه <small>${nf(review.total)} گزارش</small></h3>
    <p class="explain">مبنای تفکیک، مقدار عددی <code dir="ltr">output.total_time &gt; 4</code> است؛ مقدار دقیقاً ۴ یا نامعتبر وارد این فهرست نمی‌شود. موفق: ${nf(review.byStatus.success)}، ناموفق: ${nf(review.byStatus.fail)}. گزارش‌ها پیش از اعمال سقف MAX_ROWS از بیشترین زمان به کمترین مرتب می‌شوند؛ مقدار اعشاری زمان خام حفظ می‌شود.</p>`;
  if (review.total > review.rows.length) html += `<p class="table-caption">نمایش ${nf(review.rows.length)} مورد نخست از ${nf(review.total)} گزارش؛ برای بررسی ردیف‌های بیشتر MAX_ROWS را افزایش دهید.</p>`;
  html += review.rows.length ? tools(id) + table(review.rows.map((row, index) => ({ '#': index + 1, ...row })),
    { id, code: ['uniqueKey', 'requestId'], ltr: ['model_name', 'تاریخ و ساعت'], scroll: true })
    : empty('گزارشی با زمان اجرای مدل بیش از ۴ ثانیه ثبت نشده است.');
  return html + bank.lists.map((spec, index) => {
    const entry = ctx.data.lists[index] || { total: 0, rows: [] };
    const id = `list_${index}`;
    const rows = entry.rows.map((row, idx) => ({ '#': idx + 1, ...row }));
    return `<h3>${h(spec.title)} <small>${nf(entry.total)} گزارش</small></h3>`
      + (entry.total > ctx.options.rowsCap ? `<p class="table-caption">شناسهٔ همهٔ گزارش‌ها نمایش داده می‌شود؛ جزئیات کامل فقط برای ${nf(ctx.options.rowsCap)} مورد نخست در گزارش ذخیره شده است.</p>` : '')
      + (rows.length ? tools(id) : '') + table(rows, { id, code: ['uniqueKey', 'requestId'], ltr: ['model_name', 'تاریخ و ساعت'], scroll: true });
  }).join('');
}
function dailyContent(ctx) {
  const { bank, selectedDays } = ctx.scan;
  const dailyFlags = bank.flags.filter((spec) => spec.daily);
  return dailyChart(selectedDays,ctx.data.groups) + table(selectedDays.map((day) => {
    const stats = ctx.data.groups[`day:${day}`];
    if (!stats) return null;
    const row = { 'روز': day, 'کل گزارش‌ها': stats.total, 'موفق': stats.byStatus.success, 'ناموفق': stats.byStatus.fail };
    for (const spec of dailyFlags) {
      const count = stats.flags[spec.id] || 0, name = spec.short || spec.label;
      row[name] = { __countPercent: true, count, total: stats.total };
    }
    return row;
  }).filter(Boolean), { scroll: true, ltr: ['روز', ...dailyFlags.map((spec) => spec.short || spec.label)] });
}

function renderEmpty(scan, assets) {
  const errors = scan.errors;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>گزارش کیفیت داده</title><style>${assets.css}</style></head><body><div class="page"><div class="empty-report"><span class="brand-mark">◈</span><p class="eyebrow">داشبورد کنترل کیفیت داده</p><h1>گزارش معتبری یافت نشد</h1><p>تعداد کل ورودی‌ها: ${nf(scan.totalSamples)} · گزارش‌های نامعتبر: ${nf(scan.invalidSamples)} · فایل‌های خوانده‌نشده: ${nf(errors.length)}</p>${errors.length ? table(errors.map((_, index) => ({ 'فایل ورودی': index + 1, 'وضعیت': 'خواندن فایل ممکن نبود' }))) : ''}</div></div></body></html>`;
}
function buildHtml(scan, data, options, assets) {
  if (!scan.bank) return renderEmpty(scan, assets);
  const ctx = { scan, data, options }, { bank, selectedDays } = scan;
  const total = data.groups.ALL?.total || 0, ok = data.groups.ALL?.byStatus.success || 0;
  const failed = data.groups.ALL?.byStatus.fail || 0;
  const folderName = 'reports';
  const topics = [{ id: 'overview', ...COMMON_TOPICS.overview }, ...bank.topics,
    ...(bank.creditSources ? [{ id: 'risk', ...COMMON_TOPICS.risk }] : []),
    ...['status', 'model', 'empty', 'lists', 'daily'].map((id) => ({ id, ...COMMON_TOPICS[id] }))];
  const nav = topics.map((topic, index) => `<button type="button" class="nav-button" data-topic="${h(topic.id)}" aria-controls="panel-${h(topic.id)}" aria-pressed="false"><span class="nav-icon" aria-hidden="true">${h(topic.icon || '◌')}</span><span class="nav-copy"><b>${h(topic.label)}</b><small>${h(topic.desc || '')}</small></span><span class="nav-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span></button>`).join('');
  const panels = topics.map((topic) => {
    const content = topic.id === 'risk' ? creditAlertsContent(ctx) : topic.id === 'lists' ? listsContent(ctx)
      : topic.id === 'daily' ? dailyContent(ctx)
        : ['ALL', 'success', 'fail'].map((scope) => `<div class="scope-content scope-${scope}">${scopedContent(topic.id, scope, ctx)}${flagSamples(topic.id, scope, ctx)}</div>`).join('');
    return `<section class="panel" id="panel-${h(topic.id)}" aria-labelledby="title-${h(topic.id)}" hidden>
      <div class="panel-heading"><div class="heading-icon" aria-hidden="true">${h(topic.icon || '◌')}</div><div><p class="section-kicker">بخش ${topics.indexOf(topic) + 1} از ${topics.length}</p><h2 id="title-${h(topic.id)}">${h(topic.label)}</h2><p>${h(topic.desc || '')}</p></div></div>
      ${topic.details ? `<details class="method-details"><summary>متد محاسبه و تعریف شاخص‌ها</summary><div class="method-body">${topic.details}</div></details>` : ''}
      ${typeof topic.extraHtml === 'function' ? topic.extraHtml() : ''}${content}</section>`;
  }).join('');
  const alerts = [
    bank.auto ? `<div class="alert info"><b>گزارش عمومی:</b> برای متد <code>${h(bank.id)}</code> فایل تحلیل اختصاصی موجود نیست. برای افزودن شاخص‌های بانک، از <code>banks/_template.js</code> استفاده کنید.</div>` : '',
    scan.ignoredRows.length ? `<div class="alert"><b>محدودهٔ گزارش:</b> فقط گزارش‌های بانک ${h(bank.label)} تحلیل شده‌اند. متدهای دیگر در فایل‌های ورودی وجود داشته‌اند:${table(scan.ignoredRows, { ltr: ['input.method'] })}</div>` : '',
    scan.invalidSamples ? `<div class="alert"><b>گزارش نامعتبر:</b> ${nf(scan.invalidSamples)} مقدار غیرشیء/آرایهٔ تو‌در‌تو از تحلیل کنار گذاشته شده است.</div>` : '',
    Object.keys(data.evaluatorErrors).length ? `<div class="alert"><b>خطا در محاسبهٔ برخی شاخص‌ها:</b> لطفاً تعریف‌های بانک را بررسی کنید.${table(Object.entries(data.evaluatorErrors).map(([key, entry]) => ({ 'شاخص': key, 'تعداد رخداد': entry.count })))}</div>` : '',
  ].filter(Boolean).join('');
  const errors = [...scan.errors, ...data.runtimeErrors];
  const logo = '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 3 37 20 20 37 3 20 20 3Z" stroke="currentColor" stroke-width="1.5"/><path d="M20 10 30 20 20 30 10 20 20 10Z" fill="currentColor"/></svg>';
  const circumference = 2 * Math.PI * 76;
  const circle = `<svg class="donut" viewBox="0 0 220 220" aria-hidden="true"><circle cx="110" cy="110" r="76" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="17"/><circle cx="110" cy="110" r="76" fill="none" stroke="#6df0ce" stroke-width="17" stroke-linecap="round" stroke-dasharray="${(circumference * ok / (total || 1)).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 110 110)"/></svg>`;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>گزارش کنترل کیفیت داده — ${h(bank.label)}</title><style>${assets.css}</style></head>
<body data-scope="ALL" data-bank="${h(bank.key)}"><div class="page">
  <header class="topbar"><div class="brand"><span class="brand-mark">${logo}</span><span><strong>نــمـا</strong><small>پایش داده‌های اعتبارسنجی</small></span></div><div class="top-actions"><span class="report-type">گزارش تحلیلی / ${h(bank.label)}</span><button id="themeToggle" class="icon-button" type="button" aria-label="تغییر حالت روشن و تیره">◐ <span>نمایش</span></button><button id="printReport" class="icon-button print-button" type="button">⎙ <span>چاپ گزارش</span></button></div></header>
  <section class="hero" aria-labelledby="page-title"><div class="hero-text"><p class="eyebrow"><span class="live-dot"></span> گزارش مستقل · تحلیل کیفیت داده</p><h1 id="page-title">تصویر روشن از داده‌های <em>سرویس اعتبارسنجی بانک ${h(bank.label)}</em></h1><p class="hero-lead">بررسی وضعیت گزارش‌ها، صحت سرویس‌های ورودی و شاخص‌های اعتبارسنجی در یک نمای متمرکز.</p><div class="hero-tags"><span>متد: <bdi dir="ltr">${h(bank.id)}</bdi></span><span>بازهٔ روزانه: ${selectedDays.length ? `<bdi dir="ltr">${h(selectedDays[0])}</bdi> <bdi class="date-divider">تا</bdi> <bdi dir="ltr">${h(selectedDays.at(-1))}</bdi>` : '—'}</span></div></div><div class="hero-chart">${circle}<div class="donut-label"><small>نرخ موفقیت</small><strong dir="ltr">${pct(ok, total)}</strong><span>از کل گزارش‌ها</span></div></div></section>
  <div class="hero-footer"><div><span>اولین درخواست</span><b dir="ltr">${h(data.ranges.first?.display || '—')}</b></div><div><span>آخرین درخواست</span><b dir="ltr">${h(data.ranges.last?.display || '—')}</b></div><div><span>فایل‌های بررسی‌شده</span><b>${nf(data.processedFiles)}</b></div></div>
  <section class="headline-cards" aria-label="خلاصهٔ گزارش"><div class="headline-card"><span class="kpi-icon neutral">▦</span><div><small>گزارش‌های تحلیل‌شده</small><strong>${nf(total)}</strong><span>از ${nf(scan.totalSamples)} ورودی شناسایی‌شده</span></div></div><div class="headline-card"><span class="kpi-icon positive">✓</span><div><small>گزارش‌های موفق</small><strong>${nf(ok)}</strong><span>${pct(ok, total)} از گزارش‌های این بانک</span></div></div><div class="headline-card"><span class="kpi-icon caution">!</span><div><small>گزارش‌های ناموفق</small><strong>${nf(failed)}</strong><span>${pct(failed, total)} از گزارش‌های این بانک</span></div></div></section>
  ${alerts}
  <div class="workspace"><aside class="sidebar"><div class="sidebar-label"><span>بخش‌های گزارش</span><span>${nf(topics.length)} بخش</span></div><nav class="navigation" aria-label="بخش‌های گزارش">${nav}</nav><div class="sidebar-foot"><span>◇</span> جزئیات کامل در HTML نیستند؛ پوشهٔ <code dir="ltr">${h(folderName)}</code> باید کنار این فایل باشد.</div></aside>
    <main class="main-content"><div class="scope-slot"><div class="scopebar"><div class="scope-intro"><span class="scope-dot"></span><div><b>محدودهٔ نمایش</b><small>گزارش‌ها را بر اساس وضعیت مقایسه کنید</small></div></div><div class="scope-buttons" role="group" aria-label="فیلتر وضعیت"><button type="button" data-scope="ALL" aria-pressed="true">همه <span>${nf(total)}</span></button><button type="button" data-scope="success" aria-pressed="false">موفق <span>${nf(ok)}</span></button><button type="button" data-scope="fail" aria-pressed="false">ناموفق <span>${nf(failed)}</span></button></div><p>بخش بدهی و چک فقط گزارش‌های موفق را نشان می‌دهد؛ فهرست ویژه و روند روزانه مستقل از این فیلتر هستند.</p></div></div>${panels}</main></div>
  ${errors.length ? `<section class="errors"><h2>فایل‌های خوانده‌نشده <small>${nf(errors.length)} مورد</small></h2>${table(errors.map((_, index) => ({ 'فایل ورودی': index + 1, 'وضعیت': 'خواندن یا پردازش فایل ممکن نبود' })))}</section>` : ''}
  <footer class="footer"><span>نــمـا / گزارش تحلیل داده — نسخهٔ ${h(require('../package.json').version)}</span><span>جزئیات کامل فقط داخل پوشهٔ ${h(folderName)} است. شناسه‌ها، جمع مبلغ هشدارهای اعتباری هر گزارش و متن پیام‌های نمایشی در همین HTML وجود دارند؛ پیش از انتشار آن‌ها را بررسی کنید.</span></footer>
</div><script>window.__CE_DASHBOARD_PUBLIC__=${safeJson(options.privateAsset ? { token: options.privateAsset.token, url: options.privateAsset.url, folder: options.privateAsset.folder } : null)};window.__VIEWER_CSS=${safeJson(assets.viewerCss)};</script><script>${assets.viewerJs}</script><script>${assets.client}</script></body></html>`;
}
module.exports = { buildHtml, table, quantile, selectedRows };
