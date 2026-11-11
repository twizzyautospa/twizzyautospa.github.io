// Customer-facing quote page: /q?t=<signed token>. No login; the link itself is the key.
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const root = $('#root');
  const token = new URLSearchParams(window.location.search).get('t') || '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = (ymd) => (ymd ? new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '');
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '');
  const phone = (p) => {
    const d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    return p || '';
  };
  let q = null;
  let declining = false;

  function brand(color) {
    const hex = String(color || '#1F2937').replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    const lum = 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    const r = document.documentElement.style;
    r.setProperty('--brand', `#${hex}`);
    r.setProperty('--on-brand', lum > 0.45 ? '#141414' : '#ffffff');
    let t = c.slice();
    const contrast = (a) => { const l = 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]); return 1.05 / (l + 0.05); };
    for (let i = 0; i < 30 && contrast(t) < 4.5; i++) t = t.map((v) => Math.round(v * 0.94));
    r.setProperty('--brand-text', `rgb(${t.join(',')})`);
  }

  async function call(method, body) {
    const res = await fetch(`/api/quote-public${method === 'GET' ? `?t=${encodeURIComponent(token)}` : ''}`, {
      method,
      headers: method === 'GET' ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ ...body, t: token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  function render() {
    const b = q.business;
    document.title = `Quote ${q.number}${b.name ? ` · ${b.name}` : ''}`;
    const open = (q.status === 'sent' || q.status === 'draft') && !q.expired;
    const banner = q.status === 'approved'
      ? `<div class="banner ok">✓ Approved by ${esc(q.approvedName)} on ${esc(when(q.approvedAt))}. ${esc(b.name || 'We')} will be in touch to schedule your job.</div>`
      : q.status === 'declined' ? `<div class="banner bad">This quote was declined${q.declinedAt ? ` on ${esc(when(q.declinedAt))}` : ''}.</div>`
        : q.expired ? `<div class="banner warn">This quote expired on ${esc(day(q.validUntil))}. Contact ${esc(b.name || 'us')} for an updated quote.</div>` : '';
    const from = [b.address, phone(b.phone), b.email, b.website, b.taxNumber ? `${b.taxNumberLabel || 'Tax #'} ${b.taxNumber}` : ''].filter(Boolean).join('\n');
    const t = q.totals;
    root.innerHTML = `
      <section class="card">
        <div class="head">
          <div>${q.brand && q.brand.logo ? `<img class="logo" src="${esc(q.brand.logo)}" alt="${esc(b.name)}">` : `<div class="biz-name">${esc(b.name)}</div>`}</div>
          <div class="qmeta"><h1>Quote</h1><p><b># ${esc(q.number)}</b></p><p>Issued ${esc(day(q.issueDate))}</p>
            ${q.validUntil ? `<p>Valid until ${esc(day(q.validUntil))}</p>` : ''}</div>
        </div>
        ${banner}
        <div class="parties">
          <div><p class="label">From</p><p><b>${esc(b.name)}</b>\n${esc(from)}</p></div>
          <div><p class="label">Prepared for</p><p><b>${esc(q.customer.name)}</b>${q.customer.address ? `\n${esc(q.customer.address)}` : ''}</p></div>
        </div>
        ${q.customFields.length ? `<dl class="details">${q.customFields.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl>` : ''}
        <table>
          <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
          <tbody>${q.lines.map((l) => `<tr><td>${esc(l.desc || '—')}</td><td class="num" data-l="Qty">${esc(l.qty)}</td>
            <td class="num" data-l="Price">${esc(money(l.price))}</td><td class="num amt" data-l="Amount">${esc(money(l.qty * l.price))}</td></tr>`).join('')}</tbody>
        </table>
        <div class="totals">
          <div><span>Subtotal</span><b>${esc(money(t.subtotal))}</b></div>
          ${t.discount ? `<div><span>Discount</span><b>-${esc(money(t.discount))}</b></div>` : ''}
          ${q.taxRate ? `<div><span>${esc(q.taxName || 'Tax')} (${esc(q.taxRate)}%)</span><b>${esc(money(t.tax))}</b></div>` : ''}
          <div class="grand"><span>Total</span><b>${esc(money(t.total))}</b></div>
        </div>
        ${q.notes ? `<div class="block"><p class="label">Notes</p><p>${esc(q.notes)}</p></div>` : ''}
        ${b.terms ? `<div class="block"><p class="label">Terms</p><p>${esc(b.terms)}</p></div>` : ''}
      </section>
      ${open ? `<section class="card approve" id="approveCard">
        ${declining ? `
          <h2>Decline this quote</h2>
          <p>Let ${esc(b.name || 'us')} know why, so they can help. (Optional)</p>
          <label class="field"><span>Reason</span><textarea id="why" rows="3" maxlength="300" placeholder="Went with another company, timing, budget…"></textarea></label>
          <p class="err" id="err" hidden></p>
          <div class="row"><button class="btn ghost" type="button" id="backBtn">Back</button><button class="btn" type="button" id="declineBtn">Decline quote</button></div>`
        : `
          <h2>Ready to go ahead?</h2>
          <p>Approve the quote and ${esc(b.name || 'we')} will reach out to schedule your job.</p>
          <label class="field"><span>Your full name</span><input id="name" autocomplete="name" maxlength="80" value="${esc(q.customer.name)}"></label>
          <label class="check"><input type="checkbox" id="agree"> I accept this quote of ${esc(money(t.total))} and its terms.</label>
          <p class="err" id="err" hidden></p>
          <button class="btn" type="button" id="approveBtn">Approve quote</button>
          <div style="text-align:center"><button class="linkbtn" type="button" id="declineLink">I'd like to decline</button></div>`}
      </section>` : ''}
      <div class="row"><a class="btn ghost" href="${esc(q.pdf)}" target="_blank" rel="noopener">Download PDF</a></div>
      <p class="foot">${esc([b.name, phone(b.phone), b.email].filter(Boolean).join(' · '))}
        ${b.phone ? `<br><a href="tel:${esc(b.phone)}">Call</a> · <a href="sms:${esc(b.phone)}">Text</a>` : ''}
        <span class="powered">Powered by LeadThru</span></p>`;
  }

  function fail(msg) {
    const err = $('#err');
    if (err) { err.textContent = msg; err.hidden = false; }
  }

  root.addEventListener('click', async (e) => {
    const id = e.target.id;
    if (id === 'declineLink') { declining = true; render(); return; }
    if (id === 'backBtn') { declining = false; render(); return; }
    if (id === 'approveBtn') {
      const name = $('#name').value.trim();
      if (name.length < 2) { fail('Type your full name to approve.'); return; }
      if (!$('#agree').checked) { fail('Tick the box to accept the quote.'); return; }
      e.target.disabled = true;
      e.target.textContent = 'Approving…';
      try {
        q = await call('POST', { action: 'approve', name, agree: true });
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (ex) {
        fail(ex.message);
        e.target.disabled = false;
        e.target.textContent = 'Approve quote';
      }
    }
    if (id === 'declineBtn') {
      e.target.disabled = true;
      try {
        q = await call('POST', { action: 'decline', reason: $('#why').value.trim() });
        declining = false;
        render();
      } catch (ex) {
        fail(ex.message);
        e.target.disabled = false;
      }
    }
  });

  (async () => {
    if (!token) { root.innerHTML = '<div class="fail"><b>This link is incomplete.</b>Please open the full link you were sent.</div>'; return; }
    try {
      q = await call('GET');
      brand(q.brand && q.brand.color);
      render();
    } catch (ex) {
      root.innerHTML = `<div class="fail"><b>We couldn't open this quote.</b>${esc(ex.message)}</div>`;
    }
  })();
})();
