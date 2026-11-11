import {
  $, $$, api, busy, COLOR_LABELS, copyText, dateOnly, dateTime, describeRequest, html, money, raw, SERVICE_LABELS,
  setHtml, STATUS_LABELS, timeAgo, toast,
} from "./lib.js";

const page = $("#page");
const dialog = $("#dialog");
let platform = { name: "Admin" };
let installers = [];
let leadFilter = { installer: "", status: "" };

async function boot() {
  const me = await api("auth/me");
  if (me.session?.role !== "admin") {
    location.href = me.session?.role === "installer" ? "/app" : "/login";
    return;
  }
  window.addEventListener("hashchange", navigate);
  navigate();
}

function navigate() {
  const section = ["overview", "installers", "leads"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  $$("[data-nav]").forEach((b) => (b.dataset.nav === section ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  ({ overview: showOverview, installers: showInstallers, leads: showLeads })[section]().catch((error) =>
    setHtml(page, html`<div class="empty"><h3>${error.message}</h3></div>`));
}

$$("[data-nav]").forEach((button) => button.addEventListener("click", () => (location.hash = button.dataset.nav)));
$("#logout").addEventListener("click", async () => {
  await api("auth/logout", { method: "POST", body: {} });
  location.href = "/login";
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog || event.target.closest("[data-close]")) dialog.close();
});

const pill = (status) => html`<span class="pill pill-${status}">${STATUS_LABELS[status] || status}</span>`;

function setPlatform(next) {
  platform = next;
  setHtml($("#logo"), html`${platform.name}<small>Admin</small>`);
  document.title = `${platform.name} · Admin`;
}

/* ---------- overview ---------- */
async function showOverview() {
  setHtml(page, html`<div class="empty">Loading…</div>`);
  const [overview, recent] = await Promise.all([api("admin/overview"), api("admin/leads")]);
  setPlatform(overview.platform);
  const t = overview.totals;
  setHtml(page, html`
    <div class="page-head"><h1>Overview</h1></div>
    ${overview.previewsAvailable ? "" : html`<p class="notice notice-warn" style="margin-bottom:16px"><strong>Lighting previews are off.</strong> They switch on once this site has its first production deploy on Netlify (AI Gateway), or when a GEMINI_API_KEY is set.</p>`}
    <div class="tiles">
      <div class="tile"><div class="label">Active installers</div><div class="value">${t.activeInstallers}<span class="small muted"> / ${t.installers}</span></div></div>
      <div class="tile"><div class="label">Leads, all time</div><div class="value">${t.leads}</div></div>
      <div class="tile"><div class="label">Leads, last 7 days</div><div class="value">${t.leadsThisWeek}</div></div>
      <div class="tile"><div class="label">Quotes waiting</div><div class="value">${t.quoted}</div></div>
      <div class="tile"><div class="label">Jobs booked</div><div class="value">${t.booked}</div></div>
      <div class="tile"><div class="label">Booked value</div><div class="value">${money(t.bookedValue)}</div></div>
    </div>
    <div class="settings-grid" style="margin-bottom:20px">
      <section class="card stack" id="crm-card">${crmCard(overview.crm)}</section>
      <section class="card stack">
        <div class="section-title" style="margin:0">Platform name</div>
        <p class="small muted">Shown to installers on the sign-in page and dashboard. Homeowners never see it: their pages carry only the installer's brand.</p>
        <div class="copy-row"><input type="text" id="platform-name" value="${platform.name}" maxlength="40" aria-label="Platform name"><button type="button" class="btn btn-secondary" id="save-platform">Save</button></div>
      </section>
    </div>
    <h2 style="margin-bottom:12px">Latest leads</h2>
    ${leadsTable(recent.leads.slice(0, 8))}`);
}

function crmCard(crm, results) {
  return html`
    <div class="section-title" style="margin:0">GoHighLevel sync</div>
    ${crm.tokenSet ? "" : html`<p class="notice notice-warn">The GoHighLevel token is not set on this site, so nothing is syncing.</p>`}
    <dl class="kv">
      <dt>Linked installers</dt><dd>${crm.installers}</dd>
      <dt>Leads in a pipeline</dt><dd>${crm.linkedLeads}</dd>
      <dt>Failed to sync</dt><dd>${crm.failingLeads ? html`<strong style="color:var(--bad)">${crm.failingLeads}</strong> (open the lead to see why)` : "0"}</dd>
      <dt>Last push</dt><dd>${crm.lastPushAt ? timeAgo(crm.lastPushAt) : "Nothing sent yet"}</dd>
    </dl>
    <p class="small muted">New requests, quotes and bookings are pushed to the pipeline as they happen. Jobs booked, completed or lost in the pipeline are pulled in every 15 minutes.</p>
    <div><button type="button" class="btn btn-secondary" id="crm-sync" ${raw(crm.tokenSet && crm.installers ? "" : "disabled")}>Pull from pipeline now</button></div>
    ${results ? html`<ul class="tips">${results.length ? results.map((r) => html`<li>${r.installer}: ${r.error ? html`<span style="color:var(--bad)">${r.error}</span>` : `checked ${r.checked}, updated ${r.updated}, added ${r.imported}`}</li>`) : html`<li>No linked installers.</li>`}</ul>` : ""}`;
}

/* ---------- installers ---------- */
async function showInstallers() {
  setHtml(page, html`<div class="empty">Loading…</div>`);
  ({ installers } = await api("admin/installers"));
  setHtml(page, html`
    <div class="page-head"><h1>Installers</h1><button type="button" class="btn" id="new-installer">Add installer</button></div>
    <div class="table-wrap">
      ${installers.length ? html`
        <table class="data">
          <thead><tr><th>Company</th><th>Quote link</th><th class="right">Leads</th><th class="right">Booked</th><th class="right">Booked value</th><th>Last lead</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${installers.map((i) => html`
              <tr>
                <td><strong>${i.companyName}</strong>${i.crmLinked ? html` <span class="pill pill-new">CRM linked</span>` : ""}<div class="small muted">${i.email}</div></td>
                <td><button type="button" class="btn btn-sm btn-ghost" data-copy="${i.quoteLink}">/q/${i.slug}</button></td>
                <td class="right num">${i.leadCount}</td>
                <td class="right num">${i.bookedCount}</td>
                <td class="right num">${money(i.bookedValue)}</td>
                <td class="muted nowrap">${i.lastLeadAt ? timeAgo(i.lastLeadAt) : "-"}</td>
                <td><span class="pill pill-${i.status}">${i.status === "active" ? "Active" : "Paused"}</span></td>
                <td class="nowrap right">
                  <button type="button" class="btn btn-sm btn-secondary" data-view-as="${i.id}">Open dashboard</button>
                  <button type="button" class="btn btn-sm btn-ghost" data-manage="${i.id}">Manage</button>
                </td>
              </tr>`)}
          </tbody>
        </table>` : html`<div class="empty"><h3>No installers yet</h3><p style="margin-top:6px">Add your first installer to give them a quote link and a dashboard.</p></div>`}
    </div>`);
}

function openNewInstaller() {
  setHtml($("#dialog-body"), html`
    <form id="installer-form" class="stack" novalidate>
      <h2 id="dialog-title">Add installer</h2>
      <label class="field"><span>Company name</span><input type="text" name="companyName" required maxlength="80"></label>
      <div class="form-grid">
        <label class="field"><span>Sign-in email</span><input type="email" name="email" required autocomplete="off"></label>
        <label class="field"><span>Phone</span><input type="tel" name="phone" autocomplete="off"></label>
      </div>
      <label class="field"><span>Temporary password</span><input type="text" name="password" required minlength="8" autocomplete="off">
        <span class="hint">At least 8 characters. They can change it in Settings.</span></label>
      <p class="error-text" id="installer-error" role="alert" hidden></p>
      <div class="row"><button type="submit" class="btn">Create installer</button><button type="button" class="btn btn-ghost" data-close>Cancel</button></div>
    </form>`);
  dialog.showModal();
}

function openManage(id) {
  const i = installers.find((x) => x.id === id);
  if (!i) return;
  setHtml($("#dialog-body"), html`
    <div class="stack">
      <h2 id="dialog-title">${i.companyName}</h2>
      <dl class="kv">
        <dt>Email</dt><dd>${i.email}</dd>
        <dt>Phone</dt><dd>${i.phone || "-"}</dd>
        <dt>Quote link</dt><dd><a href="${i.quoteLink}" target="_blank" rel="noopener">${i.quoteLink}</a></dd>
        <dt>Joined</dt><dd>${dateTime(i.createdAt)}</dd>
      </dl>
      <form class="card card-flat stack" id="installer-edit" data-id="${i.id}" novalidate>
        <div class="section-title" style="margin:0">Account details</div>
        <label class="field"><span>Company name</span><input type="text" name="companyName" value="${i.companyName}" maxlength="80" required></label>
        <div class="form-grid">
          <label class="field"><span>Sign-in email</span><input type="email" name="email" value="${i.email}" required autocomplete="off"></label>
          <label class="field"><span>Phone</span><input type="tel" name="phone" value="${i.phone}" autocomplete="off"></label>
        </div>
        ${i.email.endsWith(".invalid") ? html`<p class="notice notice-warn">This installer cannot sign in yet. Set their real email here, then set a password below.</p>` : ""}
        <div><button type="submit" class="btn btn-secondary">Save details</button></div>
      </form>
      <div class="card card-flat stack">
        <div class="section-title" style="margin:0">Access</div>
        <p class="small muted">${i.status === "active" ? "Pausing stops their quote link and sign-in. Their data is kept." : "This installer is paused. Their quote link and sign-in are off."}</p>
        <div><button type="button" class="btn btn-secondary" data-toggle="${i.id}" data-next="${i.status === "active" ? "suspended" : "active"}">${i.status === "active" ? "Pause installer" : "Reactivate installer"}</button></div>
      </div>
      <div class="card card-flat stack">
        <div class="section-title" style="margin:0">Reset password</div>
        <div class="copy-row"><input type="text" id="reset-password" placeholder="New password, 8+ characters" autocomplete="off" aria-label="New password"><button type="button" class="btn btn-secondary" data-reset="${i.id}">Set</button></div>
      </div>
      <div class="row-between">
        <button type="button" class="btn btn-ghost" data-close>Close</button>
        <button type="button" class="btn btn-ghost" style="color:var(--bad)" data-delete="${i.id}">Delete installer and all their leads</button>
      </div>
    </div>`);
  dialog.showModal();
}

/** Re-open the manage dialog with fresh data after a save. */
function openManageRefresh(id) {
  if (dialog.open) dialog.close();
  openManage(id);
}

/* ---------- all leads ---------- */
function leadsTable(leads) {
  if (!leads.length) return html`<div class="table-wrap"><div class="empty">No leads to show.</div></div>`;
  return html`
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>Customer</th><th>Installer</th><th>Wants</th><th>Price</th><th>Status</th><th>Received</th></tr></thead>
        <tbody>
          ${leads.map((l) => html`
            <tr class="clickable" data-lead="${l.id}" tabindex="0">
              <td><strong>${l.customerName}</strong><div class="small muted">${l.address || "No address"}</div></td>
              <td>${l.installerName}</td>
              <td>${SERVICE_LABELS[l.service] || "-"}</td>
              <td class="num nowrap">${l.quoteTotal != null ? money(l.quoteTotal) : l.estimate ? html`<span class="muted">${money(l.estimate.low)}–${money(l.estimate.high)}</span>` : "-"}</td>
              <td>${pill(l.status)}</td>
              <td class="muted nowrap">${timeAgo(l.createdAt)}</td>
            </tr>`)}
        </tbody>
      </table>
    </div>`;
}

async function showLeads() {
  setHtml(page, html`<div class="empty">Loading…</div>`);
  if (!installers.length) ({ installers } = await api("admin/installers"));
  const query = new URLSearchParams(Object.entries(leadFilter).filter(([, v]) => v)).toString();
  const { leads } = await api(`admin/leads${query ? `?${query}` : ""}`);
  const option = (value, label, current) => html`<option value="${value}" ${raw(value === current ? "selected" : "")}>${label}</option>`;
  setHtml(page, html`
    <div class="page-head">
      <h1>All leads</h1>
      <div class="row">
        <select id="f-installer" aria-label="Filter by installer" style="width:auto">
          ${option("", "All installers", leadFilter.installer)}${installers.map((i) => option(i.id, i.companyName, leadFilter.installer))}
        </select>
        <select id="f-status" aria-label="Filter by status" style="width:auto">
          ${option("", "Any status", leadFilter.status)}${Object.entries(STATUS_LABELS).map(([v, l]) => option(v, l, leadFilter.status))}
        </select>
      </div>
    </div>
    ${leadsTable(leads)}
    <p class="small muted" style="margin-top:10px">Showing the ${leads.length} most recent. To work a lead, open that installer's dashboard.</p>`);
}

async function openLead(id) {
  const { lead } = await api(`admin/leads/${id}`);
  const previews = Object.entries(lead.previewUrls).filter(([, url]) => url);
  setHtml($("#dialog-body"), html`
    <div class="stack">
      <div class="row-between"><h2 id="dialog-title">${lead.customerName}</h2>${pill(lead.status)}</div>
      <dl class="kv">
        <dt>Installer</dt><dd>${lead.installer.companyName}</dd>
        <dt>Address</dt><dd>${lead.address || "-"}</dd>
        <dt>Phone</dt><dd>${lead.customerPhone || "-"}</dd>
        <dt>Email</dt><dd>${lead.customerEmail || "-"}</dd>
        <dt>Request</dt><dd>${describeRequest(lead.selections)}</dd>
        <dt>Received</dt><dd>${dateTime(lead.createdAt)} via ${lead.source}</dd>
        ${lead.estimate ? html`<dt>Estimate</dt><dd class="num">${money(lead.estimate.low)} – ${money(lead.estimate.high)}</dd>` : ""}
        ${lead.measurement ? html`<dt>Measured</dt><dd class="num">${lead.measurement.feet} ft</dd>` : ""}
        ${lead.quote ? html`<dt>Quote</dt><dd class="num">${money(lead.quote.total, true)} sent ${dateTime(lead.quote.sentAt)}</dd>` : ""}
        ${lead.booking ? html`<dt>Booked for</dt><dd>${dateOnly(lead.booking.date)}</dd>` : ""}
      </dl>
      ${lead.photoUrls.length || previews.length ? html`
        <div class="gallery">
          ${lead.photoUrls.map((url, i) => html`<figure><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Customer photo ${i + 1}"></a><figcaption>Photo ${i + 1}</figcaption></figure>`)}
          ${previews.map(([color, url]) => html`<figure><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${COLOR_LABELS[color]} preview"></a><figcaption>${COLOR_LABELS[color]}</figcaption></figure>`)}
        </div>` : ""}
      <div class="row">
        <button type="button" class="btn btn-secondary" data-view-as="${lead.installer.id}" data-then="lead=${lead.id}">Open in installer dashboard</button>
        <a class="btn btn-ghost" href="${lead.customerLink}" target="_blank" rel="noopener">Customer page</a>
        <button type="button" class="btn btn-ghost" data-close>Close</button>
      </div>
    </div>`);
  dialog.showModal();
}

/* ---------- events ---------- */
async function viewAs(id, then = "") {
  await api(`admin/installers/${id}/view-as`, { method: "POST", body: {} });
  location.href = `/app${then ? `#${then}` : ""}`;
}

document.addEventListener("click", async (event) => {
  const target = event.target;
  const closest = (selector) => target.closest?.(selector);

  if (target.id === "new-installer") return openNewInstaller();
  if (target.id === "crm-sync") {
    return busy(target, async () => {
      const { results, crm } = await api("admin/crm-sync", { method: "POST", body: {} });
      setHtml($("#crm-card"), crmCard(crm, results));
    });
  }
  if (target.id === "save-platform") {
    return busy(target, async () => { setPlatform(await api("admin/platform", { method: "PUT", body: { name: $("#platform-name").value } })); toast("Saved"); });
  }
  const copy = closest("[data-copy]");
  if (copy) return copyText(copy.dataset.copy);
  const view = closest("[data-view-as]");
  if (view) return busy(view, () => viewAs(view.dataset.viewAs, view.dataset.then));
  const manage = closest("[data-manage]");
  if (manage) return openManage(manage.dataset.manage);

  const toggle = closest("[data-toggle]");
  if (toggle) {
    return busy(toggle, async () => {
      await api(`admin/installers/${toggle.dataset.toggle}`, { method: "PATCH", body: { status: toggle.dataset.next } });
      dialog.close();
      toast(toggle.dataset.next === "active" ? "Installer reactivated" : "Installer paused");
      await showInstallers();
    });
  }
  const reset = closest("[data-reset]");
  if (reset) {
    return busy(reset, async () => {
      await api(`admin/installers/${reset.dataset.reset}`, { method: "PATCH", body: { password: $("#reset-password").value } });
      $("#reset-password").value = "";
      toast("Password updated");
    });
  }
  const remove = closest("[data-delete]");
  if (remove) {
    const installer = installers.find((x) => x.id === remove.dataset.delete);
    if (!confirm(`Delete ${installer?.companyName} and all of their leads and photos? This cannot be undone.`)) return;
    return busy(remove, async () => {
      await api(`admin/installers/${remove.dataset.delete}`, { method: "DELETE" });
      dialog.close();
      toast("Installer deleted");
      await showInstallers();
    });
  }
  const row = closest("[data-lead]");
  if (row) return openLead(row.dataset.lead).catch((error) => toast(error.message, "error"));
});

document.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("[data-lead]");
  if (row && event.key === "Enter") openLead(row.dataset.lead).catch((error) => toast(error.message, "error"));
});

document.addEventListener("change", (event) => {
  if (event.target.id === "f-installer") { leadFilter.installer = event.target.value; showLeads(); }
  if (event.target.id === "f-status") { leadFilter.status = event.target.value; showLeads(); }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "installer-edit") {
    event.preventDefault();
    const form = event.target;
    await busy(form.querySelector('button[type="submit"]'), async () => {
      await api(`admin/installers/${form.dataset.id}`, { method: "PATCH", body: Object.fromEntries(new FormData(form)) });
      toast("Details saved");
      await showInstallers();
      openManageRefresh(form.dataset.id);
    });
    return;
  }
  if (event.target.id !== "installer-form") return;
  event.preventDefault();
  const form = event.target;
  const errorBox = $("#installer-error");
  const button = form.querySelector('button[type="submit"]');
  errorBox.hidden = true;
  button.disabled = true;
  try {
    const created = await api("admin/installers", { method: "POST", body: Object.fromEntries(new FormData(form)) });
    dialog.close();
    toast("Installer created");
    await showInstallers();
    copyText(created.quoteLink);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
});

boot().catch((error) => setHtml(page, html`<div class="empty"><h3>${error.message}</h3></div>`));
