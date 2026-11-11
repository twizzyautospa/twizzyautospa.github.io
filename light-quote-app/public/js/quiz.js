import { $, api, applyBrand, esc, html, raw, setHtml, TILES } from "./lib.js";

const slug = decodeURIComponent(location.pathname.split("/")[2] || "");
const MAX_PHOTOS = 3;

const state = {
  index: 0,
  selections: {
    service: "",
    homeSize: "",
    stories: 1,
    scope: "front",
    trees: { small: 0, medium: 0, large: 0 },
    shrubs: 0,
    color: "",
    notes: "",
  },
  address: "",
  lat: null,
  lng: null,
  photos: [],
  contact: { name: "", phone: "", email: "" },
};

/* ---------- icons ---------- */
const bulbs = (points) => points.map(([x, y]) => `<circle class="bulb" cx="${x}" cy="${y}" r="2.6"/>`).join("");
const HOUSE = `<path d="M14 34 40 14l26 20M20 31v24h40V31M34 55V42h12v13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
const TREE = (x) => `<path d="M${x} 56V44M${x - 9} 44a9 11 0 1 1 18 0z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
const ICONS = {
  roofline: `<svg viewBox="0 0 80 62" aria-hidden="true">${HOUSE}${bulbs([[16, 35], [22, 30], [28, 25], [34, 21], [40, 16], [46, 21], [52, 25], [58, 30], [64, 35]])}</svg>`,
  trees: `<svg viewBox="0 0 80 62" aria-hidden="true">${TREE(26)}<path d="M44 56c0-8 5-12 10-12s10 4 10 12z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>${bulbs([[22, 36], [30, 39], [26, 30], [23, 43], [50, 50], [57, 48], [60, 53], [47, 54]])}</svg>`,
  full: `<svg viewBox="0 0 96 62" aria-hidden="true">${HOUSE}${TREE(82)}${bulbs([[16, 35], [22, 30], [28, 25], [34, 21], [40, 16], [46, 21], [52, 25], [58, 30], [64, 35], [78, 36], [86, 39], [82, 30], [80, 43]])}</svg>`,
  camera: `<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M6 15h8l3-5h14l3 5h8v24H6z"/><circle cx="24" cy="26" r="8"/></svg>`,
};
const houseSize = (scale) =>
  `<svg viewBox="0 0 80 62" aria-hidden="true"><g transform="translate(${40 - 40 * scale} ${58 - 58 * scale}) scale(${scale})">${HOUSE}</g></svg>`;

/* ---------- steps ---------- */
const wantsRoof = () => state.selections.service !== "trees";
const wantsTrees = () => state.selections.service !== "roofline";

function steps() {
  return ["service", wantsRoof() && "home", wantsTrees() && "trees", "color", "address", "photo", "contact"].filter(Boolean);
}

const choice = (name, value, current, body) => html`
  <label class="choice">
    <input type="radio" name="${name}" value="${value}" ${raw(String(current) === String(value) ? "checked" : "")}>
    ${body}
  </label>`;

const head = (title, sub) => html`<div class="step-head"><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ""}</div>`;

const RENDER = {
  service: () => html`
    ${head("What would you like lit up?", state.tagline)}
    <div class="choices choices-3" role="radiogroup" aria-label="What to light">
      ${choice("service", "roofline", state.selections.service, html`${raw(ICONS.roofline)}<span class="choice-text"><strong>Roofline</strong><small>Lights along the edges and peaks of your roof</small></span>`)}
      ${choice("service", "trees", state.selections.service, html`${raw(ICONS.trees)}<span class="choice-text"><strong>Trees &amp; shrubs</strong><small>Wrapped trunks, branches and bushes</small></span>`)}
      ${choice("service", "full", state.selections.service, html`${raw(ICONS.full)}<span class="choice-text"><strong>Full house</strong><small>Roofline plus trees and shrubs</small></span>`)}
    </div>`,

  home: () => html`
    ${head("Tell us about your home", "A rough answer is fine. Your installer measures before giving a final price.")}
    <div class="group-title" id="size-title">How big is it?</div>
    <div class="choices" role="radiogroup" aria-labelledby="size-title">
      ${choice("homeSize", "small", state.selections.homeSize, html`${raw(houseSize(0.62))}<strong>Small</strong><small>Under 1,500 sq ft</small>`)}
      ${choice("homeSize", "medium", state.selections.homeSize, html`${raw(houseSize(0.76))}<strong>Medium</strong><small>1,500 to 2,500 sq ft</small>`)}
      ${choice("homeSize", "large", state.selections.homeSize, html`${raw(houseSize(0.9))}<strong>Large</strong><small>2,500 to 4,000 sq ft</small>`)}
      ${choice("homeSize", "xl", state.selections.homeSize, html`${raw(houseSize(1))}<strong>Extra large</strong><small>Over 4,000 sq ft</small>`)}
    </div>
    <div class="group-title" id="stories-title">How many storeys?</div>
    <div class="choices choices-compact" role="radiogroup" aria-labelledby="stories-title">
      ${[1, 2, 3].map((n) => choice("stories", n, state.selections.stories, html`<strong>${n === 3 ? "3 or more" : n}</strong>`))}
    </div>
    <div class="group-title" id="scope-title">Which parts of the roofline?</div>
    <div class="choices choices-compact" role="radiogroup" aria-labelledby="scope-title">
      ${choice("scope", "front", state.selections.scope, html`<strong>Front only</strong><small>What you see from the street</small>`)}
      ${choice("scope", "frontSides", state.selections.scope, html`<strong>Front and sides</strong>`)}
      ${choice("scope", "full", state.selections.scope, html`<strong>All the way around</strong>`)}
    </div>`,

  trees: () => {
    const row = (key, label, hint, value) => html`
      <div class="stepper-row">
        <div><strong>${label}</strong><div class="small muted">${hint}</div></div>
        <div class="stepper">
          <button type="button" data-step="${key}" data-delta="-1" aria-label="Fewer ${label}">&minus;</button>
          <output id="count-${key}" aria-label="${label}">${value}</output>
          <button type="button" data-step="${key}" data-delta="1" aria-label="More ${label}">+</button>
        </div>
      </div>`;
    const t = state.selections.trees;
    return html`
      ${head("Which trees and shrubs?", "Count the ones you want lit.")}
      <div class="card">
        ${row("small", "Small trees", "Up to about 10 ft tall", t.small)}
        ${row("medium", "Medium trees", "About 10 to 20 ft", t.medium)}
        ${row("large", "Large trees", "Over 20 ft", t.large)}
        ${row("shrubs", "Shrubs and bushes", "Any size", state.selections.shrubs)}
      </div>`;
  },

  color: () => {
    const dots = (colors) => html`<span class="bulbs">${colors.map((c) => html`<i style="color:${c}"></i>`)}</span>`;
    return html`
      ${head("Pick a colour to start with", "You will see all three on your home, so this is only your favourite.")}
      <div class="choices choices-3" role="radiogroup" aria-label="Light colour">
        ${choice("color", "warm", state.selections.color, html`${dots(["#ffc45c", "#ffc45c", "#ffc45c", "#ffc45c"])}<span class="choice-text"><strong>Warm white</strong><small>Classic golden glow</small></span>`)}
        ${choice("color", "cool", state.selections.color, html`${dots(["#bfe1ff", "#bfe1ff", "#bfe1ff", "#bfe1ff"])}<span class="choice-text"><strong>Bright white</strong><small>Crisp and icy</small></span>`)}
        ${choice("color", "multi", state.selections.color, html`${dots(["#e5484d", "#3fa55b", "#3b82f6", "#f5b83d"])}<span class="choice-text"><strong>Multicolour</strong><small>Red, green, blue and gold</small></span>`)}
      </div>`;
  },

  address: () => html`
    ${head("Where is your home?", "We use this to look at your roofline from above.")}
    <label class="field">
      <span>Street address</span>
      <input type="text" id="address" autocomplete="street-address" inputmode="text" placeholder="Start typing your address" value="${state.address}">
    </label>
    <ul class="suggestions" id="suggestions" hidden></ul>
    <div id="map-holder" class="stack" style="margin-top:14px" ${raw(state.lat === null ? "hidden" : "")}>
      <div class="map-box" id="map" role="img" aria-label="Satellite view of the address"></div>
      <p class="small muted">Not the right spot? Pick a different address above. You can still continue either way.</p>
    </div>`,

  photo: () => html`
    ${head("Add a photo of your home", "This is what we light up for your preview. A daytime photo from across the street works best.")}
    <label class="dropzone" id="dropzone" ${raw(state.photos.length >= MAX_PHOTOS ? "hidden" : "")}>
      ${raw(ICONS.camera)}
      <strong>Take or choose a photo</strong>
      <span class="small muted">Up to ${MAX_PHOTOS} photos. The first one is used for your preview.</span>
      <input type="file" id="photo-input" accept="image/*" multiple hidden>
    </label>
    <div class="thumbs" id="thumbs" style="margin-top:12px">
      ${state.photos.map((src, i) => html`<div class="thumb"><img src="${src}" alt="Your photo ${i + 1}"><button type="button" data-remove="${i}" aria-label="Remove photo ${i + 1}">&times;</button></div>`)}
    </div>
    <ul class="tips" style="margin-top:14px">
      <li>Fit the whole front of the house in the frame.</li>
      <li>Daylight works better than night.</li>
      <li>No photo handy? Continue without one and your installer will follow up.</li>
    </ul>`,

  contact: () => html`
    ${head(state.photos.length ? "Where should we send your preview?" : "Where should we send your quote?", `${state.companyName} will use this to confirm your price.`)}
    <div class="stack">
      <label class="field"><span>Your name</span><input type="text" id="c-name" autocomplete="name" required value="${state.contact.name}"></label>
      <label class="field"><span>Mobile number</span><input type="tel" id="c-phone" autocomplete="tel" inputmode="tel" required value="${state.contact.phone}"></label>
      <label class="field"><span>Email <span class="muted" style="font-weight:400">(optional)</span></span><input type="email" id="c-email" autocomplete="email" value="${state.contact.email}"></label>
      <label class="field"><span>Anything else we should know? <span class="muted" style="font-weight:400">(optional)</span></span><textarea id="c-notes" maxlength="1000">${state.selections.notes}</textarea></label>
      <div aria-hidden="true" style="position:absolute;left:-9999px"><label>Website<input type="text" id="c-website" tabindex="-1" autocomplete="off"></label></div>
      <p class="tiny muted">By continuing you agree that ${state.companyName} may contact you about this request.</p>
    </div>`,
};

/* ---------- rendering and navigation ---------- */
function show() {
  const list = steps();
  state.index = Math.min(state.index, list.length - 1);
  const key = list[state.index];
  setHtml($("#step"), RENDER[key]());
  const pct = Math.round((state.index / list.length) * 100);
  $("#progress-bar").style.width = `${Math.max(6, pct)}%`;
  $(".progress").setAttribute("aria-valuenow", String(pct));
  $("#back").hidden = state.index === 0;
  const last = state.index === list.length - 1;
  $("#next").textContent = last ? (state.photos.length ? "See my home lit up" : "Get my quote") : key === "photo" && !state.photos.length ? "Skip for now" : "Continue";
  setError("");
  if (key === "address") initAddress();
  window.scrollTo({ top: 0 });
  $("#step h1")?.setAttribute("tabindex", "-1");
  $("#step h1")?.focus({ preventScroll: true });
}

function setError(message) {
  const box = $("#step-error");
  box.textContent = message;
  box.hidden = !message;
}

/** Validate and save the current step. Returns an error message, or "" when the step is complete. */
function collect(key) {
  const s = state.selections;
  if (key === "service") return s.service ? "" : "Choose what you would like lit up.";
  if (key === "home") return s.homeSize ? "" : "Choose the size closest to your home.";
  if (key === "trees") {
    return s.trees.small + s.trees.medium + s.trees.large + s.shrubs > 0 ? "" : "Add at least one tree or shrub.";
  }
  if (key === "color") return s.color ? "" : "Pick a colour to start with.";
  if (key === "address") {
    state.address = $("#address").value.trim();
    return state.address.length >= 6 ? "" : "Enter your street address.";
  }
  if (key === "contact") {
    state.contact = { name: $("#c-name").value.trim(), phone: $("#c-phone").value.trim(), email: $("#c-email").value.trim() };
    s.notes = $("#c-notes").value.trim();
    if (state.contact.name.length < 2) return "Enter your name.";
    if (state.contact.phone.replace(/\D/g, "").length < 7) return "Enter a phone number we can reach you on.";
    if (state.contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(state.contact.email)) return "That email address does not look right.";
  }
  return "";
}

$("#quiz").addEventListener("submit", async (event) => {
  event.preventDefault();
  const list = steps();
  const key = list[state.index];
  const problem = collect(key);
  if (problem) return setError(problem);
  if (state.index < list.length - 1) {
    state.index += 1;
    return show();
  }
  await submit();
});

$("#back").addEventListener("click", () => {
  const key = steps()[state.index];
  if (key === "address") state.address = $("#address").value.trim();
  state.index = Math.max(0, state.index - 1);
  show();
});

$("#step").addEventListener("change", (event) => {
  const input = event.target;
  if (input.type === "radio") {
    state.selections[input.name] = input.name === "stories" ? Number(input.value) : input.value;
    setError("");
    // Single-question steps move on by themselves.
    if (input.name === "service" || input.name === "color") {
      setTimeout(() => { state.index += 1; show(); }, 180);
    }
  }
  if (input.id === "photo-input") addPhotos([...input.files]);
});

$("#step").addEventListener("click", (event) => {
  const stepper = event.target.closest("[data-step]");
  if (stepper) {
    const key = stepper.dataset.step;
    const delta = Number(stepper.dataset.delta);
    const max = key === "shrubs" ? 60 : 20;
    if (key === "shrubs") state.selections.shrubs = Math.min(max, Math.max(0, state.selections.shrubs + delta));
    else state.selections.trees[key] = Math.min(max, Math.max(0, state.selections.trees[key] + delta));
    $(`#count-${key}`).textContent = key === "shrubs" ? state.selections.shrubs : state.selections.trees[key];
    setError("");
  }
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    state.photos.splice(Number(remove.dataset.remove), 1);
    show();
  }
});

/* ---------- address lookup ---------- */
let map = null;
let marker = null;
let lookupTimer = 0;
let lookupSeq = 0;

function placeLabel(p) {
  const street = [p.housenumber, p.street || p.name].filter(Boolean).join(" ");
  return [street, p.city || p.town || p.village || p.county, p.state, p.postcode].filter(Boolean).join(", ");
}

async function lookup(query) {
  const seq = ++lookupSeq;
  try {
    const res = await fetch(`https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(query)}`);
    if (!res.ok || seq !== lookupSeq) return;
    const data = await res.json();
    const seen = new Set();
    const places = (data.features || [])
      .map((f) => ({ label: placeLabel(f.properties || {}), lat: f.geometry?.coordinates?.[1], lng: f.geometry?.coordinates?.[0] }))
      .filter((p) => p.label && typeof p.lat === "number" && !seen.has(p.label) && seen.add(p.label));
    const list = $("#suggestions");
    if (!list) return;
    list.hidden = places.length === 0;
    setHtml(list, html`${places.map((p) => html`<li><button type="button" data-lat="${p.lat}" data-lng="${p.lng}">${p.label}</button></li>`)}`);
  } catch {
    /* Suggestions are a convenience. Typing the full address still works. */
  }
}

function showMap() {
  $("#map-holder").hidden = false;
  if (map) { map.remove(); map = null; }
  map = L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([state.lat, state.lng], 19);
  L.tileLayer(TILES.url, { attribution: TILES.attribution, maxNativeZoom: TILES.maxNativeZoom, maxZoom: TILES.maxZoom }).addTo(map);
  marker = L.circleMarker([state.lat, state.lng], { radius: 10, color: "#fff", weight: 3, fillColor: "#e5484d", fillOpacity: 1 }).addTo(map);
}

function initAddress() {
  map = null;
  const input = $("#address");
  input.addEventListener("input", () => {
    state.lat = state.lng = null;
    $("#map-holder").hidden = true;
    clearTimeout(lookupTimer);
    const query = input.value.trim();
    if (query.length < 5) { $("#suggestions").hidden = true; return; }
    lookupTimer = setTimeout(() => lookup(query), 320);
  });
  $("#suggestions").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    input.value = state.address = button.textContent;
    state.lat = Number(button.dataset.lat);
    state.lng = Number(button.dataset.lng);
    $("#suggestions").hidden = true;
    setError("");
    showMap();
  });
  if (state.lat !== null) showMap();
}

/* ---------- photos ---------- */
/** Shrink a photo in the browser so uploads are quick on mobile data. */
async function shrink(file, maxSide = 1536, quality = 0.82) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function addPhotos(files) {
  for (const file of files) {
    if (state.photos.length >= MAX_PHOTOS) break;
    try {
      state.photos.push(await shrink(file));
    } catch {
      setError("We could not read one of those photos. Try a JPEG or PNG.");
    }
  }
  const message = $("#step-error").textContent;
  show();
  if (message) setError(message);
}

/* ---------- submit ---------- */
async function submit() {
  const button = $("#next");
  button.disabled = true;
  button.classList.add("is-busy");
  try {
    const result = await api("public/leads", {
      method: "POST",
      body: {
        slug,
        selections: state.selections,
        address: state.address,
        lat: state.lat,
        lng: state.lng,
        photos: state.photos,
        contact: state.contact,
        website: $("#c-website").value,
      },
    });
    location.href = `/r/${result.token}`;
  } catch (error) {
    setError(error.message);
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

/* ---------- start ---------- */
async function start() {
  try {
    const { installer } = await api(`public/installer/${encodeURIComponent(slug)}`);
    state.companyName = installer.companyName;
    state.tagline = installer.brand.tagline;
    applyBrand(installer.brand.color);
    document.title = `Holiday lighting quote · ${installer.companyName}`;
    setHtml($("#brand-id"), installer.brand.logo
      ? html`<img src="${installer.brand.logo}" alt="${installer.companyName}">`
      : html`<span>${installer.companyName}</span>`);
    if (installer.phone) {
      const phone = $("#brand-phone");
      phone.hidden = false;
      phone.href = `tel:${installer.phone.replace(/[^\d+]/g, "")}`;
      phone.textContent = installer.phone;
    }
    show();
  } catch (error) {
    $("#step-nav").hidden = true;
    $(".progress").hidden = true;
    $("#step").innerHTML = `<div class="card center" style="margin-top:30px"><h1>This link is not available</h1><p class="muted" style="margin-top:8px">${esc(error.message)}</p></div>`;
  }
}

start();
