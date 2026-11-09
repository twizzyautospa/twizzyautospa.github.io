'use strict';
/*
 * LeadThru Client Portal — API (single Netlify Function).
 *
 * Routes (all under /api/*, see public/_redirects):
 *   POST /api/login   {username, password}
 *   POST /api/logout
 *   GET  /api/me
 *   GET  /api/board?pipeline=<id>        (pipeline is only honoured for the admin)
 *   POST /api/update  {id, stageId?, value?}
 *   GET  /api/notes?id=<opportunityId>
 *   POST /api/notes   {id, body}
 *
 * Environment variables (set on the Netlify site, never in code):
 *   GHL_TOKEN         Private Integration token for the sub-account
 *   GHL_LOCATION_ID   Sub-account (location) id
 *   SESSION_SECRET    Long random string used to sign login cookies
 *   PORTAL_USERS      JSON array of users:
 *                     [{"u":"brighthomecare","n":"Bright Home Care","p":"<pipelineId>","h":"scrypt$<salt>$<hash>"},
 *                      {"u":"leadthru","n":"LeadThru","admin":true,"h":"scrypt$..."}]
 *
 * Every client request is locked to that client's own pipeline on the server.
 * No npm dependencies on purpose: only Node built-ins.
 */
const crypto = require('crypto');
const https = require('https');

const GHL_HOST = 'services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const COOKIE = 'lt_session';
const SESSION_DAYS = 30;

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

/* ---------------- users & sessions ---------------- */

let usersCache = null;
function users() {
  if (!usersCache) {
    const list = JSON.parse(env('PORTAL_USERS'));
    usersCache = list.map((x) => ({ ...x, u: String(x.u).toLowerCase() }));
  }
  return usersCache;
}
function findUser(u) {
  const name = String(u || '').toLowerCase().trim();
  return users().find((x) => x.u === name) || null;
}

function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), want.length);
  return want.length > 0 && crypto.timingSafeEqual(want, got);
}

const sign = (data) => crypto.createHmac('sha256', env('SESSION_SECRET')).update(data).digest('base64url');

// The session embeds a fingerprint of the password hash, so resetting a
// password signs that user out everywhere.
function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({
    u: user.u,
    v: user.h.slice(-12),
    exp: Date.now() + SESSION_DAYS * 864e5,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(event) {
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
  const user = findUser(data.u);
  if (!user || user.h.slice(-12) !== data.v) return null;
  return user;
}

const sessionCookie = (value, maxAgeSeconds) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

/* ---------------- GoHighLevel ---------------- */

function ghl(method, path, body) {
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
    const req = https.request({ host: GHL_HOST, path, method, headers, timeout: 15000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 200) }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const msg = Array.isArray(json.message) ? json.message.join(', ') : (json.message || json.error || '');
        console.error(`GHL ${method} ${path.split('?')[0]} -> ${res.statusCode} ${msg}`);
        reject(new HttpError(res.statusCode === 429 ? 429 : 502,
          res.statusCode === 429 ? 'GoHighLevel is busy. Try again in a few seconds.' : 'GoHighLevel did not accept that. Try again.'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      console.error(`GHL ${method} ${path.split('?')[0]} failed: ${e.message}`);
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

/* ---------------- handler ---------------- */

exports.handler = async (event) => {
  const m = String(event.path || '').match(/\/api\/([a-z]+)\/?$/);
  const route = m ? m[1] : '';
  const method = event.httpMethod;
  const q = event.queryStringParameters || {};

  try {
    if (route === 'login' && method === 'POST') {
      const { username, password } = parseBody(event);
      const user = findUser(username);
      if (!user || !password || !verifyPassword(password, user.h)) {
        await wait(600);
        throw new HttpError(401, 'That username or password is not right.');
      }
      return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie(makeSession(user), SESSION_DAYS * 86400) });
    }

    if (route === 'logout' && method === 'POST') {
      return reply(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    const user = readSession(event);
    if (!user) throw new HttpError(401, 'Please sign in.');

    if (route === 'me' && method === 'GET') {
      const list = await allowedPipelines(user);
      return reply(200, {
        user: { username: user.u, name: user.n, admin: !!user.admin },
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

    throw new HttpError(404, 'Not found.');
  } catch (err) {
    if (err instanceof HttpError) return reply(err.status, { error: err.message });
    console.error(err);
    return reply(500, { error: 'Something went wrong. Try again.' });
  }
};
