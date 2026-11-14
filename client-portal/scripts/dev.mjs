// Local test server: serves public/ and runs the API function, like Netlify does.
//   GHL_TOKEN=... GHL_LOCATION_ID=... SESSION_SECRET=... PORTAL_USERS='[...]' node scripts/dev.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);
// PORTAL_MOCK_GHL=1: use the fictional demo business instead of the real GoHighLevel account.
if (process.env.PORTAL_MOCK_GHL) require(join(ROOT, 'scripts/mock-ghl.cjs')).install();
const { handler } = require(join(ROOT, 'netlify/functions/api.js'));
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const PORT = Number(process.env.PORT || 8888);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    for await (const c of req) body += c;
    const out = await handler({
      path: url.pathname, httpMethod: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'http' },
      queryStringParameters: Object.fromEntries(url.searchParams), body: body || null, isBase64Encoded: false,
    });
    res.writeHead(out.statusCode, out.headers);
    return res.end(out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
  }
  const page = url.pathname === '/' ? '/index.html' : url.pathname === '/q' ? '/quote.html' : url.pathname;
  const rel = normalize(page).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(ROOT, 'public', rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Portal on http://localhost:${PORT}`));
