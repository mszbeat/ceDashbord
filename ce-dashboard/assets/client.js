/* رابط گزارش عمومی؛ جزئیات کامل فقط از فایل همراهِ پوشهٔ reports خوانده می‌شود. */
(() => {
  'use strict';
  const privateConfig = window.__CE_DASHBOARD_PUBLIC__;
  const folderName = 'reports';
  const postbankOnly = document.body.dataset.bank === 'tavan_postbank';
  const nav = [...document.querySelectorAll('.nav-button')];
  const panels = [...document.querySelectorAll('.panel')];
  const scopes = [...document.querySelectorAll('.scope-buttons button')];
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const topbar = document.querySelector('.topbar');
  const slot = document.querySelector('.scope-slot');
  const scopebar = document.querySelector('.scopebar');
  let privatePromise = null;

  function show(topicId, updateHash = true) {
    if (!panels.some((panel) => panel.id === `panel-${topicId}`)) return;
    for (const button of nav) {
      const active = button.dataset.topic === topicId;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const panel of panels) panel.hidden = panel.id !== `panel-${topicId}`;
    if (updateHash) {
      try { history.replaceState(null, '', `#${encodeURIComponent(topicId)}`); } catch { /* file:// */ }
    }
  }
  nav.forEach((button) => button.addEventListener('click', () => {
    show(button.dataset.topic);
    slot?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
  }));
  window.addEventListener('hashchange', () => {
    try { show(decodeURIComponent(location.hash.slice(1)), false); } catch { show('overview', false); }
  });
  let initial;
  try { initial = decodeURIComponent(location.hash.slice(1)); } catch { initial = 'overview'; }
  show(panels.some((panel) => panel.id === `panel-${initial}`) ? initial : 'overview', false);

  scopes.forEach((button) => button.addEventListener('click', () => {
    document.body.dataset.scope = button.dataset.scope;
    for (const item of scopes) item.setAttribute('aria-pressed', String(item === button));
  }));

  // وقتی نوار فیلتر به هدر برسد، به پنل شناورِ سمت چپ و زیر هدر تبدیل می‌شود.
  let scheduled = false;
  function syncFloating() {
    scheduled = false;
    if (!scopebar || !slot || !topbar) return;
    if (!scopebar.classList.contains('floating')) slot.style.minHeight = `${scopebar.offsetHeight + 16}px`;
    const reached = slot.getBoundingClientRect().top <= topbar.getBoundingClientRect().bottom + 8;
    scopebar.classList.toggle('floating', reached);
    topbar.classList.toggle('scrolled', window.scrollY > 8);
  }
  function scheduleFloating() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(syncFloating);
  }
  window.addEventListener('scroll', scheduleFloating, { passive: true });
  window.addEventListener('resize', () => {
    scopebar?.classList.remove('floating');
    if (slot) slot.style.minHeight = '';
    scheduleFloating();
  });
  scheduleFloating();

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return; } catch { /* fallback */ }
    }
    const field = document.createElement('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const success = document.execCommand('copy');
    field.remove();
    if (!success) throw new Error('دسترسی به کلیپ‌بورد ممکن نبود.');
  }
  document.querySelectorAll('.table-tools').forEach((tools) => {
    const table = document.getElementById(tools.dataset.table);
    if (!table) return;
    const headers = [...table.querySelectorAll('thead th')].map((cell) => cell.textContent.trim());
    const indexKey = headers.indexOf('uniqueKey'), indexRequest = headers.indexOf('requestId');
    const search = tools.querySelector('input'), button = tools.querySelector('button');
    const status = tools.querySelector('.result-count');
    const rows = [...table.querySelectorAll('tbody tr')];
    if (postbankOnly) {
      search.placeholder = 'جست‌وجو فقط با requestId…';
      tools.querySelector('label').textContent = 'جست‌وجو بر اساس requestId';
    }
    const cellValue = (row, index) => index < 0 ? ''
      : row.cells[index]?.querySelector('button.copy-id')?.dataset.identifier || row.cells[index]?.textContent.trim() || '';
    const update = () => {
      const query = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      for (const row of rows) {
        const searchable = postbankOnly ? cellValue(row, indexRequest)
          : `${row.textContent} ${cellValue(row, indexKey)} ${cellValue(row, indexRequest)}`;
        row.hidden = !!query && !searchable.toLocaleLowerCase().includes(query);
        if (!row.hidden) visible++;
      }
      status.textContent = query ? `${visible} نتیجه از ${rows.length} ردیف` : `${rows.length} ردیف`;
    };
    search.addEventListener('input', update);
    update();
    button.addEventListener('click', async () => {
      const keys = rows.filter((row) => !row.hidden).map((row) => {
        const unique = cellValue(row, indexKey);
        return unique && unique !== '—' && unique !== '-' ? unique : cellValue(row, indexRequest);
      }).filter((value) => value && value !== '—' && value !== '-');
      if (!keys.length) { button.textContent = 'شناسه‌ای یافت نشد'; return; }
      try { await copyText(keys.join('\n')); button.textContent = `کپی شد (${keys.length})`; }
      catch { button.textContent = 'کپی ممکن نبود'; }
      setTimeout(() => { button.textContent = 'کپی شناسه‌های نمایان'; }, 2200);
    });
  });

  function loadPrivate() {
    if (privateConfig?.folder !== 'reports' || !/^[a-f0-9]{32}$/.test(privateConfig?.token || '')
      || privateConfig?.url !== `./reports/_ce-dashboard-private/details-${privateConfig.token}.js`)
      return Promise.reject(new Error('برای دیدن جزئیات، ورودی باید پوشهٔ reports باشد و HTML کنار همان پوشه تولید شود.'));
    if (window.__CE_DASHBOARD_PRIVATE__?.token === privateConfig.token) return Promise.resolve(window.__CE_DASHBOARD_PRIVATE__.details);
    if (privatePromise) return privatePromise;
    privatePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = privateConfig.url;
      script.onload = () => {
        script.remove();
        const source = window.__CE_DASHBOARD_PRIVATE__;
        if (source?.token !== privateConfig.token || !source.details) reject(new Error('فایل جزئیات متعلق به نسخهٔ دیگری از گزارش است.'));
        else resolve(source.details);
      };
      script.onerror = () => {
        script.remove();
        reject(new Error(`فایل جزئیات پیدا نشد. پوشهٔ ${folderName}، شامل _ce-dashboard-private، باید کنار این فایل HTML قرار داشته باشد.`));
      };
      document.head.appendChild(script);
    }).catch((error) => { privatePromise = null; throw error; });
    return privatePromise;
  }
  async function openReport(sid) {
    const win = window.open('', '_blank');
    if (!win) { alert('مرورگر باز کردن زبانهٔ جدید را مسدود کرده است. لطفاً اجازهٔ باز شدن زبانه را صادر کنید.'); return; }
    try { win.opener = null; } catch { /* محدودیت مرورگر */ }
    win.document.write('<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>در حال بارگذاری گزارش</title></head><body style="font-family:Tahoma,sans-serif;padding:30px">در حال آماده‌سازی دادهٔ گزارش…</body></html>');
    win.document.close();
    try {
      const details = await loadPrivate();
      const compressed = Object.prototype.hasOwnProperty.call(details, sid) ? details[sid] : null;
      if (!compressed) throw new Error('دادهٔ کامل این گزارش در محدودهٔ ذخیرهٔ جزئیات قرار ندارد.');
      if (typeof DecompressionStream === 'undefined') throw new Error('برای مشاهدهٔ جزئیات، نسخهٔ جدید مرورگر لازم است.');
      const binary = atob(compressed), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const text = await new Response(stream).text();
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      const html = window.renderSampleViewer(JSON.parse(text), theme);
      win.document.open(); win.document.write(html); win.document.close();
    } catch (error) { win.document.body.textContent = `مشاهدهٔ جزئیات ممکن نیست: ${error.message}`; }
  }
  document.addEventListener('click', (event) => {
    const copy = event.target.closest?.('td.id-cell')?.querySelector('button.copy-id')
      || event.target.closest?.('button.copy-id');
    if (copy) {
      event.stopPropagation();
      const identifier = copy.dataset.identifier;
      if (!identifier) return;
      const originalTitle = copy.title;
      copyText(identifier).then(() => {
        copy.classList.add('copied');
        const icon = copy.querySelector('span[aria-hidden]');
        if (icon) icon.textContent = '✓';
        copy.title = 'شناسهٔ کامل کپی شد';
        setTimeout(() => { copy.classList.remove('copied'); if (icon) icon.textContent = '⧉'; copy.title = originalTitle; }, 1800);
      }).catch(() => { copy.title = 'کپی ممکن نبود؛ شناسهٔ کامل را از توضیح این دکمه بردارید'; });
      return;
    }
    const row = event.target.closest?.('tr[data-sid]');
    if (row) openReport(row.dataset.sid);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest?.('tr[data-sid]');
    if (row && event.target === row) { event.preventDefault(); openReport(row.dataset.sid); }
  });
  const theme = document.getElementById('themeToggle');
  if (theme) {
    try { if (localStorage.getItem('bank-ce-dashboard-theme') === 'dark') document.documentElement.dataset.theme = 'dark'; } catch { /* file:// */ }
    theme.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      theme.setAttribute('aria-label', next === 'dark' ? 'فعال کردن حالت روشن' : 'فعال کردن حالت تیره');
      try { localStorage.setItem('bank-ce-dashboard-theme', next); } catch { /* file:// */ }
    });
  }
  document.getElementById('printReport')?.addEventListener('click', () => window.print());
})();

/* Tooltip and coordinated chart focus; no dependencies or HTML from report data. */
(() => {
  'use strict';
  if (!document.querySelector('[data-chart-tip]')) return;
  const tip=document.createElement('div');tip.id='ce-dashboard-chart-tooltip';tip.className='chart-tooltip';tip.hidden=true;tip.setAttribute('role','tooltip');document.body.appendChild(tip);
  let active=null,figure=null;
  const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  function clearFocus(){if(figure){figure.classList.remove('has-chart-focus');figure.querySelectorAll('.is-chart-active').forEach(e=>e.classList.remove('is-chart-active'));}if(active)active.removeAttribute('aria-describedby');}
  function hide(){clearFocus();tip.hidden=true;active=null;figure=null;}
  function position(event){
    if(!active||tip.hidden)return;
    const r=active.getBoundingClientRect(),mouse=event&&Number.isFinite(event.clientX),x=mouse?event.clientX:r.left+r.width/2,y=mouse?event.clientY:r.bottom;
    const box=tip.getBoundingClientRect(),pad=10;let left=x+16,top=y+18;
    if(left+box.width>window.innerWidth-pad)left=x-box.width-16;
    if(top+box.height>window.innerHeight-pad)top=y-box.height-16;
    tip.style.left=Math.max(pad,Math.min(left,window.innerWidth-box.width-pad))+'px';
    tip.style.top=Math.max(pad,Math.min(top,window.innerHeight-box.height-pad))+'px';
  }
  function show(mark,event){
    if(mark===active){position(event);return;}
    let data;try{data=JSON.parse(mark.dataset.chartTip);}catch{return hide();}
    if(!Array.isArray(data.rows))return hide();
    clearFocus();active=mark;figure=mark.closest('.insight-chart');if(!figure)return hide();
    figure.classList.add('has-chart-focus');figure.querySelectorAll('[data-chart-key]').forEach(e=>e.classList.toggle('is-chart-active',e.dataset.chartKey===mark.dataset.chartKey));
    mark.setAttribute('aria-describedby',tip.id);tip.replaceChildren();
    const title=node('div','chart-tip-title',data.title||'');title.dir='auto';if(data.subtitle){const subtitle=node('bdi','chart-tip-subtitle',data.subtitle);subtitle.dir=data.direction==='ltr'?'ltr':'auto';title.append(subtitle);}tip.append(title);
    const multiple=data.rows.length>1,grid=node('div','chart-tip-grid'+(multiple?' chart-tip-multiple':''));
    if(multiple)grid.append(node('span','chart-tip-head','وضعیت'));
    grid.append(node('span','chart-tip-head',data.countLabel||'تعداد'),node('span','chart-tip-head','درصد'));
    for(const row of data.rows){if(multiple)grid.append(node('span','chart-tip-label',row.label));for(const value of [row.count,row.percent]){const cell=node('bdi','chart-tip-value',value);cell.dir='ltr';grid.append(cell);}}
    tip.append(grid);if(data.footnote)tip.append(node('div','chart-tip-foot',data.footnote));
    tip.hidden=false;position(event);
  }
  document.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const mark=e.target.closest?.('[data-chart-tip]');if(mark)show(mark,e);});
  document.addEventListener('pointermove',e=>{if(active&&e.target.closest?.('[data-chart-tip]')===active)position(e);});
  document.addEventListener('pointerout',e=>{if(e.pointerType==='touch')return;if(active&&e.target.closest?.('[data-chart-tip]')===active&&!e.relatedTarget?.closest?.('[data-chart-tip]'))hide();});
  document.addEventListener('focusin',e=>{const mark=e.target.closest?.('[data-chart-tip]');if(mark)show(mark);else hide();});
  document.addEventListener('focusout',e=>{if(active&&!e.relatedTarget?.closest?.('[data-chart-tip]'))hide();});
  document.addEventListener('pointerdown',e=>{const mark=e.target.closest?.('[data-chart-tip]');if(mark)show(mark,e);else hide();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();});
  document.addEventListener('click',e=>{if(e.target.closest?.('.nav-button,.scope-buttons button,#themeToggle'))hide();});
  window.addEventListener('resize',hide);window.addEventListener('scroll',hide,{capture:true,passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)hide();});
})();
