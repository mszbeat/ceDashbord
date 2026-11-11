'use strict';
/* صفحهٔ زنده: همان buildHtml قدیمی، ولی بدون نوشتن فایل HTML و بدون فایل خصوصی. */
const fs = require('node:fs');
const path = require('node:path');
const { buildHtml } = require('./render');
const { h } = require('./common');

const assetsDir = path.join(__dirname, 'assets');
const readAsset = (name) => fs.readFileSync(path.join(assetsDir, name), 'utf8');
const ASSETS = {
  css: readAsset('style.css'),
  client: readAsset('client.js'),
  viewerJs: readAsset('viewer.js'),
  viewerCss: readAsset('viewer.css'),
};

const CONTROL_CSS = `
<style id="ce-live-controls-style">
.ce-live-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 16px;padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);box-shadow:var(--shadow);font-size:12px;color:var(--muted)}
.ce-live-bar form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%}
.ce-live-bar label{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-weight:700;color:var(--ink)}
.ce-live-bar select,.ce-live-bar input{border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:5px 8px;min-height:32px;font:inherit}
.ce-live-bar input{direction:ltr;text-align:left;width:112px}
.ce-live-bar button{border:1px solid var(--line);border-radius:8px;background:var(--accent-soft);color:var(--accent-strong);padding:5px 12px;min-height:32px;font:inherit;font-weight:700}
.ce-live-bar button:hover{background:var(--accent);color:#fff}
.ce-live-status{margin-inline-start:auto;color:var(--subtle);font-size:11px}
@media (max-width:720px){.ce-live-status{width:100%;margin-inline-start:0}}
</style>`;

function controlsHtml(controls = {}) {
  const banks = Array.isArray(controls.banks) && controls.banks.length
    ? controls.banks : [{ id: 'tavan_mellat', label: 'ملت' }];
  const action = String(controls.action || '/');
  const bank = String(controls.bank || banks[0].id);
  const from = String(controls.from || '');
  const to = String(controls.to || '');
  const rowsCap = Number(controls.rowsCap || 100);
  const status = String(controls.status || '');
  const updatedAt = String(controls.updatedAt || '');
  const options = banks.map((item) => `<option value="${h(item.id)}"${item.id === bank ? ' selected' : ''}>${h(item.label)}</option>`).join('');
  const note = [status && `وضعیت اجرا: ${h(status)}`, updatedAt && `آخرین بروزرسانی: <bdi dir="ltr">${h(updatedAt)}</bdi>`]
    .filter(Boolean).join(' · ');
  return `<div class="ce-live-bar" id="ce-live-controls"><form method="get" action="${h(action)}">
    <label for="ce-bank">بانک</label><select id="ce-bank" name="bank">${options}</select>
    <label for="ce-from">از روز</label><input id="ce-from" name="from" value="${h(from)}" placeholder="1405-08-01" inputmode="numeric" maxlength="10">
    <label for="ce-to">تا روز</label><input id="ce-to" name="to" value="${h(to)}" placeholder="1405-08-19" inputmode="numeric" maxlength="10">
    <input type="hidden" name="rowsCap" value="${h(rowsCap)}">
    <button type="submit">⟳ بروزرسانی</button>
    ${note ? `<span class="ce-live-status">${note}</span>` : ''}
  </form></div>`;
}

function inject(html, controls) {
  const bar = controlsHtml(controls);
  const withCss = html.includes('</head>') ? html.replace('</head>', `${CONTROL_CSS}</head>`) : `${CONTROL_CSS}${html}`;
  if (withCss.includes('</header>')) return withCss.replace('</header>', `</header>${bar}`);
  const body = withCss.match(/<body[^>]*>/);
  return body ? withCss.replace(body[0], `${body[0]}${bar}`) : bar + withCss;
}

function buildReport(scan, data, options = {}) {
  const html = buildHtml(scan, data, {
    rowsCap: Number(options.rowsCap || 100),
    api: { mode: 'api', endpoint: '/api/sample' },
  }, ASSETS);
  return inject(html, options.controls || {});
}

module.exports = { buildReport, ASSETS };
