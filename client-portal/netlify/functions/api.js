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
 *   POST /api/bookings {action:'save'|'cancel'|'complete', ...}   book / change / cancel / mark a job done
 *   GET  /api/invoices[?pipeline=]       invoices + invoice settings for the pipeline
 *   POST /api/invoices {kind:'invoice'|'quote', action:'save'|'status'|'convert'|'delete'|'settings'|'send', ...}
 *   GET  /api/invoice-pdf?t=<signed>     branded quote / invoice PDF (public link, one saved version)
 *   GET  /api/quote-public?t=<signed>    quote for the customer's approval page (/q?t=…)
 *   POST /api/quote-public {t, action:'approve'|'decline', name, agree, reason}
 *   POST /api/remove   {id, reason}         delete a lead from the pipeline (contact kept, tagged "removed by client")
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
      // Like Netlify Blobs: every key under the prefix, however deep.
      const walk = (rel) => {
        let out = [];
        let names = [];
        try { names = fs.readdirSync(file(rel)); } catch { return out; }
        for (const n of names) {
          const k = `${rel}${n}`;
          if (fs.statSync(file(k)).isDirectory()) out = out.concat(walk(`${k}/`));
          else out.push(k);
        }
        return out;
      };
      return walk(prefix);
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

/* ---- next job on the GHL contact (drives the day-of confirmation workflow) ----
 * Contact custom fields, created once in GHL: Next Job Date (date), Next Job Time,
 * Next Job Type, Next Job Address, Next Job Business (text). Matched by name; any
 * that don't exist yet are skipped. They always hold the contact's next upcoming,
 * not-yet-done job, and are cleared when there is none.
 */
const JOB_FIELDS = {
  date: 'next job date', time: 'next job time', type: 'next job type', address: 'next job address', business: 'next job business',
};
const TAG_JOB_DONE = 'job completed';
const TAG_REMOVED = 'removed by client';
let jobFieldCache = { at: 0, map: {} };
async function jobFields() {
  if (Date.now() - jobFieldCache.at < 5 * 60e3) return jobFieldCache.map;
  const map = {};
  try {
    const r = await ghl('GET', `/locations/${enc(loc())}/customFields?model=contact`);
    for (const f of r.customFields || []) {
      const n = String(f.name || '').trim().toLowerCase();
      for (const [k, name] of Object.entries(JOB_FIELDS)) if (n === name) map[k] = f.id;
    }
  } catch { /* try again on the next booking */ }
  // Local dry runs: pretend the fields exist so the would-be update shows in the log.
  if (process.env.PORTAL_DRY_WRITES && !map.date) Object.keys(JOB_FIELDS).forEach((k) => { map[k] = `dry_${k}`; });
  // Not set up yet: look again in a minute so new fields are picked up quickly.
  jobFieldCache = { at: map.date ? Date.now() : Date.now() - 4 * 60e3, map };
  return map;
}

const ymdIn = (iso, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const timeIn = (iso, zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

async function clientNameFor(store, pid, user) {
  if (!user.admin) return user.n;
  const owner = (await allUsers(store)).find((x) => !x.admin && x.p === pid);
  return owner ? owner.n : '';
}

async function syncNextJob(store, pid, contactId, tz, business) {
  if (!contactId) return true;
  const f = await jobFields();
  if (!Object.keys(f).length) return true;
  const zone = safeTz(tz || 'America/Toronto');
  const now = new Date();
  const months = [0, 1, 2, 3].map((k) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)).toISOString().slice(0, 7));
  const next = (await listBookings(store, pid, months))
    .find((b) => b.contactId === contactId && !b.completedAt && new Date(b.end) > now) || null;
  const values = next
    ? { date: ymdIn(next.start, zone), time: timeIn(next.start, zone), type: next.title, address: next.address || '', business: business || '' }
    : { date: '', time: '', type: '', address: '', business: '' };
  const fields = Object.entries(values).filter(([k]) => f[k]).map(([k, v]) => ({ id: f[k], field_value: v }));
  try {
    await ghl('PUT', `/contacts/${enc(contactId)}`, { customFields: fields });
    return true;
  } catch {
    if (next || !f.date) return false;
    // Some accounts reject an empty date: park it in the past so no reminder can fire.
    try {
      await ghl('PUT', `/contacts/${enc(contactId)}`, { customFields: fields.map((x) => (x.id === f.date ? { ...x, field_value: '2000-01-01' } : x)) });
      return true;
    } catch { return false; }
  }
}

async function saveBooking(store, user, body) {
  // A booking is either for a GHL lead (oppId) or for someone typed in by hand (manual).
  const manual = !body.oppId;
  const o = manual ? null : await loadOpportunity(user, body.oppId);
  const pid = manual ? (await bookingPipeline(user, body.pipeline)).id : o.pipelineId;
  const typed = body.lead || {};
  if (manual && !String(typed.name || '').trim()) throw new HttpError(400, "Add the customer's name.");
  const start = new Date(body.start);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Pick a date and time.');
  if (Math.abs(start.getTime() - Date.now()) > 2 * 365 * 864e5) throw new HttpError(400, 'Pick a date within the next two years.');
  const minutes = Math.round(Number(body.minutes));
  if (!(minutes >= 15 && minutes <= 720)) throw new HttpError(400, 'Pick how long it takes.');
  const isNew = !body.id;
  if (!isNew && (!BK_ID_RE.test(String(body.id)) || !MONTH_RE.test(String(body.month || '')))) throw new HttpError(400, 'Unknown appointment.');
  const amount = Math.round(Math.min(1e7, Math.max(0, Number(body.amount) || 0)) * 100) / 100;
  const moveStage = !manual && !!body.stageId && body.stageId !== o.pipelineStageId;
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
  const c = (o && o.contact) || {};
  const rec = {
    id,
    pipelineId: pid,
    month,
    oppId: o ? o.id : null,
    contactId: o ? (o.contactId || c.id || null) : null,
    manual: manual || undefined,
    lead: manual
      ? {
        name: String(typed.name).trim().slice(0, 80),
        phone: String(typed.phone || '').trim().slice(0, 30),
        email: String(typed.email || '').trim().slice(0, 120),
      }
      : { name: slim(o).name, phone: c.phone || '', email: c.email || '' },
    title: String(body.title || '').trim().slice(0, 60) || 'Appointment',
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60e3).toISOString(),
    minutes,
    address: String(body.address || '').trim().slice(0, 200),
    notes: String(body.notes || '').trim().slice(0, 1000),
    amount,
    completedAt: (prev && prev.completedAt) || undefined,
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
  if (!manual && body.setValue && amount > 0) patch.monetaryValue = amount;
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
  if (rec.contactId) synced = (await syncNextJob(store, pid, rec.contactId, body.tz, await clientNameFor(store, pid, user))) && synced;
  return { booking: publicBooking(rec), opportunity, synced, stageFailed };
}

async function cancelBooking(store, user, body) {
  const o = body.oppId ? await loadOpportunity(user, body.oppId) : null;
  const pid = o ? o.pipelineId : (await bookingPipeline(user, body.pipeline)).id;
  if (!BK_ID_RE.test(String(body.id)) || !MONTH_RE.test(String(body.month || ''))) throw new HttpError(400, 'Unknown appointment.');
  const key = `bk/${pid}/${body.month}/${body.id}`;
  const r = recentBookings.get(pid);
  const rec = (r && r.get(body.id) && r.get(body.id).rec) || await store.get(key, { type: 'json' }).catch(() => null);
  await store.delete(key);
  noteRecentBooking(pid, body.id, null);
  let synced = await ghlNote(o && o.contactId, `[Portal · ${user.n}] Appointment cancelled${rec ? `: ${rec.title} on ${whenText(rec, body.tz)}` : ''}`);
  if (o && o.contactId) synced = (await syncNextJob(store, pid, o.contactId, body.tz, await clientNameFor(store, pid, user))) && synced;
  return { cancelled: body.id, synced };
}

// "How did it go?" → mark the job done: final price, lead to the Job Completed stage,
// tag "job completed" (GHL's review-request workflow starts from the stage change).
async function completeBooking(store, user, body) {
  if (!BK_ID_RE.test(String(body.id)) || !MONTH_RE.test(String(body.month || ''))) throw new HttpError(400, 'Unknown appointment.');
  const o = body.oppId ? await loadOpportunity(user, body.oppId) : null;
  const pid = o ? o.pipelineId : (await bookingPipeline(user, body.pipeline)).id;
  const key = `bk/${pid}/${body.month}/${body.id}`;
  const recent = recentBookings.get(pid);
  const prev = (recent && recent.get(body.id) && recent.get(body.id).rec) || await store.get(key, { type: 'json' }).catch(() => null);
  if (!prev) throw new HttpError(404, 'That appointment is not saved yet. Try again in a minute.');
  const amount = body.amount === undefined || body.amount === null || body.amount === ''
    ? prev.amount || 0 : Math.round(Math.min(1e7, Math.max(0, Number(body.amount) || 0)) * 100) / 100;
  const now = new Date().toISOString();
  const rec = { ...prev, amount, completedAt: now, updatedAt: now };
  await store.setJSON(key, rec);
  noteRecentBooking(pid, rec.id, rec);

  let opportunity = null;
  let stageName = null;
  let synced = true;
  if (o) {
    const p = (await pipelines()).find((x) => x.id === pid);
    const done = p && p.stages.find((st) => /complet|\bdone\b/i.test(st.name));
    stageName = done ? done.name : null;
    const patch = {};
    if (done && done.id !== o.pipelineStageId) Object.assign(patch, { pipelineId: pid, pipelineStageId: done.id });
    if (body.setValue && amount > 0) patch.monetaryValue = amount;
    if (Object.keys(patch).length) {
      try {
        const r = await ghl('PUT', `/opportunities/${enc(o.id)}`, patch);
        opportunity = slim({ ...o, ...(r.opportunity || {}), ...patch, contact: o.contact, ...(patch.pipelineStageId ? { lastStageChangeAt: now } : {}) });
      } catch { synced = false; }
    }
    if (o.contactId) {
      try { await ghl('POST', `/contacts/${enc(o.contactId)}/tags`, { tags: [TAG_JOB_DONE] }); } catch { synced = false; }
      const price = amount > 0 ? ` ($${amount.toLocaleString('en-US')})` : '';
      synced = (await ghlNote(o.contactId, `[Portal · ${user.n}] Job done: ${rec.title}${price} on ${whenText(rec, body.tz)}`)) && synced;
      synced = (await syncNextJob(store, pid, o.contactId, body.tz, await clientNameFor(store, pid, user))) && synced;
    }
  }
  return { booking: publicBooking(rec), opportunity, stageName, synced };
}

/* ---------------- quotes & invoices ----------------
 * Every save is a NEW blob key ("<inv|quo>/<pipelineId>/<docId>/<version>"), so a link to a
 * version always shows exactly what was saved, and storage sync delays never serve an old copy.
 * Settings live the same way at "invcfg/<pipelineId>/<version>".
 */
const DOC_ID_RE = /^[a-f0-9]{12}$/;
const KINDS = {
  invoice: { dir: 'inv', label: 'Invoice', statuses: ['draft', 'sent', 'paid'] },
  quote: { dir: 'quo', label: 'Quote', statuses: ['draft', 'sent', 'approved', 'declined'] },
};
const kindOf = (k) => (k === 'quote' ? 'quote' : 'invoice');
const docBase = (kind, pid, id) => `${KINDS[kind].dir}/${pid}/${id}`;
const TAG_QUOTE_OK = 'quote approved';
const TAG_QUOTE_NO = 'quote declined';
const recentDocs = new Map(); // base key -> { key, doc, at }  (this instance's own recent writes)

const versionKey = () => `${Date.now().toString(36).padStart(9, '0')}-${crypto.randomBytes(3).toString('hex')}`;

async function vput(store, base, doc) {
  const key = `${base}/${versionKey()}`;
  await store.setJSON(key, doc);
  recentDocs.set(base, { key, doc, at: Date.now() });
  return key;
}

// Latest version of every document under a prefix: Map(base -> { key, doc }).
async function vlatestAll(store, prefix) {
  const best = new Map();
  for (const k of await store.list(prefix)) {
    const base = k.slice(0, k.lastIndexOf('/'));
    if (!best.has(base) || k > best.get(base)) best.set(base, k);
  }
  const out = new Map();
  await Promise.all([...best].map(async ([base, key]) => {
    const doc = await store.get(key, { type: 'json' }).catch(() => null);
    if (doc) out.set(base, { key, doc });
  }));
  for (const [base, r] of recentDocs) {
    if (Date.now() - r.at > 10 * 60e3) { recentDocs.delete(base); continue; }
    if (!base.startsWith(prefix)) continue;
    const cur = out.get(base);
    if (!cur || r.key > cur.key) out.set(base, { key: r.key, doc: r.doc });
  }
  return out;
}

async function vlatest(store, base) {
  return (await vlatestAll(store, `${base}/`)).get(base) || null;
}

const money2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const ymdOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const ymdPlus = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const todayYmd = () => ymdIn(new Date().toISOString(), 'America/Toronto');

function docTotals(d) {
  const subtotal = money2(d.lines.reduce((t, l) => t + money2(l.qty * l.price), 0));
  const discount = Math.min(subtotal, money2(d.discount));
  const tax = money2(((subtotal - discount) * (Number(d.taxRate) || 0)) / 100);
  return { subtotal, discount, tax, total: money2(subtotal - discount + tax) };
}

async function invoiceSettings(store, pid, clientName) {
  const r = await vlatest(store, `invcfg/${pid}`);
  const initials = String(clientName || 'INV').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 3) || 'INV';
  return {
    businessName: clientName || '',
    address: '', phone: '', email: '', website: '',
    taxNumberLabel: 'HST #', taxNumber: '',
    taxName: 'HST', taxRate: 13,
    dueDays: 14,
    payment: '', terms: 'Thank you for your business!',
    prefix: `${initials}-`, start: 1001,
    quotePrefix: `${initials}-Q`, quoteStart: 1001, quoteDays: 30,
    ...(r ? r.doc : {}),
  };
}

function cleanSettings(s) {
  const n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v) || d)));
  return {
    businessName: clip(s.businessName, 80), address: clip(s.address, 200), phone: clip(s.phone, 40),
    email: clip(s.email, 120), website: clip(s.website, 120),
    taxNumberLabel: clip(s.taxNumberLabel, 20), taxNumber: clip(s.taxNumber, 40),
    taxName: clip(s.taxName, 20), taxRate: Math.min(50, Math.max(0, Number(s.taxRate) || 0)),
    dueDays: Math.min(365, Math.max(0, Math.round(Number(s.dueDays) || 0))),
    payment: clip(s.payment, 500), terms: clip(s.terms, 500),
    prefix: clip(s.prefix, 12).replace(/\s+/g, ''), start: n(s.start, 1, 1e7, 1001),
    quotePrefix: clip(s.quotePrefix, 12).replace(/\s+/g, ''), quoteStart: n(s.quoteStart, 1, 1e7, 1001),
    quoteDays: n(s.quoteDays, 1, 365, 30),
  };
}

const ownerOf = async (store, pid) => (await allUsers(store)).find((x) => !x.admin && x.p === pid) || null;

function pdfToken(pid, key) {
  const payload = Buffer.from(JSON.stringify({ p: pid, k: key })).toString('base64url');
  return `${payload}.${sign(`inv.${payload}`).slice(0, 24)}`;
}

function quoteToken(pid, id, key) {
  const payload = Buffer.from(JSON.stringify({ p: pid, i: id, k: key })).toString('base64url');
  return `${payload}.${sign(`quo.${payload}`).slice(0, 24)}`;
}

function readQuoteToken(t) {
  const [payload, sig] = String(t || '').split('.');
  if (!payload || !sig || sign(`quo.${payload}`).slice(0, 24) !== sig) throw new HttpError(404, 'This quote link is not valid.');
  const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!DOC_ID_RE.test(String(v.i)) || !String(v.k).startsWith(`quo/${v.p}/${v.i}/`)) throw new HttpError(404, 'This quote link is not valid.');
  return v;
}

function publicDoc(kind, pid, key, doc) {
  return {
    ...doc,
    kind,
    pdf: `/api/invoice-pdf?t=${pdfToken(pid, key)}`,
    ...(kind === 'quote' ? { link: `/q?t=${quoteToken(pid, doc.id, key)}` } : {}),
  };
}

async function listDocs(store, pid, kind) {
  const all = await vlatestAll(store, `${KINDS[kind].dir}/${pid}/`);
  return [...all.values()].filter((r) => !r.doc.deleted)
    .map((r) => publicDoc(kind, pid, r.key, r.doc))
    .sort((a, b) => (b.seq || 0) - (a.seq || 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function nextSeq(store, pid, kind, settings) {
  const start = kind === 'quote' ? settings.quoteStart : settings.start;
  const existing = await listDocs(store, pid, kind);
  return Math.max(start - 1, ...existing.map((x) => x.seq || 0)) + 1;
}

async function saveDoc(store, user, pid, body, kind) {
  const v = body.invoice || body.doc || {};
  const isNew = !v.id;
  const word = KINDS[kind].label.toLowerCase();
  if (!isNew && !DOC_ID_RE.test(String(v.id))) throw new HttpError(400, `Unknown ${word}.`);
  const id = isNew ? crypto.randomBytes(6).toString('hex') : v.id;
  const prevRec = isNew ? null : await vlatest(store, docBase(kind, pid, id));
  const prev = prevRec ? prevRec.doc : null;
  if (!isNew && (!prev || prev.deleted)) throw new HttpError(404, `That ${word} no longer exists.`);

  const lines = (Array.isArray(v.lines) ? v.lines : []).slice(0, 60)
    .map((l) => ({ desc: clip(l.desc, 300), qty: money2(l.qty), price: money2(l.price) }))
    .filter((l) => l.desc || l.price);
  if (!lines.length) throw new HttpError(400, 'Add at least one line.');
  const customer = {
    name: clip(v.customer && v.customer.name, 80), email: clip(v.customer && v.customer.email, 120),
    phone: clip(v.customer && v.customer.phone, 40), address: clip(v.customer && v.customer.address, 200),
  };
  if (!customer.name) throw new HttpError(400, "Add the customer's name.");

  // Optional link to a lead in this pipeline (checked like any other lead access).
  let oppId = null; let contactId = null;
  if (v.oppId) {
    const o = await loadOpportunity(user, v.oppId);
    if (o.pipelineId !== pid) throw new HttpError(403, 'That lead is not in this pipeline.');
    oppId = o.id;
    contactId = o.contactId || (o.contact && o.contact.id) || null;
  }

  const settings = await invoiceSettings(store, pid, await clientNameFor(store, pid, user));
  let seq = prev ? prev.seq : null;
  let number = clip(v.number, 30);
  if (isNew) {
    seq = await nextSeq(store, pid, kind, settings);
    if (!number) number = `${kind === 'quote' ? settings.quotePrefix : settings.prefix}${seq}`;
  }
  if (!number) number = prev.number;
  const now = new Date().toISOString();
  const keep = (k) => (prev && prev[k]) || null;
  const doc = {
    id, kind, pipelineId: pid, seq, number,
    status: KINDS[kind].statuses.includes(v.status) && isNew ? v.status : (prev ? prev.status : 'draft'),
    customer, oppId, contactId,
    bookingId: clip(v.bookingId, 20) || keep('bookingId'),
    quoteId: clip(v.quoteId, 20) || keep('quoteId'),
    issueDate: ymdOk(v.issueDate) ? v.issueDate : now.slice(0, 10),
    dueDate: ymdOk(v.dueDate) ? v.dueDate : '',
    lines,
    taxName: clip(v.taxName, 20) || settings.taxName,
    taxRate: Math.min(50, Math.max(0, Number(v.taxRate) || 0)),
    discount: Math.max(0, money2(v.discount)),
    customFields: (Array.isArray(v.customFields) ? v.customFields : []).slice(0, 12)
      .map((f) => ({ label: clip(f.label, 40), value: clip(f.value, 200) })).filter((f) => f.label || f.value),
    notes: clip(v.notes, 1000),
    createdBy: keep('createdBy') || user.u,
    createdAt: keep('createdAt') || now,
    updatedAt: now,
    sentAt: keep('sentAt'), paidAt: keep('paidAt'), viewedAt: keep('viewedAt'),
    approvedAt: keep('approvedAt'), approvedName: keep('approvedName'), declinedAt: keep('declinedAt'),
    declineReason: keep('declineReason'), invoiceId: keep('invoiceId'),
  };
  doc.totals = docTotals(doc);
  const key = await vput(store, docBase(kind, pid, id), doc);
  return publicDoc(kind, pid, key, doc);
}

async function setDocStatus(store, pid, kind, id, status, extra = {}) {
  const word = KINDS[kind].label.toLowerCase();
  if (!DOC_ID_RE.test(String(id)) || !KINDS[kind].statuses.includes(status)) throw new HttpError(400, `Unknown ${word}.`);
  const r = await vlatest(store, docBase(kind, pid, id));
  if (!r || r.doc.deleted) throw new HttpError(404, `That ${word} no longer exists.`);
  const now = new Date().toISOString();
  const doc = {
    ...r.doc, ...extra, status, updatedAt: now,
    sentAt: status === 'draft' ? r.doc.sentAt : (r.doc.sentAt || now),
    ...(kind === 'invoice' ? { paidAt: status === 'paid' ? (r.doc.paidAt || now) : null } : {}),
  };
  const key = await vput(store, docBase(kind, pid, id), doc);
  return publicDoc(kind, pid, key, doc);
}

async function deleteDoc(store, pid, kind, id) {
  if (!DOC_ID_RE.test(String(id))) throw new HttpError(400, 'Unknown document.');
  const r = await vlatest(store, docBase(kind, pid, id));
  if (!r) throw new HttpError(404, 'That document no longer exists.');
  await vput(store, docBase(kind, pid, id), { ...r.doc, deleted: true, updatedAt: new Date().toISOString() });
}

/* ---- quote → lead stage / invoice ---- */

const closedStageOf = (p) => p && p.stages.find((s) => /\b(closed|won)\b/i.test(s.name) && !/lost/i.test(s.name));
const quotedStageOf = (p) => p && p.stages.find((s) => /quot/i.test(s.name));

// Move a lead forward to `target` (never backwards, e.g. out of Closed or Job Completed).
async function moveLeadForward(pid, oppId, target, extraPatch = {}) {
  if (!oppId) return null;
  try {
    const p = (await pipelines()).find((x) => x.id === pid);
    const r = await ghl('GET', `/opportunities/${enc(oppId)}`);
    const o = r.opportunity || r;
    if (!o || o.pipelineId !== pid) return null;
    const idx = (sid) => p.stages.findIndex((s) => s.id === sid);
    const patch = { ...extraPatch };
    if (target && idx(o.pipelineStageId) < idx(target.id)) Object.assign(patch, { pipelineId: pid, pipelineStageId: target.id });
    if (Object.keys(patch).length) await ghl('PUT', `/opportunities/${enc(oppId)}`, patch);
    return patch.pipelineStageId ? target.name : null;
  } catch { return null; }
}

async function invoiceFromQuote(store, pid, q, by) {
  const owner = await ownerOf(store, pid);
  const settings = await invoiceSettings(store, pid, owner ? owner.n : '');
  const id = crypto.randomBytes(6).toString('hex');
  const seq = await nextSeq(store, pid, 'invoice', settings);
  const today = todayYmd();
  const now = new Date().toISOString();
  const doc = {
    id, kind: 'invoice', pipelineId: pid, seq, number: `${settings.prefix}${seq}`, status: 'draft',
    customer: q.customer, oppId: q.oppId, contactId: q.contactId, bookingId: q.bookingId || null, quoteId: q.id,
    issueDate: today, dueDate: settings.dueDays ? ymdPlus(today, settings.dueDays) : '',
    lines: q.lines, taxName: q.taxName, taxRate: q.taxRate, discount: q.discount,
    customFields: q.customFields, notes: q.notes,
    createdBy: by, createdAt: now, updatedAt: now,
    sentAt: null, paidAt: null, viewedAt: null, approvedAt: null, approvedName: null,
    declinedAt: null, declineReason: null, invoiceId: null,
  };
  doc.totals = docTotals(doc);
  const key = await vput(store, docBase('invoice', pid, id), doc);
  return publicDoc('invoice', pid, key, doc);
}

async function approveQuote(store, pid, id, { name, by }) {
  const r = await vlatest(store, docBase('quote', pid, id));
  if (!r || r.doc.deleted) throw new HttpError(404, 'This quote is no longer available.');
  if (r.doc.status === 'approved') return { quote: publicDoc('quote', pid, r.key, r.doc), invoice: null, already: true };
  const invoice = r.doc.invoiceId ? null : await invoiceFromQuote(store, pid, r.doc, by);
  const now = new Date().toISOString();
  const doc = {
    ...r.doc, status: 'approved', approvedAt: now, approvedName: clip(name, 80) || by,
    invoiceId: r.doc.invoiceId || (invoice && invoice.id), updatedAt: now,
  };
  const key = await vput(store, docBase('quote', pid, id), doc);
  const p = (await pipelines()).find((x) => x.id === pid);
  // Job value = the quote before tax.
  const stageName = await moveLeadForward(pid, doc.oppId, closedStageOf(p), { monetaryValue: money2(doc.totals.subtotal - doc.totals.discount) });
  if (doc.contactId) {
    await ghl('POST', `/contacts/${enc(doc.contactId)}/tags`, { tags: [TAG_QUOTE_OK] }).catch(() => {});
    await ghlNote(doc.contactId, `[Portal] Quote ${doc.number} (${cad(doc.totals.total)}) approved by ${doc.approvedName}.`
      + `${invoice ? ` Invoice ${invoice.number} created as a draft.` : ''}`);
  }
  return { quote: publicDoc('quote', pid, key, doc), invoice, stageName };
}

async function declineQuote(store, pid, id, { name, reason }) {
  const r = await vlatest(store, docBase('quote', pid, id));
  if (!r || r.doc.deleted) throw new HttpError(404, 'This quote is no longer available.');
  if (r.doc.status === 'approved') throw new HttpError(409, 'This quote has already been approved.');
  const now = new Date().toISOString();
  const doc = { ...r.doc, status: 'declined', declinedAt: now, declineReason: clip(reason, 300), approvedName: clip(name, 80) || null, updatedAt: now };
  const key = await vput(store, docBase('quote', pid, id), doc);
  if (doc.contactId) {
    await ghl('POST', `/contacts/${enc(doc.contactId)}/tags`, { tags: [TAG_QUOTE_NO] }).catch(() => {});
    await ghlNote(doc.contactId, `[Portal] Quote ${doc.number} (${cad(doc.totals.total)}) was declined${doc.declineReason ? `: ${doc.declineReason}` : '.'}`);
  }
  return { quote: publicDoc('quote', pid, key, doc) };
}

async function markQuoteSent(store, pid, id) {
  const quote = await setDocStatus(store, pid, 'quote', id, 'sent');
  const p = (await pipelines()).find((x) => x.id === pid);
  const stageName = await moveLeadForward(pid, quote.oppId, quotedStageOf(p));
  return { quote, stageName };
}

/* ---- public quote page (no login; signed link) ---- */

async function quotePublic(store, token) {
  const t = readQuoteToken(token);
  const base = docBase('quote', t.p, t.i);
  let rec = await vlatest(store, base);
  if (!rec || t.k > rec.key) {
    const d = await store.get(t.k, { type: 'json' }).catch(() => null);
    if (d) rec = { key: t.k, doc: d };
  }
  if (!rec || rec.doc.deleted) throw new HttpError(404, 'This quote is no longer available.');
  const q = rec.doc;
  // First open by the customer: remember it so the business can see the quote was viewed.
  if (q.status === 'sent' && !q.viewedAt) {
    try {
      const doc = { ...q, viewedAt: new Date().toISOString() };
      rec = { key: await vput(store, base, doc), doc };
    } catch { /* not important */ }
  }
  const owner = await ownerOf(store, t.p);
  const settings = await invoiceSettings(store, t.p, owner ? owner.n : '');
  const brand = owner ? publicBrand(owner) : null;
  return {
    pid: t.p, id: t.i, key: rec.key,
    view: {
      number: q.number, status: q.status, expired: q.status === 'sent' && q.dueDate && q.dueDate < todayYmd(),
      issueDate: q.issueDate, validUntil: q.dueDate,
      customer: { name: q.customer.name, address: q.customer.address },
      lines: q.lines, taxName: q.taxName, taxRate: q.taxRate, totals: q.totals,
      customFields: q.customFields, notes: q.notes,
      approvedAt: q.approvedAt, approvedName: q.approvedName, declinedAt: q.declinedAt,
      business: {
        name: settings.businessName, address: settings.address, phone: settings.phone, email: settings.email,
        website: settings.website, taxNumberLabel: settings.taxNumberLabel, taxNumber: settings.taxNumber, terms: settings.terms,
      },
      brand: brand ? { color: brand.color, logo: brand.hasLogo ? `${brand.assets}/logo.png?v=${brand.v}` : null } : null,
      pdf: `/api/invoice-pdf?t=${pdfToken(t.p, rec.key)}`,
    },
  };
}

/* ---- branded PDF (quotes and invoices) ---- */

let pdfLib = null;
const winAnsi = (s) => String(s == null ? '' : s)
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...')
  .replace(/[^\x20-\x7E -ÿ–—•€]/g, '');
const prettyPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return p || '';
};
const cad = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const prettyDate = (ymd) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

async function brandLogo(store, rec, origin) {
  const b = rec && rec.brand;
  if (!b || b.hasLogo === false) return null;
  try {
    if (b.blob) return await store.get(`asset/${b.slug}/logo.png`);
    const res = await fetch(`${origin}/brands/${b.slug}/logo.png`);
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch { return null; }
}

async function renderDocPdf(doc, settings, brandColor, logoBytes) {
  if (!pdfLib) pdfLib = require('pdf-lib');
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const isQuote = doc.kind === 'quote';
  const pdf = await PDFDocument.create();
  pdf.setTitle(winAnsi(`${isQuote ? 'Quote' : 'Invoice'} ${doc.number}`));
  pdf.setAuthor(winAnsi(settings.businessName));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const hex = String(brandColor || '#1F2937').replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const brand = rgb(c[0], c[1], c[2]);
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const onBrand = lum > 0.6 ? rgb(0.08, 0.08, 0.08) : rgb(1, 1, 1);
  const ink = rgb(0.09, 0.1, 0.12);
  const muted = rgb(0.42, 0.45, 0.5);
  const rule = rgb(0.88, 0.89, 0.91);
  const green = rgb(0.1, 0.6, 0.3);
  const red = rgb(0.78, 0.16, 0.16);
  const W = 612; const H = 792; const M = 44;

  let page = pdf.addPage([W, H]);
  const text = (s, x, y, size = 10, f = font, color = ink) => page.drawText(winAnsi(s), { x, y, size, font: f, color });
  const width = (s, size = 10, f = font) => f.widthOfTextAtSize(winAnsi(s), size);
  const right = (s, xr, y, size = 10, f = font, color = ink) => text(s, xr - width(s, size, f), y, size, f, color);
  const wrap = (s, maxW, size = 10, f = font) => {
    const out = [];
    for (const para of winAnsi(s).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const t = line ? `${line} ${word}` : word;
        if (width(t, size, f) <= maxW) line = t;
        else { if (line) out.push(line); line = word; }
      }
      out.push(line);
    }
    return out;
  };

  // Header band
  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: brand });
  let y = H - 40;
  let logoBottom = y;
  if (logoBytes) {
    try {
      const img = await pdf.embedPng(logoBytes);
      const s = Math.min(170 / img.width, 64 / img.height);
      page.drawImage(img, { x: M, y: y - img.height * s, width: img.width * s, height: img.height * s });
      logoBottom = y - img.height * s - 10;
    } catch { /* not a PNG: skip */ }
  }
  right(isQuote ? 'QUOTE' : 'INVOICE', W - M, y - 22, 26, bold, brand);
  right(`# ${doc.number}`, W - M, y - 40, 11, bold);
  const meta = [['Issued', prettyDate(doc.issueDate)], doc.dueDate ? [isQuote ? 'Valid until' : 'Due', prettyDate(doc.dueDate)] : null].filter(Boolean);
  meta.forEach(([k, v], i) => { right(`${k}: ${v}`, W - M, y - 56 - i * 14, 10, font, muted); });
  const stamp = !isQuote && doc.status === 'paid' ? ['PAID', green]
    : isQuote && doc.status === 'approved' ? ['APPROVED', green]
      : isQuote && doc.status === 'declined' ? ['DECLINED', red] : null;
  if (stamp) {
    const sw = width(stamp[0], 14, bold) + 24;
    page.drawRectangle({ x: W - M - sw, y: y - 106, width: sw, height: 24, borderColor: stamp[1], borderWidth: 2 });
    text(stamp[0], W - M - sw + 12, y - 99, 14, bold, stamp[1]);
  }

  // From
  y = Math.min(logoBottom, y - 70);
  text(settings.businessName || '', M, y, 12, bold);
  y -= 14;
  const fromLines = [
    ...wrap(settings.address, 240, 9.5), prettyPhone(settings.phone), settings.email, settings.website,
    settings.taxNumber ? `${settings.taxNumberLabel || 'Tax #'} ${settings.taxNumber}` : '',
  ].filter(Boolean);
  for (const l of fromLines) { text(l, M, y, 9.5, font, muted); y -= 12.5; }

  // Bill to + details
  y -= 14;
  const topOfBlocks = y;
  text(isQuote ? 'PREPARED FOR' : 'BILL TO', M, y, 8.5, bold, muted);
  y -= 15;
  text(doc.customer.name, M, y, 11.5, bold);
  y -= 14;
  for (const l of [...wrap(doc.customer.address, 250, 9.5), prettyPhone(doc.customer.phone), doc.customer.email].filter(Boolean)) {
    text(l, M, y, 9.5, font, muted); y -= 12.5;
  }
  let y2 = topOfBlocks;
  if (doc.customFields.length) {
    text('DETAILS', 330, y2, 8.5, bold, muted);
    y2 -= 15;
    for (const f of doc.customFields) {
      const lines = wrap(f.value, 150, 9.5);
      text(f.label, 330, y2, 9.5, bold);
      lines.forEach((l, i) => right(l, W - M, y2 - i * 12, 9.5, font, ink));
      y2 -= Math.max(1, lines.length) * 12 + 3;
    }
  }
  y = Math.min(y, y2) - 18;

  // Line items
  const cols = { desc: M + 10, qty: 336, price: 440, amt: W - M - 10 };
  const header = () => {
    page.drawRectangle({ x: M, y: y - 8, width: W - 2 * M, height: 24, color: brand });
    text('DESCRIPTION', cols.desc, y, 8.5, bold, onBrand);
    right('QTY', cols.qty, y, 8.5, bold, onBrand);
    right('PRICE', cols.price, y, 8.5, bold, onBrand);
    right('AMOUNT', cols.amt, y, 8.5, bold, onBrand);
    y -= 26;
  };
  header();
  doc.lines.forEach((l, i) => {
    const lines = wrap(l.desc || '-', cols.qty - cols.desc - 50, 10);
    const h = lines.length * 13 + 10;
    if (y - h < 150) { page = pdf.addPage([W, H]); y = H - 60; header(); }
    if (i % 2 === 1) page.drawRectangle({ x: M, y: y - h + 13, width: W - 2 * M, height: h, color: rgb(0.97, 0.975, 0.98) });
    lines.forEach((t, j) => text(t, cols.desc, y - j * 13, 10));
    right(String(l.qty), cols.qty, y, 10);
    right(cad(l.price), cols.price, y, 10);
    right(cad(l.qty * l.price), cols.amt, y, 10, bold);
    y -= h;
  });
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 1, color: rule });

  // Totals
  y -= 12;
  const t = doc.totals;
  const rows = [['Subtotal', cad(t.subtotal)]];
  if (t.discount > 0) rows.push(['Discount', `-${cad(t.discount)}`]);
  if (doc.taxRate > 0) rows.push([`${doc.taxName || 'Tax'} (${doc.taxRate}%)`, cad(t.tax)]);
  for (const [k, v] of rows) { right(k, 470, y, 10, font, muted); right(v, W - M - 10, y, 10); y -= 16; }
  y -= 12;
  page.drawRectangle({ x: 330, y: y - 12, width: W - M - 330, height: 30, color: brand });
  const bar = isQuote ? (doc.status === 'approved' ? 'APPROVED TOTAL' : 'QUOTE TOTAL') : (doc.status === 'paid' ? 'PAID' : 'TOTAL DUE');
  text(bar, 342, y - 2, 11, bold, onBrand);
  right(cad(t.total), W - M - 10, y - 2, 13, bold, onBrand);
  y -= 44;

  // Notes, payment / approval, terms
  const block = (title, body) => {
    if (!body) return;
    const lines = wrap(body, W - 2 * M, 9.5);
    if (y - lines.length * 12 - 20 < 50) { page = pdf.addPage([W, H]); y = H - 60; }
    text(title, M, y, 8.5, bold, muted); y -= 14;
    for (const l of lines) { text(l, M, y, 9.5); y -= 12; }
    y -= 10;
  };
  block('NOTES', doc.notes);
  if (isQuote && doc.status === 'approved') {
    block('APPROVAL', `Approved by ${doc.approvedName || 'the customer'} on ${prettyDate(String(doc.approvedAt || '').slice(0, 10))}.`);
  }
  if (!isQuote) block('HOW TO PAY', settings.payment);
  block('TERMS', settings.terms);

  // Footer on every page
  for (const p of pdf.getPages()) {
    const foot = [settings.businessName, prettyPhone(settings.phone), settings.email].filter(Boolean).join('  |  ');
    p.drawText(winAnsi(foot), { x: (W - width(foot, 8.5)) / 2, y: 26, size: 8.5, font, color: muted });
  }
  return Buffer.from(await pdf.save());
}

async function invoicePdfResponse(store, token, origin) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || sign(`inv.${payload}`).slice(0, 24) !== sig) throw new HttpError(404, 'Not found.');
  const { p: pid, k: key } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const isQuote = String(key).startsWith(`quo/${pid}/`);
  if (!isQuote && !String(key).startsWith(`inv/${pid}/`)) throw new HttpError(404, 'Not found.');
  const doc = await store.get(key, { type: 'json' });
  if (!doc || doc.deleted) throw new HttpError(404, 'This document is no longer available.');
  doc.kind = isQuote ? 'quote' : 'invoice';
  const owner = await ownerOf(store, pid);
  const settings = await invoiceSettings(store, pid, owner ? owner.n : '');
  const bytes = await renderDocPdf(doc, settings, owner && owner.brand ? owner.brand.color : null, await brandLogo(store, owner, origin));
  const file = `${isQuote ? 'Quote' : 'Invoice'}-${String(doc.number).replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${file}"`, 'Cache-Control': 'private, max-age=300' },
    body: bytes.toString('base64'),
    isBase64Encoded: true,
  };
}

/* ---- send through GHL (needs the token's "conversations/message.write" permission) ---- */

async function sendDoc(store, user, pid, body, origin, kind) {
  const word = KINDS[kind].label.toLowerCase();
  if (!DOC_ID_RE.test(String(body.id))) throw new HttpError(400, `Unknown ${word}.`);
  const via = body.via === 'sms' ? 'sms' : 'email';
  const r = await vlatest(store, docBase(kind, pid, body.id));
  if (!r || r.doc.deleted) throw new HttpError(404, `That ${word} no longer exists.`);
  const d = r.doc;
  const owner = await ownerOf(store, pid);
  const settings = await invoiceSettings(store, pid, owner ? owner.n : user.n);
  const link = kind === 'quote' ? `${origin}/q?t=${quoteToken(pid, d.id, r.key)}` : `${origin}/api/invoice-pdf?t=${pdfToken(pid, r.key)}`;
  if (via === 'sms' && !d.customer.phone) throw new HttpError(400, 'Add the customer\'s phone number first.');
  if (via === 'email' && !d.customer.email) throw new HttpError(400, 'Add the customer\'s email first.');

  let contactId = d.contactId;
  const first = d.customer.name.split(/\s+/)[0];
  const total = cad(d.totals.total);
  try {
    if (!contactId) {
      const u = await ghl('POST', '/contacts/upsert', {
        locationId: loc(), name: d.customer.name, email: d.customer.email || undefined, phone: d.customer.phone || undefined,
      });
      contactId = (u.contact && u.contact.id) || u.id;
    }
    if (via === 'sms') {
      await ghl('POST', '/conversations/messages', {
        type: 'SMS', contactId,
        message: kind === 'quote'
          ? `Hi ${first}, here's your quote ${d.number} from ${settings.businessName} for ${total}. Review and approve it here: ${link}`
          : `Hi ${first}, here's your invoice ${d.number} from ${settings.businessName} for ${total}: ${link}`,
      });
    } else {
      const esc = (s) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
      await ghl('POST', '/conversations/messages', {
        type: 'Email', contactId,
        subject: `${KINDS[kind].label} ${d.number} from ${settings.businessName}`,
        html: `<p>Hi ${esc(first)},</p>`
          + (kind === 'quote'
            ? `<p>Thank you for considering ${esc(settings.businessName)}. Your quote <b>${esc(d.number)}</b> for <b>${esc(total)}</b> is ready.</p>`
              + `<p><a href="${esc(link)}">Review and approve your quote</a></p>`
            : `<p>Thank you for choosing ${esc(settings.businessName)}. Your invoice <b>${esc(d.number)}</b> for <b>${esc(total)}</b> is ready.</p>`
              + `<p><a href="${esc(link)}">View or download your invoice (PDF)</a></p>`
              + (settings.payment ? `<p>${esc(settings.payment).replace(/\n/g, '<br>')}</p>` : ''))
          + `<p>${esc(settings.businessName)}${settings.phone ? `<br>${esc(settings.phone)}` : ''}</p>`,
      });
    }
  } catch (e) {
    if (e instanceof HttpError && e.status === 502) return { sent: false, needsSetup: true, link };
    throw e;
  }
  if (kind === 'quote') {
    if (d.status === 'draft' || d.status === 'sent') {
      const { quote, stageName } = await markQuoteSent(store, pid, d.id);
      return { sent: true, doc: quote, stageName };
    }
    return { sent: true, doc: publicDoc(kind, pid, r.key, d) };
  }
  const updated = d.status === 'paid' ? publicDoc(kind, pid, r.key, d) : await setDocStatus(store, pid, kind, d.id, 'sent');
  return { sent: true, doc: updated };
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
const originOf = (event) => {
  const h = event.headers || {};
  return `${h['x-forwarded-proto'] || 'https'}://${h['x-forwarded-host'] || h.host}`;
};

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

    if (route === 'quote-public') {
      if (!store) throw new HttpError(503, 'Quotes are not available right now.');
      if (method === 'GET') return reply(200, (await quotePublic(store, q.t)).view);
      if (method === 'POST') {
        const body = parseBody(event);
        const t = readQuoteToken(body.t);
        const cur = (await quotePublic(store, body.t)).view;
        if (body.action === 'approve') {
          const name = clip(body.name, 80);
          if (name.length < 2) throw new HttpError(400, 'Type your full name to approve.');
          if (!body.agree) throw new HttpError(400, 'Tick the box to accept the quote.');
          if (cur.status === 'declined') throw new HttpError(409, 'This quote was declined. Ask for an updated quote.');
          if (cur.expired) throw new HttpError(409, `This quote has expired. Contact ${cur.business.name || 'us'} for an updated quote.`);
          await approveQuote(store, t.p, t.i, { name, by: 'customer' });
        } else if (body.action === 'decline') {
          await declineQuote(store, t.p, t.i, { name: body.name, reason: body.reason });
        } else {
          throw new HttpError(400, 'Unknown action.');
        }
        return reply(200, (await quotePublic(store, body.t)).view);
      }
    }

    if (route === 'invoice-pdf' && method === 'GET') {
      if (!store) throw new HttpError(503, 'Invoices are not available right now.');
      return await invoicePdfResponse(store, q.t, originOf(event));
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

    // Remove a lead from the pipeline: deletes the GHL opportunity, keeps the contact
    // (tagged "removed by client" with a note giving the reason) so nothing is lost for reporting.
    if (route === 'remove' && method === 'POST') {
      const { id, reason } = parseBody(event);
      const why = String(reason || '').trim().slice(0, 120);
      if (!why) throw new HttpError(400, 'Pick a reason for removing this lead.');
      const o = await loadOpportunity(user, id);
      const cid = o.contactId || (o.contact && o.contact.id);
      const name = slim(o).name;
      if (cid) {
        await ghlNote(cid, `[Portal · ${user.n}] Removed lead "${name}" from the pipeline. Reason: ${why}`);
        await ghl('POST', `/contacts/${enc(cid)}/tags`, { tags: [TAG_REMOVED] }).catch(() => {});
      }
      await ghl('DELETE', `/opportunities/${enc(o.id)}`);
      return reply(200, { removed: o.id });
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

    if (route === 'invoices' && method === 'GET') {
      const p = await bookingPipeline(user, q.pipeline);
      const settings = await invoiceSettings(store, p.id, await clientNameFor(store, p.id, user));
      return reply(200, {
        pipelineId: p.id, settings,
        invoices: store ? await listDocs(store, p.id, 'invoice') : [],
        quotes: store ? await listDocs(store, p.id, 'quote') : [],
      });
    }

    if (route === 'invoices' && method === 'POST') {
      if (!store) throw new HttpError(503, 'Billing is not available right now.');
      const body = parseBody(event);
      const p = await bookingPipeline(user, body.pipeline);
      const kind = kindOf(body.kind);
      if (body.action === 'save') return reply(200, { doc: await saveDoc(store, user, p.id, body, kind) });
      if (body.action === 'status') {
        if (kind === 'quote' && body.status === 'approved') {
          return reply(200, await approveQuote(store, p.id, body.id, { name: clip(body.name, 80) || `${user.n} (marked in portal)`, by: user.u }));
        }
        if (kind === 'quote' && body.status === 'declined') return reply(200, await declineQuote(store, p.id, body.id, { reason: body.reason }));
        if (kind === 'quote' && body.status === 'sent') {
          const r = await markQuoteSent(store, p.id, body.id);
          return reply(200, { doc: r.quote, stageName: r.stageName });
        }
        return reply(200, { doc: await setDocStatus(store, p.id, kind, body.id, body.status) });
      }
      if (body.action === 'convert') {
        const r = await vlatest(store, docBase('quote', p.id, body.id));
        if (!r || r.doc.deleted) throw new HttpError(404, 'That quote no longer exists.');
        if (r.doc.invoiceId) throw new HttpError(409, 'This quote already has an invoice.');
        const invoice = await invoiceFromQuote(store, p.id, r.doc, user.u);
        const doc = { ...r.doc, invoiceId: invoice.id, updatedAt: new Date().toISOString() };
        const key = await vput(store, docBase('quote', p.id, doc.id), doc);
        return reply(200, { doc: publicDoc('quote', p.id, key, doc), invoice });
      }
      if (body.action === 'delete') { await deleteDoc(store, p.id, kind, body.id); return reply(200, { deleted: body.id }); }
      if (body.action === 'settings') {
        const settings = cleanSettings(body.settings || {});
        await vput(store, `invcfg/${p.id}`, settings);
        return reply(200, { settings });
      }
      if (body.action === 'send') return reply(200, await sendDoc(store, user, p.id, body, originOf(event), kind));
      throw new HttpError(400, 'Unknown action.');
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
      if (body.action === 'complete') return reply(200, await completeBooking(store, user, body));
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
