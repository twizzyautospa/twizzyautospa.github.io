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
  };

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
    showView('leads');
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
    $('#board').innerHTML = '';
    $('#chips').innerHTML = '';
    $('#summary').innerHTML = '';
    loadBoard();
  });

  // Keep it live: refresh every minute while open, and when coming back to the app.
  setInterval(() => {
    if (state.me && !state.openId && state.view !== 'clients' && document.visibilityState === 'visible') loadBoard(true);
  }, 60e3);
  document.addEventListener('visibilitychange', () => {
    if (state.me && document.visibilityState === 'visible' && Date.now() - state.lastFetch > 20e3 && !state.openId && state.view !== 'clients') loadBoard(true);
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
      stageName && `<span>${esc(stageName)}</span>`,
      o.contact.phone && `<span>${esc(phonePretty(o.contact.phone))}</span>`,
      `<span>${esc(ago(o.createdAt))}</span>`,
      o.value > 0 && `<span class="val">${esc(money(o.value))}</span>`,
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
    $('#summary').innerHTML = `
      <div class="stat"><div class="n">${opps.length}</div><div class="l">Total leads</div></div>
      <div class="stat hi"><div class="n">${newCount}</div><div class="l">This week</div></div>
      <div class="stat"><div class="n">${esc(money(total))}</div><div class="l">Job value</div></div>`;

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

  DESKTOP.addEventListener('change', render);

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
    if (fromPop !== true && history.state && history.state.sheet) history.back();
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

      <div class="sec"><h3>Move to stage</h3><div class="stages" id="sheetStages">${stageButtons}</div></div>

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
      </div>`;
    renderNotes(o.id);
  }

  function subLine(o, stage) {
    return [stage.name, o.createdAt && `came in ${ago(o.createdAt)}`, o.source].filter(Boolean).join(' · ');
  }

  $('#sheetBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-move]');
    if (b && state.openId) moveTo(state.openId, b.dataset.move);
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
  $('#scrim').addEventListener('click', () => (editor.open ? closeEditor() : closeSheet()));
  window.addEventListener('popstate', () => (editor.open ? closeEditor(true) : closeSheet(true)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (editor.open) closeEditor(); else closeSheet(); } });

  /* ---------------- admin: clients page ---------------- */

  const editor = { open: false, draft: null, busy: false };

  function showView(view) {
    state.view = view;
    const clients = view === 'clients';
    $('#leadsView').hidden = clients;
    $('#chips').hidden = clients;
    $('#board').hidden = clients;
    $('#clientsView').hidden = !clients;
    $('#clientsBtn').classList.toggle('on', clients);
    $('#pipelinePick').hidden = clients || !(state.me && state.me.admin);
    $('#refreshBtn').hidden = clients;
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
    if (fromPop !== true && history.state && history.state.editor) history.back();
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
