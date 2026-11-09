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
    const base = `/brands/${encodeURIComponent(b.slug)}`;
    const img = $('#clientLogo');
    img.src = `${base}/logo.png`;
    img.alt = b.name;
    img.classList.toggle('wide', (b.logoRatio || 1) > 2.6);
    $('#clientName').textContent = b.name;
    $('#clientName').hidden = !b.showName;
    $('#clientBrand').hidden = false;
    $('#ltBrand').hidden = true;
    $('#who').hidden = true;
    $('#ltBar').hidden = false;
    $('#ltFoot').hidden = false;
    setHead({
      manifest: `${base}/manifest.webmanifest`, touch: `${base}/apple-touch-icon.png`, icon: `${base}/icon-192.png`,
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
    if (state.me && !state.openId && document.visibilityState === 'visible') loadBoard(true);
  }, 60e3);
  document.addEventListener('visibilitychange', () => {
    if (state.me && document.visibilityState === 'visible' && Date.now() - state.lastFetch > 20e3 && !state.openId) loadBoard(true);
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
  $('#scrim').addEventListener('click', closeSheet);
  window.addEventListener('popstate', () => closeSheet(true));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

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
