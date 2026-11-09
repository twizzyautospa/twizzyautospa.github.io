// Local test server: serves public/ and runs the API function, like Netlify does.
//   GHL_TOKEN=... GHL_LOCATION_ID=... SESSION_SECRET=... PORTAL_USERS='[...]' node scripts/dev.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { handler } = createRequire(import.meta.url)(join(ROOT, 'netlify/functions/api.js'));
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const PORT = Number(process.env.PORT || 8888);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    for await (const c of req) body += c;
    const out = await handler({
      path: url.pathname, httpMethod: req.method, headers: req.headers,
      queryStringParameters: Object.fromEntries(url.searchParams), body: body || null, isBase64Encoded: false,
    });
    res.writeHead(out.statusCode, out.headers);
    return res.end(out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(ROOT, 'public', rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Portal on http://localhost:${PORT}`));
