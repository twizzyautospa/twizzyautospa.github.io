import { $, api, applyBrand, busy, COLOR_LABELS, dateOnly, describeRequest, esc, html, money, raw, SCOPE_LABELS, SERVICE_LABELS, setHtml } from "./lib.js";

const token = decodeURIComponent(location.pathname.split("/")[2] || "");
const COLORS = ["warm", "cool", "multi"];

let data = null;
let view = "";        // which image is showing: a colour key, or "before"
let editing = false;  // "change what's lit" panel open
let pollTimer = 0;

async function load() {
  data = await api(`public/lead/${encodeURIComponent(token)}`);
  return data;
}

function brand() {
  const { installer } = data;
  applyBrand(installer.brand.color);
  document.title = `Your lighting preview · ${installer.companyName}`;
  setHtml($("#brand-id"), installer.brand.logo
    ? html`<img src="${installer.brand.logo}" alt="${installer.companyName}">`
    : html`<span>${installer.companyName}</span>`);
  if (installer.phone) {
    const phone = $("#brand-phone");
    phone.hidden = false;
    phone.href = `tel:${installer.phone.replace(/[^\d+]/g, "")}`;
    phone.textContent = installer.phone;
  }
}

/* ---------- preview viewer ---------- */
function viewer() {
  const { lead } = data;
  const { previews, photos } = lead;
  const ready = COLORS.filter((c) => previews.colors[c]);

  if (previews.status === "pending") {
    return html`
      <section class="viewer">
        <div class="making">
          <div class="lights" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
          <h2>Hanging the lights on your home…</h2>
          <p style="margin-top:8px;opacity:.8">This usually takes under a minute. Keep this page open.</p>
        </div>
      </section>`;
  }

  if (!ready.length) {
    if (!photos.length) return "";
    return html`
      <section class="viewer">
        <div class="viewer-stage"><img src="${photos[0]}" alt="Your home"><span class="viewer-tag">Your photo</span></div>
      </section>
      <p class="notice notice-info">${data.installer.companyName} will send your lighting preview together with your quote.</p>`;
  }

  if (!view || (view !== "before" && !previews.colors[view])) {
    view = previews.colors[lead.selections.color] ? lead.selections.color : ready[0];
  }
  const src = view === "before" ? photos[0] : previews.colors[view];
  const alt = view === "before" ? "Your home as it is today" : `Your home with ${COLOR_LABELS[view].toLowerCase()} lights`;
  return html`
    <section class="viewer">
      <div class="viewer-stage">
        <img src="${src}" alt="${alt}">
        <span class="viewer-tag">${view === "before" ? "Before" : "Illustration only"}</span>
      </div>
      <div class="viewer-tabs" role="group" aria-label="Choose a look">
        ${COLORS.map((c) => html`<button type="button" data-view="${c}" aria-pressed="${String(view === c)}" ${raw(previews.colors[c] ? "" : "disabled")}>${COLOR_LABELS[c]}</button>`)}
        ${photos.length ? html`<button type="button" data-view="before" aria-pressed="${String(view === "before")}">Before</button>` : ""}
      </div>
    </section>`;
}

function editPanel() {
  const { lead } = data;
  const canEdit = lead.status === "new" && lead.previews.status === "ready" && lead.previews.regensLeft > 0;
  if (!canEdit) return "";
  if (!editing) {
    return html`<div class="center"><button type="button" class="btn btn-secondary" id="edit-open">Change what's lit</button></div>`;
  }
  const s = lead.selections;
  const option = (value, label, current) => html`<option value="${value}" ${raw(value === current ? "selected" : "")}>${label}</option>`;
  return html`
    <section class="card stack">
      <h2>Change what's lit</h2>
      <div class="form-grid">
        <label class="field"><span>Light up</span>
          <select id="edit-service">${Object.entries(SERVICE_LABELS).map(([v, l]) => option(v, l, s.service))}</select>
        </label>
        <label class="field"><span>Roofline</span>
          <select id="edit-scope">${Object.entries(SCOPE_LABELS).map(([v, l]) => option(v, l, s.scope))}</select>
        </label>
      </div>
      <p class="small muted">You can update your preview ${lead.previews.regensLeft} more time${lead.previews.regensLeft === 1 ? "" : "s"}. Your estimate updates too.</p>
      <div class="row">
        <button type="button" class="btn" id="edit-apply">Update my preview</button>
        <button type="button" class="btn btn-ghost" id="edit-cancel">Cancel</button>
      </div>
    </section>`;
}

/* ---------- price, quote and booking ---------- */
function priceCard() {
  const { lead, installer } = data;
  const company = installer.companyName;

  if (lead.status === "booked" || lead.status === "completed") {
    return html`
      <section class="card stack">
        <p class="notice notice-good"><strong>You're booked.</strong> ${company} will be in touch to confirm the details.</p>
        ${lead.booking ? html`<div><div class="section-title">Install date</div><div class="price" style="font-size:1.4rem">${dateOnly(lead.booking.date)}</div></div>` : ""}
        ${lead.quote ? quoteTable(lead.quote) : ""}
      </section>`;
  }

  if (lead.status === "declined") {
    return html`<section class="card stack"><h2>Quote declined</h2><p class="muted">No problem. If you change your mind, contact ${company}${installer.phone ? html` on <a href="tel:${installer.phone.replace(/[^\d+]/g, "")}">${installer.phone}</a>` : ""}.</p></section>`;
  }

  if (lead.quote && lead.status === "quoted") {
    const q = lead.quote;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return html`
      <section class="card stack" id="quote">
        <div>
          <div class="section-title">${q.auto ? "Your price" : `Your quote from ${company}`}</div>
          <div class="price">${money(q.total, q.total % 1 !== 0)}</div>
          <p class="small muted">${describeRequest(lead.selections)}</p>
        </div>
        ${quoteTable(q)}
        ${q.note ? html`<p class="notice notice-info" style="white-space:pre-line">${q.note}</p>` : ""}
        <form id="accept-form" class="stack">
          <div>
            <div class="field-label" id="date-label">${q.dates.length ? "Choose your install date" : "Preferred install date"}</div>
            ${q.dates.length
              ? html`<div class="date-choices" role="radiogroup" aria-labelledby="date-label">${q.dates.map((d, i) => html`<label><input type="radio" name="date" value="${d}" ${raw(i === 0 ? "checked" : "")}> ${dateOnly(d)}</label>`)}</div>`
              : html`<input type="date" name="date" min="${tomorrow}" required aria-labelledby="date-label">`}
          </div>
          <p class="error-text" id="accept-error" role="alert" hidden></p>
          <button type="submit" class="btn btn-lg btn-block">Accept and book</button>
          <button type="button" class="btn btn-ghost btn-block" id="decline">No thanks</button>
        </form>
      </section>`;
  }

  if (lead.estimate) {
    const same = lead.estimate.low === lead.estimate.high;
    return html`
      <section class="card stack">
        <div>
          <div class="section-title">Estimated price</div>
          <div class="price">${same ? html`From ${money(lead.estimate.low)}` : html`${money(lead.estimate.low)} – ${money(lead.estimate.high)}`}</div>
          <p class="small muted">${describeRequest(lead.selections)}</p>
        </div>
        <p class="notice notice-info"><strong>What happens next:</strong> ${company} measures your roofline and sends your exact price to this page${lead.firstName ? html`, ${lead.firstName}` : ""}. Keep this link.</p>
      </section>`;
  }

  return html`
    <section class="card stack">
      <h2>Thanks${lead.firstName ? html`, ${lead.firstName}` : ""}. Your request is in.</h2>
      <p class="muted">${describeRequest(lead.selections)}</p>
      <p class="notice notice-info">${company} is preparing your quote and will send it to this page. Keep this link.</p>
    </section>`;
}

function quoteTable(q) {
  return html`
    <table class="quote-table">
      <thead><tr><th>Item</th><th>Amount</th></tr></thead>
      <tbody>
        ${q.items.map((item) => html`<tr><td>${item.label}<div class="small muted num">${item.qty}${item.unit ? html` ${item.unit}` : ""} × ${money(item.unitPrice, true)}</div></td><td class="num">${money(item.qty * item.unitPrice, true)}</td></tr>`)}
      </tbody>
      <tfoot><tr><td>Total</td><td class="num">${money(q.total, true)}</td></tr></tfoot>
    </table>`;
}

/* ---------- render ---------- */
function render() {
  const { lead, installer } = data;
  const heading = lead.status === "quoted" && lead.quote && !lead.quote.auto
    ? "Your quote is ready"
    : lead.previews.status === "pending"
      ? "Almost there"
      : lead.previews.status === "ready"
        ? "Here's your home, lit up"
        : "Thanks, we've got your request";
  setHtml($("#main"), html`
    <div>
      <h1>${heading}</h1>
      <p class="muted" style="margin-top:6px">${lead.address}</p>
    </div>
    ${viewer()}
    ${editPanel()}
    ${priceCard()}
    ${installer.phone ? html`<div class="center"><a class="btn btn-secondary" href="tel:${installer.phone.replace(/[^\d+]/g, "")}">Call ${installer.companyName}</a></div>` : ""}
    <p class="footnote">The lighting image is an illustration made from your photo. Your installer confirms the final design and price.</p>
  `);
  schedulePoll();
}

/** Keep the page fresh while something is still expected: a preview being made, or a quote on its way. */
function schedulePoll() {
  clearTimeout(pollTimer);
  const { lead } = data;
  const waitingPreview = lead.previews.status === "pending";
  const waitingQuote = lead.status === "new";
  if (!waitingPreview && !waitingQuote) return;
  pollTimer = setTimeout(async () => {
    if (document.hidden || editing) return schedulePoll();
    const before = JSON.stringify(data.lead);
    try {
      await load();
    } catch {
      return schedulePoll();
    }
    if (JSON.stringify(data.lead) !== before) render();
    else schedulePoll();
  }, waitingPreview ? 3000 : 20000);
}

$("#main").addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-view]");
  if (tab) {
    view = tab.dataset.view;
    return render();
  }
  if (event.target.id === "edit-open") { editing = true; return render(); }
  if (event.target.id === "edit-cancel") { editing = false; return render(); }
  if (event.target.id === "edit-apply") {
    return busy(event.target, async () => {
      data = await api(`public/lead/${encodeURIComponent(token)}/regenerate`, {
        method: "POST",
        body: { service: $("#edit-service").value, scope: $("#edit-scope").value },
      });
      editing = false;
      view = "";
      render();
    });
  }
  if (event.target.id === "decline") {
    if (!confirm("Decline this quote?")) return;
    return busy(event.target, async () => {
      data = await api(`public/lead/${encodeURIComponent(token)}/decline`, { method: "POST", body: {} });
      render();
    });
  }
});

$("#main").addEventListener("submit", async (event) => {
  if (event.target.id !== "accept-form") return;
  event.preventDefault();
  const form = event.target;
  const date = new FormData(form).get("date");
  const errorBox = $("#accept-error");
  errorBox.hidden = true;
  if (!date) {
    errorBox.textContent = "Choose an install date.";
    errorBox.hidden = false;
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.classList.add("is-busy");
  try {
    data = await api(`public/lead/${encodeURIComponent(token)}/accept`, { method: "POST", body: { date } });
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    button.disabled = false;
    button.classList.remove("is-busy");
  }
});

load()
  .then(() => { brand(); render(); })
  .catch((error) => {
    $("#main").innerHTML = `<div class="card center" style="margin-top:30px"><h1>We could not find that page</h1><p class="muted" style="margin-top:8px">${esc(error.message)}</p></div>`;
  });
