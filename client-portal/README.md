# LeadThru Client Portal

A small branded portal where each client logs in, sees only their own leads, and moves them
through their pipeline. Every change is written straight to the GoHighLevel opportunity, so
GHL "Pipeline Stage Changed" workflows fire as usual.

- Live: https://leadthru-portal.netlify.app (custom domain: `portal.leadthruagency.com`)
- Netlify site: `leadthru-portal` (ids in `portal.config.json`)
- Installable on phones (Add to Home Screen) as "LeadThru".

## How it works

```
phone / browser ──► public/ (static app)  ──► /api/*  ──► netlify/functions/api.js ──► GHL API v2
```

- One GHL sub-account, one Private Integration token, kept server-side in Netlify env vars.
- Each client = one GHL pipeline. A client's login is locked to that pipeline on the server:
  they cannot read or move any other client's leads, even by editing requests.
- The admin login (`leadthru`) sees every pipeline via the dropdown.
- Leads are read live from GHL on every load (and every 60s while open), so nothing goes stale.
- Clients can: move stage, set a job value, add notes (saved on the GHL contact, prefixed
  `[Portal · Client Name]`), and tap to call / text / email.

## Environment variables (Netlify → Site configuration → Environment variables)

| Key | What |
| --- | --- |
| `GHL_TOKEN` | GHL Private Integration token (scopes: contacts r/w, opportunities r/w, locations, custom fields, tags read) |
| `GHL_LOCATION_ID` | Sub-account id |
| `SESSION_SECRET` | Random string that signs login cookies. Changing it signs everyone out. |
| `PORTAL_USERS` | JSON list of logins (password hashes only). Manage with `scripts/users.mjs`. |

Functions read env vars **at deploy time**, so redeploy after changing any of them.

## Common jobs

```bash
node scripts/users.mjs list
node scripts/users.mjs add newclient "New Client Name" <ghlPipelineId>   # prints the password once
node scripts/users.mjs reset brighthomecare                               # prints a new password
node scripts/users.mjs remove oldclient
node scripts/deploy.mjs                                                   # push code + env changes live
```

Outside Claude Code cloud sessions, set `NETLIFY_AUTH_TOKEN` first. Inside one, the proxy supplies it
(and Node needs `NODE_USE_ENV_PROXY=1` to use the proxy).

Get a pipeline id: in GHL open Opportunities, pick the pipeline, and copy the id from the URL, or ask Claude.

### Rotating the GHL token
1. GHL → Settings → Private Integrations → LeadThru Client Portal → Rotate. Copy the new token.
2. Netlify → leadthru-portal → Site configuration → Environment variables → `GHL_TOKEN` → paste it.
3. Redeploy: `node scripts/deploy.mjs` (or ask Claude to redeploy the portal).

## Local testing

```bash
GHL_TOKEN=... GHL_LOCATION_ID=... SESSION_SECRET=anything PORTAL_USERS='[...]' node scripts/dev.mjs
# open http://localhost:8888
```

No npm install needed. Everything uses Node built-ins (Node 18+).
