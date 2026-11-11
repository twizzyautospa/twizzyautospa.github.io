// Shared helpers for every page. No build step: plain ES modules.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Call the API. Resolves with parsed JSON, rejects with an Error carrying `.status`. */
export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const error = new Error(data?.error || "Something went wrong. Please try again.");
    error.status = res.status;
    throw error;
  }
  return data;
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Raw {
  constructor(value) {
    this.value = value;
  }
}
/** Mark a string as already-safe HTML. */
export const raw = (value) => new Raw(value);

/** Tagged template that escapes every interpolated value unless it came from html`` or raw(). */
export function html(strings, ...values) {
  let out = "";
  strings.forEach((chunk, i) => {
    out += chunk;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

function render(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return esc(value);
}

export function setHtml(element, content) {
  element.innerHTML = content instanceof Raw ? content.value : esc(content);
}

export const money = (n, cents = false) =>
  Number(n ?? 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });

export const dateOnly = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

export const dateTime = (iso) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 86400 * 14) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Apply an installer's brand colour, choosing readable text to sit on top of it. */
export function applyBrand(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || "")) return;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const root = document.documentElement.style;
  root.setProperty("--brand", color);
  root.setProperty("--on-brand", luminance > 0.45 ? "#14171f" : "#ffffff");
}

export const SERVICE_LABELS = { roofline: "Roofline", trees: "Trees & shrubs", full: "Full house" };
export const SIZE_LABELS = { small: "Small", medium: "Medium", large: "Large", xl: "Extra large" };
export const SCOPE_LABELS = { front: "Front only", frontSides: "Front and sides", full: "All the way around" };
export const COLOR_LABELS = { warm: "Warm white", cool: "Bright white", multi: "Multicolour" };
export const STATUS_LABELS = {
  new: "New",
  quoted: "Quote sent",
  booked: "Booked",
  completed: "Completed",
  declined: "Declined",
  lost: "Lost",
};

/** Satellite imagery for the map views. Swap this one object to change provider. */
export const TILES = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
  maxNativeZoom: 19,
  maxZoom: 21,
};

export function toast(message, kind = "info") {
  let holder = $("#toasts");
  if (!holder) {
    holder = document.createElement("div");
    holder.id = "toasts";
    holder.setAttribute("role", "status");
    holder.setAttribute("aria-live", "polite");
    document.body.append(holder);
  }
  const item = document.createElement("div");
  item.className = `toast toast-${kind}`;
  item.textContent = message;
  holder.append(item);
  setTimeout(() => item.remove(), 4200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    window.prompt("Copy this:", text);
  }
}

/** Run an async action from a button, disabling it while it works and showing any error. */
export async function busy(button, action) {
  if (button.disabled) return;
  const label = button.textContent;
  button.disabled = true;
  button.classList.add("is-busy");
  try {
    return await action();
  } catch (error) {
    toast(error.message, "error");
    return undefined;
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
    if (!button.textContent) button.textContent = label;
  }
}

/** Describe what a customer asked for in one line. */
export function describeRequest(s) {
  if (!s) return "";
  const parts = [SERVICE_LABELS[s.service] || s.service];
  if (s.service !== "trees") parts.push(`${SIZE_LABELS[s.homeSize]} home`, `${s.stories}-storey`, SCOPE_LABELS[s.scope]);
  if (s.service !== "roofline") {
    const trees = (s.trees?.small || 0) + (s.trees?.medium || 0) + (s.trees?.large || 0);
    if (trees) parts.push(`${trees} tree${trees === 1 ? "" : "s"}`);
    if (s.shrubs) parts.push(`${s.shrubs} shrub${s.shrubs === 1 ? "" : "s"}`);
  }
  parts.push(COLOR_LABELS[s.color]);
  return parts.filter(Boolean).join(" · ");
}
