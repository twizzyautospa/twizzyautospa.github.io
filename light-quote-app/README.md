# Light Quote App

White-label quoting and booking software for Christmas light installers.

A homeowner answers a short quiz, adds their address and a photo, and sees their own home lit up in three colours with a price range. The installer gets the lead with photos and a satellite measuring tool, sends a firm quote, and the homeowner accepts and picks an install date.

The platform is called Lumiquote. The name can be changed on the admin Overview page.

## The three faces

| Who | URL | What they do |
|---|---|---|
| Homeowner | `/q/<installer-link-name>` then `/r/<private-token>` | Quiz, preview, price, accept and book. Shows only the installer's brand. |
| Installer | `/app` | Leads, roofline measuring, quote builder, branding, pricing, integrations. |
| Platform owner | `/admin` | Every installer and every lead, add or pause installers, open any installer's dashboard. |

Installers and the owner sign in at `/login`.

## How it is built

- Static pages in `public/` (plain HTML, CSS and ES modules, no build step).
- One API function, `netlify/functions/api.mts`, serving `/api/*`.
- One background function, `netlify/functions/previews.mts`, that makes the lighting previews.
- Shared code in `netlify/lib/`.
- Netlify Database (Postgres) for installers and leads. Schema in `netlify/database/migrations/`.
- Netlify Blobs for photos and preview images. They are served only through `/api/file/...`, which checks the customer's token or a signed-in owner.
- Leaflet (vendored in `public/vendor/leaflet`) with Esri satellite imagery, and Photon for address lookup. Both are set in one place each (`TILES` in `public/js/lib.js`, `lookup` in `public/js/quiz.js`) so they can be swapped for Google or Mapbox.

## Settings (environment variables)

| Variable | Needed | Purpose |
|---|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Yes | The platform owner's sign-in. Password must be 8+ characters. Without both, admin sign-in is off. |
| `SESSION_SECRET` | No | 32+ characters. If unset, one is generated and stored in the database. |
| `PREVIEW_PROVIDER` | No | `off` disables previews, `mock` returns the original photo (testing). Default: on when Gemini credentials exist. |
| `PREVIEW_MODEL` | No | Image model. Default `gemini-3.1-flash-image`. |
| `GEMINI_API_KEY` | No | Only if not using Netlify AI Gateway, which injects it automatically on credit-based plans after the first production deploy. |
| `RESEND_API_KEY`, `EMAIL_FROM` | No | Turns on email alerts to installers through Resend. |
| `GHL_TOKEN`, `GHL_LOCATION_ID` | No | Turns on the GoHighLevel sync for linked installers. |

On Netlify, variables must include the **Functions** scope, and a redeploy is needed after changing them.

## Run it locally

```bash
npm install
```

```bash
netlify dev
```

```bash
netlify database migrations apply
```

Put `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `PREVIEW_PROVIDER=mock` in a `.env` file first (see `.env.example`). Then open `http://localhost:8888/login`.

```bash
npm test
```

## Lighting previews

The first photo is sent to an image model with a prompt built only from the customer's choices (which areas, how much of the roofline), once per colour. The customer can change the lit areas twice; the installer can remake previews any time. Each lead with a photo makes three images, so preview cost scales with lead volume. Each installer has a daily request cap in Settings, and each device is limited to six requests an hour.

## Connecting other systems

**Outbound webhook.** Each installer can set a webhook URL in Settings. The app POSTs JSON for `lead.created`, `quote.sent`, `quote.accepted` and `quote.declined`:

```json
{ "event": "quote.accepted", "sentAt": "2026-11-11T18:00:00.000Z",
  "data": { "leadId": "...", "status": "booked", "customer": { "name": "...", "email": "...", "phone": "..." },
            "address": "...", "quote": { "total": 959 }, "booking": { "date": "2026-11-27" },
            "customerUrl": "https://.../r/...", "dashboardUrl": "https://.../app#lead=..." } }
```

**Inbound API.** A CRM or booking portal can push a request, or a confirmed booking, into an installer's dashboard. The key is in the installer's Settings.

```bash
curl -X POST https://YOUR-SITE/api/inbound/leads \
  -H "Authorization: Bearer lq_..." \
  -H "Content-Type: application/json" \
  -d '{"name":"Jane Doe","phone":"555-0100","email":"jane@example.com","address":"12 Elm St, Springfield","service":"roofline","bookingDate":"2026-12-01","source":"crm","externalId":"JOB-1042","notes":"Front only"}'
```

`name` and one of `phone` or `email` are required. `service` is `roofline`, `trees` or `full`. Sending `bookingDate` (YYYY-MM-DD) files it as booked.

## GoHighLevel sync

An installer can be linked to one pipeline in the platform's GoHighLevel location. The link is set by the platform owner (the `crm` column on the installer), never by the installer.

- **Out, as it happens:** a new request upserts the contact (matched by phone or email) and creates an opportunity in the first stage, or links to the opportunity that contact already has in the pipeline. Saving a quote, the customer accepting or declining, and status changes in the dashboard move the opportunity to the matching stage and set its value. Notes are added to the contact.
- **In, every 15 minutes:** opportunities moved to the booked, completed or lost stage update the linked lead. Jobs booked in the pipeline that did not start as a quote request are added to the dashboard, from the moment the link was created onward.
- Sync failures never block a request. The error is saved on the lead and shown in the lead view and on the admin Overview, which also has a "Pull from pipeline now" button.
- Needs `GHL_TOKEN` and `GHL_LOCATION_ID` on the site. `GHL_API_BASE` points the client at a stand-in server for local testing.
- Booking dates made in the LeadThru portal are stored by the portal, not in GoHighLevel, so imported jobs arrive without a date.

## Not built yet

- Online payment. Quotes show the total only; there is no deposit step.
- Automatic text messages. Installers send the quote link with one tap from their own phone or email.
- Custom domains or subdomains per installer. Links are `/q/<name>` on the platform's domain.
- Installer self-signup and billing. The owner creates installer accounts in `/admin`.
