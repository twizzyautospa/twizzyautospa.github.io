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

## Meta lead marking

Every lead has a **Did this lead come from Meta?** choice (From Meta / Not from Meta) in its panel, and lead
cards show a META / NOT META tag. The summary row counts leads from Meta.

- A client's choice is saved as a GHL contact tag: `meta lead` or `not meta lead` (the other one is removed).
- Leads nobody has marked count as Meta automatically when GHL's attribution says the lead came from a paid
  social ad (the Facebook / Instagram lead form), shown as "Marked automatically… Tap to change."

## Calendar (booked appointments)

Every login has a **Leads | Calendar** switch. The calendar is the portal's own (not a GHL calendar):

- **Book from a lead**: open a lead → *Book appointment* (right under the stage buttons). Pick what
  (Estimate, Job, Follow-up, Site visit or anything typed), date, start time, length, address and notes,
  and optionally move the lead to a new stage in the same step.
- **Book from the calendar**: *+ Book* (or *Book this day*) and choose the lead.
- **Calendar view**: *Month* (grid with dots on booked days, the selected day's appointments, what's coming up)
  or *Week* (a day-by-day list on phones; an hourly grid on desktop where clicking an empty slot books that time).
- **Revenue**: appointments can have a price. The calendar shows revenue for the week and the month being viewed
  (sum of prices of appointments starting in that period) and how much of it came from Meta leads. A price can
  also be saved as the lead's job value in GHL (checked by default).
  Lead cards show their next appointment; the Calendar tab shows how many are in the next 7 days.
- **Add to phone calendar**: every appointment has *Apple / Outlook* (an `.ics` file from `/api/ics`, with a
  1-hour reminder) and *Google* buttons. Change or cancel from the same screen.
- **GHL side**: each booking, change and cancellation adds a note on the GHL contact
  (`[Portal · Client] Booked: Job on Thu, Nov 12, 10:00 AM–12:00 PM at …`), and new bookings add the tag
  `appointment booked`, so a GHL workflow can start from "Tag added: appointment booked".
- Stored in Netlify Blobs at `bk/<pipelineId>/<YYYY-MM>/<id>`; the browser and the function both remember
  their own recent changes, so storage sync delay is not visible to the person making the change.

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

`PORTAL_LOCAL_STORE` keeps clients, logos and bookings in a local folder instead of Netlify Blobs.
Add `PORTAL_DRY_WRITES=1` to read real GHL data but skip every change to GHL (stage moves, notes, tags).
