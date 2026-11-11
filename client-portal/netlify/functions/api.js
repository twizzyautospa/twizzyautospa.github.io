'use strict';
/*
 * LeadThru Client Portal — API (single Netlify Function, bundled by scripts/deploy.mjs).
 *
 * Routes (all under /api/*, see public/_redirects):
 *   POST /api/login    {username, password}
 *   POST /api/logout
 *   GET  /api/me
 *   GET  /api/board?pipeline=<id>        (pipeline is only honoured for the admin)
 *   POST /api/update   {id, stageId?, value?}
 *   GET  /api/notes?id=<opportunityId>
 *   POST /api/notes    {id, body}
 *   GET  /api/clients                     (admin) list clients + pipelines
 *   POST /api/clients  {action:'save'|'remove', ...}   (admin) add / edit / remove a client
 *   GET  /api/asset/<slug>/<file>         client logo, app icons and manifest (public, random slug)
 *   GET  /api/bookings?months=YYYY-MM,...[&pipeline=<id>]   portal calendar appointments
 *   POST /api/bookings {action:'save'|'cancel', ...}         book / change / cancel an appointment
 *   POST /api/meta     {id, meta:'yes'|'no'}  mark whether a lead came from Meta (GHL tags "meta lead" / "not meta lead")
 *   GET  /api/ics?t=<signed token>        one appointment as an .ics file (add to phone calendar)
 *   GET  /api/health
 *
 * Environment variables (set on the Netlify site, never in code):
 *   GHL_TOKEN, GHL_LOCATION_ID, SESSION_SECRET
 *   PORTAL_USERS   JSON list of logins used to seed the client list the first time
 *
 * Clients (logins, pipelines, branding, logos) live in Netlify Blobs (store "portal"), edited from
 * the admin Clients page. Until the first save there, the list comes from PORTAL_USERS + brands.json.
 * Every client request is locked to that client's own pipeline on the server.
 */
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

let blobs = null;
try { blobs = require('@netlify/blobs'); } catch { /* local runs without the package */ }

// Branding made with scripts/make-brand.py before the Clients page existed (assets in public/brands/).
let SEED_BRANDS = {};
try { SEED_BRANDS = require('./brands.json'); } catch { /* none */ }

const GHL_HOST = 'services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const COOKIE = 'lt_session';
const SESSION_DAYS = 30;
const ASSET_FILES = ['logo.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new HttpError(500, `Portal is missing its ${name} setting.`);
  return v;
}
const loc = () => env('GHL_LOCATION_ID');
const enc = encodeURIComponent;

/* ---------------- storage (Netlify Blobs, or a folder when testing locally) ---------------- */

function localStore(dir) {
  const file = (key) => path.join(dir, key.replace(/[^a-zA-Z0-9._/-]/g, '_'));
  return {
    mode: 'local',
    async get(key, opts = {}) {
      try {
        const buf = fs.readFileSync(file(key));
        return opts.type === 'json' ? JSON.parse(buf.toString('utf8')) : buf;
      } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async setJSON(key, value) { fs.mkdirSync(path.dirname(file(key)), { recursive: true }); fs.writeFileSync(file(key), JSON.stringify(value)); },
    async set(key, buf) { fs.mkdirSync(path.dirname(file(key)), { recursive: true }); fs.writeFileSync(file(key), Buffer.from(buf)); },
    async delete(key) { try { fs.unlinkSync(file(key)); } catch { /* gone */ } },
    async list(prefix) {
      const d = file(prefix);
      try { return fs.readdirSync(d).map((f) => `${prefix}${f}`); } catch { return []; }
    },
  };
}

function openStore(event) {
  if (process.env.PORTAL_LOCAL_STORE) return localStore(process.env.PORTAL_LOCAL_STORE);
  if (!blobs || !event.blobs) return null;
  try {
    const data = JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'));
    const uncached = data.uncachedEdgeURL || data.uncached_url || data.uncachedURL || null;
    blobs.setEnvironmentContext({
      deployID: event.headers['x-nf-deploy-id'],
      siteID: event.headers['x-nf-site-id'],
      edgeURL: data.url,
      uncachedEdgeURL: uncached || undefined,
      token: data.token,
    });
    const store = blobs.getStore({ name: 'portal', consistency: uncached ? 'strong' : 'eventual' });
    return {
      mode: uncached ? 'strong' : 'eventual',
      get: (key, opts = {}) => (opts.type === 'json' ? store.get(key, { type: 'json' })
        : store.get(key, { type: 'arrayBuffer' }).then((ab) => (ab ? Buffer.from(ab) : null))),
      setJSON: (key, value) => store.setJSON(key, value),
      set: (key, buf) => store.set(key, buf),
      delete: (key) => store.delete(key),
      list: async (prefix) => (await store.list({ prefix })).blobs.map((b) => b.key),
    };
  } catch (e) {
    console.error('blobs unavailable:', e.message);
    return null;
  }
}

/* ---------------- clients ----------------
 * One record per login at "clients/<username>":
 *   {u, n, p, h, admin?, brand?: {slug, short, color, showName, logoRatio, hasLogo, blob, v}}
 * One key per client means editing one client can never overwrite another.
 * Until the first save from the Clients page ("meta".migrated), records come from
 * PORTAL_USERS + brands.json (the original setup).
 */

function seedUsers() {
  let users = [];
  try { users = JSON.parse(process.env.PORTAL_USERS || '[]'); } catch { users = []; }
  return users.map((x) => {
    const u = String(x.u).toLowerCase();
    const b = SEED_BRANDS[u];
    const rec = { ...x, u };
    if (b) {
      rec.brand = {
        slug: b.slug, short: b.short, color: b.color, showName: !!b.showName,
        logoRatio: b.logoRatio || 1, hasLogo: true, blob: false, v: 1,
      };
    }
    return rec;
  });
}

let migratedFlag = false;
async function isMigrated(store) {
  if (migratedFlag || !store) return migratedFlag;
  try {
    const m = await store.get('meta', { type: 'json' });
    if (m && m.migrated) migratedFlag = true;
  } catch (e) { console.error('meta read failed:', e.message); }
  return migratedFlag;
}

const userCache = new Map();
const normU = (u) => String(u || '').toLowerCase().trim();

async function getUser(store, username) {
  const u = normU(username);
  if (!u) return null;
  const hit = userCache.get(u);
  if (hit && Date.now() - hit.at < 15e3) return hit.rec;
  let rec = null;
  if (store) {
    try { rec = await store.get(`clients/${u}`, { type: 'json' }); } catch (e) { console.error('client read failed:', e.message); }
  }
  if (!rec && !(await isMigrated(store))) rec = seedUsers().find((x) => x.u === u) || null;
  userCache.set(u, { at: Date.now(), rec });
  return rec;
}

let allCache = { at: 0, list: null };
async function allUsers(store, fresh) {
  if (!fresh && allCache.list && Date.now() - allCache.at < 30e3) return allCache.list;
  let list;
  if (store && await isMigrated(store)) {
    const keys = await store.list('clients/');
    list = (await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch(() => null)))).filter(Boolean);
  } else {
    list = seedUsers();
  }
  allCache = { at: Date.now(), list };
  return list;
}

// Storage can lag up to a minute after a write; prefer this instance's newer copy if it has one.
async function freshestUser(store, u) {
  const hit = userCache.get(u);
  const stored = await store.get(`clients/${u}`, { type: 'json' });
  if (hit && hit.rec && (!stored || (hit.rec.updatedAt || 0) > (stored.updatedAt || 0))) return hit.rec;
  return stored;
}

// First save from the Clients page: copy the original logins into storage (never overwriting).
async function migrate(store) {
  if (await isMigrated(store)) return;
  for (const rec of seedUsers()) {
    const existing = await store.get(`clients/${rec.u}`, { type: 'json' });
    if (!existing) await store.setJSON(`clients/${rec.u}`, rec);
  }
  await store.setJSON('meta', { migrated: true, at: new Date().toISOString() });
  migratedFlag = true;
}

async function putUser(store, rec) {
  rec.updatedAt = Date.now();
  await store.setJSON(`clients/${rec.u}`, rec);
  userCache.set(rec.u, { at: Date.now(), rec });
  allCache = { at: 0, list: null };
}

async function deleteUser(store, u) {
  await store.delete(`clients/${u}`);
  userCache.set(u, { at: Date.now(), rec: null });
  allCache = { at: 0, list: null };
}

function publicBrand(rec) {
  const b = rec && rec.brand;
  if (!b) return null;
  const v = b.v || 1;
  return {
    slug: b.slug,
    name: rec.n,
    short: b.short || rec.n,
    color: b.color,
    showName: !!b.showName,
    logoRatio: b.logoRatio || 1,
    hasLogo: b.hasLogo !== false,
    assets: b.blob ? `/api/asset/${b.slug}` : `/brands/${b.slug}`,
    manifest: `/api/asset/${b.slug}/manifest.webmanifest?v=${v}`,
    v,
  };
}

/* ---------------- passwords & sessions ---------------- */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), want.length);
  return want.length > 0 && crypto.timingSafeEqual(want, got);
}

const sign = (data) => crypto.createHmac('sha256', env('SESSION_SECRET')).update(data).digest('base64url');

// The session embeds a fingerprint of the password hash, so changing a
// password signs that user out everywhere.
function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    u: user.u,
    v: user.h.slice(-12),
    exp: Date.now() + SESSION_DAYS * 864e5,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

async function readSession(event, store) {
  const raw = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const m = raw.match(/(?:^|;\s*)lt_session=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || !data.exp || data.exp < Date.now()) return null;
  const user = await getUser(store, data.u);
  if (!user || !user.h || user.h.slice(-12) !== data.v) return null;
  return user;
}

const sessionCookie = (value, maxAgeSeconds) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

/* ---------------- GoHighLevel ---------------- */

function ghl(method, p, body) {
  // Local testing only: PORTAL_DRY_WRITES=1 reads real GHL data but skips every change.
  if (process.env.PORTAL_DRY_WRITES && method !== 'GET') {
    console.log(`[dry run] GHL ${method} ${p.split('?')[0]} ${body ? JSON.stringify(body).slice(0, 160) : ''}`);
    return Promise.resolve({});
  }
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Bearer ${env('GHL_TOKEN')}`,
      Version: GHL_VERSION,
      Accept: 'application/json',
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ host: GHL_HOST, path: p, method, headers, timeout: 15000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 200) }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const msg = Array.isArray(json.message) ? json.message.join(', ') : (json.message || json.error || '');
        console.error(`GHL ${method} ${p.split('?')[0]} -> ${res.statusCode} ${msg}`);
        reject(new HttpError(res.statusCode === 429 ? 429 : 502,
          res.statusCode === 429 ? 'GoHighLevel is busy. Try again in a few seconds.' : 'GoHighLevel did not accept that. Try again.'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      console.error(`GHL ${method} ${p.split('?')[0]} failed: ${e.message}`);
      reject(new HttpError(502, 'Could not reach GoHighLevel. Try again.'));
    });
    if (data) req.write(data);
    req.end();
  });
}

let pipeCache = { at: 0, list: null };
async function pipelines() {
  if (pipeCache.list && Date.now() - pipeCache.at < 5 * 60e3) return pipeCache.list;
  const r = await ghl('GET', `/opportunities/pipelines?locationId=${enc(loc())}`);
  const list = (r.pipelines || []).map((p) => ({
    id: p.id,
    name: p.name,
    stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })),
  }));
  pipeCache = { at: Date.now(), list };
  return list;
}

async function allowedPipelines(user) {
  const all = await pipelines();
  return user.admin ? all : all.filter((p) => p.id === user.p);
}

async function listOpportunities(pipelineId) {
  const out = [];
  let startAfter = null;
  let startAfterId = null;
  for (let page = 0; page < 30; page++) {
    let q = `/opportunities/search?location_id=${enc(loc())}&pipeline_id=${enc(pipelineId)}&limit=100`;
    if (startAfterId) q += `&startAfter=${enc(startAfter)}&startAfterId=${enc(startAfterId)}`;
    const r = await ghl('GET', q);
    const items = r.opportunities || [];
    out.push(...items);
    const meta = r.meta || {};
    if (items.length < 100 || !meta.startAfterId || meta.startAfterId === startAfterId) break;
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }
  return out;
}

// Lead source: a client's explicit choice (GHL tag) wins; otherwise GHL's ad attribution.
const TAG_META = 'meta lead';
const TAG_NOT_META = 'not meta lead';
const META_RE = /facebook|instagram|\bfb\b|\big\b|\bmeta\b/i;
function metaState(o) {
  const tags = (((o.contact || {}).tags) || []).map((t) => String(t).toLowerCase());
  if (tags.includes(TAG_NOT_META)) return 'no';
  if (tags.includes(TAG_META)) return 'yes';
  const fromAd = (o.attributions || []).some((a) => /paid social/i.test(a.medium || '')
    || META_RE.test([a.utmSource, a.utmSessionSource, a.adSource, a.utmMedium].filter(Boolean).join(' ')));
  return fromAd || META_RE.test(o.source || '') ? 'auto' : 'unknown';
}

function slim(o) {
  const c = o.contact || {};
  return {
    id: o.id,
    // GHL auto-names leads "<Name> Opportunity"; drop the suffix for a cleaner list.
    name: String(o.name || '').replace(/\s+opportunity$/i, '').trim() || c.name || 'Unnamed lead',
    stageId: o.pipelineStageId,
    status: o.status || 'open',
    value: Number(o.monetaryValue) || 0,
    source: o.source || '',
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
    stageChangedAt: o.lastStageChangeAt || o.lastStatusChangeAt || null,
    meta: metaState(o),
    contact: {
      id: c.id || o.contactId || null,
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      company: c.companyName || '',
    },
  };
}

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

// Loads an opportunity and checks the signed-in user may touch it.
async function loadOpportunity(user, id) {
  if (!ID_RE.test(String(id || ''))) throw new HttpError(400, 'Unknown lead.');
  const r = await ghl('GET', `/opportunities/${enc(id)}`);
  const o = r.opportunity || r;
  if (!o || !o.id) throw new HttpError(404, 'Lead not found.');
  if (o.locationId && o.locationId !== loc()) throw new HttpError(404, 'Lead not found.');
  if (!user.admin && o.pipelineId !== user.p) throw new HttpError(403, 'That lead is not in your pipeline.');
  return o;
}

/* ---------------- admin: clients ---------------- */

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function pngFromBase64(b64, label) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length < 8 || !buf.subarray(0, 4).equals(PNG_MAGIC)) throw new HttpError(400, `The ${label} image is not a PNG.`);
  if (buf.length > 1.5 * 1024 * 1024) throw new HttpError(400, `The ${label} image is too large.`);
  return buf;
}

async function listClients(store, fresh) {
  const pipes = await pipelines();
  const pname = (id) => (pipes.find((p) => p.id === id) || {}).name || 'Pipeline not found in GHL';
  const users = await allUsers(store, fresh);
  return {
    clients: users.filter((x) => !x.admin).map((x) => ({
      u: x.u, n: x.n, p: x.p, pipelineName: pname(x.p), brand: publicBrand(x),
    })).sort((a, b) => a.n.localeCompare(b.n)),
    pipelines: pipes.map((p) => ({ id: p.id, name: p.name })),
  };
}

async function saveClient(store, body) {
  const isNew = !!body.isNew;
  const u = normU(body.u);
  const n = String(body.n || '').trim().slice(0, 80);
  const p = String(body.p || '').trim();
  if (!USERNAME_RE.test(u)) throw new HttpError(400, 'Username: 2–32 lowercase letters or numbers, no spaces.');
  if (!n) throw new HttpError(400, 'Add the business name.');
  if (!(await pipelines()).some((x) => x.id === p)) throw new HttpError(400, 'Pick one of your GHL pipelines.');

  await migrate(store);
  const existing = await freshestUser(store, u);
  if (isNew && existing) throw new HttpError(409, 'That username is already taken.');
  if (!isNew && !existing) throw new HttpError(409, 'Could not load this client. If you just added them, wait a minute and try again.');
  if (existing && existing.admin) throw new HttpError(400, 'The admin login cannot be edited here.');

  const password = body.password ? String(body.password) : '';
  if (isNew && !password) throw new HttpError(400, 'Set a password for the new client.');
  if (password && password.length < 6) throw new HttpError(400, 'Passwords need at least 6 characters.');
  if (password.length > 200) throw new HttpError(400, 'That password is too long.');

  const rec = { ...(existing || {}), u, n, p };
  if (password) rec.h = hashPassword(password);
  if (!rec.h) throw new HttpError(400, 'Set a password for this client.');

  const b = body.brand || {};
  const prev = rec.brand || null;
  const color = COLOR_RE.test(b.color || '') ? b.color.toUpperCase() : (prev && prev.color) || null;
  const files = b.files || null;
  if (files || prev || color) {
    const brand = {
      ...(prev || {}),
      slug: (prev && prev.slug) || crypto.randomBytes(5).toString('hex'),
      short: String(b.short || (prev && prev.short) || n).trim().slice(0, 24) || n,
      color: color || '#7CC521',
      showName: b.showName === undefined ? !!(prev && prev.showName) : !!b.showName,
    };
    if (files) {
      const bufs = {
        'logo.png': pngFromBase64(files.logo, 'logo'),
        'icon-192.png': pngFromBase64(files.icon192, 'icon'),
        'icon-512.png': pngFromBase64(files.icon512, 'icon'),
        'icon-maskable-512.png': pngFromBase64(files.maskable, 'icon'),
        'apple-touch-icon.png': pngFromBase64(files.apple, 'icon'),
      };
      for (const [name, buf] of Object.entries(bufs)) await store.set(`asset/${brand.slug}/${name}`, buf);
      brand.blob = true;
      brand.hasLogo = true;
      brand.logoRatio = Math.max(0.2, Math.min(12, Number(b.ratio) || 1));
    } else if (!prev) {
      brand.hasLogo = false;
    }
    brand.v = Date.now();
    rec.brand = brand;
  }
  await putUser(store, rec);
  if (rec.brand) await store.setJSON(`slug/${rec.brand.slug}`, { u });
  return rec;
}

async function removeClient(store, username) {
  const u = normU(username);
  await migrate(store);
  const existing = await freshestUser(store, u);
  if (!existing) throw new HttpError(409, 'Could not load this client. If you just added them, wait a minute and try again.');
  if (existing.admin) throw new HttpError(400, 'The admin login cannot be removed.');
  await deleteUser(store, u);
  const b = existing.brand;
  if (b) await store.delete(`slug/${b.slug}`).catch(() => {});
  if (b && b.blob) {
    for (const f of ASSET_FILES) await store.delete(`asset/${b.slug}/${f}`).catch(() => {});
  }
}

/* ---------------- bookings (portal calendar, separate from GHL calendars) ----------------
 * One record per appointment at "bk/<pipelineId>/<YYYY-MM of start, UTC>/<id>".
 * Each booking also leaves a note on the GHL contact and tags new bookings
 * "appointment booked", so GHL workflows can react to it.
 */
const MONTH_RE = /^\d{4}-\d{2}$/;
const BK_ID_RE = /^[a-f0-9]{12}$/;
const BOOKED_TAG = 'appointment booked';

// Storage can lag after a write; this instance remembers its own recent writes for 5 minutes.
const recentBookings = new Map();
function noteRecentBooking(pid, id, rec) {
  let m = recentBookings.get(pid);
  if (!m) { m = new Map(); recentBookings.set(pid, m); }
  m.set(id, { rec, at: Date.now() });
}

function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'America/Toronto'; }
}

function whenText(rec, tz) {
  const zone = safeTz(tz || 'America/Toronto');
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(rec.start));
  const t = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  return `${day}, ${t(rec.start)}–${t(rec.end)}`;
}

function icsToken(b) {
  const payload = Buffer.from(JSON.stringify({
    i: b.id, t: b.title, n: b.lead.name, p: b.lead.phone, a: b.address, s: b.start, e: b.end, d: (b.notes || '').slice(0, 300),
  })).toString('base64url');
  return `${payload}.${sign(`ics.${payload}`).slice(0, 24)}`;
}

function publicBooking(rec) {
  return { ...rec, ics: `/api/ics?t=${icsToken(rec)}` };
}

function icsFile(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || sign(`ics.${payload}`).slice(0, 24) !== sig) throw new HttpError(404, 'Not found.');
  const b = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\;');
  const dt = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const fold = (line) => {
    const out = [];
    for (let s = line; s.length; s = s.slice(73)) out.push((out.length ? ' ' : '') + s.slice(0, 73));
    return out.join('\r\n');
  };
  const details = [b.p && `Phone: ${b.p}`, b.d].filter(Boolean).join('\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LeadThru//Client Portal//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.i}@portal.leadthruagency.com`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(b.s)}`,
    `DTEND:${dt(b.e)}`,
    fold(`SUMMARY:${esc(`${b.t} · ${b.n}`)}`),
    b.a ? fold(`LOCATION:${esc(b.a)}`) : null,
    details ? fold(`DESCRIPTION:${esc(details)}`) : null,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(b.t)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter((l) => l !== null).join('\r\n');
}

async function bookingPipeline(user, wanted) {
  const list = await allowedPipelines(user);
  const p = user.admin ? list.find((x) => x.id === wanted) : list[0];
  if (!p) throw new HttpError(404, 'No pipeline found.');
  return p;
}

async function listBookings(store, pid, months) {
  const out = new Map();
  if (store) {
    await Promise.all(months.map(async (m) => {
      const keys = await store.list(`bk/${pid}/${m}/`);
      const recs = await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch(() => null)));
      for (const r of recs) if (r && r.id) out.set(r.id, r);
    }));
  }
  const recent = recentBookings.get(pid);
  if (recent) {
    for (const [id, x] of recent) {
      if (Date.now() - x.at > 5 * 60e3) { recent.delete(id); continue; }
      if (x.rec && months.includes(x.rec.month)) out.set(id, x.rec); else out.delete(id);
    }
  }
  return [...out.values()].sort((a, b) => a.start.localeCompare(b.start)).map(publicBooking);
}

// GHL side effects are best effort: the booking is saved even if GHL is briefly unavailable.
async function ghlNote(contactId, text) {
  if (!contactId) return true;
  try { await ghl('POST', `/contacts/${enc(contactId)}/notes`, { body: text }); return true; } catch { return false; }
}

async function saveBooking(store, user, body) {
  const o = await loadOpportunity(user, body.oppId);
  const pid = o.pipelineId;
  const start = new Date(body.start);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Pick a date and time.');
  if (Math.abs(start.getTime() - Date.now()) > 2 * 365 * 864e5) throw new HttpError(400, 'Pick a date within the next two years.');
  const minutes = Math.round(Number(body.minutes));
  if (!(minutes >= 15 && minutes <= 720)) throw new HttpError(400, 'Pick how long it takes.');
  const isNew = !body.id;
  if (!isNew && (!BK_ID_RE.test(String(body.id)) || !MONTH_RE.test(String(body.month || '')))) throw new HttpError(400, 'Unknown appointment.');
  const amount = Math.round(Math.min(1e7, Math.max(0, Number(body.amount) || 0)) * 100) / 100;
  const moveStage = !!body.stageId && body.stageId !== o.pipelineStageId;
  if (moveStage) {
    const p = (await pipelines()).find((x) => x.id === pid);
    if (!p || !p.stages.some((st) => st.id === body.stageId)) throw new HttpError(400, 'Unknown stage.');
  }
  const id = isNew ? crypto.randomBytes(6).toString('hex') : body.id;
  const month = start.toISOString().slice(0, 7);
  const now = new Date().toISOString();

  let prev = null;
  if (!isNew) {
    const r = recentBookings.get(pid);
    prev = (r && r.get(id) && r.get(id).rec) || await store.get(`bk/${pid}/${body.month}/${id}`, { type: 'json' }).catch(() => null);
  }
  const c = o.contact || {};
  const rec = {
    id,
    pipelineId: pid,
    month,
    oppId: o.id,
    contactId: o.contactId || c.id || null,
    lead: { name: slim(o).name, phone: c.phone || '', email: c.email || '' },
    title: String(body.title || '').trim().slice(0, 60) || 'Appointment',
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60e3).toISOString(),
    minutes,
    address: String(body.address || '').trim().slice(0, 200),
    notes: String(body.notes || '').trim().slice(0, 1000),
    amount,
    createdBy: (prev && prev.createdBy) || user.u,
    createdAt: (prev && prev.createdAt) || now,
    updatedAt: now,
  };
  await store.setJSON(`bk/${pid}/${month}/${id}`, rec);
  if (!isNew && body.month !== month) await store.delete(`bk/${pid}/${body.month}/${id}`).catch(() => {});
  noteRecentBooking(pid, id, rec);

  // One GHL update for the stage move and/or the job value.
  let opportunity = null;
  let stageFailed = false;
  const patch = {};
  if (moveStage) Object.assign(patch, { pipelineId: pid, pipelineStageId: body.stageId });
  if (body.setValue && amount > 0) patch.monetaryValue = amount;
  if (Object.keys(patch).length) {
    try {
      const r = await ghl('PUT', `/opportunities/${enc(o.id)}`, patch);
      opportunity = slim({
        ...o, ...(r.opportunity || {}), ...patch, contact: o.contact,
        ...(moveStage ? { lastStageChangeAt: now } : {}),
      });
    } catch { stageFailed = true; }
  }

  const price = amount > 0 ? ` ($${amount.toLocaleString('en-US')})` : '';
  const text = `[Portal · ${user.n}] ${isNew ? 'Booked' : 'Appointment changed'}: ${rec.title}${price} on ${whenText(rec, body.tz)}`
    + `${rec.address ? ` at ${rec.address}` : ''}${rec.notes ? `. Notes: ${rec.notes}` : ''}`;
  let synced = await ghlNote(rec.contactId, text);
  if (isNew && rec.contactId) {
    try { await ghl('POST', `/contacts/${enc(rec.contactId)}/tags`, { tags: [BOOKED_TAG] }); } catch { synced = false; }
  }
  return { booking: publicBooking(rec), opportunity, synced, stageFailed };
}

async function cancelBooking(store, user, body) {
  const o = await loadOpportunity(user, body.oppId);
  const pid = o.pipelineId;
  if (!BK_ID_RE.test(String(body.id)) || !MONTH_RE.test(String(body.month || ''))) throw new HttpError(400, 'Unknown appointment.');
  const key = `bk/${pid}/${body.month}/${body.id}`;
  const r = recentBookings.get(pid);
  const rec = (r && r.get(body.id) && r.get(body.id).rec) || await store.get(key, { type: 'json' }).catch(() => null);
  await store.delete(key);
  noteRecentBooking(pid, body.id, null);
  const synced = await ghlNote(o.contactId, `[Portal · ${user.n}] Appointment cancelled${rec ? `: ${rec.title} on ${whenText(rec, body.tz)}` : ''}`);
  return { cancelled: body.id, synced };
}

/* ---------------- HTTP plumbing ---------------- */

function reply(status, body, extraHeaders) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const ct = String((event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '');
  // JSON only: a cross-site form cannot send this without a CORS preflight.
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected JSON.');
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Bad request.'); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function findBySlug(store, slug) {
  if (store) {
    const idx = await store.get(`slug/${slug}`, { type: 'json' }).catch(() => null);
    if (idx && idx.u) {
      userCache.delete(idx.u);
      const rec = await getUser(store, idx.u);
      if (rec && rec.brand && rec.brand.slug === slug) return rec;
    }
  }
  return (await allUsers(store)).find((x) => x.brand && x.brand.slug === slug) || null;
}

async function serveAsset(store, slug, file) {
  if (!/^[a-f0-9]{10}$/.test(slug)) throw new HttpError(404, 'Not found.');
  if (ASSET_FILES.includes(file)) {
    const buf = store ? await store.get(`asset/${slug}/${file}`).catch(() => null) : null;
    if (!buf) throw new HttpError(404, 'Not found.');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  }
  if (file !== 'manifest.webmanifest') throw new HttpError(404, 'Not found.');
  const rec = await findBySlug(store, slug);
  if (!rec) throw new HttpError(404, 'Not found.');
  const pb = publicBrand(rec);
  const icon = (f) => `${pb.assets}/${f}?v=${pb.v}`;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify({
      name: rec.n,
      short_name: pb.short,
      description: `${rec.n} leads, powered by LeadThru.`,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#ffffff',
      theme_color: '#040604',
      icons: pb.hasLogo ? [
        { src: icon('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: icon('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: icon('icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ] : [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    }),
  };
}

/* ---------------- handler ---------------- */

exports.handler = async (event) => {
  const m = String(event.path || '').match(/\/api\/(.+?)\/?$/);
  const parts = m ? m[1].split('/') : [];
  const route = parts[0] || '';
  const method = event.httpMethod;
  const q = event.queryStringParameters || {};
  const store = openStore(event);

  try {
    if (route === 'health' && method === 'GET') {
      return reply(200, { ok: true, node: process.version, storage: store ? store.mode : 'none' });
    }

    if (route === 'ics' && method === 'GET') {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'inline; filename="appointment.ics"',
          'Cache-Control': 'private, max-age=300',
        },
        body: icsFile(q.t),
      };
    }

    if (route === 'asset' && method === 'GET' && parts.length === 3) {
      return await serveAsset(store, parts[1], parts[2]);
    }

    if (route === 'login' && method === 'POST') {
      const { username, password } = parseBody(event);
      const user = await getUser(store, username);
      if (!user || !user.h || !password || !verifyPassword(password, user.h)) {
        await wait(600);
        throw new HttpError(401, 'That username or password is not right.');
      }
      return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie(makeSession(user), SESSION_DAYS * 86400) });
    }

    if (route === 'logout' && method === 'POST') {
      return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    const user = await readSession(event, store);
    if (!user) throw new HttpError(401, 'Please sign in.');

    if (route === 'me' && method === 'GET') {
      const list = await allowedPipelines(user);
      return reply(200, {
        user: { username: user.u, name: user.n, admin: !!user.admin },
        brand: user.admin ? null : publicBrand(user),
        pipelines: list.map((p) => ({ id: p.id, name: p.name })),
      });
    }

    if (route === 'board' && method === 'GET') {
      const list = await allowedPipelines(user);
      const wanted = user.admin && q.pipeline ? q.pipeline : null;
      const pipeline = (wanted && list.find((p) => p.id === wanted)) || list[0];
      if (!pipeline) throw new HttpError(404, 'No pipeline is set up for this account yet.');
      const opps = await listOpportunities(pipeline.id);
      return reply(200, {
        pipeline,
        opportunities: opps.map(slim),
        fetchedAt: new Date().toISOString(),
      });
    }

    if (route === 'update' && method === 'POST') {
      const { id, stageId, value } = parseBody(event);
      const o = await loadOpportunity(user, id);
      const patch = {};
      if (stageId !== undefined && stageId !== null) {
        const p = (await pipelines()).find((x) => x.id === o.pipelineId);
        if (!p || !p.stages.some((s) => s.id === stageId)) throw new HttpError(400, 'Unknown stage.');
        patch.pipelineId = o.pipelineId;
        patch.pipelineStageId = stageId;
      }
      if (value !== undefined && value !== null && value !== '') {
        const v = Number(value);
        if (!Number.isFinite(v) || v < 0 || v > 1e8) throw new HttpError(400, 'Enter a dollar amount.');
        patch.monetaryValue = Math.round(v * 100) / 100;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change.');
      const r = await ghl('PUT', `/opportunities/${enc(o.id)}`, patch);
      const merged = { ...o, ...(r.opportunity || {}), ...patch, contact: o.contact };
      return reply(200, { opportunity: slim(merged) });
    }

    if (route === 'notes' && method === 'GET') {
      const o = await loadOpportunity(user, q.id);
      if (!o.contactId) return reply(200, { notes: [] });
      const r = await ghl('GET', `/contacts/${enc(o.contactId)}/notes`);
      const notes = (r.notes || [])
        .map((n) => ({ id: n.id, body: n.body || '', at: n.dateAdded || n.createdAt || null }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return reply(200, { notes });
    }

    if (route === 'notes' && method === 'POST') {
      const { id, body } = parseBody(event);
      const text = String(body || '').trim();
      if (!text) throw new HttpError(400, 'Write a note first.');
      if (text.length > 2000) throw new HttpError(400, 'That note is too long.');
      const o = await loadOpportunity(user, id);
      if (!o.contactId) throw new HttpError(400, 'This lead has no contact to attach notes to.');
      const r = await ghl('POST', `/contacts/${enc(o.contactId)}/notes`, { body: `[Portal · ${user.n}] ${text}` });
      const n = r.note || {};
      return reply(200, { note: { id: n.id, body: n.body || text, at: n.dateAdded || new Date().toISOString() } });
    }

    if (route === 'meta' && method === 'POST') {
      const { id, meta } = parseBody(event);
      if (meta !== 'yes' && meta !== 'no') throw new HttpError(400, 'Pick Meta or not Meta.');
      const o = await loadOpportunity(user, id);
      const cid = o.contactId || (o.contact && o.contact.id);
      if (!cid) throw new HttpError(400, 'This lead has no contact in GHL.');
      const [add, remove] = meta === 'yes' ? [TAG_META, TAG_NOT_META] : [TAG_NOT_META, TAG_META];
      await ghl('POST', `/contacts/${enc(cid)}/tags`, { tags: [add] });
      await ghl('DELETE', `/contacts/${enc(cid)}/tags`, { tags: [remove] }).catch(() => {});
      return reply(200, { id: o.id, meta });
    }

    if (route === 'bookings' && method === 'GET') {
      const p = await bookingPipeline(user, q.pipeline);
      const months = [...new Set(String(q.months || '').split(',').filter((m) => MONTH_RE.test(m)))].slice(0, 8);
      if (!months.length) throw new HttpError(400, 'Pick a month.');
      return reply(200, { pipelineId: p.id, months, bookings: await listBookings(store, p.id, months) });
    }

    if (route === 'bookings' && method === 'POST') {
      if (!store) throw new HttpError(503, 'Calendar storage is not available right now.');
      const body = parseBody(event);
      if (body.action === 'save') return reply(200, await saveBooking(store, user, body));
      if (body.action === 'cancel') return reply(200, await cancelBooking(store, user, body));
      throw new HttpError(400, 'Unknown action.');
    }

    if (route === 'clients') {
      if (!user.admin) throw new HttpError(403, 'Only LeadThru can manage clients.');
      if (method === 'GET') {
        const data = await listClients(store, true);
        return reply(200, { ...data, storage: store ? store.mode : 'none' });
      }
      if (method === 'POST') {
        if (!store) throw new HttpError(503, 'Portal storage is not available on this deploy.');
        const body = parseBody(event);
        if (body.action === 'save') {
          const rec = await saveClient(store, body);
          const pipe = (await pipelines()).find((x) => x.id === rec.p);
          return reply(200, {
            client: { u: rec.u, n: rec.n, p: rec.p, pipelineName: pipe ? pipe.name : '', brand: publicBrand(rec) },
            storage: store.mode,
          });
        }
        if (body.action === 'remove') {
          await removeClient(store, body.u);
          return reply(200, { removed: normU(body.u), storage: store.mode });
        }
        throw new HttpError(400, 'Unknown action.');
      }
    }

    throw new HttpError(404, 'Not found.');
  } catch (err) {
    if (err instanceof HttpError) return reply(err.status, { error: err.message });
    console.error(err);
    return reply(500, { error: 'Something went wrong. Try again.' });
  }
};
