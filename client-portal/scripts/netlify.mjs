// Tiny Netlify API helper shared by deploy.mjs and users.mjs. No dependencies.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const config = JSON.parse(readFileSync(join(ROOT, 'portal.config.json'), 'utf8'));

// In Claude Code cloud sessions the proxy injects the real token; elsewhere set NETLIFY_AUTH_TOKEN.
const TOKEN = process.env.NETLIFY_AUTH_TOKEN || 'injected-by-proxy';

export async function nf(method, path, body, contentType = 'application/json') {
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'Content-Type': contentType } : {}) },
    body: body === undefined ? undefined : (contentType === 'application/json' ? JSON.stringify(body) : body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`Netlify ${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const envPath = (key) => `/accounts/${config.accountId}/env${key ? `/${encodeURIComponent(key)}` : ''}?site_id=${config.siteId}`;

export async function getEnv(key) {
  try {
    const v = await nf('GET', envPath(key));
    const val = (v.values || []).find((x) => x.context === 'all') || (v.values || [])[0];
    return val ? val.value : null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function setEnv(key, value) {
  const full = { key, values: [{ context: 'all', value }] };
  try {
    await nf('PUT', envPath(key), full);
  } catch (e) {
    if (e.status !== 404) throw e;
    await nf('POST', envPath(), [full]);
  }
}
