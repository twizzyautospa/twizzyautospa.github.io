# LeadThru Client Portal

A small branded portal where each client logs in, sees only their own leads, and moves them
through their pipeline. Every change is written straight to the GoHighLevel opportunity, so
GHL "Pipeline Stage Changed" workflows fire as usual.

- Live: https://portal.leadthruagency.com (also https://leadthru-portal.netlify.app)
- Netlify site: `leadthru-portal` (ids in `portal.config.json`)
- Installable on phones (Add to Home Screen).

## How it works

```
phone / browser ──► public/ (static app) ──► /api/* ──► netlify/functions/api.js ──► GHL API v2
                                                               └──► Netlify Blobs (clients, logos)
```

- One GHL sub-account (LeadThru), one Private Integration token, kept server-side in Netlify env vars.
- Each client = one GHL pipeline. A client's login is locked to that pipeline on the server:
  they cannot read or move any other client's leads, even by editing requests.
- Leads are read live from GHL on every load (and every 60s while open).
- Clients can: move stage, set a job value, add notes (saved on the GHL contact, prefixed
  `[Portal · Client Name]`), and tap to call / text / email.

## Managing clients (no code, no redeploy)

Log in as the admin (`leadthru`) and tap the **people icon** in the top bar to open **Clients**:

- **Add client**: business name, their GHL pipeline, username, password, logo, brand colour.
  They can log in as soon as you save.
- **Edit**: tap a client to change their password, pipeline, logo, colour or name.
- **Remove**: at the bottom of a client's form. Their leads in GHL are not touched.

Logos are trimmed and turned into the header logo and home-screen app icons in the browser,
then stored in Netlify Blobs (store `portal`). The brand colour is picked from the logo and can
be changed. Wide logos with a separate symbol can use just the symbol as the app icon.

Storage is eventually consistent: new clients work right away, but password changes and removals
can take a few minutes to apply on every server.

### Branding

After login, each client sees a light page in their colours with their logo in the header, a
"Powered by LeadThru" strip on top and a LeadThru sign-off at the bottom. The sign-in page and
the admin view stay LeadThru-branded. The five original clients' assets live in `public/brands/`
(listed in `netlify/functions/brands.json`); anything added or changed from the Clients page is
served from `/api/asset/<slug>/…`.

### Where client data lives

- `clients/<username>` in Netlify Blobs: login (scrypt hash), pipeline, branding.
- `asset/<slug>/…`: uploaded logo and icons. `slug/<slug>`: lookup for the app manifest.
- `meta`: marks that the original logins (env `PORTAL_USERS` + `brands.json`) were copied into
  storage on the first save. After that, `PORTAL_USERS` is no longer read for logins that exist in storage.

## Environment variables (Netlify → Site configuration → Environment variables)

| Key | What |
| --- | --- |
| `GHL_TOKEN` | GHL Private Integration token (scopes: contacts r/w, opportunities r/w, locations, custom fields, tags read) |
| `GHL_LOCATION_ID` | Sub-account id |
| `SESSION_SECRET` | Random string that signs login cookies. Changing it signs everyone out. |
| `PORTAL_USERS` | Original logins, used only to seed storage (see above). |

Functions read env vars **at deploy time**, so redeploy after changing any of them.

## Deploying code changes

```bash
npm install
node scripts/deploy.mjs
```

The deploy bundles the function with esbuild and uploads through the Netlify API. Outside Claude
Code cloud sessions, set `NETLIFY_AUTH_TOKEN` first. Inside one, the proxy supplies it (and Node
needs `NODE_USE_ENV_PROXY=1`). Each production deploy uses Netlify credits.

### Rotating the GHL token
1. GHL → Settings → Private Integrations → LeadThru Client Portal → Rotate. Copy the new token.
2. Netlify → leadthru-portal → Site configuration → Environment variables → `GHL_TOKEN` → paste it.
3. Redeploy: `node scripts/deploy.mjs` (or ask Claude to redeploy the portal).

## Local testing

```bash
PORTAL_LOCAL_STORE=./.local-store GHL_TOKEN=... GHL_LOCATION_ID=... SESSION_SECRET=anything \
  PORTAL_USERS='[...]' node scripts/dev.mjs
# open http://localhost:8888
```

`PORTAL_LOCAL_STORE` keeps clients and logos in a local folder instead of Netlify Blobs.
