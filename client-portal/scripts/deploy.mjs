// Deploys public/ and the API function to the portal's Netlify site.
//   node scripts/deploy.mjs
// Re-run after changing code or any environment variable (functions pick up env at deploy time).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crc32 } from 'node:zlib';
import { ROOT, config, nf } from './netlify.mjs';

const PUBLIC = join(ROOT, 'public');
const FUNCTIONS = join(ROOT, 'netlify', 'functions');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Minimal "stored" (uncompressed) zip: enough for a one-file function bundle.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 30); central.writeUInt32LE(0, 34);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const files = {};
const byHash = {};
for (const p of walk(PUBLIC)) {
  const rel = `/${relative(PUBLIC, p).split('\\').join('/')}`;
  const buf = readFileSync(p);
  const h = sha1(buf);
  files[rel] = h;
  byHash[h] = { rel, buf };
}

const functions = {};
const fnZips = {};
// JSON files next to the functions (e.g. brands.json) ship inside every function bundle.
const extras = readdirSync(FUNCTIONS).filter((f) => f.endsWith('.json'))
  .map((f) => ({ name: f, data: readFileSync(join(FUNCTIONS, f)) }));
for (const p of readdirSync(FUNCTIONS).filter((f) => f.endsWith('.js'))) {
  const name = p.replace(/\.js$/, '');
  const z = zip([{ name: p, data: readFileSync(join(FUNCTIONS, p)) }, ...extras]);
  const h = sha256(z);
  functions[name] = h;
  fnZips[h] = { name, z };
}

console.log(`Deploying ${Object.keys(files).length} files + ${Object.keys(functions).length} function(s) to ${config.siteName}…`);
const deploy = await nf('POST', `/sites/${config.siteId}/deploys`, { files, functions });

for (const h of deploy.required || []) {
  const { rel, buf } = byHash[h];
  await nf('PUT', `/deploys/${deploy.id}/files${rel.split('/').map(encodeURIComponent).join('/')}`, buf, 'application/octet-stream');
  console.log(`  uploaded ${rel}`);
}
for (const h of deploy.required_functions || []) {
  const { name, z } = fnZips[h];
  await nf('PUT', `/deploys/${deploy.id}/functions/${name}?runtime=js`, z, 'application/octet-stream');
  console.log(`  uploaded function ${name}`);
}

for (let i = 0; i < 60; i++) {
  const d = await nf('GET', `/deploys/${deploy.id}`);
  if (d.state === 'ready') { console.log(`Live: ${d.ssl_url || d.url}`); process.exit(0); }
  if (d.state === 'error') { console.error(`Deploy failed: ${d.error_message}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error('Timed out waiting for deploy.');
process.exit(1);
