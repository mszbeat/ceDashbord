/* سازندهٔ زبانهٔ جزئیات گزارش. ورودی‌های JSON پیش از ورود به HTML escape می‌شوند. */
(() => {
  'use strict';
  const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const safeScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const get = (object, path) => path.split('.').reduce((value, key) =>
    value != null && Object.prototype.hasOwnProperty.call(Object(value), key) ? value[key] : undefined, object);
  const humanNumber = (value) => {
    const text = typeof value === 'number' ? value.toLocaleString('en-US', {useGrouping: false, maximumFractionDigits: 20}) : String(value ?? '—');
    return text.replace(/(-?\d+)(\.\d+)?/g, (_all, integer, decimal) => integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (decimal || ''));
  };
  const moneyKey = (key) => /amount|^Am[A-Z]|^pay_install_|^dep_avg$|^max_bes$|^rem_deposit$|^average$|^credit_categories_amount$|^Credit_Basket$|^Tavan_Baz_Pardakht$|^suggested_tavan|^adj_max_installment|^average_deposit_|^approved_guarantee_capacity/i.test(key);
  const TIERS = [['Excellent', 'عالی'], ['Very_Good', 'خیلی خوب'], ['Good', 'خوب'], ['Medium_Good', 'متوسط رو به خوب'],
    ['Medium', 'متوسط'], ['Medium_Bad', 'متوسط رو به بد'], ['Bad', 'بد'], ['Very_Bad', 'خیلی بد']];

  function tree(key, value, depth, money = false) {
    money = money || moneyKey(key);
    const label = `<span class="key">${escapeHtml(key)}</span>`;
    if (value === null) return `<div class="line">${label}<span class="value null">null</span></div>`;
    if (typeof value !== 'object') {
      const kind = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
      const display = money && ["string", "number"].includes(kind) ? humanNumber(value) : String(value);
      const text = kind === 'string' ? `"${display}"` : display;
      return `<div class="line">${label}<span class="value ${kind}">${escapeHtml(text)}</span></div>`;
    }
    const array = Array.isArray(value), keys = array ? value.map((_, index) => index) : Object.keys(value);
    if (!keys.length) return `<div class="line">${label}<span class="value null">${array ? '[ ]' : '{ }'}</span></div>`;
    const inside = keys.map((item) => tree(array ? `[${item}]` : item, value[item], depth + 1, money)).join('');
    return `<details${depth <= 1 ? ' open' : ''}><summary>${label}<span class="type">${array ? `[${keys.length}]` : `{${keys.length}}`}</span></summary><div class="children">${inside}</div></details>`;
  }
  function cardsHtml(cards) {
    return `<div class="cards">${cards.map(([label, value, tone]) => `<div class="card ${['hot', 'ok', 'bad', 'privacy'].includes(tone) ? tone : ''}"><div class="label">${escapeHtml(label)}</div><div class="value" dir="auto">${escapeHtml(value)}</div></div>`).join('')}</div>`;
  }
  function messageLines(output) {
    const candidate = output.message || output.data?.message;
    if (!candidate) return [];
    if (typeof candidate === 'string') return [candidate];
    if (typeof candidate === 'object') return [candidate.fa, candidate.en].filter((text) => typeof text === 'string' && text.trim());
    return [];
  }
  function creditAlertHtml(risk) {
    if (!risk?.overdue && !risk?.cheque) return '';
    const title = risk.overdue && risk.cheque ? 'بدهی معوق و چک برگشتیِ تأییدشده'
      : risk.overdue ? 'بدهی معوقِ تأییدشده' : 'چک برگشتیِ تأییدشده';
    let html = `<section class="credit-alerts-private"><h2>${title}</h2><p>این موارد فقط در گزارش‌های موفق و با تطبیق هم‌زمان پیام خروجی و دادهٔ سمات شناسایی شده‌اند. نام بانک فقط در صورت وجود در متن بانک/شعبه استخراج می‌شود.</p>`;
    if (risk.overdue) {
      const overdue = risk.overdue;
      html += `<h3>تسهیلات دارای بدهی معوق <small>${overdue.items.length} مورد</small></h3>`;
      html += overdue.totalAmount != null
        ? `<p class="risk-total">جمع بدهی معوق این گزارش: <b dir="ltr">${escapeHtml(humanNumber(Math.round(overdue.totalAmount)))}</b> ${escapeHtml(overdue.currency)}</p>`
        : `<p class="risk-total">جمع بدهی معوق این گزارش: ${escapeHtml(overdue.totalIssue || 'قابل محاسبه نیست')}</p>`;
      html += '<div class="table-wrap"><table><thead><tr><th>مبلغ معوق</th><th>واحد</th><th>نام بانک</th><th>بانک / شعبهٔ ثبت‌شده</th><th>کلید منبع</th></tr></thead><tbody>';
      html += overdue.items.map((item) => `<tr><td dir="ltr">${escapeHtml(humanNumber(item.amount))}</td><td>${escapeHtml(item.currency)}</td><td>${escapeHtml(item.bank)}</td><td dir="auto">${escapeHtml(item.branch)}</td><td><code dir="ltr">${escapeHtml(item.field)}</code></td></tr>`).join('');
      html += '</tbody></table></div>';
    }
    if (risk.cheque) {
      html += `<h3>چک‌های برگشتی <small>${risk.cheque.items.length} مورد</small></h3>`;
      html += risk.cheque.totalAmount != null
        ? `<p class="risk-total">جمع مبلغ چک‌های برگشتی این گزارش: <b dir="ltr">${escapeHtml(humanNumber(Math.round(risk.cheque.totalAmount)))}</b> ${escapeHtml(risk.cheque.currency)}</p>`
        : `<p class="risk-total">جمع مبلغ چک‌های برگشتی این گزارش: ${escapeHtml(risk.cheque.totalIssue || 'قابل محاسبه نیست')}</p>`;
      html += '<div class="table-wrap"><table><thead><tr><th>مبلغ چک</th><th>واحد</th><th>نام بانک</th><th>بانک / شعبهٔ ثبت‌شده</th><th>تاریخ برگشت</th></tr></thead><tbody>';
      html += risk.cheque.items.map((item) => `<tr><td dir="ltr">${escapeHtml(item.amount == null ? 'ثبت نشده' : humanNumber(item.amount))}</td><td>${escapeHtml(item.currency)}</td><td>${escapeHtml(item.bank)}</td><td dir="auto">${escapeHtml(item.branch)}</td><td dir="ltr">${escapeHtml(item.date)}</td></tr>`).join('');
      html += '</tbody></table></div>';
    }
    return html + '</section>';
  }
  const actions = `(() => {
    const status = document.getElementById('copyStatus');
    document.getElementById('openAll').addEventListener('click', () => document.querySelectorAll('.tree details').forEach((item) => { item.open = true; }));
    document.getElementById('closeAll').addEventListener('click', () => document.querySelectorAll('.tree details').forEach((item) => { item.open = false; }));
    document.getElementById('copyJson').addEventListener('click', async () => {
      const text = JSON.stringify(JSON.parse(document.getElementById('raw').textContent), null, 2);
      try {
        if (!navigator.clipboard?.writeText) throw new Error('fallback');
        await navigator.clipboard.writeText(text);
      } catch {
        const input = document.createElement('textarea'); input.value = text; document.body.appendChild(input); input.select();
        const success = document.execCommand('copy'); input.remove();
        if (!success) { status.textContent = 'کپی امکان‌پذیر نبود.'; return; }
      }
      status.textContent = 'JSON در کلیپ‌بورد کپی شد.';
    });
    document.querySelector?.('.chips')?.addEventListener('click', async (event) => {
      const button = event.target.closest?.('button.copy-chip');
      if (!button) return;
      const value = button.dataset.identifier;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('fallback');
        await navigator.clipboard.writeText(value);
      } catch {
        const input = document.createElement('textarea');
        input.value = value; document.body.appendChild(input); input.select();
        const success = document.execCommand('copy'); input.remove();
        if (!success) { button.title = 'کپی ممکن نبود'; return; }
      }
      const originalTitle = button.title;
      button.classList.add('copied');
      button.title = button.dataset.copyLabel === 'کد ملی' ? 'کد ملی کپی شد' : 'شناسهٔ کامل کپی شد';
      status.textContent = button.title;
      setTimeout(() => { button.classList.remove('copied'); button.title = originalTitle; }, 1800);
    });
    document.getElementById('detailThemeToggle').addEventListener('click', () => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    });
    document.getElementById('detailPrint').addEventListener('click', () => window.print());
  })();`;

  window.renderSampleViewer = function renderSampleViewer(data, activeTheme = 'light') {
    const sample = data.sample || {}, meta = data.meta || {}, output = sample.output || {};
    const cards = [];
    const add = (label, value, tone) => { if (value !== undefined && value !== null && value !== '') cards.push([label, value, tone]); };
    if (Array.isArray(meta.viewer?.cards) && meta.viewer.cards.length) {
      for (const card of meta.viewer.cards) if (Array.isArray(card)) add(...card);
    } else {
      const pd = Number(output.PD);
      if (output.PD !== undefined && output.PD !== null && output.PD !== '') add('احتمال نکول (PD)', Number.isFinite(pd) ? String(pd) : output.PD, 'hot');
      add(meta.methodKey === 'tavan_mellat' ? 'توان بازپرداخت (ریال) — output.Credit_Basket' : 'سبد اعتباری (ریال)',
        output.Credit_Basket == null ? null : humanNumber(output.Credit_Basket), 'hot');
      add('نام مدل', output.model_name);
      if (meta.methodKey !== 'tavan_resalat') add('امتیاز وام درخواستی', output.score_for_requested_loan);
      add('زمان اجرای مدل (ثانیه)', output.total_time);
    }
    add('کد وضعیت خروجی', output.statusCode == null || output.statusCode === ''
      ? (meta.status === 'success' ? '200' : 'ثبت نشده')
      : String(output.statusCode) === '200' ? '200' : output.statusCode);
    add('وضعیت', meta.status === 'success' ? 'موفق' : 'ناموفق', meta.status === 'success' ? 'ok' : 'bad');
    const showNational = meta.methodKey === 'tavan_resalat' || meta.methodKey === 'tavan_postbank';
    const national = meta.nationalCode ?? get(sample, 'input.data.nationalCode') ?? 'ثبت نشده';
    const canCopyNational = showNational && !['', 'ثبت نشده', '—', '-', 'null', 'undefined'].includes(String(national).trim());
    if (showNational) add('کد ملی', national, 'privacy');
    const timestamp = String(sample.insertDate_full || '');
    const validTime = /^\d{14,17}$/.test(timestamp) && Number(timestamp.slice(8, 10)) < 24
      && Number(timestamp.slice(10, 12)) < 60 && Number(timestamp.slice(12, 14)) < 60;
    const when = validTime ? `${timestamp.slice(0, 4)}/${timestamp.slice(4, 6)}/${timestamp.slice(6, 8)} ${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}` : '';
    const chips = [['متد', meta.method], ['روز', meta.day], ['زمان درخواست', when],
      ['شناسهٔ درخواست', meta.requestId],
      ...(meta.methodKey === 'tavan_postbank' ? [] : [['شناسهٔ یکتا', meta.uniqueKey]]),
      ...(showNational ? [['کد ملی', national]] : [])]
      .filter(([, value]) => value != null && value !== '' && value !== '—' && value !== '-')
      .map(([label, value]) => label === 'شناسهٔ درخواست' || label === 'شناسهٔ یکتا' || (label === 'کد ملی' && canCopyNational)
        ? `<button type="button" class="chip copy-chip${label === 'کد ملی' ? ' privacy' : ''}" data-copy-label="${escapeHtml(label)}" data-identifier="${escapeHtml(value)}" title="کپی ${escapeHtml(label)}: ${escapeHtml(value)}"><span>${escapeHtml(label)}:</span> <b dir="ltr">${escapeHtml(value)}</b><span aria-hidden="true">⧉</span></button>`
        : `<span class="chip${label === 'کد ملی' ? ' privacy' : ''}">${escapeHtml(label)}: <b dir="auto">${escapeHtml(value)}</b></span>`).join('');
    const flags = (meta.flags || []).map((label) => `<span class="flag">${escapeHtml(label)}</span>`).join('');
    const messages = messageLines(output);
    let tables = '';
    for (const item of meta.viewer?.tables || []) {
      if (!item || !Array.isArray(item.head) || !Array.isArray(item.rows) || !item.rows.length) continue;
      tables += `<h2>${escapeHtml(item.title)}</h2><div class="table-wrap"><table><thead><tr>${item.head.map((head) => `<th>${escapeHtml(head)}</th>`).join('')}</tr></thead><tbody>${item.rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    const ability = output.Tavan_Baz_Pardakht;
    if (ability && typeof ability === 'object') {
      const rows = TIERS.filter(([key]) => ability[key] && typeof ability[key] === 'object')
        .map(([key, fa]) => `<tr><td>${escapeHtml(fa)} <code>${escapeHtml(key)}</code></td><td>${escapeHtml(humanNumber(ability[key].min))}</td><td>${escapeHtml(humanNumber(ability[key].max))}</td></tr>`).join('');
      if (rows) tables += `<h2>${meta.methodKey === 'tavan_mellat' ? 'سبد اعتباری به تفکیک رده' : 'توان بازپرداخت به تفکیک رده'}</h2><div class="table-wrap"><table><thead><tr><th>رده</th><th>کمینه</th><th>بیشینه</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    const top = Object.keys(sample), priority = ['output', 'input', 'collectedData'];
    const content = [...priority.filter((key) => top.includes(key)), ...top.filter((key) => !priority.includes(key))]
      .map((key) => tree(key, sample[key], 1)).join('');
    const raw = safeScript(sample);
    // این فایل داخل <script> گزارش جاسازی می‌شود؛ پایان تگ script نباید به‌صورت متوالی در متن آن ظاهر شود.
    const scriptEnd = '</' + 'script>';
    return `<!doctype html><html lang="fa" dir="rtl" data-theme="${activeTheme === 'dark' ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>جزئیات گزارش — ${escapeHtml(meta.bank || '')}</title><style>${window.__VIEWER_CSS || ''}</style></head><body><div class="viewer">
      <header class="detail-topbar"><strong>◈ جزئیات گزارش</strong><div class="detail-actions"><button id="detailThemeToggle" type="button" aria-label="تغییر حالت روشن و تیره">◐ <span>تغییر تم</span></button><button id="detailPrint" type="button">⎙ <span>چاپ گزارش</span></button></div></header>
      <div class="hero"><p class="eyebrow">گزارش کیفیت داده / جزئیات</p><h1>دادهٔ کامل گزارش — ${escapeHtml(meta.bank || '')}</h1><div class="chips">${chips}</div></div>
      ${creditAlertHtml(meta.creditAlerts)}${cardsHtml(cards)}${messages.length ? `<div class="note"><div class="label">پیام خروجی</div>${messages.map((text) => `<span class="message-line" dir="auto">${escapeHtml(text)}</span>`).join('')}</div>` : ''}
      ${flags ? `<h2>شاخص‌های فعال در این گزارش</h2><div class="flags">${flags}</div>` : ''}${tables}
      <h2>ساختار و دادهٔ کامل گزارش</h2><p>مبالغ در نمایش سه‌رقمی جدا می‌شوند؛ کپی JSON مقدارهای اصلی را بدون تغییر نگه می‌دارد.</p><div class="toolbar"><button id="openAll" type="button">باز کردن همه</button><button id="closeAll" type="button">بستن همه</button><button id="copyJson" type="button">کپی JSON</button><span id="copyStatus" role="status" aria-live="polite"></span></div>
      <div class="tree">${content}</div></div><script type="application/json" id="raw">${raw}${scriptEnd}<script>${actions}${scriptEnd}</body></html>`;
  };
})();
