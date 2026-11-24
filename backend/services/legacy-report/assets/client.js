/* رابط داشبورد زنده؛ جزئیات کامل هر نمونه با requestId از API اصلی خوانده می‌شود. */
(() => {
  'use strict';
  const apiConfig = window.__CE_DASHBOARD_PUBLIC__ || { mode: 'api' };
  const postbankOnly = document.body.dataset.bank === 'tavan_postbank';
  const nav = [...document.querySelectorAll('.nav-button')];
  const panels = [...document.querySelectorAll('.panel')];
  const scopes = [...document.querySelectorAll('.scope-buttons button')];
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const topbar = document.querySelector('.topbar');
  const slot = document.querySelector('.scope-slot');
  const scopebar = document.querySelector('.scopebar');

  const ROLE_FA = {
    admin: 'ادمین',
    creditEvaluation: 'CE',
    visitor: 'بازدیدکننده',
  };
  const ROLE_ORDER = { admin: 3, creditEvaluation: 2, visitor: 1 };

  /** فقط برترین نقش: admin > creditEvaluation (CE) > visitor */
  function primaryRoleLabel(roles) {
    const list = Array.isArray(roles) ? roles.filter(Boolean) : [];
    if (!list.length) return ROLE_FA.visitor;
    const top = [...list].sort((a, b) => (ROLE_ORDER[b] || 0) - (ROLE_ORDER[a] || 0))[0];
    return ROLE_FA[top] || top;
  }

  let authState = null;
  let refreshInFlight = null;
  let sessionUnconfirmed = 0;
  let refreshTimer = null;
  let keepaliveTimer = null;
  let redirectingToLogin = false;
  const authChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ce-auth') : null;

  function redirectToLogin(reason) {
    if (redirectingToLogin) return;
    redirectingToLogin = true;
    stopKeepalive();
    const currentPath = `${window.location.pathname || '/'}${window.location.search || ''}`;
    const sp = new URLSearchParams();
    if (currentPath && currentPath !== '/login') {
      sp.set('next', currentPath);
    }
    if (reason) sp.set('reason', reason);
    const qs = sp.toString();
    window.location.replace(qs ? `/login?${qs}` : '/login');
  }

  function unwrapEnvelope(raw) {
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.data !== undefined &&
      !raw.sample &&
      typeof raw.data === 'object'
    ) {
      return raw.data;
    }
    return raw;
  }

  async function fetchAuthMe() {
    try {
      const res = await fetch('/api/auth/me', {
        cache: 'no-store',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return { _httpError: res.status };
      const raw = await res.json().catch(() => null);
      return unwrapEnvelope(raw);
    } catch {
      return null;
    }
  }

  async function executeSingleFlightRefresh() {
    const run = async () => {
      const current = await fetchAuthMe();
      if (current && current.authenticated) {
        authState = current;
        return true;
      }
      // canRefresh:false از /me پس از انقضای اکسس توکن قطعی نیست؛ حتماً رفرش امتحان شود.
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: '{}',
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          authState = { authenticated: false, username: 'visitor', roles: ['visitor'], canRefresh: false };
        }
        return false;
      }
      const raw = await res.json().catch(() => null);
      const data = unwrapEnvelope(raw);
      if (data && data.authenticated) {
        authState = data;
        try {
          authChannel?.postMessage({ type: 'refreshed', auth: data });
        } catch {
          // ignore
        }
        return true;
      }
      return false;
    };

    if (navigator.locks && typeof navigator.locks.request === 'function') {
      return navigator.locks.request('ce-auth-refresh', run);
    }
    return run();
  }

  function refreshSession() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      // در تبِ پنهان تمدید نکنیم؛ چرخش توکن در تب پنهان باعث می‌شود تب فعال با
      // توکنِ کهنه درخواست بدهد. پس از مرئی‌شدن، visibilitychange تمدید می‌کند.
      return Promise.resolve(false);
    }
    if (!refreshInFlight) {
      refreshInFlight = executeSingleFlightRefresh().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  function renderAuthBar(state) {
    const container = document.getElementById('ce-auth-slot');
    const adminLink = document.getElementById('ce-admin-nav-link');
    if (!container) return;

    const roles = Array.isArray(state?.roles) ? state.roles : ['visitor'];
    const isAdmin = roles.includes('admin');
    if (adminLink) {
      if (state?.authenticated && isAdmin) {
        adminLink.style.display = '';
        adminLink.href = '/admin';
      } else {
        adminLink.style.display = 'none';
      }
    }

    container.replaceChildren();
    const nextUrl = encodeURIComponent(window.location.pathname + window.location.search);

    if (state && state.authenticated) {
      const chip = document.createElement('span');
      chip.className = 'ce-user-chip';
      const userLabel = document.createElement('span');
      userLabel.textContent = `👤 ${state.username || state.samadUsername || ''}`;
      const badge = document.createElement('span');
      badge.className = 'ce-role-badge';
      badge.textContent = primaryRoleLabel(roles);
      chip.append(userLabel, badge);

      const logoutBtn = document.createElement('button');
      logoutBtn.type = 'button';
      logoutBtn.className = 'ce-logout-btn';
      logoutBtn.textContent = 'خروج';
      logoutBtn.addEventListener('click', async () => {
        logoutBtn.disabled = true;
        try {
          await fetch('/api/auth/logout', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
        } catch {
          // ignore
        }
        authState = { authenticated: false, username: 'visitor', roles: ['visitor'], canRefresh: false };
        stopKeepalive();
        renderAuthBar(authState);
        try {
          authChannel?.postMessage({ type: 'logout' });
        } catch {
          // ignore
        }
        redirectToLogin();
      });

      container.append(chip, logoutBtn);
    } else {
      const loginLink = document.createElement('a');
      loginLink.href = `/login?next=${nextUrl}`;
      loginLink.className = 'ce-auth-link ce-auth-link-primary';
      loginLink.textContent = '🔑 ورود به حساب';
      container.append(loginLink);
    }
  }

  function stopKeepalive() {
    if (keepaliveTimer) {
      window.clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function scheduleKeepalive(state) {
    stopKeepalive();
    if (!state || !state.authenticated) return;
    const idleMs = Number(state.idleExpireMs || 20000);
    const accessMs = Number(state.accessExpireMs || 120000);
    const intervalMs = Math.max(10000, Math.min(60000, Math.floor(Math.min(idleMs, accessMs) * 0.65)));

    keepaliveTimer = window.setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      await syncAuthState();
    }, intervalMs);

    // تمدید پیش‌دستانه: پیش از انقضای اکسس توکن، رفرش توکن را در پس‌زمینه می‌چرخانیم
    // تا کاربر هنگام کلیک روی گزارش به «نشست منقضی» نخورد.
    const delay = Math.max(15000, Math.floor(accessMs * 0.6));
    refreshTimer = window.setTimeout(async () => {
      if (document.visibilityState !== 'visible') return;
      const refreshed = await refreshSession();
      if (refreshed && authState && authState.authenticated) {
        scheduleKeepalive(authState);
      }
    }, delay);
  }

  async function syncAuthState() {
    // دست‌کم دو بار تلاش می‌کنیم؛ خطای موقت (502/شبکه) نباید کاربر را به صفحهٔ ورود بفرستد.
    let me = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      me = await fetchAuthMe();
      if (me && !me._httpError && me.authenticated) break;
      if (me && me.authenticated) break;
      if (attempt === 0) {
        const refreshed = await refreshSession();
        if (refreshed) {
          me = authState || (await fetchAuthMe());
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    if (me && !me._httpError && me.authenticated) {
      sessionUnconfirmed = 0;
      authState = me;
      renderAuthBar(me);
      scheduleKeepalive(me);
      return authState;
    }

    // احراز نشده: تنها وقتی به لاگین می‌رویم که سرویس نشست با اطمینان (پاسخ معتبر 2xx)
    // بگوید نشستی وجود ندارد؛ خطای HTTP/شبکه فقط نادیده گرفته می‌شود.
    if (me && !me._httpError && me.authenticated === false) {
      authState = me;
      renderAuthBar(me);
      stopKeepalive();
      redirectToLogin('expired');
      return authState;
    }

    sessionUnconfirmed += 1;
    if (sessionUnconfirmed >= 3) {
      sessionUnconfirmed = 0;
      redirectToLogin('expired');
    }
    return authState;
  }

  if (authChannel) {
    authChannel.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'logout') {
        authState = { authenticated: false, username: 'visitor', roles: ['visitor'], canRefresh: false };
        stopKeepalive();
        renderAuthBar(authState);
        redirectToLogin();
      } else if (msg.type === 'refreshed' || msg.type === 'login') {
        if (msg.auth) {
          authState = msg.auth;
          renderAuthBar(msg.auth);
          scheduleKeepalive(msg.auth);
        } else {
          void syncAuthState();
        }
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void syncAuthState();
    }
  });

  void syncAuthState();

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

  // فهرست اصلی به‌صورت lazy و cursor-based بارگذاری می‌شود؛ هیچ صفحه‌ای بیش از ۵۰ ردیف ندارد.
  const pagerState = new WeakMap();
  const formatDigits = (value) => String(value ?? '').replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const faNumber = new Intl.NumberFormat('fa-IR');
  function appendCell(row, value, { ltr = false } = {}) {
    const cell = document.createElement('td');
    if (ltr) cell.dir = 'ltr';
    cell.textContent = value == null || value === '' ? '—' : String(value);
    row.appendChild(cell);
  }
  function displayStamp(item) {
    const raw = formatDigits(item.inserted_at || '');
    if (/^\d{14,17}$/.test(raw)) return `${raw.slice(0,4)}/${raw.slice(4,6)}/${raw.slice(6,8)} ${raw.slice(8,10)}:${raw.slice(10,12)}`;
    return formatDigits(item.day || '—');
  }
  function renderRecordPage(pager, page, pageNo) {
    const host = pager.querySelector('.paged-records-table');
    const table = document.createElement('table');
    table.className = 'report-page-table';
    const headings = ['#','شناسهٔ یکتا','شناسهٔ درخواست','تاریخ و ساعت','وضعیت','مدل','زمان اجرا (ثانیه)','PD','توان بازپرداخت'];
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headings.forEach((heading) => { const th = document.createElement('th'); th.textContent = heading; headRow.appendChild(th); });
    thead.appendChild(headRow); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    page.items.forEach((item, index) => {
      const tr = document.createElement('tr');
      if (item.request_id) {
        tr.className = 'clickable'; tr.dataset.sid = String(item.request_id); tr.tabIndex = 0;
        tr.setAttribute('role','button'); tr.setAttribute('aria-label','نمایش جزئیات گزارش در پنجرهٔ جدید');
      }
      const successText = item.is_success === true ? 'موفق' : item.is_success === false ? 'ناموفق' : '—';
      const formatted = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : faNumber.format(Number(value));
      const amount = formatted(item.suggested_amount);
      const duration = formatted(item.total_time_s);
      const pd = formatted(item.pd);
      [faNumber.format((pageNo - 1) * (Number(page.limit) || 50) + index + 1), item.unique_key || '—', item.request_id,
        displayStamp(item), successText, item.model_name, duration, pd, amount]
        .forEach((value, col) => appendCell(tr, value, { ltr: col === 1 || col === 2 }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); host.replaceChildren(table);
    const state = pagerState.get(pager);
    const pageSize = Number(page.limit) || 50;
    state.page = page; state.pageNo = pageNo; state.loading = false;
    const controls = pager.querySelector('.paged-records-controls');
    controls.hidden = false;
    controls.querySelector('[data-page-retry]').hidden = true;
    controls.querySelector('[data-page-prev]').disabled = pageNo <= 1;
    controls.querySelector('[data-page-next]').disabled = !page.nextCursor || pageNo * pageSize >= page.total;
    controls.querySelector('[data-page-label]').textContent = `صفحهٔ ${faNumber.format(pageNo)} · ${faNumber.format(page.items.length)} از ${faNumber.format(page.total)}`;
    const status = pager.querySelector('.paged-records-status');
    status.textContent = page.total ? `نمایش ${faNumber.format((pageNo - 1) * pageSize + 1)} تا ${faNumber.format(Math.min(pageNo * pageSize, page.total))} از ${faNumber.format(page.total)} رکورد` : 'رکوردی برای این فیلتر پیدا نشد.';
    status.removeAttribute('data-error');
  }
  async function loadRecordPage(pager, pageNo = 1, cursor = null) {
    let state = pagerState.get(pager);
    if (!state) { state = { cursors: [null], pageNo: 1, loading: false }; pagerState.set(pager, state); }
    if (state.loading) return;
    state.loading = true;
    state.requestPageNo = pageNo;
    state.requestCursor = cursor;
    const status = pager.querySelector('.paged-records-status');
    const controls = pager.querySelector('.paged-records-controls');
    status.textContent = 'در حال دریافت حداکثر ۵۰ رکورد…';
    status.removeAttribute('data-error');
    pager.setAttribute('aria-busy','true');
    controls.hidden = true;
    try {
      const form = document.querySelector('#ce-live-controls form');
      const params = new URLSearchParams({ type:'all', limit:'50' });
      const bank = form?.elements.namedItem('bank')?.value || document.body.dataset.bank;
      const from = form?.elements.namedItem('from')?.value || '';
      const to = form?.elements.namedItem('to')?.value || '';
      if (bank) params.set('bank',bank);
      if (from) params.set('from',from);
      if (to) params.set('to',to);
      const listStatus = pager.dataset.status;
      if (listStatus === 'success' || listStatus === 'fail') params.set('status',listStatus);
      if (cursor) params.set('cursor',cursor);
      const response = await fetch(`/api/list?${params.toString()}`, {
        credentials:'include', cache:'no-store', headers:{ accept:'application/json' },
      });
      if (!response.ok) throw new Error('list request failed');
      const raw = await response.json();
      let body = raw;
      for (let depth = 0; depth < 3 && body?.data && typeof body.data === 'object'
        && !Array.isArray(body.items) && !Array.isArray(body.rows); depth += 1) body = body.data;
      const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.rows) ? body.rows : [];
      const page = { items, total:Number(body?.total ?? items.length), limit:Number(body?.limit) || 50, nextCursor:body?.nextCursor || null };
      if (cursor && !items.length) page.nextCursor = null;
      if (page.nextCursor) state.cursors[pageNo] = page.nextCursor;
      renderRecordPage(pager,page,pageNo);
    } catch {
      state.loading = false;
      status.textContent = 'دریافت فهرست انجام نشد. اتصال را بررسی کنید و دوباره تلاش کنید.';
      status.dataset.error = 'true';
      controls.hidden = false;
      controls.querySelector('[data-page-prev]').disabled = state.pageNo <= 1;
      controls.querySelector('[data-page-next]').disabled = true;
      controls.querySelector('[data-page-label]').textContent = '';
      controls.querySelector('[data-page-retry]').hidden = false;
    } finally { pager.removeAttribute('aria-busy'); }
  }
  document.querySelectorAll('[data-record-pager]').forEach((pager) => {
    pager.addEventListener('toggle', () => {
      if (pager.open && !pagerState.get(pager)?.page) void loadRecordPage(pager);
    });
    pager.querySelector('[data-page-prev]').addEventListener('click', () => {
      const state = pagerState.get(pager); if (!state || state.pageNo <= 1) return;
      const pageNo = state.pageNo - 1; void loadRecordPage(pager,pageNo,state.cursors[pageNo - 1] || null);
    });
    pager.querySelector('[data-page-next]').addEventListener('click', () => {
      const state = pagerState.get(pager); if (!state?.page?.nextCursor) return;
      const pageNo = state.pageNo + 1; void loadRecordPage(pager,pageNo,state.page.nextCursor);
    });
    pager.querySelector('[data-page-retry]').addEventListener('click', () => {
      const state = pagerState.get(pager); if (!state) return;
      void loadRecordPage(pager,state.requestPageNo || 1,state.requestCursor || null);
    });
  });

  // نوار «محدودهٔ نمایش» در جریان عادی صفحه می‌ماند (بدون چسبیدن/تمام‌عرض شدن)؛
  // فقط سایهٔ ملایم هدر هنگام اسکرول اضافه می‌شود.
  let scheduled = false;
  function syncHeader() {
    scheduled = false;
    if (!topbar) return;
    topbar.classList.toggle('scrolled', window.scrollY > 8);
  }
  function scheduleHeader() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(syncHeader);
  }
  window.addEventListener('scroll', scheduleHeader, { passive: true });
  window.addEventListener('resize', scheduleHeader);
  syncHeader();

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

  async function loadSample(requestId) {
    // روت استاتیک است؛ شناسه و بانک از query param می‌آیند.
    const sampleQuery = new URLSearchParams({ requestId });
    const bankKey = document.body.dataset.bank;
    if (bankKey) sampleQuery.set('bank', bankKey);
    const url = `/api/sample?${sampleQuery.toString()}`;
    const doFetch = () => fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });

    let response = await doFetch();
    if (response.status === 401 || response.status === 403) {
      const currentMe = await fetchAuthMe();
      if (currentMe && !currentMe._httpError && currentMe.authenticated) {
        authState = currentMe;
        renderAuthBar(currentMe);
      } else {
        const refreshed = await refreshSession();
        if (refreshed) {
          renderAuthBar(authState);
          scheduleKeepalive(authState);
          response = await doFetch();
        }
      }
    }
    if (response.status === 401 && !(authState && authState.authenticated)) {
      stopKeepalive();
      redirectToLogin('expired');
      const err = new Error('نشست کاربری شما منقضی شده است؛ در حال انتقال به صفحه ورود…');
      err.status = 401;
      throw err;
    }

    let raw = null;
    try {
      raw = await response.json();
    } catch {
      raw = null;
    }
    const unwrapped = unwrapEnvelope(raw);
    if (!response.ok) {
      const serverMsg =
        unwrapped &&
        (typeof unwrapped.message === 'string'
          ? unwrapped.message
          : typeof unwrapped.message?.fa === 'string'
            ? unwrapped.message.fa
            : typeof unwrapped.data?.message?.fa === 'string'
              ? unwrapped.data.message.fa
              : null);
      const cleanedServerMsg = serverMsg
        ? String(serverMsg).replace(/\s*\(نیازمند نقش creditEvaluation یا admin\)\.?/g, '').trim()
        : null;
      const err = new Error(
        cleanedServerMsg ||
          (response.status === 403 || response.status === 401
            ? 'شما مجوز مشاهدهٔ جزئیات گزارش را ندارید.'
            : `دریافت جزئیات از API اصلی ناموفق بود (HTTP ${response.status}).`),
      );
      err.status = response.status;
      throw err;
    }
    if (!unwrapped || !unwrapped.meta || !unwrapped.sample) throw new Error('پاسخ جزئیات معتبر نیست.');
    return unwrapped;
  }
  async function openReport(requestId) {
    const win = window.open('', '_blank');
    if (!win) { alert('مرورگر باز کردن زبانهٔ جدید را مسدود کرده است. لطفاً اجازهٔ باز شدن زبانه را صادر کنید.'); return; }
    try { win.opener = null; } catch { /* محدودیت مرورگر */ }
    const activeTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const isDark = activeTheme === 'dark';
    const fontCss = window.__CE_FONT_CSS || '';
    win.document.write(`<!doctype html><html lang="fa" dir="rtl" data-theme="${activeTheme}"><head><meta charset="utf-8"><title>در حال بارگذاری گزارش</title><style>${fontCss}body{margin:0;background:${isDark ? '#040d21' : '#eef4fb'};color:${isDark ? '#eaf2ff' : '#0c1e3e'};font:14px/1.9 'Vazirmatn',Tahoma,"Segoe UI",sans-serif;padding:30px}</style></head><body>در حال آمادهسازی دادهٔ گزارش…</body></html>`);
    win.document.close();
    try {
      const payload = await loadSample(requestId);
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      const html = window.renderSampleViewer(payload, theme);
      win.document.open(); win.document.write(html); win.document.close();
    } catch (error) {
      if (error && error.status === 401 && !(authState && authState.authenticated)) {
        try { win.close(); } catch { /* ignore */ }
        redirectToLogin('expired');
        return;
      }
      const isForbidden = Boolean(error && (error.status === 403 || (error.status === 401 && authState && authState.authenticated)));
      const origin = window.location.origin && window.location.origin !== 'null' ? window.location.origin : '';
      const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const loginHref = escAttr(`${origin}/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      const homeHref = escAttr(`${origin}/`);
      const errTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      const errDark = errTheme === 'dark';
      win.document.open();
      win.document.write(`<!doctype html><html lang="fa" dir="rtl" data-theme="${errTheme}"><head><meta charset="utf-8"><title>${isForbidden ? 'عدم دسترسی به جزئیات گزارش' : 'خطا در نمایش گزارش'}</title><style>${fontCss}
        body{margin:0;background:${errDark ? '#040d21' : '#eef4fb'};color:${errDark ? '#eaf2ff' : '#0c1e3e'};font:14px/1.9 'Vazirmatn',Tahoma,"Segoe UI",sans-serif;padding:44px}
        main{max-width:640px;margin:auto;background:${errDark ? '#0a1938' : '#fff'};border:1px solid ${errDark ? '#1e3766' : '#d4e2f4'};border-radius:16px;padding:28px 32px;box-shadow:0 14px 36px ${errDark ? 'rgba(0,0,0,.45)' : 'rgba(0,28,88,.08)'}}
        .badge{display:inline-block;background:${isForbidden ? (errDark ? 'rgba(248,113,113,.18)' : '#fdecec') : (errDark ? 'rgba(251,191,36,.18)' : '#fff4e2')};color:${isForbidden ? (errDark ? '#fca5a5' : '#c9313d') : (errDark ? '#fcd34d' : '#b4690e')};border-radius:8px;padding:3px 10px;font-size:12px;font-weight:700}
        h1{font-size:20px;margin:12px 0 8px;color:${errDark ? '#f8fafc' : '#0c1e3e'}}p{color:${errDark ? '#9fb5d4' : '#4e6788'};margin:0 0 18px}
        .actions{display:flex;gap:10px;flex-wrap:wrap}
        .btn{display:inline-flex;align-items:center;border-radius:10px;padding:8px 16px;text-decoration:none;font-weight:700;font-size:13px;border:1px solid ${errDark ? '#27447a' : '#d4e2f4'};color:${errDark ? '#e6f0ff' : '#0c1e3e'};background:${errDark ? '#0f234c' : '#f4f8fe'}}
        .btn-primary{background:${errDark ? '#0ea5e9' : '#0b5ed7'};border-color:${errDark ? '#0ea5e9' : '#0b5ed7'};color:${errDark ? '#041226' : '#fff'}}
      </style></head><body><main><span class="badge">${isForbidden ? 'HTTP 403 · محدودیت سطح دسترسی' : 'خطا'}</span><h1>${isForbidden ? 'عدم مجوز مشاهدهٔ جزئیات گزارش' : 'مشاهدهٔ جزئیات ممکن نیست'}</h1><p id="err-msg"></p>${isForbidden ? `<div class="actions"><a class="btn btn-primary" href="${loginHref}">ورود با حساب مجاز</a><a class="btn" href="${homeHref}">بازگشت به داشبورد</a></div>` : ''}</main></body></html>`);
      win.document.close();
      const msgEl = win.document.getElementById('err-msg');
      if (msgEl) msgEl.textContent = error.message || 'خطای نامشخص';
    }
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
    try {
      const savedTheme = localStorage.getItem('bank-ce-dashboard-theme') || localStorage.getItem('ce-theme');
      if (savedTheme === 'dark') document.documentElement.dataset.theme = 'dark';
    } catch { /* file:// */ }
    theme.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      theme.setAttribute('aria-label', next === 'dark' ? 'فعال کردن حالت روشن' : 'فعال کردن حالت تیره');
      try {
        localStorage.setItem('bank-ce-dashboard-theme', next);
        localStorage.setItem('ce-theme', next);
      } catch { /* file:// */ }
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
