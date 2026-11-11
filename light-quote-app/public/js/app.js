import {
  $, $$, api, busy, COLOR_LABELS, copyText, dateOnly, dateTime, describeRequest, html, money, raw, SCOPE_LABELS,
  SERVICE_LABELS, setHtml, SIZE_LABELS, STATUS_LABELS, TILES, timeAgo, toast,
} from "./lib.js";

const page = $("#page");
let account = null;
let leads = [];
let filter = "all";
let lead = null;       // lead open in the detail view
let draft = null;      // quote being edited
let measure = null;    // { map, lines, current, layer }
let sent = null;       // customer link shown after sending a quote

/* ---------- boot and navigation ---------- */
async function boot() {
  const me = await api("auth/me");
  if (me.session?.role !== "installer") {
    location.href = me.session?.role === "admin" ? "/admin" : "/login";
    return;
  }
  $("#admin-banner").hidden = !me.session.viaAdmin;
  const [platform, acct] = await Promise.all([api("public/platform"), api("installer/account")]);
  account = acct;
  setHtml($("#logo"), html`${account.companyName}<small>${platform.name}</small>`);
  document.title = `${account.companyName} · Dashboard`;
  window.addEventListener("hashchange", navigate);
  navigate();
}

function navigate() {
  const hash = location.hash.slice(1);
  const leadId = hash.startsWith("lead=") ? hash.slice(5) : "";
  const section = leadId ? "leads" : hash === "settings" ? "settings" : "leads";
  $$("[data-nav]").forEach((b) => (b.dataset.nav === section ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  if (measure?.map) { measure.map.remove(); measure = null; }
  if (leadId) return showLead(leadId);
  if (section === "settings") return showSettings();
  return showLeads();
}

$$("[data-nav]").forEach((button) => button.addEventListener("click", () => (location.hash = button.dataset.nav)));
$("#share").addEventListener("click", () => copyText(account.quoteLink));
$("#logout").addEventListener("click", async () => {
  await api("auth/logout", { method: "POST", body: {} });
  location.href = "/login";
});
$("#return-admin").addEventListener("click", async () => {
  await api("auth/return-to-admin", { method: "POST", body: {} });
  location.href = "/admin";
});

const pill = (status) => html`<span class="pill pill-${status}">${STATUS_LABELS[status] || status}</span>`;
const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, "")}`;

/* ---------- leads list ---------- */
async function showLeads() {
  setHtml(page, html`<div class="empty">Loading leads…</div>`);
  ({ leads } = await api("installer/leads"));
  renderLeads();
}

function renderLeads() {
  const counts = { all: leads.length };
  for (const l of leads) counts[l.status] = (counts[l.status] || 0) + 1;
  const shown = filter === "all" ? leads : leads.filter((l) => l.status === filter);
  const bookedValue = leads.filter((l) => ["booked", "completed"].includes(l.status)).reduce((sum, l) => sum + (l.quoteTotal || 0), 0);
  const chip = (key, label) => html`<button type="button" class="chip" data-filter="${key}" aria-pressed="${String(filter === key)}">${label}<span class="count">${counts[key] || 0}</span></button>`;

  setHtml(page, html`
    <div class="page-head">
      <h1>Leads</h1>
      <div class="copy-row" style="min-width:min(100%,420px)">
        <input type="text" readonly value="${account.quoteLink}" aria-label="Your quote link">
        <button type="button" class="btn btn-secondary" id="copy-link">Copy</button>
        <a class="btn btn-secondary" href="${account.quoteLink}" target="_blank" rel="noopener">Open</a>
      </div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="label">Needs a quote</div><div class="value">${counts.new || 0}</div></div>
      <div class="tile"><div class="label">Quotes out</div><div class="value">${counts.quoted || 0}</div></div>
      <div class="tile"><div class="label">Booked</div><div class="value">${(counts.booked || 0) + (counts.completed || 0)}</div></div>
      <div class="tile"><div class="label">Booked value</div><div class="value">${money(bookedValue)}</div></div>
    </div>
    <div class="chips" role="group" aria-label="Filter by status">
      ${chip("all", "All")}${Object.entries(STATUS_LABELS).map(([key, label]) => chip(key, label))}
    </div>
    <div class="table-wrap">
      ${shown.length ? html`
        <table class="data">
          <thead><tr><th>Customer</th><th>Wants</th><th>Price</th><th>Status</th><th>Received</th></tr></thead>
          <tbody>
            ${shown.map((l) => html`
              <tr class="clickable" data-lead="${l.id}" tabindex="0">
                <td><strong>${l.customerName}</strong><div class="small muted">${l.address || "No address"}</div></td>
                <td>${SERVICE_LABELS[l.service] || "-"}${l.hasPhotos ? "" : html`<div class="tiny muted">No photo</div>`}</td>
                <td class="num nowrap">${l.quoteTotal != null ? money(l.quoteTotal) : l.estimate ? html`<span class="muted">${money(l.estimate.low)}–${money(l.estimate.high)}</span>` : "-"}</td>
                <td>${pill(l.status)}${l.bookingDate ? html`<div class="tiny muted">${dateOnly(l.bookingDate)}</div>` : ""}</td>
                <td class="nowrap muted">${timeAgo(l.createdAt)}</td>
              </tr>`)}
          </tbody>
        </table>` : html`
        <div class="empty">
          <h3>${leads.length ? "No leads with this status" : "No leads yet"}</h3>
          <p style="margin-top:6px">${leads.length ? "Try another filter." : "Share your quote link on your website, ads and socials. Requests show up here."}</p>
        </div>`}
    </div>`);
}

page.addEventListener("click", (event) => {
  const chipButton = event.target.closest("[data-filter]");
  if (chipButton) { filter = chipButton.dataset.filter; return renderLeads(); }
  const row = event.target.closest("[data-lead]");
  if (row) { location.hash = `lead=${row.dataset.lead}`; return; }
  if (event.target.id === "copy-link") copyText(account.quoteLink);
});
page.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("[data-lead]");
  if (row && event.key === "Enter") location.hash = `lead=${row.dataset.lead}`;
});

/* ---------- lead detail ---------- */
async function showLead(id) {
  setHtml(page, html`<div class="empty">Loading…</div>`);
  try {
    ({ lead } = await api(`installer/leads/${id}`));
  } catch (error) {
    setHtml(page, html`<div class="empty"><h3>${error.message}</h3><p style="margin-top:10px"><a href="#leads">Back to leads</a></p></div>`);
    return;
  }
  sent = null;
  draft = lead.quote
    ? { items: lead.quote.items.map((i) => ({ ...i })), depositPct: lead.quote.depositPct, dates: [...lead.quote.dates], note: lead.quote.note }
    : { items: lead.suggestedItems.map((i) => ({ ...i })), depositPct: account.settings.depositPct, dates: [], note: "" };
  renderLead();
}

function renderLead() {
  const s = lead.selections;
  const q = encodeURIComponent(lead.address);
  const hasSpot = lead.lat !== null && lead.lng !== null;
  const previews = Object.entries(lead.previewUrls).filter(([, url]) => url);
  const first = lead.customerName.split(/\s+/)[0] || "there";

  setHtml(page, html`
    <div class="page-head">
      <div>
        <a href="#leads" class="small muted">&larr; All leads</a>
        <h1 style="margin-top:4px">${lead.customerName}</h1>
        <p class="muted">${lead.address || "No address given"}</p>
      </div>
      <div class="row">
        ${pill(lead.status)}
        <select id="status" aria-label="Lead status" style="width:auto">
          ${Object.entries(STATUS_LABELS).map(([key, label]) => html`<option value="${key}" ${raw(key === lead.status ? "selected" : "")}>${label}</option>`)}
        </select>
      </div>
    </div>

    <div class="detail">
      <div class="stack" style="--gap:18px">
        <section class="card">
          <div class="section-title">Customer</div>
          <dl class="kv">
            <dt>Phone</dt><dd>${lead.customerPhone ? html`<a href="${telHref(lead.customerPhone)}">${lead.customerPhone}</a>` : "-"}</dd>
            <dt>Email</dt><dd>${lead.customerEmail ? html`<a href="mailto:${lead.customerEmail}">${lead.customerEmail}</a>` : "-"}</dd>
            <dt>Received</dt><dd>${dateTime(lead.createdAt)} <span class="muted">via ${lead.source}</span></dd>
          </dl>
          ${lead.address ? html`
            <div class="row" style="margin-top:14px">
              <a class="btn btn-sm btn-secondary" target="_blank" rel="noopener" href="https://earth.google.com/web/search/${q}">Google Earth</a>
              <a class="btn btn-sm btn-secondary" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${q}">Google Maps</a>
              ${hasSpot ? html`<a class="btn btn-sm btn-secondary" target="_blank" rel="noopener" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lead.lat},${lead.lng}">Street View</a>` : ""}
            </div>` : ""}
        </section>

        <section class="card">
          <div class="section-title">What they want</div>
          <dl class="kv">
            <dt>Light up</dt><dd><strong>${SERVICE_LABELS[s.service]}</strong></dd>
            ${s.service !== "trees" ? html`
              <dt>Home</dt><dd>${SIZE_LABELS[s.homeSize]}, ${s.stories}-storey</dd>
              <dt>Roofline</dt><dd>${SCOPE_LABELS[s.scope]}</dd>` : ""}
            ${s.service !== "roofline" ? html`
              <dt>Trees</dt><dd>${s.trees.small} small, ${s.trees.medium} medium, ${s.trees.large} large</dd>
              <dt>Shrubs</dt><dd>${s.shrubs}</dd>` : ""}
            <dt>Colour</dt><dd>${COLOR_LABELS[s.color]}</dd>
            ${lead.estimate ? html`<dt>Shown price</dt><dd class="num">${money(lead.estimate.low)} – ${money(lead.estimate.high)} <span class="muted">(${lead.estimate.feet} ft estimated)</span></dd>` : ""}
            ${s.notes ? html`<dt>Their note</dt><dd style="white-space:pre-line">${s.notes}</dd>` : ""}
          </dl>
        </section>

        <section class="card">
          <div class="row-between" style="margin-bottom:10px">
            <div class="section-title" style="margin:0">Photos and previews</div>
            ${lead.photoUrls.length && account.previewsAvailable ? html`<button type="button" class="btn btn-sm btn-secondary" id="regen" ${raw(lead.previews.status === "pending" ? "disabled" : "")}>${lead.previews.status === "pending" ? "Making previews…" : "Remake previews"}</button>` : ""}
          </div>
          ${lead.photoUrls.length || previews.length ? html`
            <div class="gallery">
              ${lead.photoUrls.map((url, i) => html`<figure><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Customer photo ${i + 1}" loading="lazy"></a><figcaption>Photo ${i + 1}</figcaption></figure>`)}
              ${previews.map(([color, url]) => html`<figure><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${COLOR_LABELS[color]} preview" loading="lazy"></a><figcaption>${COLOR_LABELS[color]}</figcaption></figure>`)}
            </div>` : html`<p class="muted small">The customer did not add a photo. Use the map and Street View links to see the house.</p>`}
          ${lead.previews.status === "failed" ? html`<p class="small" style="color:var(--bad);margin-top:8px">The preview could not be made. Try "Remake previews".</p>` : ""}
          ${lead.photoUrls.length && !account.previewsAvailable ? html`<p class="small muted" style="margin-top:8px">Lighting previews are not switched on for this platform yet.</p>` : ""}
        </section>

        <section class="card stack">
          <div class="section-title" style="margin:0">Private notes</div>
          <textarea id="notes" aria-label="Private notes" placeholder="Only you can see these">${lead.notes}</textarea>
          <div class="row-between">
            <button type="button" class="btn btn-sm btn-secondary" id="save-notes">Save notes</button>
            <button type="button" class="btn btn-sm btn-ghost" id="delete-lead" style="color:var(--bad)">Delete lead</button>
          </div>
        </section>
      </div>

      <div class="stack" style="--gap:18px">
        <section class="card stack">
          <div class="row-between">
            <div>
              <div class="section-title" style="margin:0">Measure the roofline</div>
              <p class="small muted">Click along each roof edge to trace it. Start a new line for each separate run.</p>
            </div>
            <div class="center"><div class="measure-total" id="measure-total">0 ft</div><div class="tiny muted">traced</div></div>
          </div>
          <div class="measure-map" id="measure-map"></div>
          <p class="small muted" id="map-message" hidden></p>
          <div class="row">
            <button type="button" class="btn btn-sm btn-secondary" id="m-new">New line</button>
            <button type="button" class="btn btn-sm btn-secondary" id="m-undo">Undo</button>
            <button type="button" class="btn btn-sm btn-ghost" id="m-clear">Clear</button>
            <span class="grow"></span>
            <button type="button" class="btn btn-sm" id="m-save">Save and use in quote</button>
          </div>
        </section>

        <section class="card stack" id="quote-card"></section>
      </div>
    </div>`);

  renderQuote();
  initMap();
}

/* ---------- quote builder ---------- */
const lineTotal = (item) => (Number(item.qty) || 0) * (Number(item.unitPrice) || 0);
const draftTotal = () => draft.items.reduce((sum, item) => sum + lineTotal(item), 0);

function renderQuote() {
  const card = $("#quote-card");
  if (!card) return;
  const first = lead.customerName.split(/\s+/)[0] || "there";
  const link = sent || (lead.quote ? `${location.origin}${lead.customerLink}` : "");
  const message = `Hi ${first}, your holiday lighting quote from ${account.companyName} is ready: ${link}`;
  const total = draftTotal();

  setHtml(card, html`
    <div class="row-between">
      <div class="section-title" style="margin:0">${lead.quote ? "Quote" : "Build the quote"}</div>
      ${lead.quote ? html`<span class="small muted">Sent ${dateTime(lead.quote.sentAt)}${lead.quote.auto ? " (instant price)" : ""}</span>` : ""}
    </div>
    ${lead.booking ? html`<p class="notice notice-good"><strong>Booked for ${dateOnly(lead.booking.date)}.</strong> Accepted ${dateTime(lead.booking.acceptedAt)}.</p>` : ""}
    <table class="items">
      <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Price</th><th style="text-align:right">Total</th><th></th></tr></thead>
      <tbody>
        ${draft.items.map((item, i) => html`
          <tr data-item="${i}">
            <td><input type="text" data-field="label" value="${item.label}" aria-label="Item ${i + 1} description"></td>
            <td><input type="number" class="w-qty" data-field="qty" value="${item.qty}" min="0" step="any" aria-label="Item ${i + 1} quantity"></td>
            <td><input type="text" class="w-unit" data-field="unit" value="${item.unit}" aria-label="Item ${i + 1} unit"></td>
            <td><input type="number" class="w-price" data-field="unitPrice" value="${item.unitPrice}" step="any" aria-label="Item ${i + 1} unit price"></td>
            <td class="line-total">${money(lineTotal(item), true)}</td>
            <td><button type="button" class="btn btn-sm btn-ghost" data-remove-item="${i}" aria-label="Remove item ${i + 1}">&times;</button></td>
          </tr>`)}
      </tbody>
    </table>
    <div class="row">
      <button type="button" class="btn btn-sm btn-secondary" id="add-item">Add line</button>
      <button type="button" class="btn btn-sm btn-ghost" id="reset-items">Reset to suggested</button>
    </div>
    <div class="total-row"><span>Total</span><strong id="quote-total">${money(total, true)}</strong></div>
    <div class="form-grid">
      <label class="field"><span>Deposit %</span><input type="number" id="deposit" min="0" max="100" step="1" value="${draft.depositPct}"></label>
      <label class="field"><span>Offer an install date</span>
        <span class="copy-row"><input type="date" id="date-input" min="${new Date().toISOString().slice(0, 10)}"><button type="button" class="btn btn-secondary" id="add-date">Add</button></span>
      </label>
    </div>
    <div>
      <div class="date-tags" id="date-tags">
        ${draft.dates.map((d) => html`<span class="date-tag">${dateOnly(d)}<button type="button" data-remove-date="${d}" aria-label="Remove ${dateOnly(d)}">&times;</button></span>`)}
      </div>
      <p class="hint">${draft.dates.length ? "The customer picks one of these." : "No dates offered: the customer suggests a date when they accept."}</p>
    </div>
    <label class="field"><span>Note to the customer</span><textarea id="quote-note" placeholder="Optional. What's included, lease terms, takedown date…">${draft.note}</textarea></label>
    <button type="button" class="btn btn-lg" id="send-quote">${lead.quote ? "Update and resend quote" : "Send quote"}</button>
    ${link ? html`
      <div class="stack" style="--gap:10px">
        <p class="notice notice-good">${sent ? html`<strong>Quote saved.</strong> Now send the customer their link:` : "Customer link:"}</p>
        <div class="copy-row"><input type="text" readonly value="${link}" aria-label="Customer quote link"><button type="button" class="btn btn-secondary" id="copy-customer">Copy</button></div>
        <div class="row">
          ${lead.customerPhone ? html`<a class="btn btn-sm btn-secondary" href="sms:${lead.customerPhone.replace(/[^\d+]/g, "")}?&body=${encodeURIComponent(message)}">Text it</a>` : ""}
          ${lead.customerEmail ? html`<a class="btn btn-sm btn-secondary" href="mailto:${lead.customerEmail}?subject=${encodeURIComponent(`Your holiday lighting quote from ${account.companyName}`)}&body=${encodeURIComponent(message)}">Email it</a>` : ""}
          <a class="btn btn-sm btn-ghost" href="${link}" target="_blank" rel="noopener">Preview what they see</a>
        </div>
      </div>` : ""}`);
}

function readDraftInputs() {
  $$("#quote-card [data-item]").forEach((row) => {
    const item = draft.items[Number(row.dataset.item)];
    if (!item) return;
    $$("[data-field]", row).forEach((input) => {
      const field = input.dataset.field;
      item[field] = field === "qty" || field === "unitPrice" ? Number(input.value) || 0 : input.value;
    });
  });
  const deposit = $("#deposit");
  if (deposit) draft.depositPct = Math.min(100, Math.max(0, Number(deposit.value) || 0));
  const note = $("#quote-note");
  if (note) draft.note = note.value;
}

page.addEventListener("input", (event) => {
  const row = event.target.closest?.("#quote-card [data-item]");
  if (!row) return;
  readDraftInputs();
  $(".line-total", row).textContent = money(lineTotal(draft.items[Number(row.dataset.item)]), true);
  $("#quote-total").textContent = money(draftTotal(), true);
});

page.addEventListener("click", async (event) => {
  const target = event.target;
  if (!lead || !$("#quote-card")) return;

  if (target.dataset.removeItem !== undefined) { readDraftInputs(); draft.items.splice(Number(target.dataset.removeItem), 1); return renderQuote(); }
  if (target.dataset.removeDate) { readDraftInputs(); draft.dates = draft.dates.filter((d) => d !== target.dataset.removeDate); return renderQuote(); }
  if (target.id === "add-item") { readDraftInputs(); draft.items.push({ label: "", qty: 1, unit: "each", unitPrice: 0 }); renderQuote(); $$("#quote-card [data-field='label']").at(-1)?.focus(); return; }
  if (target.id === "reset-items") { readDraftInputs(); draft.items = lead.suggestedItems.map((i) => ({ ...i })); return renderQuote(); }
  if (target.id === "add-date") {
    const value = $("#date-input").value;
    if (!value) return toast("Pick a date first", "error");
    readDraftInputs();
    if (!draft.dates.includes(value)) draft.dates = [...draft.dates, value].sort();
    return renderQuote();
  }
  if (target.id === "copy-customer") return copyText(sent || `${location.origin}${lead.customerLink}`);

  if (target.id === "send-quote") {
    readDraftInputs();
    return busy(target, async () => {
      const result = await api(`installer/leads/${lead.id}/quote`, { method: "POST", body: draft });
      lead = result.lead;
      sent = result.customerUrl;
      draft.items = lead.quote.items.map((i) => ({ ...i }));
      renderLead();
      $("#quote-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  if (target.id === "save-notes") {
    return busy(target, async () => {
      ({ lead } = await api(`installer/leads/${lead.id}`, { method: "PATCH", body: { notes: $("#notes").value } }));
      toast("Notes saved");
    });
  }
  if (target.id === "delete-lead") {
    if (!confirm(`Delete ${lead.customerName}'s request and photos? This cannot be undone.`)) return;
    return busy(target, async () => {
      await api(`installer/leads/${lead.id}`, { method: "DELETE" });
      toast("Lead deleted");
      location.hash = "leads";
    });
  }
  if (target.id === "regen") {
    return busy(target, async () => {
      ({ lead } = await api(`installer/leads/${lead.id}/regenerate`, { method: "POST", body: {} }));
      toast("Making new previews. Refresh in a minute.");
      readDraftInputs();
      renderLead();
    });
  }

  /* measuring */
  if (target.id === "m-new") { finishLine(); return drawMeasure(); }
  if (target.id === "m-undo") {
    if (measure.current.length) measure.current.pop();
    else if (measure.lines.length) measure.current = measure.lines.pop();
    return drawMeasure();
  }
  if (target.id === "m-clear") { measure.lines = []; measure.current = []; return drawMeasure(); }
  if (target.id === "m-save") {
    finishLine();
    readDraftInputs();
    return busy(target, async () => {
      ({ lead } = await api(`installer/leads/${lead.id}`, { method: "PATCH", body: { measurement: { lines: measure.lines } } }));
      const feet = lead.measurement?.feet || 0;
      const roofItem = draft.items.find((item) => item.unit === "ft");
      if (feet && roofItem) roofItem.qty = feet;
      else if (feet) draft.items.unshift({ ...(lead.suggestedItems.find((i) => i.unit === "ft") || { label: "Roofline lighting", unit: "ft", unitPrice: account.settings.pricing.rooflinePerFt }), qty: feet });
      renderQuote();
      toast(feet ? `Saved ${feet} ft and updated the quote` : "Measurement cleared");
    });
  }
});

page.addEventListener("change", async (event) => {
  if (event.target.id !== "status" || !lead) return;
  try {
    readDraftInputs();
    ({ lead } = await api(`installer/leads/${lead.id}`, { method: "PATCH", body: { status: event.target.value } }));
    renderLead();
    toast("Status updated");
  } catch (error) {
    toast(error.message, "error");
  }
});

/* ---------- measuring map ---------- */
const FEET_PER_METRE = 3.28084;

function finishLine() {
  if (measure.current.length >= 2) measure.lines.push(measure.current);
  measure.current = [];
}

function measuredFeet() {
  let metres = 0;
  for (const line of [...measure.lines, measure.current]) {
    for (let i = 1; i < line.length; i++) metres += measure.map.distance(line[i - 1], line[i]);
  }
  return Math.round(metres * FEET_PER_METRE);
}

function drawMeasure() {
  measure.layer.clearLayers();
  for (const line of measure.lines) L.polyline(line, { color: "#ffd23f", weight: 4 }).addTo(measure.layer);
  if (measure.current.length) {
    L.polyline(measure.current, { color: "#ff5c5c", weight: 4, dashArray: "6 6" }).addTo(measure.layer);
    for (const point of measure.current) L.circleMarker(point, { radius: 4, color: "#fff", weight: 2, fillColor: "#ff5c5c", fillOpacity: 1 }).addTo(measure.layer);
  }
  $("#measure-total").textContent = `${measuredFeet()} ft`;
}

async function initMap() {
  let spot = lead.lat !== null && lead.lng !== null ? [lead.lat, lead.lng] : null;
  if (!spot && lead.address) {
    try {
      const res = await fetch(`https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(lead.address)}`);
      const coords = (await res.json()).features?.[0]?.geometry?.coordinates;
      if (coords) spot = [coords[1], coords[0]];
    } catch { /* fall through to the message below */ }
  }
  const holder = $("#measure-map");
  if (!holder) return;
  if (!spot) {
    holder.hidden = true;
    const message = $("#map-message");
    message.hidden = false;
    message.textContent = "We could not place this address on the map. Use the Google Earth link to measure, then type the length into the quote.";
    return;
  }
  const map = L.map(holder, { doubleClickZoom: false }).setView(spot, 20);
  L.tileLayer(TILES.url, { attribution: TILES.attribution, maxNativeZoom: TILES.maxNativeZoom, maxZoom: TILES.maxZoom }).addTo(map);
  measure = { map, lines: (lead.measurement?.lines || []).map((line) => line.map((p) => [...p])), current: [], layer: L.layerGroup().addTo(map) };
  map.on("click", (event) => { measure.current.push([event.latlng.lat, event.latlng.lng]); drawMeasure(); });
  map.on("dblclick", () => { measure.current.pop(); finishLine(); drawMeasure(); });
  drawMeasure();
}

/* ---------- settings ---------- */
function showSettings() {
  lead = null;
  const s = account.settings;
  const p = s.pricing;
  const number = (id, label, value, step = "any", hint = "") => html`<label class="field"><span>${label}</span><input type="number" id="${id}" value="${value}" step="${step}" min="0">${hint ? html`<span class="hint">${hint}</span>` : ""}</label>`;
  const mode = (value, title, text) => html`
    <label class="choice" style="align-items:flex-start;text-align:left">
      <input type="radio" name="priceMode" value="${value}" ${raw(s.priceMode === value ? "checked" : "")}>
      <strong>${title}</strong><small>${text}</small>
    </label>`;
  const curl = `curl -X POST ${account.inboundUrl} \\\n  -H "Authorization: Bearer ${account.inboundKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"Jane Doe","phone":"555-0100","address":"12 Elm St","service":"roofline","bookingDate":"2026-12-01","source":"crm"}'`;

  setHtml(page, html`
    <div class="page-head"><h1>Settings</h1><button type="button" class="btn" id="save-settings">Save changes</button></div>
    <div class="settings-grid">
      <section class="card stack">
        <div class="section-title" style="margin:0">Your business</div>
        <label class="field"><span>Company name</span><input type="text" id="s-company" value="${account.companyName}" maxlength="80"></label>
        <label class="field"><span>Phone shown to customers</span><input type="tel" id="s-phone" value="${account.phone}"></label>
        <label class="field"><span>Quote link name</span><input type="text" id="s-slug" value="${account.slug}" maxlength="40">
          <span class="hint">Your link is ${location.origin}/q/<strong>${account.slug}</strong>. Changing it breaks links you have already shared.</span></label>
      </section>

      <section class="card stack">
        <div class="section-title" style="margin:0">Branding on your customer pages</div>
        <div class="row">
          <label class="field"><span>Brand colour</span><input type="color" id="s-color" value="${s.brand.color}"></label>
          <div class="grow">
            <div class="field-label">Logo</div>
            <div class="row">
              <span id="logo-preview">${s.brand.logo ? html`<img src="${s.brand.logo}" alt="Current logo" style="max-height:44px;max-width:150px">` : html`<span class="small muted">No logo. Your company name is shown.</span>`}</span>
              <label class="btn btn-sm btn-secondary">Upload<input type="file" id="s-logo" accept="image/png,image/jpeg,image/webp" hidden></label>
              <button type="button" class="btn btn-sm btn-ghost" id="logo-remove" ${raw(s.brand.logo ? "" : "hidden")}>Remove</button>
            </div>
          </div>
        </div>
        <label class="field"><span>Tagline on the first screen</span><input type="text" id="s-tagline" value="${s.brand.tagline}" maxlength="140"></label>
      </section>

      <section class="card stack">
        <div class="section-title" style="margin:0">What customers see for price</div>
        <div class="choices" role="radiogroup" aria-label="Price display">
          ${mode("range", "Price range", "They see a ballpark. You confirm the exact price.")}
          ${mode("instant", "Instant price", "They see one price and can book right away.")}
          ${mode("hidden", "No price", "They see the preview only. You send the quote.")}
        </div>
        <div class="form-grid">
          ${number("s-deposit", "Deposit %", s.depositPct, "1")}
          ${number("s-range", "Range spread ± %", p.rangePct, "1", "Used for the price range.")}
          ${number("s-min", "Minimum job $", p.minimumJob)}
        </div>
      </section>

      <section class="card stack">
        <div class="section-title" style="margin:0">Roofline pricing</div>
        <div class="form-grid">
          ${number("s-perft", "Price per foot $", p.rooflinePerFt)}
          ${number("s-story2", "2-storey multiplier", p.storyMultiplier[2])}
          ${number("s-story3", "3-storey multiplier", p.storyMultiplier[3])}
        </div>
        <p class="hint">Before you measure, the estimate uses a typical front roofline length for each home size:</p>
        <div class="form-grid">
          ${number("s-small", "Small home (ft)", p.sizes.small, "1")}
          ${number("s-medium", "Medium home (ft)", p.sizes.medium, "1")}
          ${number("s-large", "Large home (ft)", p.sizes.large, "1")}
          ${number("s-xl", "Extra large home (ft)", p.sizes.xl, "1")}
        </div>
        <div class="form-grid">
          ${number("s-sides", "Front and sides ×", p.scope.frontSides, "any", "Multiplier on the front length.")}
          ${number("s-full", "All the way around ×", p.scope.full)}
        </div>
      </section>

      <section class="card stack">
        <div class="section-title" style="margin:0">Trees and shrubs pricing</div>
        <div class="form-grid">
          ${number("s-tree-s", "Small tree $", p.treeSmall)}
          ${number("s-tree-m", "Medium tree $", p.treeMedium)}
          ${number("s-tree-l", "Large tree $", p.treeLarge)}
          ${number("s-shrub", "Shrub $", p.shrub)}
        </div>
      </section>

      <section class="card stack">
        <div class="section-title" style="margin:0">Previews and limits</div>
        <label class="row"><input type="checkbox" id="s-ai" ${raw(s.aiPreviews ? "checked" : "")} style="width:20px;height:20px"> <span>Show customers a lighting preview of their own home</span></label>
        ${account.previewsAvailable ? "" : html`<p class="notice notice-warn">Previews are not switched on for this platform yet, so customers will not see one.</p>`}
        ${number("s-cap", "Most requests accepted per day", s.dailyLeadCap, "1", "Protects you from spam and runaway preview costs.")}
      </section>

      <section class="card stack">
        <div class="section-title" style="margin:0">Alerts and connections</div>
        <label class="field"><span>Send new-lead alerts to</span><input type="email" id="s-notify" value="${s.notifyEmail}" placeholder="${account.email}">
          <span class="hint">Email alerts need the platform owner to connect an email service.</span></label>
        <label class="field"><span>Webhook URL</span><input type="url" id="s-webhook" value="${s.webhookUrl}" placeholder="https://hooks.zapier.com/...">
          <span class="hint">We POST new leads, sent quotes and bookings here. Works with Zapier, Make, GoHighLevel and most CRMs.</span></label>
      </section>

      <section class="card stack">
        <div class="section-title" style="margin:0">Send leads or bookings in from another system</div>
        <p class="small muted">Your CRM or booking portal can push a request, or a confirmed booking, straight into this dashboard.</p>
        <div class="copy-row"><input type="text" readonly value="${account.inboundKey}" aria-label="API key"><button type="button" class="btn btn-secondary" id="copy-key">Copy</button></div>
        <div class="code" tabindex="0" aria-label="Example request">${curl}</div>
        <div><button type="button" class="btn btn-sm btn-ghost" id="rotate-key">Replace this key</button></div>
      </section>

      <section class="card stack">
        <div class="section-title" style="margin:0">Password</div>
        <label class="field"><span>Current password</span><input type="password" id="pw-current" autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input type="password" id="pw-next" autocomplete="new-password" minlength="8"></label>
        <div><button type="button" class="btn btn-secondary" id="save-password">Change password</button></div>
      </section>
    </div>`);
  pendingLogo = undefined;
}

let pendingLogo; // undefined = unchanged, "" = removed, data URL = new logo

async function logoDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  for (const maxWidth of [480, 320, 220]) {
    const scale = Math.min(1, maxWidth / bitmap.width, 160 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    if (url.length < 210_000) return url;
  }
  throw new Error("That logo is too detailed. Try a simpler or smaller image.");
}

page.addEventListener("change", async (event) => {
  if (event.target.id !== "s-logo" || !event.target.files[0]) return;
  try {
    pendingLogo = await logoDataUrl(event.target.files[0]);
    setHtml($("#logo-preview"), html`<img src="${pendingLogo}" alt="New logo" style="max-height:44px;max-width:150px">`);
    $("#logo-remove").hidden = false;
  } catch (error) {
    toast(error.message || "Could not read that image", "error");
  }
});

page.addEventListener("click", async (event) => {
  const target = event.target;
  if (!$("#save-settings")) return;
  const value = (id) => $(`#${id}`).value;
  const numberOf = (id) => Number(value(id));

  if (target.id === "logo-remove") {
    pendingLogo = "";
    setHtml($("#logo-preview"), html`<span class="small muted">No logo. Your company name is shown.</span>`);
    target.hidden = true;
    return;
  }
  if (target.id === "copy-key") return copyText(account.inboundKey);
  if (target.id === "rotate-key") {
    if (!confirm("Replace the key? Anything using the old key will stop working.")) return;
    return busy(target, async () => { account = await api("installer/inbound-key", { method: "POST", body: {} }); showSettings(); toast("New key created"); });
  }
  if (target.id === "save-password") {
    return busy(target, async () => {
      await api("installer/password", { method: "POST", body: { current: value("pw-current"), next: value("pw-next") } });
      $("#pw-current").value = $("#pw-next").value = "";
      toast("Password changed");
    });
  }
  if (target.id === "save-settings") {
    return busy(target, async () => {
      const brand = { color: value("s-color"), tagline: value("s-tagline") };
      if (pendingLogo !== undefined) brand.logo = pendingLogo;
      account = await api("installer/account", {
        method: "PUT",
        body: {
          companyName: value("s-company"),
          phone: value("s-phone"),
          slug: value("s-slug"),
          settings: {
            brand,
            priceMode: $("input[name=priceMode]:checked")?.value,
            depositPct: numberOf("s-deposit"),
            aiPreviews: $("#s-ai").checked,
            dailyLeadCap: numberOf("s-cap"),
            notifyEmail: value("s-notify"),
            webhookUrl: value("s-webhook"),
            pricing: {
              rooflinePerFt: numberOf("s-perft"),
              minimumJob: numberOf("s-min"),
              rangePct: numberOf("s-range"),
              sizes: { small: numberOf("s-small"), medium: numberOf("s-medium"), large: numberOf("s-large"), xl: numberOf("s-xl") },
              scope: { front: 1, frontSides: numberOf("s-sides"), full: numberOf("s-full") },
              storyMultiplier: { 1: 1, 2: numberOf("s-story2"), 3: numberOf("s-story3") },
              treeSmall: numberOf("s-tree-s"),
              treeMedium: numberOf("s-tree-m"),
              treeLarge: numberOf("s-tree-l"),
              shrub: numberOf("s-shrub"),
            },
          },
        },
      });
      const webhookDropped = value("s-webhook").trim() && !account.settings.webhookUrl;
      showSettings();
      $("#logo").firstChild.textContent = account.companyName;
      toast(webhookDropped ? "Saved, but the webhook URL was not accepted. It must be a public https address." : "Settings saved", webhookDropped ? "error" : "info");
    });
  }
});

boot().catch((error) => setHtml(page, html`<div class="empty"><h3>${error.message}</h3></div>`));
