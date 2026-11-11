(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const DESKTOP = window.matchMedia('(min-width: 960px)');
  const state = {
    me: null,
    pipelines: [],
    pipelineId: null,
    board: null,
    stage: null,
    query: '',
    openId: null,
    notes: {},
    loading: false,
    lastFetch: 0,
    view: 'leads',
    bk: { pid: null, months: new Set(), map: new Map() },   // portal calendar bookings by id
    cal: { month: null, day: null },
    inv: { pid: null, settings: null, map: new Map(), quotes: new Map(), loaded: false },
  };

  // Closing a panel with its X/scrim steps browser history back; ignore the popstate that causes.
  let skipPop = 0;
  const backQuietly = () => { skipPop++; history.back(); };

  /* ---------------- helpers ---------------- */

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls = '') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  function phonePretty(p) {
    const d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    return p || '';
  }
  function ago(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const fullDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }) : '—');
  const money = (n) => `$${Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2,
  })}`;
  // Compact dollars for small tiles: $950, $7.1k, $12k, $1.2M.
  const shortMoney = (n) => {
    const v = Number(n) || 0;
    if (v < 1000) return money(v);
    if (v < 1e6) return `$${v < 1e4 ? (v / 1e3).toFixed(1).replace(/\.0$/, '') : Math.round(v / 1e3)}k`;
    return `$${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  };
  const isNew = (o) => o.createdAt && Date.now() - new Date(o.createdAt).getTime() < 48 * 3600e3;

  let toastTimer;
  function toast(msg, bad) {
    const el = $('#toast');
    el.className = `toast${bad ? ' bad' : ''}`;
    el.innerHTML = `${icon(bad ? 'x' : 'check')}<span>${esc(msg)}</span>`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 4200 : 2400);
  }

  async function api(path, body) {
    const opts = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try { res = await fetch(`/api/${path}`, opts); } catch {
      throw new Error('No connection. Check your signal and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== 'login') { showLogin(); throw new Error('Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  /* ---------------- client branding ---------------- */

  const BRAND_VARS = ['--accent', '--accent-hi', '--accent-dim', '--accent-text', '--accent-soft', '--accent-soft-2', '--on-accent'];
  const DEFAULT_HEAD = {
    manifest: '/manifest.webmanifest', touch: '/icons/apple-touch-icon.png', icon: '/icons/icon-192.png',
    title: 'LeadThru', doc: 'LeadThru Portal',
  };

  const rgb = (h) => {
    let s = String(h).replace('#', '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const mix = (c, t, amt) => c.map((v, i) => Math.round(v + (t[i] - v) * amt));

  // From one brand colour: readable text on it, a darker shade for text on white, soft tints.
  function brandVars(color) {
    const c = rgb(color);
    const W = [255, 255, 255];
    const K = [0, 0, 0];
    const onAccent = contrast(c, W) >= contrast(c, K) ? '#FFFFFF' : '#141414';
    let text = c;
    for (let i = 0; i < 30 && contrast(text, W) < 4.5; i++) text = mix(text, K, 0.06);
    const hi = lum(c) < 0.03 ? mix(c, W, 0.18) : mix(c, K, 0.12);
    return {
      '--accent': hex(c),
      '--accent-hi': hex(hi),
      '--accent-dim': hex(mix(c, W, 0.45)),
      '--accent-text': hex(text),
      '--accent-soft': `rgba(${c.join(',')},.09)`,
      '--accent-soft-2': `rgba(${c.join(',')},.16)`,
      '--on-accent': onAccent,
    };
  }

  function setHead(h) {
    $('link[rel="manifest"]').href = h.manifest;
    $('link[rel="apple-touch-icon"]').href = h.touch;
    $('link[rel="icon"]').href = h.icon;
    $('meta[name="apple-mobile-web-app-title"]').content = h.title;
    document.title = h.doc;
  }

  function applyBrand(b) {
    const root = document.documentElement;
    Object.entries(brandVars(b.color)).forEach(([k, v]) => root.style.setProperty(k, v));
    root.classList.add('client-theme');
    const base = b.assets || `/brands/${encodeURIComponent(b.slug)}`;
    const ver = `?v=${b.v || 1}`;
    const img = $('#clientLogo');
    if (b.hasLogo !== false) {
      img.src = `${base}/logo.png${ver}`;
      img.alt = b.name;
      img.classList.toggle('wide', (b.logoRatio || 1) > 2.6);
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
    $('#clientName').textContent = b.name;
    $('#clientName').hidden = !(b.showName || b.hasLogo === false);
    $('#clientBrand').hidden = false;
    $('#ltBrand').hidden = true;
    $('#who').hidden = true;
    $('#ltBar').hidden = false;
    $('#ltFoot').hidden = false;
    const own = b.hasLogo !== false;
    setHead({
      manifest: b.manifest || `${base}/manifest.webmanifest`,
      touch: own ? `${base}/apple-touch-icon.png${ver}` : DEFAULT_HEAD.touch,
      icon: own ? `${base}/icon-192.png${ver}` : DEFAULT_HEAD.icon,
      title: b.short, doc: `${b.name} · Leads`,
    });
  }

  function clearBrand() {
    const root = document.documentElement;
    BRAND_VARS.forEach((k) => root.style.removeProperty(k));
    root.classList.remove('client-theme');
    $('#clientBrand').hidden = true;
    $('#ltBrand').hidden = false;
    $('#ltBar').hidden = true;
    $('#ltFoot').hidden = true;
    setHead(DEFAULT_HEAD);
  }

  /* ---------------- login ---------------- */

  function showLogin() {
    state.me = null;
    clearBrand();
    closeSheet();
    closeEditor();
    closeBooker();
    closeInvPanel();
    state.bk = { pid: null, months: new Set(), map: new Map() };
    state.inv = { pid: null, settings: null, map: new Map(), quotes: new Map(), loaded: false };
    $('#clientsBtn').hidden = true;
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#boot').hidden = true;
    setTimeout(() => $('#username').focus(), 50);
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginBtn');
    const err = $('#loginErr');
    err.hidden = true;
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) { err.textContent = 'Enter your username and password.'; err.hidden = false; return; }
    btn.disabled = true;
    btn.firstChild.textContent = 'Signing in… ';
    try {
      await api('login', { username, password });
      $('#password').value = '';
      await start();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.firstChild.textContent = 'Sign in ';
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('logout', {}); } catch { /* signed out anyway */ }
    state.board = null;
    showLogin();
  });

  /* ---------------- start / load ---------------- */

  async function start() {
    const me = await api('me');
    state.me = me.user;
    state.pipelines = me.pipelines || [];
    const pick = $('#pipelinePick');
    if (state.me.admin) {
      const saved = store.get('lt_pipe');
      state.pipelineId = state.pipelines.some((p) => p.id === saved) ? saved : (state.pipelines[0] || {}).id;
      pick.innerHTML = state.pipelines.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      pick.value = state.pipelineId || '';
      pick.hidden = false;
      $('#who').hidden = true;
    } else {
      state.pipelineId = (state.pipelines[0] || {}).id;
      $('#who').textContent = state.me.name;
      $('#who').hidden = false;
      pick.hidden = true;
    }
    if (me.brand) applyBrand(me.brand); else clearBrand();
    $('#clientsBtn').hidden = !state.me.admin;
    showView('home');
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#boot').hidden = true;
    setupInstallHint();
    await loadBoard();
  }

  async function loadBoard(silent) {
    if (state.loading) return;
    state.loading = true;
    const btn = $('#refreshBtn');
    btn.classList.add('spin');
    try {
      const q = state.me.admin && state.pipelineId ? `?pipeline=${encodeURIComponent(state.pipelineId)}` : '';
      const data = await api(`board${q}`);
      state.board = data;
      state.lastFetch = Date.now();
      const stages = data.pipeline.stages;
      if (!stages.some((s) => s.id === state.stage)) state.stage = (stages[0] || {}).id || null;
      render();
      if (state.view === 'home') renderHome();
      loadBookings(true);
      loadInvoices();
    } catch (ex) {
      if (!state.me) return;
      if (!state.board) {
        $('#board').innerHTML = `<div class="err-box">${esc(ex.message)}</div>`;
      } else if (!silent) toast(ex.message, true);
    } finally {
      state.loading = false;
      btn.classList.remove('spin');
    }
  }

  $('#refreshBtn').addEventListener('click', () => loadBoard());
  $('#pipelinePick').addEventListener('change', (e) => {
    state.pipelineId = e.target.value;
    store.set('lt_pipe', state.pipelineId);
    state.board = null;
    state.stage = null;
    state.bk = { pid: null, months: new Set(), map: new Map() };
    state.inv = { pid: null, settings: null, map: new Map(), quotes: new Map(), loaded: false };
    $('#board').innerHTML = '';
    $('#chips').innerHTML = '';
    $('#summary').innerHTML = '';
    loadBoard();
  });

  // Keep it live: refresh every minute while open, and when coming back to the app.
  setInterval(() => {
    if (state.me && !state.openId && !booker.open && !invp.open && state.view !== 'clients' && document.visibilityState === 'visible') loadBoard(true);
  }, 60e3);
  document.addEventListener('visibilitychange', () => {
    if (state.me && document.visibilityState === 'visible' && Date.now() - state.lastFetch > 20e3 && !state.openId && !booker.open && state.view !== 'clients') loadBoard(true);
  });

  /* ---------------- render ---------------- */

  function matches(o) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    const digits = q.replace(/\D/g, '');
    return [o.name, o.contact.name, o.contact.email, o.contact.company].some((v) => String(v || '').toLowerCase().includes(q))
      || (digits.length >= 3 && String(o.contact.phone || '').replace(/\D/g, '').includes(digits));
  }

  function sorted(list) {
    return list.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  function cardHTML(o, showStage) {
    const stageName = showStage ? (state.board.pipeline.stages.find((s) => s.id === o.stageId) || {}).name : '';
    const badge = o.status === 'won' ? '<span class="badge won">Won</span>'
      : (o.status === 'lost' || o.status === 'abandoned') ? '<span class="badge lost">Lost</span>'
        : isNew(o) ? '<span class="badge">New</span>' : '';
    const bits = [
      o.meta === 'no' ? '<span class="src no">Not Meta</span>' : isMeta(o) ? '<span class="src">Meta</span>' : '',
      stageName && `<span>${esc(stageName)}</span>`,
      o.contact.phone && `<span>${esc(phonePretty(o.contact.phone))}</span>`,
      `<span>${esc(ago(o.createdAt))}</span>`,
      o.value > 0 && `<span class="val">${esc(money(o.value))}</span>`,
      nextBooking(o.id) && `<span class="bk">${icon('cal')}${esc(shortWhen(nextBooking(o.id)))}</span>`,
    ].filter(Boolean).join('');
    const call = o.contact.phone
      ? `<a class="call" href="tel:${esc(o.contact.phone)}" aria-label="Call ${esc(o.name)}" data-stop>${icon('phone')}</a>` : '';
    return `<div class="card" role="button" tabindex="0" data-id="${esc(o.id)}"${DESKTOP.matches ? ' draggable="true"' : ''}>
      <div class="main"><div class="nm">${esc(o.name)}${badge}</div><div class="meta">${bits}</div></div>${call}</div>`;
  }

  function render() {
    const b = state.board;
    if (!b) return;
    const opps = b.opportunities;
    const stages = b.pipeline.stages;
    const shown = opps.filter(matches);

    const weekAgo = Date.now() - 7 * 864e5;
    const newCount = opps.filter((o) => o.createdAt && new Date(o.createdAt).getTime() > weekAgo).length;
    const total = opps.reduce((s, o) => s + (o.value || 0), 0);
    const metaCount = opps.filter((o) => isMeta(o)).length;
    $('#summary').innerHTML = `
      <div class="stat"><div class="n">${opps.length}</div><div class="l">Leads</div></div>
      <div class="stat hi"><div class="n">${metaCount}</div><div class="l">From Meta</div></div>
      <div class="stat"><div class="n">${newCount}</div><div class="l">This week</div></div>
      <div class="stat" title="${esc(money(total))}"><div class="n">${esc(shortMoney(total))}</div><div class="l">Job value</div></div>`;
    renderWrapUp();

    const count = (id) => shown.filter((o) => o.stageId === id).length;
    $('#chips').innerHTML = stages.map((s) => `
      <button class="chip" type="button" data-stage="${esc(s.id)}" aria-pressed="${s.id === state.stage}">
        ${esc(s.name)} <span class="c">${count(s.id)}</span></button>`).join('');

    // Phone + search: one flat list across every stage so nothing hides.
    if (state.query && !DESKTOP.matches) {
      $('#board').innerHTML = `<section class="col on"><div class="cards">${
        shown.length ? sorted(shown).map((o) => cardHTML(o, true)).join('') : '<div class="empty">No leads match that search.</div>'
      }</div></section>`;
    } else {
      $('#board').innerHTML = stages.map((s) => {
        const list = sorted(shown.filter((o) => o.stageId === s.id));
        return `<section class="col${s.id === state.stage ? ' on' : ''}" data-stage="${esc(s.id)}">
          <div class="col-head"><span>${esc(s.name)}</span><span class="c">${list.length}</span></div>
          <div class="cards">${list.length ? list.map((o) => cardHTML(o)).join('') : '<div class="empty">No leads here yet.</div>'}</div>
        </section>`;
      }).join('');
    }

    $('#synced').textContent = `Live from your pipeline · updated ${new Date(state.lastFetch).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    if (state.openId) renderSheet();
  }

  DESKTOP.addEventListener('change', () => { render(); if (state.view === 'calendar') renderCalendar(); });

  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.stage = chip.dataset.stage;
    if (state.query) { state.query = ''; $('#search').value = ''; }
    render();
  });

  $('#search').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });

  $('#board').addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;
    const card = e.target.closest('.card');
    if (card) openSheet(card.dataset.id);
  });
  $('#board').addEventListener('keydown', (e) => {
    const card = e.target.closest('.card');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSheet(card.dataset.id); }
  });

  /* drag & drop between columns (desktop) */
  let dragId = null;
  $('#board').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  $('#board').addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.dragging,.drop').forEach((el) => el.classList.remove('dragging', 'drop'));
  });
  $('#board').addEventListener('dragover', (e) => {
    const col = e.target.closest('.col');
    if (!col || !dragId) return;
    e.preventDefault();
    document.querySelectorAll('.col.drop').forEach((c) => c !== col && c.classList.remove('drop'));
    col.classList.add('drop');
  });
  $('#board').addEventListener('drop', (e) => {
    const col = e.target.closest('.col');
    if (!col || !dragId) return;
    e.preventDefault();
    const id = dragId;
    col.classList.remove('drop');
    moveTo(id, col.dataset.stage);
  });

  /* ---------------- updates ---------------- */

  const findOpp = (id) => state.board && state.board.opportunities.find((o) => o.id === id);

  // "Closed", "Job Closed", "Won", "Job Booked"… but never "Lost".
  const isClosedStage = (st) => !!st && /\b(closed|won|booked)\b/i.test(st.name) && !/lost/i.test(st.name);

  async function moveTo(id, stageId) {
    const o = findOpp(id);
    if (!o || o.stageId === stageId) return;
    const prev = o.stageId;
    const stage = state.board.pipeline.stages.find((s) => s.id === stageId);
    o.stageId = stageId;
    o._saving = true;
    render();
    try {
      const r = await api('update', { id, stageId });
      Object.assign(o, { stageId: r.opportunity.stageId || stageId, stageChangedAt: new Date().toISOString() });
      toast(`Moved to ${stage ? stage.name : 'new stage'}`);
      if (isClosedStage(stage) && !nextBooking(id)) {
        setTimeout(() => openBookingForm({ oppId: id, lockLead: true, closing: true }), 150);
      }
    } catch (ex) {
      o.stageId = prev;
      toast(ex.message, true);
    } finally {
      delete o._saving;
      render();
    }
  }

  async function saveValue(id, raw) {
    const o = findOpp(id);
    if (!o) return;
    const v = Number(String(raw).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(v)) { toast('Enter a dollar amount.', true); return; }
    try {
      const r = await api('update', { id, value: v });
      o.value = r.opportunity.value;
      toast(`Job value saved: ${money(o.value)}`);
      render();
    } catch (ex) { toast(ex.message, true); }
  }

  async function loadNotes(id) {
    state.notes[id] = { loading: true, list: [] };
    renderNotes(id);
    try {
      const r = await api(`notes?id=${encodeURIComponent(id)}`);
      state.notes[id] = { list: r.notes || [] };
    } catch (ex) {
      state.notes[id] = { error: ex.message, list: [] };
    }
    renderNotes(id);
  }

  function renderNotes(id) {
    const ul = $('#notesList');
    if (!ul || state.openId !== id) return;
    const n = state.notes[id] || { list: [] };
    if (n.loading) { ul.innerHTML = '<li class="loading">Loading notes…</li>'; return; }
    if (n.error) { ul.innerHTML = `<li class="none">${esc(n.error)}</li>`; return; }
    ul.innerHTML = n.list.length
      ? n.list.map((x) => `<li><time>${esc(fullDate(x.at))}</time>${esc(x.body)}</li>`).join('')
      : '<li class="none">No notes yet.</li>';
  }

  /* ---------------- lead sheet ---------------- */

  function openSheet(id) {
    if (!findOpp(id)) return;
    state.openId = id;
    renderSheet(true);
    $('#scrim').hidden = false;
    $('#sheet').hidden = false;
    $('#sheet').scrollTop = 0;
    if (!(history.state && history.state.sheet)) history.pushState({ sheet: 1 }, '');
    loadNotes(id);
  }

  function closeSheet(fromPop) {
    if (!state.openId) return;
    state.openId = null;
    $('#scrim').hidden = true;
    $('#sheet').hidden = true;
    if (fromPop !== true && history.state && history.state.sheet) backQuietly();
  }

  function renderSheet(full) {
    const o = findOpp(state.openId);
    if (!o) { closeSheet(); return; }
    const stages = state.board.pipeline.stages;
    const stage = stages.find((s) => s.id === o.stageId) || {};
    const c = o.contact;
    const stageButtons = stages.map((s) => {
      const cur = s.id === o.stageId;
      return `<button class="stage-btn${cur ? ' cur' : ''}" type="button" data-move="${esc(s.id)}"${o._saving ? ' disabled' : ''}>
        <span class="dot"></span>${esc(s.name)}${cur ? icon('check', 'tick') : ''}</button>`;
    }).join('');

    if (!full && $('#sheetStages')) {
      // Light refresh: keep what the person is typing in value/notes.
      $('#sheetStages').innerHTML = stageButtons;
      $('#sheetSub').textContent = subLine(o, stage);
      renderSheetBookings(o);
      renderMetaPick(o);
      return;
    }

    $('#sheetBody').innerHTML = `
      <h2 id="sheetName">${esc(o.name)}</h2>
      <p class="sub" id="sheetSub">${esc(subLine(o, stage))}</p>
      <div class="actions">
        <a class="act${c.phone ? '' : ' off'}" href="${c.phone ? `tel:${esc(c.phone)}` : '#'}">${icon('phone')}Call</a>
        <a class="act${c.phone ? '' : ' off'}" href="${c.phone ? `sms:${esc(c.phone)}` : '#'}">${icon('sms')}Text</a>
        <a class="act${c.email ? '' : ' off'}" href="${c.email ? `mailto:${esc(c.email)}` : '#'}">${icon('mail')}Email</a>
      </div>
      ${(c.phone || c.email) ? `<p class="contact-line">${esc([phonePretty(c.phone), c.email].filter(Boolean).join(' · '))}</p>` : ''}

      <div class="sec"><h3>Did this lead come from Meta?</h3><div id="metaPick"></div></div>

      <div class="sec"><h3>Move to stage</h3><div class="stages" id="sheetStages">${stageButtons}</div>
        <div class="sheet-bk" id="sheetBk"></div></div>

      <div class="sec"><h3>Job value</h3>
        <form class="money" id="valueForm">
          <label><input id="valueInput" inputmode="decimal" placeholder="0" value="${o.value ? esc(o.value) : ''}" aria-label="Job value in dollars"></label>
          <button class="btn sm ghost" type="submit">Save</button>
        </form>
      </div>

      <div class="sec"><h3>Notes</h3>
        <form class="note-form" id="noteForm">
          <textarea id="noteInput" placeholder="Called, left a voicemail… booked for Tuesday…" maxlength="2000" aria-label="New note"></textarea>
          <button class="btn sm" type="submit">Add note</button>
        </form>
        <ul class="notes" id="notesList"></ul>
      </div>

      <div class="sec"><h3>Details</h3>
        <dl class="detail">
          ${c.company ? `<dt>Company</dt><dd>${esc(c.company)}</dd>` : ''}
          <dt>Source</dt><dd>${esc(o.source || '—')}</dd>
          <dt>Came in</dt><dd>${esc(fullDate(o.createdAt))}</dd>
          <dt>Last moved</dt><dd>${esc(fullDate(o.stageChangedAt))}</dd>
        </dl>
      </div>

      <div class="sec remove-sec" id="removeSec">${removeBlock(false)}</div>`;
    renderNotes(o.id);
    renderSheetBookings(o);
    renderMetaPick(o);
  }

  const isMeta = (o) => !!o && (o.meta === 'yes' || o.meta === 'auto');

  const REMOVE_REASONS = ['Spam or fake', 'Duplicate', 'Wrong number', 'Not interested', 'Outside service area', 'Other'];
  let removeReason = '';
  function removeBlock(open) {
    if (!open) return `<button class="btn ghost danger" type="button" data-remove="open">${icon('x')}Remove lead</button>`;
    return `<h3>Remove this lead?</h3>
      <p class="hint">It's deleted from your pipeline. LeadThru still keeps the contact and your reason.</p>
      <div class="quick">${REMOVE_REASONS.map((r) => `<button type="button" class="qchip${r === removeReason ? ' on' : ''}" data-remove-why="${esc(r)}">${esc(r)}</button>`).join('')}</div>
      <div class="remove-acts">
        <button class="btn ghost" type="button" data-remove="cancel">Keep lead</button>
        <button class="btn danger-solid" type="button" data-remove="go"${removeReason ? '' : ' disabled'}>Remove lead</button>
      </div>`;
  }

  async function removeLead(id) {
    const o = findOpp(id);
    if (!o || !removeReason) return;
    const btn = document.querySelector('[data-remove="go"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    try {
      await api('remove', { id, reason: removeReason });
      state.board.opportunities = state.board.opportunities.filter((x) => x.id !== id);
      closeSheet();
      render();
      toast(`${o.name} removed`);
    } catch (ex) {
      toast(ex.message, true);
      if (btn) { btn.disabled = false; btn.textContent = 'Remove lead'; }
    }
  }

  function renderMetaPick(o) {
    const box = $('#metaPick');
    if (!box || !o) return;
    const yes = isMeta(o);
    const no = o.meta === 'no';
    const hint = {
      auto: 'Marked automatically from the Facebook / Instagram ad form. Tap to change.',
      yes: 'Marked as a Meta lead.',
      no: 'Marked as not from Meta.',
      unknown: 'Not marked yet.',
    }[o.meta || 'unknown'];
    box.innerHTML = `<div class="meta-pick">
        <button type="button" data-meta="yes" class="${yes ? 'on' : ''}"${o._metaSaving ? ' disabled' : ''}>${icon('check')}From Meta</button>
        <button type="button" data-meta="no" class="${no ? 'on no' : ''}"${o._metaSaving ? ' disabled' : ''}>${icon('x')}Not from Meta</button>
      </div><p class="hint">${esc(hint)}</p>`;
  }

  async function setMeta(id, meta) {
    const o = findOpp(id);
    if (!o || o._metaSaving || o.meta === meta) return;
    const prev = o.meta;
    o.meta = meta;
    o._metaSaving = true;
    render();
    try {
      await api('meta', { id, meta });
      toast(meta === 'yes' ? 'Marked as a Meta lead' : 'Marked as not from Meta');
    } catch (ex) {
      o.meta = prev;
      toast(ex.message, true);
    } finally {
      delete o._metaSaving;
      render();
      if (state.openId === id) renderMetaPick(o);
    }
  }

  function renderSheetBookings(o) {
    const box = $('#sheetBk');
    if (!box || !o || !o.id) return;
    const list = bookingsFor(o.id);
    box.innerHTML = list.map((b) => bkCard(b, true)).join('')
      + `<button class="btn sm book-btn" type="button" data-book="${esc(o.id)}">${icon('cal')}${list.length ? 'Book another appointment' : 'Book appointment'}</button>`
      + quotesForLead(o.id).map((v) => `<button type="button" class="lead-doc" data-qopen="${esc(v.id)}">${icon('doc')}<span>Quote ${esc(v.number)} · ${esc(money2f(v.totals.total))}</span>${statusPill(v)}</button>`).join('')
      + `<button class="btn sm ghost quote-btn" type="button" data-quote="${esc(o.id)}">${icon('doc')}Create quote</button>`;
  }

  function subLine(o, stage) {
    return [stage.name, o.createdAt && `came in ${ago(o.createdAt)}`, o.source].filter(Boolean).join(' · ');
  }

  $('#sheetBody').addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;
    const b = e.target.closest('[data-move]');
    if (b && state.openId) { moveTo(state.openId, b.dataset.move); return; }
    const rm = e.target.closest('[data-remove]');
    if (rm && state.openId) {
      const a = rm.dataset.remove;
      if (a === 'go') { removeLead(state.openId); return; }
      removeReason = '';
      $('#removeSec').innerHTML = removeBlock(a === 'open');
      if (a === 'open') $('#removeSec').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const why = e.target.closest('[data-remove-why]');
    if (why) { removeReason = why.dataset.removeWhy; $('#removeSec').innerHTML = removeBlock(true); return; }
    const mt = e.target.closest('[data-meta]');
    if (mt && state.openId) { setMeta(state.openId, mt.dataset.meta); return; }
    const qb = e.target.closest('[data-quote]');
    if (qb) { openInvoiceEditor({ kind: 'quote', lead: findOpp(qb.dataset.quote) }); return; }
    const qo = e.target.closest('[data-qopen]');
    if (qo) { openInvoiceView(qo.dataset.qopen, 'quote'); return; }
    const book = e.target.closest('[data-book]');
    if (book) { openBookingForm({ oppId: book.dataset.book, lockLead: true }); return; }
    const card = e.target.closest('[data-bk]');
    if (card) openBookingView(card.dataset.bk);
  });
  $('#sheetBody').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = state.openId;
    if (!id) return;
    if (e.target.id === 'valueForm') {
      saveValue(id, $('#valueInput').value);
    } else if (e.target.id === 'noteForm') {
      const input = $('#noteInput');
      const text = input.value.trim();
      if (!text) return;
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        const r = await api('notes', { id, body: text });
        const n = state.notes[id] || { list: [] };
        n.list = [r.note, ...(n.list || [])];
        state.notes[id] = { list: n.list };
        input.value = '';
        renderNotes(id);
        toast('Note added');
      } catch (ex) { toast(ex.message, true); } finally { btn.disabled = false; }
    }
  });
  $('#sheetClose').addEventListener('click', closeSheet);
  function closeTop(fromPop) {
    if (invp.open) closeInvPanel(fromPop);
    else if (booker.open) closeBooker(fromPop);
    else if (editor.open) closeEditor(fromPop);
    else closeSheet(fromPop);
  }
  $('#scrim').addEventListener('click', () => (editor.open ? closeEditor() : closeSheet()));
  window.addEventListener('popstate', () => { if (skipPop) { skipPop--; return; } closeTop(true); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTop(); });

  /* ---------------- calendar: booked appointments ---------------- */

  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fromDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const utcMonth = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtDayLong = (d) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtLen = (m) => (m >= 60 ? `${Number.isInteger(m / 60) ? m / 60 : (m / 60).toFixed(1)}h` : `${m}m`);
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } };
  const LENGTHS = [[30, '30 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'], [480, 'Full day']];
  const KINDS = ['Estimate', 'Job', 'Follow-up', 'Site visit'];

  function shortWhen(b) {
    const d = new Date(b.start);
    const today = dayKey(new Date());
    const tomorrow = dayKey(new Date(Date.now() + 864e5));
    const k = dayKey(d);
    const day = k === today ? 'Today' : k === tomorrow ? 'Tomorrow' : fmtDay(d);
    return `${day} ${fmtTime(d)}`;
  }

  const allBookings = () => [...state.bk.map.values()].sort((a, b) => a.start.localeCompare(b.start));
  // Jobs (not estimates or follow-ups) that have ended in the last 2 weeks and aren't marked done.
  const isJobBooking = (b) => !/estimate|quote|follow|site visit|consult|call back|callback/i.test(b.title || '');
  const toWrapUp = () => allBookings().filter((b) => isJobBooking(b) && !b.completedAt
    && new Date(b.end) < new Date() && Date.now() - new Date(b.end) < 14 * 864e5);

  function renderWrapUp() {
    const list = toWrapUp();
    const html = list.length ? `<div class="wrapup">
        <div class="wrapup-h">${icon('check')}<b>${list.length === 1 ? '1 job to wrap up' : `${list.length} jobs to wrap up`}</b>
          <span>Mark it done to send the review request.</span></div>
        ${list.slice(0, 5).map((b) => `<button type="button" class="wrapup-row" data-wrap="${esc(b.id)}">
          <span><b>${esc(b.lead.name)}</b> · ${esc(b.title)} · ${esc(shortWhen(b))}</span><em>Mark done</em></button>`).join('')}
      </div>` : '';
    document.querySelectorAll('.wrapup-slot').forEach((el) => { el.innerHTML = html; });
  }
  const bookingsFor = (oppId) => allBookings().filter((b) => b.oppId === oppId && new Date(b.end) > new Date(Date.now() - 864e5));
  const nextBooking = (oppId) => allBookings().find((b) => b.oppId === oppId && new Date(b.end) > new Date());

  // This device's own recent changes, laid over what the server lists (storage can lag a few minutes).
  const bkKey = (pid) => `lt_bk_${pid}`;
  function bkPending(pid) {
    try { return JSON.parse(localStorage.getItem(bkKey(pid)) || '[]').filter((x) => Date.now() - x.at < 10 * 60e3); } catch { return []; }
  }
  function rememberBooking(pid, id, rec) {
    const list = bkPending(pid).filter((x) => x.id !== id);
    list.push({ id, rec, at: Date.now() });
    try { localStorage.setItem(bkKey(pid), JSON.stringify(list)); } catch { /* private mode */ }
  }

  function neededMonths() {
    const set = new Set();
    const now = new Date();
    for (let k = -1; k <= 2; k++) set.add(utcMonth(now.getFullYear(), now.getMonth() + k));
    const cm = state.cal.month || now;
    for (let k = -1; k <= 1; k++) set.add(utcMonth(cm.getFullYear(), cm.getMonth() + k));
    return [...set];
  }

  async function loadBookings(force) {
    const pid = state.board && state.board.pipeline.id;
    if (!pid) return;
    if (state.bk.pid !== pid) state.bk = { pid, months: new Set(), map: new Map() };
    const want = neededMonths().filter((m) => force || !state.bk.months.has(m));
    if (want.length) {
      try {
        const q = `bookings?months=${want.join(',')}${state.me.admin ? `&pipeline=${encodeURIComponent(pid)}` : ''}`;
        const r = await api(q);
        if (state.bk.pid !== pid) return;
        for (const [id, b] of state.bk.map) if (want.includes(b.month)) state.bk.map.delete(id);
        for (const b of r.bookings) state.bk.map.set(b.id, b);
        want.forEach((m) => state.bk.months.add(m));
      } catch (ex) {
        if (state.view === 'calendar' && !force) toast(ex.message, true);
      }
    }
    for (const x of bkPending(pid)) { if (x.rec) state.bk.map.set(x.id, x.rec); else state.bk.map.delete(x.id); }
    afterBookingsChange();
  }

  function afterBookingsChange() {
    renderWrapUp();
    const now = Date.now();
    const soon = allBookings().filter((b) => new Date(b.end) > now && new Date(b.start) - now < 7 * 864e5).length;
    const c = $('#calCount');
    c.textContent = soon;
    c.hidden = !soon;
    if (state.view === 'calendar') renderCalendar();
    if (state.view === 'home') renderHome();
    if (state.board && state.view === 'leads') render();
    else if (state.openId) renderSheetBookings(findOpp(state.openId) || {});
    if (booker.open && booker.mode === 'view') renderBookingView();
  }

  function bkCard(b, withDate) {
    const s = new Date(b.start);
    const past = new Date(b.end) < new Date();
    const where = [b.amount > 0 && money(b.amount), b.address || phonePretty(b.lead.phone)].filter(Boolean).join(' · ');
    return `<div class="bk-card${past ? ' past' : ''}${b.completedAt ? ' done' : ''}" role="button" tabindex="0" data-bk="${esc(b.id)}">
      <div class="bk-time"><b>${esc(fmtTime(s))}</b><span>${esc(withDate ? fmtDay(s) : fmtLen(b.minutes))}</span></div>
      <div class="bk-main"><div class="bk-title">${b.completedAt ? icon('check', 'done-i') : ''}${esc(b.title)} · ${esc(b.lead.name)}</div>
        <div class="bk-meta">${esc([withDate ? fmtLen(b.minutes) : '', where].filter(Boolean).join(' · '))}</div></div>
      ${b.lead.phone ? `<a class="call" href="tel:${esc(b.lead.phone)}" aria-label="Call ${esc(b.lead.name)}" data-stop>${icon('phone')}</a>` : ''}
    </div>`;
  }

  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const startOfWeek = (d) => addDays(d, -d.getDay());
  const fmtMD = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  function weekTitle(ws) {
    const we = addDays(ws, 6);
    const end = we.getMonth() === ws.getMonth() ? we.getDate() : fmtMD(we);
    return `${fmtMD(ws)} – ${end}`;
  }

  function bookingsByDay() {
    const byDay = new Map();
    for (const b of allBookings()) {
      const k = dayKey(new Date(b.start));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(b);
    }
    return byDay;
  }

  // Revenue = prices on appointments that start in the period; "from Meta" = leads marked/auto Meta.
  function revenue(from, to) {
    let total = 0; let meta = 0; let jobs = 0;
    for (const b of allBookings()) {
      const s = new Date(b.start);
      if (s < from || s >= to || !(b.amount > 0)) continue;
      total += b.amount;
      jobs++;
      if (isMeta(findOpp(b.oppId))) meta += b.amount;
    }
    return { total, meta, jobs };
  }

  function revTile(label, r) {
    const sub = r.jobs
      ? `${r.jobs} priced ${r.jobs === 1 ? 'job' : 'jobs'}${r.meta ? ` · ${money(r.meta)} from Meta` : ''}`
      : 'No priced jobs yet';
    return `<div class="rev-tile"><span class="l">${esc(label)}</span><b>${esc(money(r.total))}</b><span class="s">${esc(sub)}</span></div>`;
  }

  function monthBody(m, byDay, today) {
    const now = new Date();
    const lead = new Date(m.getFullYear(), m.getMonth(), 1).getDay();
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const wd = Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
    let cells = '<span class="cal-blank"></span>'.repeat(lead);
    for (let d = 1; d <= days; d++) {
      const k = dayKey(new Date(m.getFullYear(), m.getMonth(), d));
      const n = (byDay.get(k) || []).length;
      const cls = ['cal-day', k === today && 'today', k === state.cal.day && 'sel', k < today && 'past'].filter(Boolean).join(' ');
      cells += `<button type="button" class="${cls}" data-day="${k}" aria-label="${esc(fmtDayLong(fromDayKey(k)))}${n ? `, ${n} booked` : ''}">
        ${d}<span class="dots">${'<i></i>'.repeat(Math.min(n, 3))}</span></button>`;
    }
    const sel = fromDayKey(state.cal.day);
    const dayList = byDay.get(state.cal.day) || [];
    const after = addDays(sel, 1);
    const upcoming = allBookings().filter((b) => new Date(b.start) >= after && new Date(b.start) >= now).slice(0, 8);
    const thisMonth = m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth();
    return `
      <div class="cal-layout">
        <div class="cal-month">
          <div class="cal-wd">${wd.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
          <div class="cal-grid">${cells}</div>
          ${thisMonth && state.cal.day === today ? '' : '<button class="cal-today" type="button" data-cal="today">Back to today</button>'}
        </div>
        <div class="cal-agenda">
          <h3>${state.cal.day === today ? 'Today · ' : ''}${esc(fmtDayLong(sel))}</h3>
          <div class="bk-list">${dayList.length ? dayList.map((b) => bkCard(b)).join('')
            : `<div class="bk-empty">Nothing booked${state.cal.day < today ? '' : `<button class="btn sm ghost" type="button" data-cal="bookday">${icon('plus')}Book this day</button>`}</div>`}</div>
          <h3>Coming up</h3>
          <div class="bk-list">${upcoming.length ? upcoming.map((b) => bkCard(b, true)).join('')
            : '<div class="bk-empty">No other appointments booked yet.</div>'}</div>
        </div>
      </div>`;
  }

  // Phone: the week as a list of days.
  function weekList(ws, byDay, today) {
    return `<div class="wk-list">${Array.from({ length: 7 }, (_, i) => {
      const d = addDays(ws, i);
      const k = dayKey(d);
      const list = byDay.get(k) || [];
      const dayRev = list.reduce((t, b) => t + (b.amount || 0), 0);
      return `<section class="wk-day${k === today ? ' today' : ''}${k < today ? ' past' : ''}">
        <div class="wk-dh"><b>${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</b><span>${esc(fmtMD(d))}</span>
          ${dayRev ? `<em>${esc(money(dayRev))}</em>` : ''}
          ${k >= today ? `<button class="icon-btn small" type="button" data-cal="bookon" data-on="${k}" aria-label="Book ${esc(fmtDayLong(d))}">${icon('plus')}</button>` : ''}</div>
        ${list.length ? `<div class="bk-list">${list.map((b) => bkCard(b)).join('')}</div>` : '<p class="wk-none">Nothing booked</p>'}
      </section>`;
    }).join('')}</div>`;
  }

  // Desktop: the week as an hourly grid. Click an empty slot to book it.
  const HOUR_PX = 48;
  function weekGrid(ws, byDay, today) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    let lo = 7; let hi = 19;
    for (const d of days) {
      for (const b of byDay.get(dayKey(d)) || []) {
        const s = new Date(b.start); const e = new Date(b.end);
        lo = Math.min(lo, s.getHours());
        hi = Math.max(hi, dayKey(e) !== dayKey(s) ? 24 : e.getHours() + (e.getMinutes() ? 1 : 0));
      }
    }
    const hours = Array.from({ length: hi - lo }, (_, i) => lo + i);
    const hourLabel = (h) => new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
    const cols = days.map((d) => {
      const k = dayKey(d);
      const list = (byDay.get(k) || []).slice().sort((a, b) => a.start.localeCompare(b.start));
      const lanes = [];
      const placed = list.map((b) => {
        const st = +new Date(b.start); const en = +new Date(b.end);
        let lane = lanes.findIndex((end) => end <= st);
        if (lane < 0) { lane = lanes.length; lanes.push(en); } else lanes[lane] = en;
        return { b, lane };
      });
      const n = Math.max(1, lanes.length);
      const blocks = placed.map(({ b, lane }) => {
        const s = new Date(b.start);
        const top = (((s.getHours() - lo) * 60 + s.getMinutes()) / 60) * HOUR_PX;
        const h = Math.max((b.minutes / 60) * HOUR_PX - 2, 22);
        return `<div class="wk-ev${new Date(b.end) < new Date() ? ' past' : ''}" role="button" tabindex="0" data-bk="${esc(b.id)}"
          style="top:${top}px;height:${h}px;left:calc(${(lane * 100) / n}% + 2px);width:calc(${100 / n}% - 4px)">
          <b>${esc(fmtTime(s))}</b> ${esc(b.title)} · ${esc(b.lead.name)}${b.amount > 0 ? ` <i>${esc(money(b.amount))}</i>` : ''}</div>`;
      }).join('');
      const dayRev = list.reduce((t, b) => t + (b.amount || 0), 0);
      return `<div class="wk-col${k === today ? ' today' : ''}${k < today ? ' past' : ''}">
        <div class="wk-head"><span>${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</span><b>${d.getDate()}</b>${dayRev ? `<em>${esc(money(dayRev))}</em>` : ''}</div>
        <div class="wk-body" data-slot="${k}" style="height:${hours.length * HOUR_PX}px">${hours.map(() => '<div class="wk-hr"></div>').join('')}${blocks}</div>
      </div>`;
    }).join('');
    return `<div class="wk-grid" data-lo="${lo}">
      <div class="wk-times"><div class="wk-head"></div>${hours.map((h) => `<div class="wk-t">${esc(hourLabel(h))}</div>`).join('')}</div>${cols}</div>`;
  }

  function renderCalendar() {
    const now = new Date();
    if (!state.cal.month) state.cal.month = new Date(now.getFullYear(), now.getMonth(), 1);
    if (!state.cal.day) state.cal.day = dayKey(now);
    if (!state.cal.mode) state.cal.mode = store.get('lt_calmode') === 'week' ? 'week' : 'month';
    const week = state.cal.mode === 'week';
    const today = dayKey(now);
    const sel = fromDayKey(state.cal.day);
    const ws = startOfWeek(sel);
    if (week) state.cal.month = new Date(sel.getFullYear(), sel.getMonth(), 1);
    const m = state.cal.month;
    const byDay = bookingsByDay();
    const thisWeek = dayKey(ws) === dayKey(startOfWeek(now));
    const thisMonth = m.getFullYear() === now.getFullYear() && m.getMonth() === now.getMonth();
    const title = week ? weekTitle(ws) : m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    let body;
    if (!week) body = monthBody(m, byDay, today);
    else {
      body = DESKTOP.matches ? weekGrid(ws, byDay, today) : weekList(ws, byDay, today);
      if (!thisWeek) body = `<button class="cal-today" type="button" data-cal="today">Back to this week</button>${body}`;
    }
    $('#calView').innerHTML = `
      <div class="cal-top">
        <div class="cal-nav">
          <button class="icon-btn prev" type="button" data-cal="prev" aria-label="Previous ${week ? 'week' : 'month'}">${icon('next')}</button>
          <h2>${esc(title)}</h2>
          <button class="icon-btn" type="button" data-cal="next" aria-label="Next ${week ? 'week' : 'month'}">${icon('next')}</button>
        </div>
        <div class="cal-tools">
          <div class="seg cal-mode" role="group" aria-label="Calendar view">
            <button type="button" data-mode="month" class="${week ? '' : 'on'}">Month</button><button type="button" data-mode="week" class="${week ? 'on' : ''}">Week</button>
          </div>
          <button class="btn sm" type="button" data-cal="book">${icon('plus')}Book</button>
        </div>
      </div>
      <div class="wrapup-slot"></div>
      <div class="rev">
        ${revTile(thisWeek ? 'This week' : `Week of ${fmtMD(ws)}`, revenue(ws, addDays(ws, 7)))}
        ${revTile(thisMonth ? 'This month' : m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), revenue(m, new Date(m.getFullYear(), m.getMonth() + 1, 1)))}
      </div>
      ${body}`;
    renderWrapUp();
  }

  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-wrap]');
    if (row) openBookingView(row.dataset.wrap);
  });

  $('#tabs').addEventListener('click', (e) => {
    const bt = e.target.closest('button[data-view]');
    if (bt && bt.dataset.view !== state.view) showView(bt.dataset.view);
  });

  $('#calView').addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;
    const mode = e.target.closest('[data-mode]');
    if (mode) {
      state.cal.mode = mode.dataset.mode;
      store.set('lt_calmode', state.cal.mode);
      renderCalendar();
      loadBookings();
      return;
    }
    const act = e.target.closest('[data-cal]');
    if (act) {
      const week = state.cal.mode === 'week';
      const a = act.dataset.cal;
      if (a === 'prev' || a === 'next') {
        const dir = a === 'next' ? 1 : -1;
        if (week) {
          const d = addDays(fromDayKey(state.cal.day), 7 * dir);
          state.cal.day = dayKey(d);
          state.cal.month = new Date(d.getFullYear(), d.getMonth(), 1);
        } else {
          const m = state.cal.month;
          state.cal.month = new Date(m.getFullYear(), m.getMonth() + dir, 1);
        }
        renderCalendar();
        loadBookings();
      } else if (a === 'today') {
        const n = new Date();
        state.cal.month = new Date(n.getFullYear(), n.getMonth(), 1);
        state.cal.day = dayKey(n);
        renderCalendar();
        loadBookings();
      } else if (a === 'book') {
        openBookingForm({ day: state.cal.day >= dayKey(new Date()) ? state.cal.day : null });
      } else if (a === 'bookday') {
        openBookingForm({ day: state.cal.day });
      } else if (a === 'bookon') {
        openBookingForm({ day: act.dataset.on });
      }
      return;
    }
    const day = e.target.closest('[data-day]');
    if (day) { state.cal.day = day.dataset.day; renderCalendar(); return; }
    const card = e.target.closest('[data-bk]');
    if (card) { openBookingView(card.dataset.bk); return; }
    const slot = e.target.closest('[data-slot]');
    if (slot && slot.dataset.slot >= dayKey(new Date())) {
      const lo = Number(slot.closest('.wk-grid').dataset.lo);
      const y = e.clientY - slot.getBoundingClientRect().top;
      const mins = Math.max(0, Math.round(((y / HOUR_PX) * 60) / 30) * 30);
      const h = Math.min(23, lo + Math.floor(mins / 60));
      openBookingForm({ day: slot.dataset.slot, time: `${pad2(h)}:${pad2(mins % 60)}` });
    }
  });
  $('#calView').addEventListener('keydown', (e) => {
    const card = e.target.closest('[data-bk]');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openBookingView(card.dataset.bk); }
  });

  /* ---- booking panel: book / view / edit / cancel ---- */

  const booker = { open: false, mode: null, draft: null, id: null, busy: false, fresh: false };

  function showBooker() {
    booker.open = true;
    $('#bkScrim').hidden = false;
    $('#booker').hidden = false;
    $('#booker').scrollTop = 0;
    if (!(history.state && history.state.booker)) history.pushState({ booker: 1 }, '');
  }

  function closeBooker(fromPop) {
    if (!booker.open) return;
    booker.open = false;
    booker.draft = null;
    $('#bkScrim').hidden = true;
    $('#booker').hidden = true;
    if (fromPop !== true && history.state && history.state.booker) backQuietly();
  }
  $('#bookerClose').addEventListener('click', () => closeBooker());
  $('#bkScrim').addEventListener('click', () => closeBooker());

  function openBookingForm({ oppId = '', lockLead = false, day = null, time = null, edit = null, closing = false } = {}) {
    if (!state.board) return;
    const tomorrow = dayKey(new Date(Date.now() + 864e5));
    let draft;
    if (edit) {
      const s = new Date(edit.start);
      draft = {
        id: edit.id, month: edit.month, oppId: edit.oppId, lockLead: true, title: edit.title,
        date: dayKey(s), time: `${pad2(s.getHours())}:${pad2(s.getMinutes())}`, minutes: edit.minutes,
        address: edit.address, notes: edit.notes, stageId: '', amount: edit.amount || '', setValue: false,
        manual: !edit.oppId, lead: { ...edit.lead },
      };
    } else {
      const lead = oppId ? findOpp(oppId) : null;
      draft = {
        id: null, month: null, oppId, lockLead, title: closing ? 'Job' : 'Estimate', date: day || tomorrow, time: time || '09:00',
        minutes: closing ? 120 : 60, address: '', notes: '', stageId: '',
        amount: closing && lead && lead.value > 0 ? String(lead.value) : '', setValue: true, closing,
        manual: false, lead: { name: '', phone: '', email: '' },
      };
    }
    booker.mode = 'form';
    booker.draft = draft;
    renderBookingForm();
    showBooker();
  }

  function renderBookingForm() {
    const dr = booker.draft;
    const o = dr.oppId ? findOpp(dr.oppId) : null;
    const stages = state.board.pipeline.stages;
    const cur = o && stages.find((s) => s.id === o.stageId);
    const leads = state.board.opportunities.slice().sort((a, b) => a.name.localeCompare(b.name));
    const lenOpts = LENGTHS.some(([v]) => v === dr.minutes) ? LENGTHS : [...LENGTHS, [dr.minutes, fmtLen(dr.minutes)]];
    $('#bookerBody').innerHTML = `
      <h2 id="bookerTitle">${dr.id ? 'Edit appointment' : dr.closing ? 'Schedule the job' : 'Book appointment'}</h2>
      <p class="sub">${dr.closing
        ? `${esc(o ? o.name : 'This lead')} is closed. Add the job date and price so it shows in your calendar and revenue.`
        : dr.manual ? "Someone who isn't in your leads. Their details stay in your calendar only."
          : o && dr.lockLead ? esc(o.name) : 'Pick the lead, then the time.'}</p>
      <form class="cf" id="bkForm" novalidate>
        ${dr.manual ? `<div class="field"><span>Customer</span>
            <input id="bkName" maxlength="80" autocomplete="name" placeholder="Full name" value="${esc(dr.lead.name)}" aria-label="Customer name">
            <div class="row2 manual-row">
              <input id="bkPhone" type="tel" maxlength="30" autocomplete="tel" placeholder="Phone" value="${esc(dr.lead.phone)}" aria-label="Customer phone">
              <input id="bkEmail" type="email" maxlength="120" autocomplete="email" placeholder="Email (optional)" value="${esc(dr.lead.email)}" aria-label="Customer email">
            </div>
            ${dr.id ? '' : `<button type="button" class="link-btn" id="bkPickLead">${icon('back')}Pick from my leads instead</button>`}</div>`
        : dr.lockLead && o ? '' : `<label class="field"><span>Lead</span><select id="bkLead">
          <option value="">Choose a lead…</option>${leads.map((l) => `<option value="${esc(l.id)}"${l.id === dr.oppId ? ' selected' : ''}>${
            esc(l.name)}${l.contact.phone ? ` · ${esc(phonePretty(l.contact.phone))}` : ''}</option>`).join('')}</select></label>
          <button type="button" class="btn sm ghost manual-btn" id="bkManual">${icon('plus')}Book someone who isn't in your leads</button>`}
        <div class="field"><span>What</span>
          <div class="quick">${KINDS.map((k) => `<button type="button" class="qchip${k === dr.title ? ' on' : ''}" data-kind="${esc(k)}">${esc(k)}</button>`).join('')}</div>
          <input id="bkTitle" maxlength="60" value="${esc(dr.title)}" aria-label="What is booked"></div>
        <div class="row2">
          <label class="field"><span>Date</span><input id="bkDate" type="date" value="${esc(dr.date)}" required></label>
          <label class="field"><span>Start time</span><input id="bkTime" type="time" step="900" value="${esc(dr.time)}" required></label>
        </div>
        <label class="field"><span>How long</span><select id="bkLen">${lenOpts.map(([v, l]) => `<option value="${v}"${v === dr.minutes ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div class="field"><span>Price (optional)</span>
          <div class="price"><input id="bkAmount" inputmode="decimal" placeholder="0" value="${esc(dr.amount)}" aria-label="Price in dollars"></div>
          <span class="hint">Counts toward your weekly and monthly revenue.</span></div>
        ${dr.manual ? '' : `<label class="check"><input type="checkbox" id="bkSetValue"${dr.setValue ? ' checked' : ''}> Also save it as this lead's job value</label>`}
        <label class="field"><span>Address</span><input id="bkAddr" maxlength="200" autocomplete="street-address" value="${esc(dr.address)}" placeholder="Job address (optional)"></label>
        <label class="field"><span>Notes</span><textarea id="bkNotes" maxlength="1000" placeholder="Gate code, what to bring, who to ask for…">${esc(dr.notes)}</textarea></label>
        ${dr.manual ? '' : `<label class="field"><span>Move lead to</span><select id="bkStage">
          <option value="">${cur ? `Keep in ${esc(cur.name)}` : 'Keep the current stage'}</option>
          ${stages.filter((s) => !o || s.id !== o.stageId).map((s) => `<option value="${esc(s.id)}"${s.id === dr.stageId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select><span class="hint">Optional: update their stage in the same step.</span></label>`}
        <p class="err" id="bkErr" hidden></p>
        <button class="btn" type="submit" id="bkSave">${dr.id ? 'Save changes' : dr.closing ? 'Schedule job' : 'Book appointment'}</button>
        ${dr.closing ? '<button class="btn ghost" type="button" id="bkLater">Not now</button>' : ''}
      </form>`;
  }

  $('#bookerBody').addEventListener('input', (e) => {
    const dr = booker.draft;
    if (!dr || booker.mode !== 'form') return;
    const v = e.target.value;
    switch (e.target.id) {
      case 'bkTitle':
        dr.title = v;
        document.querySelectorAll('.qchip').forEach((q) => q.classList.toggle('on', q.dataset.kind === v.trim()));
        break;
      case 'bkDate': dr.date = v; break;
      case 'bkTime': dr.time = v; break;
      case 'bkAddr': dr.address = v; break;
      case 'bkNotes': dr.notes = v; break;
      case 'bkAmount': dr.amount = v; break;
      case 'bkName': dr.lead.name = v; break;
      case 'bkPhone': dr.lead.phone = v; break;
      case 'bkEmail': dr.lead.email = v; break;
      default: break;
    }
  });
  $('#bookerBody').addEventListener('change', (e) => {
    const dr = booker.draft;
    if (!dr || booker.mode !== 'form') return;
    if (e.target.id === 'bkLead') { dr.oppId = e.target.value; dr.stageId = ''; renderBookingForm(); }
    if (e.target.id === 'bkLen') dr.minutes = Number(e.target.value);
    if (e.target.id === 'bkStage') dr.stageId = e.target.value;
    if (e.target.id === 'bkSetValue') dr.setValue = e.target.checked;
  });

  $('#bookerBody').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dr = booker.draft;
    if (!dr || booker.busy) return;
    const err = $('#bkErr');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    err.hidden = true;
    if (dr.manual && !dr.lead.name.trim()) return fail("Add the customer's name.");
    if (!dr.manual && !dr.oppId) return fail('Choose which lead this is for, or book someone who isn\'t in your leads.');
    if (!dr.date || !dr.time) return fail('Pick a date and a start time.');
    const start = new Date(`${dr.date}T${dr.time}`);
    if (Number.isNaN(start.getTime())) return fail('That date or time does not look right.');
    const amount = Number(String(dr.amount || '').replace(/[^0-9.]/g, '')) || 0;
    const btn = $('#bkSave');
    booker.busy = true;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const pid = state.board.pipeline.id;
      const r = await api('bookings', {
        action: 'save', id: dr.id || undefined, month: dr.month || undefined, start: start.toISOString(),
        oppId: dr.manual ? undefined : dr.oppId,
        lead: dr.manual ? { name: dr.lead.name.trim(), phone: dr.lead.phone.trim(), email: dr.lead.email.trim() } : undefined,
        pipeline: pid,
        minutes: dr.minutes, title: dr.title.trim() || 'Appointment', address: dr.address.trim(), notes: dr.notes.trim(),
        stageId: dr.stageId || undefined, tz: tz(), amount, setValue: !!dr.setValue && amount > 0,
      });
      state.bk.map.set(r.booking.id, r.booking);
      rememberBooking(pid, r.booking.id, r.booking);
      if (r.opportunity) {
        const o = findOpp(dr.oppId);
        if (o) {
          if (o.stageId !== r.opportunity.stageId) o.stageChangedAt = new Date().toISOString();
          Object.assign(o, { stageId: r.opportunity.stageId, value: r.opportunity.value });
        }
      }
      const moved = r.opportunity && dr.stageId && r.opportunity.stageId === dr.stageId;
      const stageName = moved && (state.board.pipeline.stages.find((s) => s.id === r.opportunity.stageId) || {}).name;
      toast(`${dr.id ? 'Updated' : 'Booked'}: ${shortWhen(r.booking)}${stageName ? ` · moved to ${stageName}` : ''}`
        + (r.stageFailed ? ' (stage not updated, try again)' : ''), !!r.stageFailed);
      booker.fresh = !dr.id;
      openBookingView(r.booking.id, true);
      afterBookingsChange();
    } catch (ex) {
      fail(ex.message);
    } finally {
      booker.busy = false;
      if (booker.mode === 'form' && $('#bkSave')) {
        $('#bkSave').disabled = false;
        $('#bkSave').textContent = dr.id ? 'Save changes' : dr.closing ? 'Schedule job' : 'Book appointment';
      }
    }
  });

  const gcalDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  function googleLink(b) {
    const details = [b.lead.phone && `Phone: ${phonePretty(b.lead.phone)}`, b.notes].filter(Boolean).join('\n');
    const p = new URLSearchParams({
      action: 'TEMPLATE', text: `${b.title} · ${b.lead.name}`, dates: `${gcalDate(b.start)}/${gcalDate(b.end)}`, details, location: b.address || '',
    });
    return `https://calendar.google.com/calendar/render?${p}`;
  }

  function openBookingView(id, keep) {
    if (!state.bk.map.has(id)) return;
    if (!keep) booker.fresh = false;
    booker.mode = 'view';
    booker.id = id;
    renderBookingView();
    if (!booker.open) showBooker(); else $('#booker').scrollTop = 0;
  }

  function renderBookingView() {
    const b = state.bk.map.get(booker.id);
    if (!b) { closeBooker(); return; }
    const s = new Date(b.start);
    const e = new Date(b.end);
    const ph = b.lead.phone;
    const o = findOpp(b.oppId);
    const addCal = `<div class="addcal${booker.fresh ? ' hi' : ''}">
        <a class="btn sm ghost" href="${esc(b.ics)}">${icon('cal')}Apple / Outlook</a>
        <a class="btn sm ghost" href="${esc(googleLink(b))}" target="_blank" rel="noopener">${icon('cal')}Google</a></div>`;
    $('#bookerBody').innerHTML = `
      <h2 id="bookerTitle">${esc(b.title)}</h2>
      <p class="sub">${esc(b.lead.name)}${o ? ` · ${esc((state.board.pipeline.stages.find((x) => x.id === o.stageId) || {}).name || '')}`
        : b.manual ? " · not in your leads" : ''}</p>
      <div class="bk-when">${icon('cal')}<div><b>${esc(fmtDayLong(s))}</b><span>${esc(fmtTime(s))} – ${esc(fmtTime(e))} · ${esc(fmtLen(b.minutes))}${b.amount > 0 ? ` · ${esc(money(b.amount))}` : ''}</span></div></div>
      ${b.address ? `<a class="bk-addr" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address)}" target="_blank" rel="noopener">${icon('pin')}${esc(b.address)}</a>` : ''}
      ${b.notes ? `<p class="bk-notes">${esc(b.notes)}</p>` : ''}
      <div class="actions">
        <a class="act${ph ? '' : ' off'}" href="${ph ? `tel:${esc(ph)}` : '#'}">${icon('phone')}Call</a>
        <a class="act${ph ? '' : ' off'}" href="${ph ? `sms:${esc(ph)}` : '#'}">${icon('sms')}Text</a>
        <a class="act${b.address ? '' : ' off'}" href="${b.address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(b.address)}` : '#'}" target="_blank" rel="noopener">${icon('pin')}Directions</a>
      </div>
      ${b.completedAt ? `<div class="done-badge">${icon('check')}Job done · ${esc(fmtDay(new Date(b.completedAt)))}${b.amount > 0 ? ` · ${esc(money(b.amount))}` : ''}</div>`
        : isJobBooking(b) && new Date(b.end) < new Date() ? `<div class="sec wrap-sec"><h3>How did it go?</h3>
          <div class="field"><span>Final price</span><div class="price"><input id="doneAmount" inputmode="decimal" placeholder="0" value="${b.amount > 0 ? esc(b.amount) : ''}" aria-label="Final price"></div></div>
          ${b.oppId ? `<label class="check"><input type="checkbox" id="doneSetValue" checked> Save it as this lead's job value</label>` : ''}
          <button class="btn" type="button" data-bk-act="done">${icon('check')}Mark job done</button>
          <p class="hint">${b.oppId ? 'Moves the lead to Job Completed so your review request goes out.' : 'Marks this job done in your calendar.'}</p></div>` : ''}
      ${new Date(b.end) < new Date() ? '' : `<div class="sec"><h3>${booker.fresh ? 'Booked! Add it to your phone calendar' : 'Add to my calendar'}</h3>${addCal}</div>`}
      <div class="sec bk-actions">
        ${(() => {
          if (!isJobBooking(b)) return `<button class="btn ghost" type="button" data-bk-act="quote">${icon('doc')}Create quote</button>`;
          const iv = invoiceForBooking(b.id);
          return iv
            ? `<button class="btn ghost" type="button" data-bk-act="invoice-open">${icon('doc')}Invoice ${esc(iv.number)} · ${iv.status === 'paid' ? 'Paid' : 'Unpaid'}</button>`
            : `<button class="btn${b.completedAt ? '' : ' ghost'}" type="button" data-bk-act="invoice">${icon('doc')}Create invoice</button>`;
        })()}
        <button class="btn ghost" type="button" data-bk-act="edit">Change time or details</button>
        ${o && state.openId !== o.id ? '<button class="btn ghost" type="button" data-bk-act="lead">Open lead</button>' : ''}
        ${b.completedAt ? '' : '<button class="btn ghost danger" type="button" data-bk-act="cancel">Cancel appointment</button>'}
      </div>`;
  }

  $('#bookerBody').addEventListener('click', async (e) => {
    const q = e.target.closest('.qchip');
    if (q && booker.mode === 'form') {
      booker.draft.title = q.dataset.kind;
      $('#bkTitle').value = q.dataset.kind;
      document.querySelectorAll('.qchip').forEach((x) => x.classList.toggle('on', x === q));
      return;
    }
    if (e.target.closest('#bkLater')) { closeBooker(); return; }
    if (e.target.closest('#bkManual') || e.target.closest('#bkPickLead')) {
      const dr = booker.draft;
      dr.manual = !!e.target.closest('#bkManual');
      dr.oppId = '';
      dr.stageId = '';
      renderBookingForm();
      if (dr.manual) $('#bkName').focus();
      return;
    }
    const act = e.target.closest('[data-bk-act]');
    if (!act || booker.mode !== 'view') return;
    const b = state.bk.map.get(booker.id);
    if (!b) return;
    if (act.dataset.bkAct === 'invoice') { openInvoiceEditor({ booking: b }); return; }
    if (act.dataset.bkAct === 'quote') { openInvoiceEditor({ kind: 'quote', booking: b }); return; }
    if (act.dataset.bkAct === 'invoice-open') { const iv = invoiceForBooking(b.id); if (iv) openInvoiceView(iv.id, 'invoice'); return; }
    if (act.dataset.bkAct === 'edit') {
      booker.mode = 'form';
      openBookingForm({ edit: b });
    } else if (act.dataset.bkAct === 'lead') {
      closeBooker();
      if (findOpp(b.oppId)) setTimeout(() => openSheet(b.oppId), 250);
    } else if (act.dataset.bkAct === 'done') {
      const amount = Number(String(($('#doneAmount') || {}).value || '').replace(/[^0-9.]/g, '')) || 0;
      const setValue = !!($('#doneSetValue') && $('#doneSetValue').checked) && amount > 0;
      act.disabled = true;
      try {
        const r = await api('bookings', {
          action: 'complete', id: b.id, month: b.month, oppId: b.oppId || undefined, pipeline: state.board.pipeline.id,
          amount, setValue, tz: tz(),
        });
        state.bk.map.set(r.booking.id, r.booking);
        rememberBooking(state.board.pipeline.id, r.booking.id, r.booking);
        if (r.opportunity) {
          const o = findOpp(b.oppId);
          if (o) {
            if (o.stageId !== r.opportunity.stageId) o.stageChangedAt = new Date().toISOString();
            Object.assign(o, { stageId: r.opportunity.stageId, value: r.opportunity.value });
          }
        }
        toast(!b.oppId ? 'Job marked done'
          : r.stageName ? `Job done · moved to ${r.stageName}. Review request goes out tomorrow.`
            : 'Job marked done. Add a "Job Completed" stage in GHL to send review requests.', b.oppId && !r.stageName);
        afterBookingsChange();
        renderBookingView();
      } catch (ex) {
        toast(ex.message, true);
        act.disabled = false;
      }
    } else if (act.dataset.bkAct === 'cancel') {
      if (!window.confirm(`Cancel ${b.title} with ${b.lead.name} on ${fmtDay(new Date(b.start))}?`)) return;
      act.disabled = true;
      try {
        await api('bookings', {
          action: 'cancel', id: b.id, month: b.month, oppId: b.oppId || undefined, pipeline: state.board.pipeline.id, tz: tz(),
        });
        state.bk.map.delete(b.id);
        rememberBooking(state.board.pipeline.id, b.id, null);
        toast('Appointment cancelled');
        closeBooker();
        afterBookingsChange();
      } catch (ex) {
        toast(ex.message, true);
        act.disabled = false;
      }
    }
  });

  /* ---------------- billing: quotes & invoices ---------------- */

  const money2f = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const ymdAdd = (ymd, days) => dayKey(addDays(fromDayKey(ymd), days));
  const prettyYmd = (ymd) => (ymd ? fromDayKey(ymd).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const numIn = (v) => Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0;
  const absUrl = (path) => new URL(path, window.location.origin).href;
  const WORD = { invoice: 'Invoice', quote: 'Quote' };

  const docMap = (kind) => (kind === 'quote' ? state.inv.quotes : state.inv.map);
  const docList = (kind) => [...docMap(kind).values()].sort((a, b) => (b.seq || 0) - (a.seq || 0));
  const invList = () => docList('invoice');
  const quoteList = () => docList('quote');
  const isOverdue = (v) => v.status !== 'paid' && v.dueDate && v.dueDate < dayKey(new Date());
  const isExpired = (v) => v.kind === 'quote' && (v.status === 'sent' || v.status === 'draft') && v.dueDate && v.dueDate < dayKey(new Date());
  const invoiceForBooking = (id) => invList().find((v) => v.bookingId === id);
  const quotesForLead = (oppId) => quoteList().filter((v) => v.oppId === oppId);

  function totalsOf(d) {
    const subtotal = r2(d.lines.reduce((t, l) => t + r2(numIn(l.qty) * numIn(l.price)), 0));
    const discount = Math.min(subtotal, r2(numIn(d.discount)));
    const tax = r2(((subtotal - discount) * numIn(d.taxRate)) / 100);
    return { subtotal, discount, tax, total: r2(subtotal - discount + tax) };
  }

  // This device's own recent saves, laid over the server list while storage catches up.
  const invKey = (pid) => `lt_inv_${pid}`;
  function invPending(pid) {
    try { return JSON.parse(localStorage.getItem(invKey(pid)) || '[]').filter((x) => Date.now() - x.at < 10 * 60e3); } catch { return []; }
  }
  function rememberDoc(pid, kind, id, doc) {
    const list = invPending(pid).filter((x) => !(x.id === id && (x.kind || 'invoice') === kind));
    list.push({ id, kind, doc, at: Date.now() });
    try { localStorage.setItem(invKey(pid), JSON.stringify(list)); } catch { /* private mode */ }
  }
  function storeDoc(doc) {
    const kind = doc.kind || 'invoice';
    docMap(kind).set(doc.id, doc);
    rememberDoc(state.board.pipeline.id, kind, doc.id, doc);
  }

  async function loadInvoices() {
    const pid = state.board && state.board.pipeline.id;
    if (!pid) return;
    try {
      const r = await api(`invoices${state.me.admin ? `?pipeline=${encodeURIComponent(pid)}` : ''}`);
      if (!state.board || state.board.pipeline.id !== pid) return;
      state.inv = {
        pid, settings: r.settings, loaded: true,
        map: new Map(r.invoices.map((v) => [v.id, { ...v, kind: 'invoice' }])),
        quotes: new Map((r.quotes || []).map((v) => [v.id, { ...v, kind: 'quote' }])),
      };
    } catch (ex) {
      if (state.inv.pid !== pid) state.inv = { pid, settings: null, map: new Map(), quotes: new Map(), loaded: false, error: ex.message };
    }
    for (const x of invPending(pid)) {
      const m = docMap(x.kind || 'invoice');
      const cur = m.get(x.id);
      if (!x.doc) m.delete(x.id);
      else if (!cur || String(x.doc.updatedAt) >= String(cur.updatedAt)) m.set(x.id, x.doc);
    }
    afterInvoicesChange();
  }

  function afterInvoicesChange() {
    const unpaid = invList().filter((v) => v.status !== 'paid').length;
    const c = $('#invCount');
    c.textContent = unpaid;
    c.hidden = !unpaid;
    if (state.view === 'invoices') renderInvoices();
    if (state.view === 'home') renderHome();
    if (booker.open && booker.mode === 'view') renderBookingView();
    if (state.openId) renderSheetBookings(findOpp(state.openId));
  }

  function statusPill(v) {
    let k = v.status;
    let label;
    if (v.kind === 'quote') {
      if (isExpired(v)) { k = 'overdue'; label = 'Expired'; }
      else label = { draft: 'Draft', sent: v.viewedAt ? 'Viewed' : 'Sent', approved: 'Approved', declined: 'Declined' }[v.status];
      if (v.status === 'approved') k = 'paid';
      if (v.status === 'declined') k = 'overdue';
    } else {
      if (isOverdue(v)) k = 'overdue';
      label = { paid: 'Paid', overdue: 'Overdue', sent: 'Sent', draft: 'Draft' }[k];
    }
    return `<span class="pill ${k}">${label}</span>`;
  }

  function invRow(v) {
    return `<button type="button" class="inv-row" data-inv="${esc(v.id)}" data-kind="${esc(v.kind || 'invoice')}">
      <span class="inv-main"><b>${esc(v.customer.name)}</b><span>${esc(v.number)} · ${esc(prettyYmd(v.issueDate))}</span></span>
      <span class="inv-amt"><b>${esc(money2f(v.totals.total))}</b>${statusPill(v)}</span></button>`;
  }

  let billMode = store.get('lt_billmode') === 'quotes' ? 'quotes' : 'invoices';
  let invFilter = 'all';
  function renderInvoices() {
    const box = $('#invView');
    if (!state.inv.loaded && !state.inv.error) { box.innerHTML = '<div class="empty">Loading…</div>'; return; }
    if (state.inv.error && !state.inv.loaded) { box.innerHTML = `<div class="err-box">${esc(state.inv.error)}</div>`; return; }
    const quotes = billMode === 'quotes';
    const all = quotes ? quoteList() : invList();
    const now = new Date();
    const monthStart = dayKey(new Date(now.getFullYear(), now.getMonth(), 1));
    const sum = (list) => list.reduce((t, v) => t + v.totals.total, 0);
    let tiles;
    let chips;
    let shown;
    if (quotes) {
      const waiting = all.filter((v) => v.status === 'sent' && !isExpired(v));
      const approvedMonth = all.filter((v) => v.status === 'approved' && (v.approvedAt || '').slice(0, 10) >= monthStart);
      const closeRate = all.filter((v) => v.status === 'approved' || v.status === 'declined').length
        ? Math.round((all.filter((v) => v.status === 'approved').length / all.filter((v) => v.status === 'approved' || v.status === 'declined').length) * 100) : null;
      tiles = `<div class="rev-tile"><span class="l">Awaiting approval</span><b>${esc(money2f(sum(waiting)))}</b><span class="s">${waiting.length} ${waiting.length === 1 ? 'quote' : 'quotes'}</span></div>
        <div class="rev-tile"><span class="l">Approved this month</span><b>${esc(money2f(sum(approvedMonth)))}</b><span class="s">${closeRate === null ? 'No decisions yet' : `${closeRate}% approval rate`}</span></div>`;
      const f = { all: () => true, sent: (v) => v.status === 'sent', approved: (v) => v.status === 'approved', declined: (v) => v.status === 'declined' || isExpired(v), draft: (v) => v.status === 'draft' };
      shown = all.filter(f[invFilter] || f.all);
      chips = [['all', 'All'], ['sent', 'Awaiting'], ['approved', 'Approved'], ['declined', 'Declined'], ['draft', 'Drafts']];
    } else {
      const outstanding = all.filter((v) => v.status !== 'paid');
      const overdue = all.filter(isOverdue);
      const paidMonth = all.filter((v) => v.status === 'paid' && (v.paidAt || '').slice(0, 10) >= monthStart);
      tiles = `<div class="rev-tile"><span class="l">Outstanding</span><b>${esc(money2f(sum(outstanding)))}</b><span class="s">${overdue.length ? `${overdue.length} overdue` : 'Nothing overdue'}</span></div>
        <div class="rev-tile"><span class="l">Paid this month</span><b>${esc(money2f(sum(paidMonth)))}</b><span class="s">${all.filter((v) => v.status === 'paid').length} paid in total</span></div>`;
      shown = all.filter((v) => invFilter === 'all' || (invFilter === 'unpaid' ? v.status !== 'paid' : v.status === invFilter));
      chips = [['all', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid'], ['draft', 'Drafts']];
    }
    box.innerHTML = `
      <div class="inv-top">
        <div class="seg bill-mode" role="group" aria-label="Quotes or invoices">
          <button type="button" data-mode="quotes" class="${quotes ? 'on' : ''}">Quotes</button><button type="button" data-mode="invoices" class="${quotes ? '' : 'on'}">Invoices</button>
        </div>
        <div class="inv-tools">
          <button class="icon-btn" type="button" data-inva="settings" aria-label="Quote and invoice settings" title="Settings">${icon('gear')}</button>
          <button class="btn sm" type="button" data-inva="new">${icon('plus')}New ${quotes ? 'quote' : 'invoice'}</button>
        </div>
      </div>
      <div class="rev">${tiles}</div>
      <nav class="chips inv-chips">${chips.map(([k, l]) => `<button type="button" class="chip" data-invf="${k}" aria-pressed="${invFilter === k}">${l}</button>`).join('')}</nav>
      <div class="inv-list">${shown.length ? shown.map(invRow).join('')
        : `<div class="empty">${all.length ? 'Nothing here.' : quotes
          ? 'No quotes yet. Open a lead and tap Create quote, or tap New quote.'
          : 'No invoices yet. Turn a booked job into one from the Calendar, or tap New invoice.'}</div>`}</div>`;
  }

  $('#invView').addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { billMode = m.dataset.mode; store.set('lt_billmode', billMode); invFilter = 'all'; renderInvoices(); return; }
    const f = e.target.closest('[data-invf]');
    if (f) { invFilter = f.dataset.invf; renderInvoices(); return; }
    const a = e.target.closest('[data-inva]');
    if (a) {
      if (a.dataset.inva === 'settings') openInvoiceSettings();
      else openInvoiceEditor({ kind: billMode === 'quotes' ? 'quote' : 'invoice' });
      return;
    }
    const row = e.target.closest('[data-inv]');
    if (row) openInvoiceView(row.dataset.inv, row.dataset.kind);
  });

  /* ---- panel: edit / view / settings ---- */

  const invp = { open: false, mode: null, kind: 'invoice', id: null, draft: null, busy: false };

  function showInvPanel() {
    invp.open = true;
    $('#invScrim').hidden = false;
    $('#invPanel').hidden = false;
    $('#invPanel').scrollTop = 0;
    if (!(history.state && history.state.inv)) history.pushState({ inv: 1 }, '');
  }
  function closeInvPanel(fromPop) {
    if (!invp.open) return;
    invp.open = false;
    invp.draft = null;
    $('#invScrim').hidden = true;
    $('#invPanel').hidden = true;
    if (fromPop !== true && history.state && history.state.inv) backQuietly();
  }
  $('#invClose').addEventListener('click', () => closeInvPanel());
  $('#invScrim').addEventListener('click', () => closeInvPanel());

  function nextNumberHint(kind) {
    const s = state.inv.settings || {};
    const prefix = kind === 'quote' ? (s.quotePrefix || 'Q-') : (s.prefix || 'INV-');
    const start = kind === 'quote' ? (s.quoteStart || 1001) : (s.start || 1001);
    return `${prefix}${Math.max(start - 1, ...docList(kind).map((v) => v.seq || 0)) + 1}`;
  }

  function openInvoiceEditor({ invoice = null, booking = null, lead = null, copy = false, kind = null } = {}) {
    if (!state.board) return;
    const k = kind || (invoice && invoice.kind) || 'invoice';
    const s = state.inv.settings || { taxName: 'HST', taxRate: 13, dueDays: 14, quoteDays: 30 };
    const days = k === 'quote' ? (s.quoteDays || 30) : (s.dueDays || 0);
    const today = dayKey(new Date());
    let d;
    if (invoice) {
      d = JSON.parse(JSON.stringify(invoice));
      if (copy) Object.assign(d, { id: null, number: '', status: 'draft', issueDate: today, dueDate: days ? ymdAdd(today, days) : '', bookingId: null, quoteId: null });
    } else {
      d = {
        id: null, kind: k, number: '', status: 'draft', customer: { name: '', email: '', phone: '', address: '' },
        oppId: null, bookingId: null, issueDate: today, dueDate: days ? ymdAdd(today, days) : '',
        lines: [{ desc: '', qty: 1, price: '' }], taxName: s.taxName, taxRate: s.taxRate, discount: 0, customFields: [], notes: '',
      };
      if (booking) {
        const st = new Date(booking.start);
        Object.assign(d, {
          customer: { name: booking.lead.name, email: booking.lead.email || '', phone: booking.lead.phone || '', address: booking.address || '' },
          oppId: booking.oppId || null,
          bookingId: k === 'invoice' ? booking.id : null,
          lines: [{ desc: k === 'invoice' ? booking.title + (booking.notes ? ` - ${booking.notes}` : '') : '', qty: 1, price: booking.amount || '' }],
          customFields: [{ label: k === 'quote' ? 'Site visit' : 'Service date', value: fmtDayLong(st) }],
        });
      } else if (lead) {
        const b = nextBooking(lead.id);
        Object.assign(d, {
          customer: { name: lead.contact.name || lead.name, phone: lead.contact.phone || '', email: lead.contact.email || '', address: (b && b.address) || '' },
          oppId: lead.id,
          lines: [{ desc: '', qty: 1, price: lead.value > 0 ? lead.value : '' }],
        });
      }
    }
    d.kind = k;
    invp.mode = 'edit';
    invp.kind = k;
    invp.draft = d;
    renderInvoiceEditor();
    showInvPanel();
  }

  function lineRow(l, i) {
    return `<div class="line" data-line="${i}">
      <textarea class="ln-desc" data-k="desc" rows="1" maxlength="300" placeholder="Description" aria-label="Line ${i + 1} description">${esc(l.desc)}</textarea>
      <div class="ln-nums">
        <label><span>Qty</span><input data-k="qty" inputmode="decimal" value="${esc(l.qty)}" aria-label="Line ${i + 1} quantity"></label>
        <label><span>Price</span><div class="price"><input data-k="price" inputmode="decimal" placeholder="0" value="${esc(l.price)}" aria-label="Line ${i + 1} price"></div></label>
        <b class="ln-amt">${esc(money2f(numIn(l.qty) * numIn(l.price)))}</b>
        <button type="button" class="icon-btn small" data-del-line="${i}" aria-label="Remove line ${i + 1}"${invp.draft.lines.length < 2 ? ' disabled' : ''}>${icon('x')}</button>
      </div></div>`;
  }

  function fieldRow(f, i) {
    return `<div class="cfield" data-cf="${i}">
      <input data-k="label" maxlength="40" placeholder="Label (e.g. PO #)" value="${esc(f.label)}" aria-label="Custom field ${i + 1} label">
      <input data-k="value" maxlength="200" placeholder="Value" value="${esc(f.value)}" aria-label="Custom field ${i + 1} value">
      <button type="button" class="icon-btn small" data-del-cf="${i}" aria-label="Remove field ${i + 1}">${icon('x')}</button></div>`;
  }

  function renderInvoiceEditor() {
    const d = invp.draft;
    const q = d.kind === 'quote';
    const word = q ? 'quote' : 'invoice';
    const leads = state.board.opportunities.slice().sort((a, b) => a.name.localeCompare(b.name));
    $('#invBody').innerHTML = `
      <h2 id="invTitle">${d.id ? `Edit ${esc(d.number)}` : `New ${word}`}</h2>
      <p class="sub">${q ? 'Your customer gets a link to review it and tap Approve.'
        : d.bookingId ? 'Filled in from the booked job. Check the lines and price.' : 'Your logo and colours are added to the PDF automatically.'}</p>
      <form class="cf inv-form" id="invForm" novalidate>
        ${d.id || d.bookingId || d.oppId ? '' : `<label class="field"><span>Fill in from a lead (optional)</span><select id="ivLead">
          <option value="">Type the customer in below…</option>${leads.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}${l.contact.phone ? ` · ${esc(phonePretty(l.contact.phone))}` : ''}</option>`).join('')}
        </select></label>`}
        <div class="field"><span>${q ? 'Prepared for' : 'Bill to'}</span>
          <input id="ivName" maxlength="80" placeholder="Customer name" value="${esc(d.customer.name)}" aria-label="Customer name">
          <div class="row2 manual-row">
            <input id="ivPhone" type="tel" maxlength="40" placeholder="Phone" value="${esc(d.customer.phone)}" aria-label="Customer phone">
            <input id="ivEmail" type="email" maxlength="120" placeholder="Email" value="${esc(d.customer.email)}" aria-label="Customer email">
          </div>
          <input id="ivAddr" class="manual-row" maxlength="200" placeholder="Address" value="${esc(d.customer.address)}" aria-label="Customer address">
        </div>
        <div class="row3">
          <label class="field"><span>${q ? 'Quote #' : 'Invoice #'}</span><input id="ivNum" maxlength="30" placeholder="${esc(d.id ? d.number : nextNumberHint(d.kind))}" value="${esc(d.id ? d.number : d.number || '')}"></label>
          <label class="field"><span>Issued</span><input id="ivIssue" type="date" value="${esc(d.issueDate)}"></label>
          <label class="field"><span>${q ? 'Valid until' : 'Due'}</span><input id="ivDue" type="date" value="${esc(d.dueDate)}"></label>
        </div>
        <div class="field"><span>Lines</span><div id="ivLines">${d.lines.map(lineRow).join('')}</div>
          <button type="button" class="btn sm ghost add-btn" data-add="line">${icon('plus')}Add line</button></div>
        <div class="row3">
          <label class="field"><span>Tax name</span><input id="ivTaxName" maxlength="20" value="${esc(d.taxName)}"></label>
          <label class="field"><span>Tax %</span><input id="ivTaxRate" inputmode="decimal" value="${esc(d.taxRate)}"></label>
          <label class="field"><span>Discount</span><div class="price"><input id="ivDisc" inputmode="decimal" placeholder="0" value="${d.discount ? esc(d.discount) : ''}"></div></label>
        </div>
        <div class="field"><span>Custom fields</span><div id="ivFields">${d.customFields.map(fieldRow).join('')}</div>
          <button type="button" class="btn sm ghost add-btn" data-add="field">${icon('plus')}Add field</button>
          <span class="hint">Anything extra to show: PO #, job site, warranty, permit #, start date…</span></div>
        <label class="field"><span>Notes</span><textarea id="ivNotes" maxlength="1000" placeholder="${q ? 'What\'s included, timeline, warranty…' : 'Thanks for your business! Warranty: 2 years on labour.'}">${esc(d.notes)}</textarea></label>
        <div class="inv-totals" id="ivTotals"></div>
        <p class="err" id="ivErr" hidden></p>
        <button class="btn" type="submit" id="ivSave">${d.id ? 'Save changes' : `Create ${word}`}</button>
      </form>`;
    renderInvoiceTotals();
  }

  function renderInvoiceTotals() {
    const d = invp.draft;
    const t = totalsOf(d);
    $('#ivTotals').innerHTML = `
      <div><span>Subtotal</span><b>${esc(money2f(t.subtotal))}</b></div>
      ${t.discount ? `<div><span>Discount</span><b>-${esc(money2f(t.discount))}</b></div>` : ''}
      ${numIn(d.taxRate) ? `<div><span>${esc(d.taxName || 'Tax')} (${esc(numIn(d.taxRate))}%)</span><b>${esc(money2f(t.tax))}</b></div>` : ''}
      <div class="grand"><span>Total</span><b>${esc(money2f(t.total))}</b></div>`;
    document.querySelectorAll('#ivLines .line').forEach((row, i) => {
      const l = d.lines[i];
      if (l) row.querySelector('.ln-amt').textContent = money2f(numIn(l.qty) * numIn(l.price));
    });
  }

  $('#invBody').addEventListener('input', (e) => {
    const d = invp.draft;
    if (!d || invp.mode === 'view') return;
    if (invp.mode === 'settings') { d[e.target.dataset.s] = e.target.value; return; }
    const t = e.target;
    const line = t.closest('[data-line]');
    const cf = t.closest('[data-cf]');
    if (line) d.lines[Number(line.dataset.line)][t.dataset.k] = t.value;
    else if (cf) d.customFields[Number(cf.dataset.cf)][t.dataset.k] = t.value;
    else {
      const map = { ivName: 'name', ivPhone: 'phone', ivEmail: 'email', ivAddr: 'address' };
      if (map[t.id]) d.customer[map[t.id]] = t.value;
      else if (t.id === 'ivNum') d.number = t.value;
      else if (t.id === 'ivIssue') d.issueDate = t.value;
      else if (t.id === 'ivDue') d.dueDate = t.value;
      else if (t.id === 'ivTaxName') d.taxName = t.value;
      else if (t.id === 'ivTaxRate') d.taxRate = t.value;
      else if (t.id === 'ivDisc') d.discount = t.value;
      else if (t.id === 'ivNotes') d.notes = t.value;
    }
    renderInvoiceTotals();
  });

  $('#invBody').addEventListener('change', (e) => {
    const d = invp.draft;
    if (!d || e.target.id !== 'ivLead') return;
    const o = findOpp(e.target.value);
    d.oppId = o ? o.id : null;
    if (o) {
      const b = nextBooking(o.id);
      d.customer = { name: o.contact.name || o.name, phone: o.contact.phone || '', email: o.contact.email || '', address: (b && b.address) || d.customer.address };
      if (!d.lines.some((l) => l.desc || numIn(l.price)) && o.value > 0) d.lines = [{ desc: 'Job', qty: 1, price: o.value }];
    }
    renderInvoiceEditor();
  });

  $('#invBody').addEventListener('click', async (e) => {
    const d = invp.draft;
    const add = e.target.closest('[data-add]');
    if (add && d) {
      if (add.dataset.add === 'line') d.lines.push({ desc: '', qty: 1, price: '' });
      else d.customFields.push({ label: '', value: '' });
      renderInvoiceEditor();
      const sel = add.dataset.add === 'line' ? '#ivLines .line:last-child .ln-desc' : '#ivFields .cfield:last-child input';
      $(sel).focus();
      return;
    }
    const dl = e.target.closest('[data-del-line]');
    if (dl && d) { d.lines.splice(Number(dl.dataset.delLine), 1); renderInvoiceEditor(); return; }
    const dc = e.target.closest('[data-del-cf]');
    if (dc && d) { d.customFields.splice(Number(dc.dataset.delCf), 1); renderInvoiceEditor(); return; }
    const act = e.target.closest('[data-iv]');
    if (act && invp.mode === 'view') invoiceAction(act.dataset.iv, act);
  });

  $('#invBody').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (invp.busy) return;
    if (invp.mode === 'settings') { saveInvoiceSettings(); return; }
    const d = invp.draft;
    const err = $('#ivErr');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    err.hidden = true;
    if (!d.customer.name.trim()) return fail("Add the customer's name.");
    const lines = d.lines.map((l) => ({ desc: String(l.desc || '').trim(), qty: numIn(l.qty) || 1, price: numIn(l.price) })).filter((l) => l.desc || l.price);
    if (!lines.length) return fail('Add at least one line with a description or price.');
    const btn = $('#ivSave');
    invp.busy = true;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const r = await api('invoices', {
        action: 'save', kind: d.kind, pipeline: state.board.pipeline.id,
        invoice: {
          ...d, lines, number: String(d.number || '').trim(), taxRate: numIn(d.taxRate), discount: numIn(d.discount),
          customFields: d.customFields.filter((f) => String(f.label).trim() || String(f.value).trim()),
        },
      });
      storeDoc(r.doc);
      toast(d.id ? `${r.doc.number} saved` : `${r.doc.number} created`);
      openInvoiceView(r.doc.id, r.doc.kind);
      afterInvoicesChange();
    } catch (ex) {
      fail(ex.message);
      btn.disabled = false;
      btn.textContent = d.id ? 'Save changes' : `Create ${d.kind}`;
    } finally {
      invp.busy = false;
    }
  });

  function openInvoiceView(id, kind = 'invoice') {
    if (!docMap(kind).has(id)) return;
    invp.mode = 'view';
    invp.kind = kind;
    invp.id = id;
    invp.draft = null;
    renderInvoiceView();
    if (!invp.open) showInvPanel(); else $('#invPanel').scrollTop = 0;
  }

  function renderInvoiceView() {
    const v = docMap(invp.kind).get(invp.id);
    if (!v) { closeInvPanel(); return; }
    const q = v.kind === 'quote';
    const t = v.totals;
    const canShare = !!navigator.share;
    const linked = q && v.invoiceId ? state.inv.map.get(v.invoiceId) : null;
    const fromQuote = !q && v.quoteId ? state.inv.quotes.get(v.quoteId) : null;
    const info = [
      q && v.viewedAt && v.status === 'sent' ? `Opened by the customer ${ago(v.viewedAt)}.` : '',
      q && v.status === 'approved' ? `Approved by ${v.approvedName || 'the customer'} on ${new Date(v.approvedAt).toLocaleDateString()}.` : '',
      q && v.status === 'declined' ? `Declined${v.declineReason ? `: “${v.declineReason}”` : '.'}` : '',
      isExpired(v) ? `Expired on ${prettyYmd(v.dueDate)}. Edit the "Valid until" date to send it again.` : '',
    ].filter(Boolean).join(' ');
    let primary;
    if (q) {
      primary = v.status === 'approved'
        ? (linked ? `<button class="btn" type="button" data-iv="openinvoice">${icon('doc')}Open invoice ${esc(linked.number)}</button>`
          : `<button class="btn" type="button" data-iv="convert">${icon('doc')}Turn into an invoice</button>`)
        : `<button class="btn" type="button" data-iv="approve">${icon('check')}Mark as approved</button>
           <button class="btn ghost" type="button" data-iv="decline">Mark as declined</button>`;
    } else {
      primary = v.status === 'paid'
        ? '<button class="btn ghost" type="button" data-iv="unpaid">Mark as unpaid</button>'
        : `<button class="btn" type="button" data-iv="paid">${icon('check')}Mark as paid</button>`;
    }
    $('#invBody').innerHTML = `
      <h2 id="invTitle">${esc(v.number)} ${statusPill(v)}</h2>
      <p class="sub">${esc(v.customer.name)} · issued ${esc(prettyYmd(v.issueDate))}${v.dueDate ? ` · ${q ? 'valid until' : 'due'} ${esc(prettyYmd(v.dueDate))}` : ''}</p>
      ${info ? `<p class="doc-info">${esc(info)}</p>` : ''}
      <div class="inv-big"><span>${q ? 'Quote total' : v.status === 'paid' ? 'Paid' : 'Amount due'}</span><b>${esc(money2f(t.total))}</b></div>
      <div class="actions inv-acts">
        <a class="act" href="${esc(v.pdf)}" download="${q ? 'Quote' : 'Invoice'}-${esc(v.number)}.pdf" target="_blank" rel="noopener">${icon('download')}PDF</a>
        <button class="act" type="button" data-iv="sms"${v.customer.phone ? '' : ' disabled'}>${icon('sms')}Text it</button>
        <button class="act" type="button" data-iv="email"${v.customer.email ? '' : ' disabled'}>${icon('mail')}Email it</button>
      </div>
      <div class="inv-acts2">
        ${q ? `<a class="btn sm ghost" href="${esc(v.link)}" target="_blank" rel="noopener">${icon('next')}Preview</a>` : ''}
        ${canShare ? `<button class="btn sm ghost" type="button" data-iv="share">${icon('share')}Share…</button>` : ''}
        <button class="btn sm ghost" type="button" data-iv="copy">${icon('link')}Copy link</button>
      </div>
      <div class="sec"><h3>Lines</h3>
        <div class="inv-lines">${v.lines.map((l) => `<div><span>${esc(l.desc || '—')}${l.qty !== 1 ? ` <em>× ${esc(l.qty)}</em>` : ''}</span><b>${esc(money2f(l.qty * l.price))}</b></div>`).join('')}
          <div class="sum"><span>Subtotal</span><b>${esc(money2f(t.subtotal))}</b></div>
          ${t.discount ? `<div class="sum"><span>Discount</span><b>-${esc(money2f(t.discount))}</b></div>` : ''}
          ${v.taxRate ? `<div class="sum"><span>${esc(v.taxName)} (${esc(v.taxRate)}%)</span><b>${esc(money2f(t.tax))}</b></div>` : ''}
          <div class="sum grand"><span>Total</span><b>${esc(money2f(t.total))}</b></div></div></div>
      ${v.customFields.length ? `<div class="sec"><h3>Details</h3><dl class="detail">${v.customFields.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl></div>` : ''}
      <div class="sec bk-actions">
        ${primary}
        ${fromQuote ? `<button class="btn ghost" type="button" data-iv="openquote">From quote ${esc(fromQuote.number)}</button>` : ''}
        <button class="btn ghost" type="button" data-iv="edit">Edit ${q ? 'quote' : 'invoice'}</button>
        <button class="btn ghost" type="button" data-iv="copyinv">Duplicate</button>
        <button class="btn ghost danger" type="button" data-iv="delete">Delete ${q ? 'quote' : 'invoice'}</button>
      </div>`;
  }

  async function setStatus(v, status, extra = {}) {
    const r = await api('invoices', { action: 'status', kind: v.kind, pipeline: state.board.pipeline.id, id: v.id, status, ...extra });
    const doc = r.doc || r.quote;
    storeDoc(doc);
    if (r.invoice) storeDoc({ ...r.invoice, kind: 'invoice' });
    if (r.stageName && v.oppId) {
      const o = findOpp(v.oppId);
      const st = state.board.pipeline.stages.find((s) => s.name === r.stageName);
      if (o && st) { o.stageId = st.id; o.stageChangedAt = new Date().toISOString(); render(); }
    }
    afterInvoicesChange();
    if (invp.open && invp.mode === 'view') renderInvoiceView();
    return r;
  }

  async function invoiceAction(a, btn) {
    const v = docMap(invp.kind).get(invp.id);
    if (!v) return;
    const q = v.kind === 'quote';
    const pid = state.board.pipeline.id;
    const link = absUrl(q ? v.link : v.pdf);
    const first = v.customer.name.split(/\s+/)[0];
    const biz = (state.inv.settings && state.inv.settings.businessName) || (state.me && state.me.name) || '';
    const msg = q
      ? `Hi ${first}, here's your quote ${v.number} from ${biz} for ${money2f(v.totals.total)}. Review and approve it here: ${link}`
      : `Hi ${first}, here's your invoice ${v.number} from ${biz} for ${money2f(v.totals.total)}: ${link}`;
    const markSent = async () => { if (v.status === 'draft') await setStatus(v, 'sent'); };
    try {
      if (a === 'sms' || a === 'email') {
        btn.disabled = true;
        const r = await api('invoices', { action: 'send', kind: v.kind, pipeline: pid, id: v.id, via: a });
        if (r.sent) {
          storeDoc(r.doc);
          toast(a === 'sms' ? `Texted to ${v.customer.phone}` : `Emailed to ${v.customer.email}`);
          afterInvoicesChange();
          renderInvoiceView();
        } else {
          // GHL sending isn't switched on: hand it to the phone's own Messages / Mail app.
          const url = a === 'sms'
            ? `sms:${v.customer.phone}${/iPhone|iPad|Mac/.test(navigator.userAgent) ? '&' : '?'}body=${encodeURIComponent(msg)}`
            : `mailto:${v.customer.email}?subject=${encodeURIComponent(`${WORD[v.kind]} ${v.number} from ${biz}`)}&body=${encodeURIComponent(`${msg}\n\nThank you!\n${biz}`)}`;
          window.location.href = url;
          await markSent();
        }
        btn.disabled = false;
      } else if (a === 'share') {
        await navigator.share({ title: `${WORD[v.kind]} ${v.number}`, text: msg, url: link }).catch(() => null);
        await markSent();
      } else if (a === 'copy') {
        await navigator.clipboard.writeText(link);
        toast(`${WORD[v.kind]} link copied`);
        await markSent();
      } else if (a === 'paid' || a === 'unpaid') {
        await setStatus(v, a === 'paid' ? 'paid' : 'sent');
        toast(a === 'paid' ? `${v.number} marked paid` : `${v.number} marked unpaid`);
      } else if (a === 'approve') {
        if (!window.confirm(`Mark ${v.number} as approved? This moves the lead to Closed and creates the invoice as a draft.`)) return;
        btn.disabled = true;
        const r = await setStatus(v, 'approved');
        toast(`Approved${r.invoice ? ` · invoice ${r.invoice.number} created` : ''}${r.stageName ? ` · moved to ${r.stageName}` : ''}`);
      } else if (a === 'decline') {
        const reason = window.prompt('Why did they decline? (optional)', '');
        if (reason === null) return;
        await setStatus(v, 'declined', { reason });
        toast(`${v.number} marked declined`);
      } else if (a === 'convert') {
        btn.disabled = true;
        const r = await api('invoices', { action: 'convert', kind: 'quote', pipeline: pid, id: v.id });
        storeDoc(r.doc);
        storeDoc({ ...r.invoice, kind: 'invoice' });
        afterInvoicesChange();
        openInvoiceView(r.invoice.id, 'invoice');
        toast(`Invoice ${r.invoice.number} created from ${v.number}`);
      } else if (a === 'openinvoice') {
        openInvoiceView(v.invoiceId, 'invoice');
      } else if (a === 'openquote') {
        openInvoiceView(v.quoteId, 'quote');
      } else if (a === 'edit') {
        openInvoiceEditor({ invoice: v });
      } else if (a === 'copyinv') {
        openInvoiceEditor({ invoice: v, copy: true });
      } else if (a === 'delete') {
        if (!window.confirm(`Delete ${WORD[v.kind].toLowerCase()} ${v.number}? This can't be undone.`)) return;
        await api('invoices', { action: 'delete', kind: v.kind, pipeline: pid, id: v.id });
        docMap(v.kind).delete(v.id);
        rememberDoc(pid, v.kind, v.id, null);
        toast(`${v.number} deleted`);
        closeInvPanel();
        afterInvoicesChange();
      }
    } catch (ex) {
      toast(ex.message, true);
      if (btn) btn.disabled = false;
    }
  }

  /* ---- settings ---- */

  const SETTINGS_FIELDS = [
    ['businessName', 'Business name', 'text'], ['address', 'Business address', 'text'], ['phone', 'Phone', 'tel'],
    ['email', 'Email', 'email'], ['website', 'Website', 'text'],
    ['taxNumberLabel', 'Tax number label', 'text'], ['taxNumber', 'Tax number (HST/GST #)', 'text'],
    ['taxName', 'Default tax name', 'text'], ['taxRate', 'Default tax %', 'num'],
    ['prefix', 'Invoice # prefix', 'text'], ['start', 'First invoice #', 'num'], ['dueDays', 'Invoices due in (days)', 'num'],
    ['quotePrefix', 'Quote # prefix', 'text'], ['quoteStart', 'First quote #', 'num'], ['quoteDays', 'Quotes valid for (days)', 'num'],
  ];

  function openInvoiceSettings() {
    invp.mode = 'settings';
    invp.draft = { ...(state.inv.settings || {}) };
    const d = invp.draft;
    $('#invBody').innerHTML = `
      <h2 id="invTitle">Quote &amp; invoice settings</h2>
      <p class="sub">Shown on every quote and invoice. Your logo and colours come from your portal branding.</p>
      <form class="cf" id="invSettingsForm" novalidate>
        ${SETTINGS_FIELDS.map(([k, label, type]) => `<label class="field"><span>${esc(label)}</span>
          <input data-s="${k}" ${type === 'num' ? 'inputmode="decimal"' : `type="${type}"`} value="${esc(d[k] == null ? '' : d[k])}"></label>`).join('')}
        <label class="field"><span>How to pay (invoices)</span><textarea data-s="payment" maxlength="500" placeholder="E-transfer to payments@yourbusiness.ca, or cheque payable to…">${esc(d.payment || '')}</textarea></label>
        <label class="field"><span>Terms / footer note</span><textarea data-s="terms" maxlength="500">${esc(d.terms || '')}</textarea></label>
        <p class="err" id="ivErr" hidden></p>
        <button class="btn" type="submit" id="ivSetSave">Save settings</button>
      </form>`;
    showInvPanel();
  }

  async function saveInvoiceSettings() {
    const btn = $('#ivSetSave');
    invp.busy = true;
    btn.disabled = true;
    try {
      const r = await api('invoices', { action: 'settings', pipeline: state.board.pipeline.id, settings: invp.draft });
      state.inv.settings = r.settings;
      toast('Settings saved');
      closeInvPanel();
      afterInvoicesChange();
    } catch (ex) {
      $('#ivErr').textContent = ex.message;
      $('#ivErr').hidden = false;
      btn.disabled = false;
    } finally {
      invp.busy = false;
    }
  }

  /* ---------------- home (dashboard) ---------------- */

  function renderHome() {
    const box = $('#homeView');
    if (!state.board) { box.innerHTML = '<div class="empty">Loading…</div>'; return; }
    const now = new Date();
    const today = dayKey(now);
    const opps = state.board.opportunities;
    const stages = state.board.pipeline.stages;
    const hour = now.getHours();
    const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const name = state.me.admin ? state.board.pipeline.name : state.me.name;
    const weekAgo = Date.now() - 7 * 864e5;
    const newLeads = opps.filter((o) => o.createdAt && new Date(o.createdAt) > weekAgo).length;
    const metaShare = opps.length ? Math.round((opps.filter((o) => isMeta(o)).length / opps.length) * 100) : 0;
    const ws = startOfWeek(now);
    const ms = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekJobs = allBookings().filter((b) => new Date(b.start) >= ws && new Date(b.start) < addDays(ws, 7)).length;
    const monthRev = revenue(ms, new Date(now.getFullYear(), now.getMonth() + 1, 1));
    const unpaid = invList().filter((v) => v.status !== 'paid');
    const outstanding = unpaid.reduce((t, v) => t + v.totals.total, 0);
    const todays = allBookings().filter((b) => dayKey(new Date(b.start)) === today);
    const upcoming = allBookings().filter((b) => new Date(b.start) > now && dayKey(new Date(b.start)) !== today).slice(0, 3);
    const firstStage = stages[0];
    const waiting = firstStage ? opps.filter((o) => o.stageId === firstStage.id) : [];
    const overdue = unpaid.filter(isOverdue);
    const approvedQ = quoteList().filter((v) => v.status === 'approved' && v.oppId && findOpp(v.oppId)
      && Date.now() - new Date(v.approvedAt) < 14 * 864e5 && !nextBooking(v.oppId));
    const waitingQ = quoteList().filter((v) => v.status === 'sent' && !isExpired(v));
    const attention = [
      ...approvedQ.slice(0, 3).map((v) => `<button type="button" class="att ok" data-sched="${esc(v.oppId)}">${icon('check')}<span><b class="nm">${esc(v.customer.name)}</b> approved quote ${esc(v.number)} · ${esc(money2f(v.totals.total))}. Schedule the job.</span>${icon('next')}</button>`),
      waitingQ.length && `<button type="button" class="att" data-go="invoices" data-bill="quotes"><b>${waitingQ.length}</b><span>${waitingQ.length === 1 ? 'quote' : 'quotes'} awaiting approval · ${esc(money2f(waitingQ.reduce((t, v) => t + v.totals.total, 0)))}</span>${icon('next')}</button>`,
      waiting.length && `<button type="button" class="att" data-go="leads" data-stage="${esc(firstStage.id)}"><b>${waiting.length}</b><span>${waiting.length === 1 ? 'lead' : 'leads'} in ${esc(firstStage.name)}. Call them first.</span>${icon('next')}</button>`,
      overdue.length && `<button type="button" class="att warn" data-go="invoices"><b>${overdue.length}</b><span>overdue ${overdue.length === 1 ? 'invoice' : 'invoices'} · ${esc(money2f(overdue.reduce((t, v) => t + v.totals.total, 0)))}</span>${icon('next')}</button>`,
    ].filter(Boolean).join('');
    box.innerHTML = `
      <div class="home-hello"><h2>${esc(hello)}${name ? `, ${esc(name)}` : ''}</h2><p>${esc(now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</p></div>
      <div class="home-kpis">
        <button type="button" class="kpi" data-go="leads"><span class="l">New leads · 7 days</span><b>${newLeads}</b><span class="s">${metaShare}% from Meta</span></button>
        <button type="button" class="kpi" data-go="calendar"><span class="l">Jobs this week</span><b>${weekJobs}</b><span class="s">${todays.length} today</span></button>
        <button type="button" class="kpi" data-go="calendar"><span class="l">Revenue this month</span><b>${esc(shortMoney(monthRev.total))}</b><span class="s">${monthRev.meta ? `${esc(shortMoney(monthRev.meta))} from Meta` : `${monthRev.jobs} priced ${monthRev.jobs === 1 ? 'job' : 'jobs'}`}</span></button>
        <button type="button" class="kpi" data-go="invoices"><span class="l">Unpaid invoices</span><b>${esc(shortMoney(outstanding))}</b><span class="s">${unpaid.length} open</span></button>
      </div>
      <div class="wrapup-slot"></div>
      ${attention ? `<div class="home-att">${attention}</div>` : ''}
      <div class="home-grid">
        <section class="home-card">
          <div class="hc-head"><h3>Today</h3><button class="btn sm ghost" type="button" data-home="book">${icon('plus')}Book</button></div>
          <div class="bk-list">${todays.length ? todays.map((b) => bkCard(b)).join('') : '<div class="bk-empty">Nothing booked today.</div>'}</div>
          ${upcoming.length ? `<h3 class="hc-sub">Coming up</h3><div class="bk-list">${upcoming.map((b) => bkCard(b, true)).join('')}</div>` : ''}
        </section>
        <section class="home-card">
          <div class="hc-head"><h3>Pipeline</h3><button class="btn sm ghost" type="button" data-go="leads">All leads</button></div>
          <div class="stage-tiles">${stages.map((s) => `<button type="button" class="stile" data-go="leads" data-stage="${esc(s.id)}">
            <b>${opps.filter((o) => o.stageId === s.id).length}</b><span>${esc(s.name)}</span></button>`).join('')}</div>
        </section>
        <section class="home-card">
          <div class="hc-head"><h3>Invoices</h3><button class="btn sm ghost" type="button" data-home="invoice">${icon('plus')}New</button></div>
          <div class="inv-list">${invList().slice(0, 3).map(invRow).join('') || '<div class="bk-empty">No invoices yet.</div>'}</div>
        </section>
      </div>`;
    renderWrapUp();
  }

  $('#homeView').addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]')) return;
    const sched = e.target.closest('[data-sched]');
    if (sched) { openBookingForm({ oppId: sched.dataset.sched, lockLead: true, closing: true }); return; }
    const go = e.target.closest('[data-go]');
    if (go) {
      if (go.dataset.bill) { billMode = go.dataset.bill; store.set('lt_billmode', billMode); invFilter = 'all'; }
      if (go.dataset.stage) { state.stage = go.dataset.stage; state.query = ''; $('#search').value = ''; }
      showView(go.dataset.go);
      return;
    }
    const h = e.target.closest('[data-home]');
    if (h) { if (h.dataset.home === 'book') openBookingForm({ day: dayKey(new Date()) }); else openInvoiceEditor(); return; }
    const card = e.target.closest('[data-bk]');
    if (card) { openBookingView(card.dataset.bk); return; }
    const inv = e.target.closest('[data-inv]');
    if (inv) openInvoiceView(inv.dataset.inv, inv.dataset.kind || 'invoice');
  });

  /* ---------------- admin: clients page ---------------- */

  const editor = { open: false, draft: null, busy: false };

  function showView(view) {
    state.view = view;
    $('#homeView').hidden = view !== 'home';
    $('#leadsView').hidden = view !== 'leads';
    $('#calView').hidden = view !== 'calendar';
    $('#invView').hidden = view !== 'invoices';
    $('#clientsView').hidden = view !== 'clients';
    $('#tabs').hidden = view === 'clients';
    $('#tabs').querySelectorAll('button').forEach((bt) => bt.classList.toggle('on', bt.dataset.view === view));
    $('#clientsBtn').classList.toggle('on', view === 'clients');
    $('#pipelinePick').hidden = view === 'clients' || !(state.me && state.me.admin);
    $('#refreshBtn').hidden = view === 'clients';
    if (view === 'home') renderHome();
    if (view === 'calendar') { renderCalendar(); loadBookings(); }
    if (view === 'invoices') renderInvoices();
    if (view === 'leads' && state.board) render();
    window.scrollTo(0, 0);
  }

  // Netlify storage can take up to a minute to list a change everywhere, so remember
  // this browser's recent saves/removals and lay them over the list for 2 minutes.
  const PENDING = 'lt_pending_clients';
  function pendingChanges() {
    try { return JSON.parse(sessionStorage.getItem(PENDING) || '[]').filter((x) => Date.now() - x.at < 120e3); } catch { return []; }
  }
  function rememberChange(entry) {
    const list = pendingChanges().filter((x) => x.u !== entry.u);
    list.push({ ...entry, at: Date.now() });
    try { sessionStorage.setItem(PENDING, JSON.stringify(list)); } catch { /* private mode */ }
  }
  function withPending(data) {
    for (const x of pendingChanges()) {
      data.clients = data.clients.filter((c) => c.u !== x.u);
      if (!x.removed && x.client) data.clients.push(x.client);
    }
    data.clients.sort((a, b) => a.n.localeCompare(b.n));
    return data;
  }

  async function openClients() {
    showView('clients');
    renderClients();
    try {
      state.clients = withPending(await api('clients'));
    } catch (ex) {
      state.clients = { error: ex.message };
    }
    renderClients();
  }

  $('#clientsBtn').addEventListener('click', () => {
    if (state.view === 'clients') { showView('leads'); loadBoard(true); } else openClients();
  });

  function clientCard(x) {
    const b = x.brand;
    const logo = b && b.hasLogo
      ? `<img src="${esc(b.assets)}/logo.png?v=${esc(b.v)}" alt="">`
      : `<span class="cc-initial" style="background:${esc((b && b.color) || '#2A3526')}">${esc(x.n.slice(0, 1).toUpperCase())}</span>`;
    const missing = x.pipelineName === 'Pipeline not found in GHL';
    return `<button class="client-card" type="button" data-u="${esc(x.u)}">
      <span class="cc-logo">${logo}</span>
      <span class="cc-main"><span class="cc-name">${esc(x.n)}</span>
        <span class="cc-meta${missing ? ' warn' : ''}">${esc(x.u)} · ${esc(x.pipelineName)}</span></span>
      ${b && b.color ? `<span class="cc-swatch" style="background:${esc(b.color)}"></span>` : ''}
    </button>`;
  }

  function renderClients() {
    const c = state.clients;
    let body;
    if (!c) body = '<div class="empty">Loading clients…</div>';
    else if (c.error) body = `<div class="err-box">${esc(c.error)}</div>`;
    else {
      const used = new Set(c.clients.map((x) => x.p));
      const free = c.pipelines.filter((p) => !used.has(p.id));
      body = (c.clients.length ? `<div class="client-list">${c.clients.map(clientCard).join('')}</div>`
        : '<div class="empty">No clients yet. Add your first one.</div>')
        + (free.length ? `<p class="cv-note">Pipelines with no client login: <b>${free.map((p) => esc(p.name)).join(', ')}</b></p>` : '')
        + (c.storage === 'eventual' ? '<p class="cv-note">New clients can log in right away. Password changes and removals can take a few minutes to apply everywhere.</p>' : '')
        + (c.storage === 'none' ? '<div class="err-box">Client storage is not connected on this deploy, so changes cannot be saved.</div>' : '');
    }
    $('#clientsView').innerHTML = `
      <button class="back-link" type="button" id="backToLeads">${icon('back')}Back to leads</button>
      <div class="cv-head">
        <div><h2>Clients</h2><p>Add a client, set their login and branding. Saved changes go live right away.</p></div>
        <button class="btn sm" type="button" id="addClientBtn"${c && !c.error ? '' : ' disabled'}>${icon('plus')}Add client</button>
      </div>${body}`;
  }

  $('#clientsView').addEventListener('click', (e) => {
    if (e.target.closest('#backToLeads')) { showView('leads'); loadBoard(true); return; }
    if (e.target.closest('#addClientBtn')) { openEditor(null); return; }
    const card = e.target.closest('.client-card');
    if (card) openEditor(state.clients.clients.find((x) => x.u === card.dataset.u));
  });

  /* ---- logo processing (in the browser, so any image becomes clean PNGs) ---- */

  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) { reject(new Error('Pick an image file (PNG, JPG, WebP or SVG).')); return; }
      if (file.size > 12 * 1024 * 1024) { reject(new Error('That image is over 12 MB. Try a smaller one.')); return; }
      const r = new FileReader();
      r.onerror = () => reject(new Error('Could not read that file.'));
      r.onload = () => {
        const img = new Image();
        img.onload = () => resolve({ img, svg: file.type === 'image/svg+xml' });
        img.onerror = () => reject(new Error('That file is not an image this browser can open.'));
        img.src = r.result;
      };
      r.readAsDataURL(file);
    });
  }

  const visible = (d, i) => d[i + 3] > 40 && !(d[i] > 242 && d[i + 1] > 242 && d[i + 2] > 242);
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; };
  const sat = (c) => { const mx = Math.max(...c); return mx ? (mx - Math.min(...c)) / mx : 0; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  function analyzeLogo({ img, svg }) {
    let w = img.naturalWidth || 1200;
    let h = img.naturalHeight || 600;
    const s = svg ? 1600 / Math.max(w, h) : Math.min(1, 1600 / Math.max(w, h));
    w = Math.round(w * s); h = Math.round(h * s);
    const c = canvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
    const col = new Uint32Array(w);
    const buckets = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!visible(d, i)) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        col[x]++;
        if (d[i + 3] >= 250) {
          const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
          let e = buckets.get(k);
          if (!e) { e = [0, 0, 0, 0]; buckets.set(k, e); }
          e[0] += d[i]; e[1] += d[i + 1]; e[2] += d[i + 2]; e[3]++;
        }
      }
    }
    if (x1 < 0) throw new Error('That logo looks empty or all white. Try a different file.');
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const pad = Math.round(Math.max(bw, bh) * 0.02);
    const trimmed = canvas(bw + pad * 2, bh + pad * 2);
    trimmed.getContext('2d').drawImage(c, x0, y0, bw, bh, pad, pad, bw, bh);

    const list = [...buckets.values()].map((e) => ({ c: [e[0], e[1], e[2]].map((v) => Math.round(v / e[3])), n: e[3] }))
      .sort((a, b) => b.n - a.n);
    const picked = [];
    for (const x of list) {
      if (picked.every((p) => dist(p.c, x.c) > 60)) picked.push(x);
      if (picked.length >= 6) break;
    }
    const top = picked[0] || { c: [124, 197, 33], n: 1 };
    const colorful = picked.find((p) => sat(p.c) > 0.3 && p.n >= top.n * 0.2);

    // Wide logos: if there is a clear gap after a symbol on the left, offer the symbol as the app icon.
    let mark = null;
    const ratio = trimmed.width / trimmed.height;
    if (ratio > 2.4) {
      for (let x = x0 + Math.round(bw * 0.08); x < x0 + Math.round(bw * 0.5); x++) {
        if (col[x] !== 0) continue;
        const mw = x - x0;
        if (mw >= bh * 0.5) {
          let my0 = h; let my1 = -1;
          for (let y = y0; y <= y1; y++) {
            for (let xx = x0; xx < x; xx++) {
              if (visible(d, (y * w + xx) * 4)) { if (y < my0) my0 = y; my1 = y; break; }
            }
          }
          if (my1 >= my0) {
            mark = canvas(mw, my1 - my0 + 1);
            mark.getContext('2d').drawImage(c, x0, my0, mw, mark.height, 0, 0, mw, mark.height);
          }
        }
        break;
      }
    }
    return { trimmed, ratio, mark, colors: picked.map((p) => hex(p.c)), main: hex((colorful || top).c) };
  }

  function fitPng(src, maxW, maxH) {
    const s = Math.min(1, maxW / src.width, maxH / src.height);
    const c = canvas(Math.round(src.width * s), Math.round(src.height * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  function iconPng(src, size, fill) {
    const c = canvas(size, size);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    const s = (size * fill) / Math.max(src.width, src.height);
    const w = src.width * s;
    const h = src.height * s;
    ctx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
    return c.toDataURL('image/png');
  }

  const b64 = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);

  function shortName(n) {
    if (n.length <= 12) return n;
    let out = '';
    for (const w of n.split(/\s+/)) {
      if ((out ? `${out} ${w}` : w).length > 12) break;
      out = out ? `${out} ${w}` : w;
    }
    return out || n.slice(0, 12);
  }

  function newPassword() {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    const r = new Uint32Array(12);
    crypto.getRandomValues(r);
    return Array.from(r, (v, i) => (i && i % 4 === 0 ? '-' : '') + a[v % a.length]).join('');
  }

  /* ---- editor ---- */

  function openEditor(client) {
    const used = new Map((state.clients.clients || []).map((x) => [x.p, x.n]));
    const firstFree = (state.clients.pipelines.find((p) => !used.has(p.id)) || state.clients.pipelines[0] || {}).id || '';
    const b = client && client.brand;
    editor.draft = {
      isNew: !client,
      u: client ? client.u : '',
      uTouched: false,
      n: client ? client.n : '',
      p: client ? client.p : firstFree,
      password: '',
      color: (b && b.color) || '#7CC521',
      colors: [],
      showName: !!(b && b.showName),
      logo: null,            // new upload: {trimmed, ratio, mark, ...}
      iconMode: 'full',
      existing: b && b.hasLogo ? b : null,
    };
    editor.open = true;
    renderEditor();
    $('#scrim').hidden = false;
    $('#editor').hidden = false;
    $('#editor').scrollTop = 0;
    if (!(history.state && history.state.editor)) history.pushState({ editor: 1 }, '');
    setTimeout(() => (client ? $('#cfPass') : $('#cfName')).focus(), 60);
  }

  function closeEditor(fromPop) {
    if (!editor.open) return;
    editor.open = false;
    editor.draft = null;
    $('#editor').hidden = true;
    $('#scrim').hidden = true;
    if (fromPop !== true && history.state && history.state.editor) backQuietly();
  }
  $('#editorClose').addEventListener('click', closeEditor);

  function logoSrc(dr) {
    if (dr.logo) return dr.logo.preview;
    if (dr.existing) return `${dr.existing.assets}/logo.png?v=${dr.existing.v}`;
    return '';
  }
  function iconSrc(dr) {
    if (dr.logo) return dr.iconMode === 'mark' && dr.logo.mark ? dr.logo.iconMark : dr.logo.iconFull;
    if (dr.existing) return `${dr.existing.assets}/apple-touch-icon.png?v=${dr.existing.v}`;
    return '/icons/apple-touch-icon.png';
  }
  const logoRatio = (dr) => (dr.logo ? dr.logo.ratio : (dr.existing ? dr.existing.logoRatio : 1));

  function renderEditor() {
    const dr = editor.draft;
    const used = new Map((state.clients.clients || []).filter((x) => x.u !== dr.u).map((x) => [x.p, x.n]));
    const opts = state.clients.pipelines.map((p) => `<option value="${esc(p.id)}"${p.id === dr.p ? ' selected' : ''}>${
      esc(p.name)}${used.has(p.id) ? ` (used by ${esc(used.get(p.id))})` : ''}</option>`).join('');
    $('#editorBody').innerHTML = `
      <h2 id="editorTitle">${dr.isNew ? 'Add client' : `Edit ${esc(dr.n)}`}</h2>
      <p class="sub">${dr.isNew ? 'They can log in as soon as you save.' : 'Changes go live as soon as you save.'}</p>
      <form class="cf" id="clientForm" autocomplete="off" novalidate>
        <label class="field"><span>Business name</span><input id="cfName" maxlength="80" value="${esc(dr.n)}" placeholder="Bright Home Care"></label>
        <label class="field"><span>Their GHL pipeline</span><select id="cfPipe">${opts}</select>
          <span class="hint">They only ever see leads in this pipeline.</span></label>
        <label class="field"><span>Username</span><input id="cfUser" maxlength="32" autocapitalize="none" autocorrect="off" spellcheck="false"
          value="${esc(dr.u)}"${dr.isNew ? '' : ' disabled'} placeholder="brighthomecare"></label>
        <div class="field"><span>${dr.isNew ? 'Password' : 'New password'}</span>
          <div class="pw-row"><input id="cfPass" maxlength="200" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="new-password"
            placeholder="${dr.isNew ? 'At least 6 characters' : 'Leave blank to keep it'}">
            <button class="btn sm ghost" type="button" id="cfGen">Generate</button></div></div>
        <div class="field"><span>Logo</span>
          <label class="drop" id="cfDrop"><input type="file" id="cfLogo" accept="image/png,image/jpeg,image/webp,image/svg+xml">
            ${icon('upload')}<b>${logoSrc(dr) ? 'Replace logo' : 'Upload logo'}</b><small>PNG with a transparent background works best. Extra space is trimmed for you.</small></label></div>
        <div class="field"><span>Brand colour</span>
          <div class="color-row"><input type="color" id="cfColor" value="${esc(dr.color)}" aria-label="Pick brand colour">
            <input id="cfHex" maxlength="7" value="${esc(dr.color)}" aria-label="Brand colour hex"><div class="swatches" id="cfSwatches"></div></div>
          <span class="hint">Used for buttons and highlights on their page.</span></div>
        <label class="check"><input type="checkbox" id="cfShowName"${dr.showName ? ' checked' : ''}> Show the business name next to the logo</label>
        <div class="field"><span>App icon on their phone</span>
          <div class="icon-row"><img id="cfIcon" alt="App icon preview"><div class="seg" id="cfIconMode" hidden>
            <button type="button" data-mode="full">Whole logo</button><button type="button" data-mode="mark">Symbol only</button></div></div></div>
        <div class="field"><span>Preview of their page</span><div class="pv client-scope" id="cfPreview"></div></div>
        <p class="err" id="cfErr" hidden></p>
        <button class="btn" type="submit" id="cfSave">${dr.isNew ? 'Add client' : 'Save changes'}</button>
        ${dr.isNew ? '' : '<button class="btn ghost danger" type="button" id="cfRemove">Remove client</button>'}
      </form>`;
    refreshPreview();
  }

  function refreshPreview() {
    const dr = editor.draft;
    if (!dr) return;
    const vars = brandVars(dr.color);
    const pv = $('#cfPreview');
    Object.entries(vars).forEach(([k, v]) => pv.style.setProperty(k, v));
    const src = logoSrc(dr);
    const wide = logoRatio(dr) > 2.6;
    pv.innerHTML = `
      <div class="pv-bar">${icon('mark')}Powered by <b>Lead<span>Thru</span></b></div>
      <div class="pv-top">${src ? `<img src="${esc(src)}" alt=""${wide ? ' class="wide"' : ''}>` : ''}${
        dr.showName || !src ? `<span>${esc(dr.n || 'Business name')}</span>` : ''}</div>
      <div class="pv-body">
        <div class="pv-chips"><span class="pv-chip">New Lead 4</span><span class="pv-chip off">Contacted 2</span></div>
        <div class="pv-card"><div><b>Jane Smith</b><small>(416) 555-0182 · 2h ago</small></div><i>${icon('phone')}</i></div>
        <span class="pv-btn">Add note</span>
      </div>`;
    $('#cfIcon').src = iconSrc(dr);
    const seg = $('#cfIconMode');
    seg.hidden = !(dr.logo && dr.logo.mark);
    seg.querySelectorAll('button').forEach((bt) => bt.classList.toggle('on', bt.dataset.mode === dr.iconMode));
    const sw = [...new Set([...(dr.colors || []), dr.color.toUpperCase()])].slice(0, 7);
    $('#cfSwatches').innerHTML = sw.map((c) => `<button type="button" class="swatch${c.toUpperCase() === dr.color.toUpperCase() ? ' on' : ''}"
      style="background:${esc(c)}" data-color="${esc(c)}" aria-label="Use ${esc(c)}"></button>`).join('');
    $('#cfColor').value = dr.color;
    if (document.activeElement !== $('#cfHex')) $('#cfHex').value = dr.color.toUpperCase();
  }

  const slugify = (n) => n.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').slice(0, 32);

  function setColor(c) {
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
    editor.draft.color = c.toUpperCase();
    refreshPreview();
  }

  $('#editorBody').addEventListener('input', (e) => {
    const dr = editor.draft;
    if (!dr) return;
    const id = e.target.id;
    if (id === 'cfName') {
      dr.n = e.target.value;
      if (dr.isNew && !dr.uTouched) { dr.u = slugify(dr.n); $('#cfUser').value = dr.u; }
      refreshPreview();
    } else if (id === 'cfUser') { dr.uTouched = true; dr.u = e.target.value.toLowerCase().trim(); }
    else if (id === 'cfPass') dr.password = e.target.value;
    else if (id === 'cfPipe') dr.p = e.target.value;
    else if (id === 'cfColor') setColor(e.target.value);
    else if (id === 'cfHex') { const v = e.target.value.trim(); setColor(v.startsWith('#') ? v : `#${v}`); }
    else if (id === 'cfShowName') { dr.showName = e.target.checked; refreshPreview(); }
  });
  $('#editorBody').addEventListener('change', async (e) => {
    const dr = editor.draft;
    if (!dr) return;
    if (e.target.id === 'cfPipe') dr.p = e.target.value;
    if (e.target.id === 'cfShowName') { dr.showName = e.target.checked; refreshPreview(); }
    if (e.target.id !== 'cfLogo' || !e.target.files[0]) return;
    const err = $('#cfErr');
    err.hidden = true;
    try {
      const a = analyzeLogo(await readImage(e.target.files[0]));
      a.preview = fitPng(a.trimmed, 900, 192);
      a.iconFull = iconPng(a.trimmed, 180, 0.74);
      a.iconMark = a.mark ? iconPng(a.mark, 180, 0.74) : null;
      dr.logo = a;
      dr.iconMode = a.mark ? 'mark' : 'full';
      dr.colors = a.colors;
      dr.color = a.main.toUpperCase();
      if (a.ratio < 1.3) { dr.showName = true; $('#cfShowName').checked = true; }
      $('#cfDrop b').textContent = 'Replace logo';
      refreshPreview();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
    e.target.value = '';
  });
  $('#editorBody').addEventListener('click', async (e) => {
    const dr = editor.draft;
    if (!dr) return;
    const sw = e.target.closest('.swatch');
    if (sw) { setColor(sw.dataset.color); return; }
    const mode = e.target.closest('#cfIconMode button');
    if (mode) { dr.iconMode = mode.dataset.mode; refreshPreview(); return; }
    if (e.target.closest('#cfGen')) { dr.password = newPassword(); $('#cfPass').value = dr.password; return; }
    if (e.target.closest('#cfRemove')) {
      if (!window.confirm(`Remove ${dr.n}? They will not be able to log in any more. Their leads in GHL are not touched.`)) return;
      try {
        await api('clients', { action: 'remove', u: dr.u });
        rememberChange({ u: dr.u, removed: true });
        state.clients.clients = state.clients.clients.filter((x) => x.u !== dr.u);
        toast(`${dr.n} removed`);
        closeEditor();
        renderClients();
      } catch (ex) { toast(ex.message, true); }
    }
  });
  $('#editorBody').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dr = editor.draft;
    if (!dr || editor.busy) return;
    const err = $('#cfErr');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    err.hidden = true;
    if (!dr.n.trim()) return fail('Add the business name.');
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(dr.u)) return fail('Username: 2–32 lowercase letters or numbers, no spaces.');
    if (dr.isNew && dr.password.length < 6) return fail('Set a password with at least 6 characters.');
    if (!dr.isNew && dr.password && dr.password.length < 6) return fail('New passwords need at least 6 characters.');
    const brand = { color: dr.color, showName: dr.showName, short: shortName(dr.n.trim()) };
    if (dr.logo) {
      const src = dr.iconMode === 'mark' && dr.logo.mark ? dr.logo.mark : dr.logo.trimmed;
      brand.ratio = Math.round(dr.logo.ratio * 1000) / 1000;
      brand.files = {
        logo: b64(dr.logo.preview),
        icon192: b64(iconPng(src, 192, 0.72)),
        icon512: b64(iconPng(src, 512, 0.72)),
        maskable: b64(iconPng(src, 512, 0.56)),
        apple: b64(iconPng(src, 180, 0.74)),
      };
    }
    const btn = $('#cfSave');
    editor.busy = true;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const r = await api('clients', {
        action: 'save', isNew: dr.isNew, u: dr.u, n: dr.n.trim(), p: dr.p, password: dr.password || undefined, brand,
      });
      rememberChange({ u: r.client.u, client: r.client });
      const list = state.clients.clients.filter((x) => x.u !== r.client.u);
      list.push(r.client);
      list.sort((a, b) => a.n.localeCompare(b.n));
      state.clients.clients = list;
      toast(dr.isNew ? `${r.client.n} added. They can log in now.` : `${r.client.n} saved`);
      closeEditor();
      renderClients();
    } catch (ex) {
      fail(ex.message);
      btn.disabled = false;
      btn.textContent = dr.isNew ? 'Add client' : 'Save changes';
    } finally {
      editor.busy = false;
    }
  });

  /* ---------------- add to home screen ---------------- */

  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    if (state.me) setupInstallHint();
  });

  function setupInstallHint() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone || store.get('lt_install_x')) return;
    const ua = navigator.userAgent;
    const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    const box = $('#installHint');
    if (installEvent) {
      $('#installText').textContent = 'Open it like an app, one tap from your home screen.';
      $('#installBtn').hidden = false;
      box.hidden = false;
    } else if (ios) {
      $('#installText').innerHTML = `Tap ${icon('share', 'inline')} <b>Share</b>, then <b>Add to Home Screen</b>.`;
      $('#installBtn').hidden = true;
      box.hidden = false;
    }
  }
  $('#installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => null);
    installEvent = null;
    $('#installHint').hidden = true;
  });
  $('#installClose').addEventListener('click', () => {
    store.set('lt_install_x', '1');
    $('#installHint').hidden = true;
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  /* ---------------- go ---------------- */

  start().catch(() => { if (!state.me) showLogin(); });
})();
