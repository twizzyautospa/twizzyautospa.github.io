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

## Home, tabs and invoices

The portal opens on **Home**, with tabs **Home | Leads | Calendar | Invoices**.

- **Home**: greeting, four KPI tiles (new leads in 7 days and % from Meta, jobs this week, revenue this month,
  unpaid invoices), jobs to wrap up, "call these first" and overdue-invoice nudges, today's and upcoming jobs,
  a stage-by-stage pipeline snapshot, and recent invoices.
- **Invoices**: outstanding / paid-this-month totals, All / Unpaid / Paid / Drafts filters.
  - *New invoice* (optionally filled from a lead) or *Create invoice* on any booked job (customer, address,
    job line, price and service date filled in).
  - Editable lines (description, qty, price), tax name and %, discount, any number of custom fields
    (label + value, e.g. PO #, warranty), notes. Numbering is automatic per client (`<prefix><n>`, e.g. TB-1001)
    and can be overridden per invoice.
  - Branded PDF (client logo and colour, business details, PAID stamp) from `/api/invoice-pdf` behind a signed link.
  - *Text it* / *Email it*: sent through GHL from the account's number/email when the token has the
    **conversations/message.write** permission; otherwise the phone's Messages/Mail app opens with the message
    and link ready. *Share…* / *Copy link* also available. Mark paid / unpaid, edit, duplicate, delete.
  - **Invoice settings** (gear): business name, address, phone, email, website, tax number, default tax,
    due days, number prefix and first number, how to pay, terms.
  - Storage: every save is a new version key `inv/<pipelineId>/<invoiceId>/<version>` (and settings at
    `invcfg/<pipelineId>/<version>`), so a sent link always shows exactly that version.

## Quotes with customer approval

The **Billing** tab has **Quotes | Invoices**. Quotes use the same editor, numbering (`quotePrefix`, e.g. TB-Q1001),
branding and PDF as invoices, plus a *Valid until* date (default `quoteDays`, 30).

- Create from a lead (*Create quote* under the stage buttons), from an estimate/site-visit booking, or from scratch.
- *Text it / Email it / Share / Copy link* sends a link to **/q?t=…**, a branded customer page (no login; the link is
  HMAC-signed) showing the quote with **Approve** (type full name + tick "I accept") and **Decline** (optional reason).
  The first time the customer opens it, the quote shows as *Viewed* in the portal.
- Sending a quote moves the lead forward to the **Quoted** stage.
- **On approval** (by the customer, or *Mark as approved* in the portal): the lead moves forward to **Closed** with
  the pre-tax quote total as its job value, the contact is tagged `quote approved` with a note, and a matching
  **invoice is created as a draft**. Home shows "<customer> approved quote … Schedule the job" until it is booked.
- **On decline**: tagged `quote declined` with the reason in a note. Expired quotes can't be approved.
- Leads are only ever moved forward (never back out of Closed / Job Completed).

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
- **Moving a lead to Closed** (tap or drag; any stage named Closed / Won / Booked, never Lost) moves it right away,
  then opens *Schedule the job* with Job, 2 hours and the lead's job value as the price. *Not now* skips it;
  leads that already have an upcoming appointment are not asked again.
- **Book from the calendar**: *+ Book* (or *Book this day*) and choose the lead, or tap
  *Book someone who isn't in your leads* to type a name, phone and email by hand. Those appointments live only in
  the portal calendar (no GHL contact, note or tag), count toward revenue, and count as not from Meta.
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

## Jobs done, review requests and day-of confirmations

- **Mark job done**: jobs (not estimates or follow-ups) that ended in the last 2 weeks show in a *jobs to wrap up*
  banner on Leads and Calendar. *Mark job done* confirms the final price, moves the lead to the pipeline's
  **Job Completed** stage (any stage named Completed / Done), tags `job completed` and adds a note. A GHL
  "Pipeline Stage Changed → Job Completed" workflow sends the review request.
- **Next job on the contact**: every booking change re-computes the customer's next upcoming job and writes it to
  the GHL contact fields **Next Job Date** (date), **Next Job Time**, **Next Job Type**, **Next Job Address**,
  **Next Job Business** (found by name; skipped until they exist). Cancelling or finishing clears them.
  A GHL "Custom Date Reminder" workflow on Next Job Date sends the day-of confirmation.
- Setup prompts for Claude in Chrome (stage, fields, workflows): `docs/ghl-automation-prompts.md`.

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

**Demo mode** (no real data): `PORTAL_MOCK_GHL=1` swaps GoHighLevel for an in-memory fictional business,
"Northshore Landscaping" (`scripts/mock-ghl.cjs`), so the portal can be demoed or screen-recorded safely:

```bash
PORTAL_MOCK_GHL=1 PORTAL_LOCAL_STORE=./.demo-store GHL_TOKEN=demo GHL_LOCATION_ID=demo SESSION_SECRET=demo \
  PORTAL_USERS='[]' node scripts/dev.mjs
```
Add `PORTAL_DRY_WRITES=1` to read real GHL data but skip every change to GHL (stage moves, notes, tags).
