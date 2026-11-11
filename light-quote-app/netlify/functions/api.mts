import type { Config, Context } from "@netlify/functions";
import {
  adminConfigured,
  assertNotLocked,
  clearCookie,
  clearLoginFailures,
  getSecret,
  getSession,
  hashPassword,
  isAdminLogin,
  recordLoginFailure,
  safeEqual,
  sessionCookie,
  validatePassword,
  verifyPassword,
  type Session,
} from "../lib/auth.mts";
import { previewProvider } from "../lib/ai.mts";
import { getSetting, j, setSetting, sql } from "../lib/db.mts";
import { parseImageDataUrl, readFile } from "../lib/files.mts";
import {
  cleanMeasurement,
  createLead,
  customerView,
  deleteLead,
  installerById,
  installerBySlug,
  leadById,
  leadByToken,
  listView,
  MAX_CUSTOMER_REGENS,
  publicInstaller,
  staffView,
  startPreviews,
  STATUSES,
  toInstaller,
  webhookPayload,
  type Installer,
  type Lead,
} from "../lib/leads.mts";
import { sendEmail, sendWebhook, type EventName } from "../lib/notify.mts";
import {
  buildQuote,
  cleanItems,
  computeEstimate,
  DEFAULT_SETTINGS,
  normalizeSelections,
  normalizeSettings,
  SCOPES,
  SERVICES,
} from "../lib/pricing.mts";
import { fail, HttpError, isDate, isEmail, json, newId, newToken, num, oneOf, readJson, sha256, slugify, str } from "../lib/util.mts";

interface Ctx {
  req: Request;
  url: URL;
  seg: string[];
  context: Context;
  origin: string;
}

const DEFAULT_PLATFORM = { name: "Lumaquote" };
const MAX_PHOTOS = 3;
const LEADS_PER_IP_PER_HOUR = 6;

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const seg = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "").split("/").map(decodeURIComponent);
  const ctx: Ctx = { req, url, seg, context, origin: url.origin };
  try {
    assertSameOrigin(ctx);
    return await route(ctx);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("Unhandled API error:", err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config: Config = { path: "/api/*" };

/** Browser writes must come from our own pages. Server-to-server callers send no Origin header. */
function assertSameOrigin({ req, url }: Ctx): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) fail(403, "Cross-site request blocked");
}

async function route(ctx: Ctx): Promise<Response> {
  const [area] = ctx.seg;
  if (area === "public") return publicRoutes(ctx);
  if (area === "file") return fileRoute(ctx);
  if (area === "auth") return authRoutes(ctx);
  if (area === "installer") return installerRoutes(ctx);
  if (area === "admin") return adminRoutes(ctx);
  if (area === "inbound") return inboundRoutes(ctx);
  fail(404, "Not found");
}

function notify(ctx: Ctx, installer: Installer, lead: Lead, event: EventName): void {
  const payload = webhookPayload(lead, installer, ctx.origin);
  const to = installer.settings.notifyEmail || installer.email;
  const who = lead.customerName || "A customer";
  const subjects: Record<EventName, string> = {
    "lead.created": `New lighting request from ${who}`,
    "quote.sent": `Quote sent to ${who}`,
    "quote.accepted": `${who} accepted your quote`,
    "quote.declined": `${who} declined your quote`,
  };
  const work = Promise.all([
    sendWebhook(installer.settings.webhookUrl, event, payload),
    event === "quote.sent"
      ? Promise.resolve()
      : sendEmail(to, subjects[event], [`${who} · ${lead.address}`, `Phone: ${lead.customerPhone || "not given"}`], {
          label: "Open in your dashboard",
          url: payload.dashboardUrl,
        }),
  ]);
  ctx.context.waitUntil(work);
}

async function platform() {
  return { ...DEFAULT_PLATFORM, ...((await getSetting<{ name: string }>("platform")) ?? {}) };
}

/* ------------------------------------------------------------------ public (homeowner) */

async function publicRoutes(ctx: Ctx): Promise<Response> {
  const { req, seg } = ctx;
  const [, resource, id, action] = seg;

  if (resource === "platform" && req.method === "GET") return json(await platform());

  if (resource === "installer" && id && req.method === "GET") {
    const installer = await installerBySlug(id);
    if (!installer || installer.status !== "active") fail(404, "This quote link is not active");
    return json({ installer: publicInstaller(installer) });
  }

  if (resource === "leads" && !id && req.method === "POST") return submitLead(ctx);

  if (resource === "lead" && id) {
    const lead = await leadByToken(id);
    if (!lead) fail(404, "We could not find that request");
    const installer = await installerById(lead.installerId);
    if (!installer) fail(404, "We could not find that request");

    if (!action && req.method === "GET") return json(customerView(lead, installer));

    if (action === "regenerate" && req.method === "POST") {
      const body = await readJson(req);
      if (lead.status !== "new") fail(409, "Your quote has already been prepared. Ask your installer to change it.");
      if (lead.previews.status === "pending") fail(409, "Your preview is still being made");
      if (lead.previews.regen >= MAX_CUSTOMER_REGENS) fail(429, "You have used all your preview changes");
      if (!lead.photos.length || !installer.settings.aiPreviews || previewProvider() === "off") fail(409, "Previews are not available");
      const selections = normalizeSelections({
        ...lead.selections,
        service: oneOf(body.service, SERVICES, lead.selections.service),
        scope: oneOf(body.scope, SCOPES, lead.selections.scope),
      });
      const estimate = computeEstimate(selections, installer.settings);
      await sql()`UPDATE leads SET selections = ${j(selections)}::jsonb, estimate = ${j(estimate)}::jsonb WHERE id = ${lead.id}`;
      await startPreviews(lead.id, lead.previews.regen + 1, ctx.origin);
      return json(customerView((await leadById(lead.id))!, installer));
    }

    if (action === "accept" && req.method === "POST") {
      const body = await readJson(req);
      if (!lead.quote || lead.status !== "quoted") fail(409, "There is no open quote to accept");
      if (!isDate(body.date)) fail(400, "Choose an install date");
      if (lead.quote.dates.length && !lead.quote.dates.includes(body.date)) fail(400, "Choose one of the offered dates");
      if (new Date(`${body.date}T23:59:59Z`).getTime() < Date.now()) fail(400, "Choose a date in the future");
      const booking = { date: body.date, acceptedAt: new Date().toISOString() };
      await sql()`UPDATE leads SET status = 'booked', booking = ${j(booking)}::jsonb, updated_at = now() WHERE id = ${lead.id}`;
      const updated = (await leadById(lead.id))!;
      notify(ctx, installer, updated, "quote.accepted");
      return json(customerView(updated, installer));
    }

    if (action === "decline" && req.method === "POST") {
      if (lead.status !== "quoted") fail(409, "There is no open quote to decline");
      await sql()`UPDATE leads SET status = 'declined', updated_at = now() WHERE id = ${lead.id}`;
      const updated = (await leadById(lead.id))!;
      notify(ctx, installer, updated, "quote.declined");
      return json(customerView(updated, installer));
    }
  }
  fail(404, "Not found");
}

async function submitLead(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx.req);
  // Honeypot: real visitors never see or fill this field.
  if (str(body.website)) return json({ token: newToken(24) });

  const installer = await installerBySlug(str(body.slug, 60));
  if (!installer || installer.status !== "active") fail(404, "This quote link is not active");

  const name = str(body.contact?.name, 120);
  const email = str(body.contact?.email, 200).toLowerCase();
  const phone = str(body.contact?.phone, 40);
  const address = str(body.address, 300);
  if (name.length < 2) fail(400, "Please enter your name");
  if (!email && !phone) fail(400, "Please enter a phone number or email");
  if (email && !isEmail(email)) fail(400, "That email address does not look right");
  if (phone && phone.replace(/\D/g, "").length < 7) fail(400, "That phone number does not look right");
  if (address.length < 6) fail(400, "Please enter your address");

  const ipHash = sha256(`${await getSecret()}:${ctx.context.ip || "unknown"}`).slice(0, 32);
  const [ipCount] = await sql()`
    SELECT count(*)::int AS n FROM leads WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour'`;
  if (ipCount.n >= LEADS_PER_IP_PER_HOUR) fail(429, "Too many requests from this device. Please try again later.");
  const [dayCount] = await sql()`
    SELECT count(*)::int AS n FROM leads WHERE installer_id = ${installer.id} AND created_at > now() - interval '1 day'`;
  if (dayCount.n >= installer.settings.dailyLeadCap) fail(429, "We are receiving a lot of requests today. Please call us instead.");

  const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, MAX_PHOTOS).map(parseImageDataUrl);
  const lat = typeof body.lat === "number" && Math.abs(body.lat) <= 90 ? body.lat : null;
  const lng = typeof body.lng === "number" && Math.abs(body.lng) <= 180 ? body.lng : null;

  const lead = await createLead(
    installer,
    {
      source: "quiz",
      name,
      email,
      phone,
      address,
      lat: lat !== null && lng !== null ? lat : null,
      lng: lat !== null && lng !== null ? lng : null,
      selections: normalizeSelections(body.selections),
      photos,
      ipHash,
    },
    ctx.origin,
  );
  notify(ctx, installer, lead, "lead.created");
  return json({ token: lead.publicToken }, 201);
}

/* ------------------------------------------------------------------ images */

async function fileRoute(ctx: Ctx): Promise<Response> {
  const [, leadId, name] = ctx.seg;
  if (ctx.req.method !== "GET" || !leadId || !name) fail(404, "Not found");
  const lead = await leadById(leadId);
  if (!lead) fail(404, "Not found");

  const token = ctx.url.searchParams.get("t") || "";
  let allowed = token.length > 0 && safeEqual(token, lead.publicToken);
  if (!allowed) {
    const session = await getSession(ctx.req);
    allowed = session?.role === "admin" || (session?.role === "installer" && session.id === lead.installerId);
  }
  if (!allowed) fail(404, "Not found");

  const file = await readFile(leadId, name);
  if (!file) fail(404, "Not found");
  return new Response(file.bytes, {
    headers: {
      "content-type": file.mime,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

/* ------------------------------------------------------------------ sign in */

async function authRoutes(ctx: Ctx): Promise<Response> {
  const { req, seg } = ctx;
  const action = seg[1];

  if (action === "me" && req.method === "GET") {
    const session = await getSession(req);
    if (!session) return json({ session: null, adminConfigured: adminConfigured() });
    if (session.role === "admin") return json({ session: { role: "admin" } });
    const installer = await installerById(session.id);
    if (!installer || (installer.status !== "active" && !session.viaAdmin)) {
      return json({ session: null }, 200, { "set-cookie": clearCookie(req) });
    }
    return json({ session: { role: "installer", viaAdmin: !!session.viaAdmin, companyName: installer.companyName } });
  }

  if (action === "login" && req.method === "POST") {
    const body = await readJson(req);
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
    if (!email || !password) fail(400, "Enter your email and password");
    await assertNotLocked(email);

    if (isAdminLogin(email, password)) {
      await clearLoginFailures(email);
      return json({ role: "admin" }, 200, { "set-cookie": await sessionCookie(req, { role: "admin" }) });
    }
    const rows = await sql()`SELECT * FROM installers WHERE email = ${email}`;
    const ok = rows.length > 0 && (await verifyPassword(password, rows[0].password_hash));
    if (!ok) {
      await recordLoginFailure(email);
      fail(401, "Email or password is incorrect");
    }
    if (rows[0].status !== "active") fail(403, "This account is paused. Contact support.");
    await clearLoginFailures(email);
    return json({ role: "installer" }, 200, { "set-cookie": await sessionCookie(req, { role: "installer", id: rows[0].id }) });
  }

  if (action === "logout" && req.method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearCookie(req) });
  }

  // An admin who is "viewing as" an installer returns to the admin console.
  if (action === "return-to-admin" && req.method === "POST") {
    const session = await getSession(req);
    if (session?.role !== "installer" || !session.viaAdmin) fail(403, "Not allowed");
    return json({ role: "admin" }, 200, { "set-cookie": await sessionCookie(req, { role: "admin" }) });
  }
  fail(404, "Not found");
}

/* ------------------------------------------------------------------ installer dashboard */

async function requireInstaller(ctx: Ctx): Promise<{ installer: Installer; session: Extract<Session, { role: "installer" }> }> {
  const session = await getSession(ctx.req);
  if (session?.role !== "installer") fail(401, "Please sign in");
  const installer = await installerById(session.id);
  if (!installer) fail(401, "Please sign in");
  if (installer.status !== "active" && !session.viaAdmin) fail(403, "This account is paused");
  return { installer, session };
}

async function ownLead(installer: Installer, leadId: string): Promise<Lead> {
  const lead = await leadById(leadId);
  if (!lead || lead.installerId !== installer.id) fail(404, "Lead not found");
  return lead;
}

function installerAccount(installer: Installer, ctx: Ctx) {
  return {
    companyName: installer.companyName,
    email: installer.email,
    phone: installer.phone,
    slug: installer.slug,
    settings: installer.settings,
    quoteLink: `${ctx.origin}/q/${installer.slug}`,
    inboundKey: installer.inboundKey,
    inboundUrl: `${ctx.origin}/api/inbound/leads`,
    previewsAvailable: previewProvider() !== "off",
  };
}

async function installerRoutes(ctx: Ctx): Promise<Response> {
  const { req, seg } = ctx;
  const { installer } = await requireInstaller(ctx);
  const [, resource, id, action] = seg;

  if (resource === "account") {
    if (req.method === "GET") return json(installerAccount(installer, ctx));
    if (req.method === "PUT") {
      const body = await readJson(req);
      const companyName = str(body.companyName, 80) || installer.companyName;
      const phone = body.phone === undefined ? installer.phone : str(body.phone, 40);
      const settings = normalizeSettings(body.settings, installer.settings);
      let slug = installer.slug;
      if (typeof body.slug === "string" && slugify(body.slug) !== installer.slug) {
        slug = slugify(body.slug);
        if (slug.length < 3) fail(400, "Your link name must be at least 3 letters or numbers");
        const taken = await sql()`SELECT 1 FROM installers WHERE slug = ${slug} AND id <> ${installer.id}`;
        if (taken.length) fail(409, "That link name is already taken");
      }
      await sql()`
        UPDATE installers SET company_name = ${companyName}, phone = ${phone}, slug = ${slug}, settings = ${j(settings)}::jsonb
        WHERE id = ${installer.id}`;
      return json(installerAccount((await installerById(installer.id))!, ctx));
    }
  }

  if (resource === "password" && req.method === "POST") {
    const body = await readJson(req);
    const rows = await sql()`SELECT password_hash FROM installers WHERE id = ${installer.id}`;
    if (!(await verifyPassword(String(body.current ?? ""), rows[0].password_hash))) fail(400, "Current password is incorrect");
    const hash = await hashPassword(validatePassword(body.next));
    await sql()`UPDATE installers SET password_hash = ${hash} WHERE id = ${installer.id}`;
    return json({ ok: true });
  }

  if (resource === "inbound-key" && req.method === "POST") {
    await sql()`UPDATE installers SET inbound_key = ${`lq_${newToken(24)}`} WHERE id = ${installer.id}`;
    return json(installerAccount((await installerById(installer.id))!, ctx));
  }

  if (resource === "leads" && !id && req.method === "GET") {
    const rows = await sql()`
      SELECT l.*, ${installer.companyName}::text AS company_name FROM leads l
      WHERE l.installer_id = ${installer.id} ORDER BY l.created_at DESC LIMIT 500`;
    return json({ leads: rows.map(listView) });
  }

  if (resource === "leads" && id) {
    const lead = await ownLead(installer, id);

    if (!action && req.method === "GET") return json({ lead: staffView(lead, installer) });

    if (!action && req.method === "PATCH") {
      const body = await readJson(req);
      const status = oneOf(body.status, STATUSES, lead.status as (typeof STATUSES)[number]);
      const notes = body.notes === undefined ? lead.notes : str(body.notes, 4000);
      const measurement = body.measurement === undefined ? lead.measurement : cleanMeasurement(body.measurement);
      await sql()`
        UPDATE leads SET status = ${status}, notes = ${notes}, measurement = ${j(measurement)}::jsonb, updated_at = now()
        WHERE id = ${lead.id}`;
      return json({ lead: staffView((await leadById(lead.id))!, installer) });
    }

    if (!action && req.method === "DELETE") {
      await deleteLead(lead.id);
      return json({ ok: true });
    }

    if (action === "quote" && req.method === "POST") {
      const body = await readJson(req);
      const items = cleanItems(body.items);
      if (!items.length) fail(400, "Add at least one line to the quote");
      const dates = (Array.isArray(body.dates) ? body.dates : []).filter(isDate).slice(0, 12).sort();
      const depositPct = num(body.depositPct, 0, 100, installer.settings.depositPct);
      const quote = buildQuote(items, depositPct, [...new Set<string>(dates)], str(body.note, 1500));
      if (quote.total <= 0) fail(400, "The quote total must be more than zero");
      await sql()`
        UPDATE leads SET quote = ${j(quote)}::jsonb, status = 'quoted', booking = NULL, updated_at = now() WHERE id = ${lead.id}`;
      const updated = (await leadById(lead.id))!;
      notify(ctx, installer, updated, "quote.sent");
      return json({ lead: staffView(updated, installer), customerUrl: `${ctx.origin}/r/${updated.publicToken}` });
    }

    if (action === "regenerate" && req.method === "POST") {
      if (!lead.photos.length) fail(409, "This lead has no photo to work from");
      if (previewProvider() === "off") fail(409, "Lighting previews are not switched on for this platform yet");
      if (lead.previews.status === "pending") fail(409, "A preview is already being made");
      await startPreviews(lead.id, lead.previews.regen, ctx.origin);
      return json({ lead: staffView((await leadById(lead.id))!, installer) });
    }
  }
  fail(404, "Not found");
}

/* ------------------------------------------------------------------ platform owner */

async function adminRoutes(ctx: Ctx): Promise<Response> {
  const { req, seg } = ctx;
  const session = await getSession(req);
  if (session?.role !== "admin") fail(401, "Please sign in");
  const [, resource, id, action] = seg;

  if (resource === "overview" && req.method === "GET") {
    const [totals] = await sql()`
      SELECT count(*)::int AS leads,
             count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS leads_week,
             count(*) FILTER (WHERE status = 'quoted')::int AS quoted,
             count(*) FILTER (WHERE status IN ('booked', 'completed'))::int AS booked,
             coalesce(sum((quote->>'total')::numeric) FILTER (WHERE status IN ('booked', 'completed')), 0)::float AS booked_value
      FROM leads`;
    const [installers] = await sql()`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active FROM installers`;
    return json({
      totals: {
        leads: totals.leads,
        leadsThisWeek: totals.leads_week,
        quoted: totals.quoted,
        booked: totals.booked,
        bookedValue: totals.booked_value,
        installers: installers.total,
        activeInstallers: installers.active,
      },
      platform: await platform(),
      previewsAvailable: previewProvider() !== "off",
    });
  }

  if (resource === "platform" && req.method === "PUT") {
    const body = await readJson(req);
    const name = str(body.name, 40);
    if (name.length < 2) fail(400, "Enter a platform name");
    await setSetting("platform", { name });
    return json(await platform());
  }

  if (resource === "installers" && !id && req.method === "GET") {
    const rows = await sql()`
      SELECT i.*, count(l.id)::int AS lead_count,
             count(l.id) FILTER (WHERE l.status IN ('booked', 'completed'))::int AS booked_count,
             coalesce(sum((l.quote->>'total')::numeric) FILTER (WHERE l.status IN ('booked', 'completed')), 0)::float AS booked_value,
             max(l.created_at) AS last_lead_at
      FROM installers i LEFT JOIN leads l ON l.installer_id = i.id
      GROUP BY i.id ORDER BY i.created_at DESC`;
    return json({
      installers: rows.map((row: any) => ({
        id: row.id,
        slug: row.slug,
        companyName: row.company_name,
        email: row.email,
        phone: row.phone,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        leadCount: row.lead_count,
        bookedCount: row.booked_count,
        bookedValue: row.booked_value,
        lastLeadAt: row.last_lead_at ? new Date(row.last_lead_at).toISOString() : null,
        quoteLink: `${ctx.origin}/q/${row.slug}`,
      })),
    });
  }

  if (resource === "installers" && !id && req.method === "POST") {
    const body = await readJson(req);
    const companyName = str(body.companyName, 80);
    const email = str(body.email, 200).toLowerCase();
    if (companyName.length < 2) fail(400, "Enter the company name");
    if (!isEmail(email)) fail(400, "Enter a valid email address");
    const hash = await hashPassword(validatePassword(body.password));
    const base = slugify(str(body.slug, 60) || companyName);
    if (base.length < 3) fail(400, "The link name must be at least 3 letters or numbers");
    if ((await sql()`SELECT 1 FROM installers WHERE email = ${email}`).length) fail(409, "An installer with that email already exists");
    let slug = base;
    for (let n = 2; (await sql()`SELECT 1 FROM installers WHERE slug = ${slug}`).length; n++) slug = `${base}-${n}`;
    const installerId = newId();
    await sql()`
      INSERT INTO installers (id, slug, company_name, email, password_hash, phone, settings, inbound_key)
      VALUES (${installerId}, ${slug}, ${companyName}, ${email}, ${hash}, ${str(body.phone, 40)},
              ${j(DEFAULT_SETTINGS)}::jsonb, ${`lq_${newToken(24)}`})`;
    const created = (await installerById(installerId))!;
    return json({ id: created.id, slug: created.slug, quoteLink: `${ctx.origin}/q/${created.slug}` }, 201);
  }

  if (resource === "installers" && id) {
    const installer = await installerById(id);
    if (!installer) fail(404, "Installer not found");

    if (!action && req.method === "PATCH") {
      const body = await readJson(req);
      const status = oneOf(body.status, ["active", "suspended"] as const, installer.status as "active" | "suspended");
      await sql()`UPDATE installers SET status = ${status} WHERE id = ${installer.id}`;
      if (body.password !== undefined) {
        const hash = await hashPassword(validatePassword(body.password));
        await sql()`UPDATE installers SET password_hash = ${hash} WHERE id = ${installer.id}`;
        await clearLoginFailures(installer.email);
      }
      return json({ ok: true });
    }

    if (!action && req.method === "DELETE") {
      const leads = await sql()`SELECT id FROM leads WHERE installer_id = ${installer.id}`;
      for (const row of leads) await deleteLead(row.id);
      await sql()`DELETE FROM installers WHERE id = ${installer.id}`;
      return json({ ok: true });
    }

    // Open this installer's dashboard exactly as they see it.
    if (action === "view-as" && req.method === "POST") {
      return json({ ok: true }, 200, {
        "set-cookie": await sessionCookie(req, { role: "installer", id: installer.id, viaAdmin: true }),
      });
    }
  }

  if (resource === "leads" && !id && req.method === "GET") {
    const installerId = str(ctx.url.searchParams.get("installer"), 60);
    const status = str(ctx.url.searchParams.get("status"), 20);
    const rows = await sql()`
      SELECT l.*, i.company_name FROM leads l JOIN installers i ON i.id = l.installer_id
      WHERE (${installerId} = '' OR l.installer_id = ${installerId}) AND (${status} = '' OR l.status = ${status})
      ORDER BY l.created_at DESC LIMIT 500`;
    return json({ leads: rows.map(listView) });
  }

  if (resource === "leads" && id && req.method === "GET") {
    const lead = await leadById(id);
    if (!lead) fail(404, "Lead not found");
    const installer = await installerById(lead.installerId);
    return json({ lead: staffView(lead, installer!) });
  }
  fail(404, "Not found");
}

/* ------------------------------------------------------------------ inbound (CRM and booking integrations) */

/**
 * POST /api/inbound/leads with "Authorization: Bearer <installer inbound key>".
 * Lets another system (a CRM, a booking portal) push a request or a confirmed booking into the installer's dashboard.
 */
async function inboundRoutes(ctx: Ctx): Promise<Response> {
  const { req, seg } = ctx;
  if (seg[1] !== "leads" || req.method !== "POST") fail(404, "Not found");
  const header = req.headers.get("authorization") || "";
  const key = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!/^lq_[A-Za-z0-9_-]{20,}$/.test(key)) fail(401, "Missing or invalid API key");
  const rows = await sql()`SELECT * FROM installers WHERE inbound_key = ${key}`;
  if (!rows.length) fail(401, "Missing or invalid API key");
  const installer = toInstaller(rows[0]);
  if (installer.status !== "active") fail(403, "This account is paused");

  const body = await readJson(req, 200_000);
  const name = str(body.name, 120);
  const email = str(body.email, 200).toLowerCase();
  const phone = str(body.phone, 40);
  const address = str(body.address, 300);
  if (!name) fail(400, "name is required");
  if (!email && !phone) fail(400, "email or phone is required");
  if (email && !isEmail(email)) fail(400, "email is not valid");
  if (body.bookingDate !== undefined && !isDate(body.bookingDate)) fail(400, "bookingDate must be YYYY-MM-DD");

  const source = `api:${slugify(str(body.source, 40)) || "external"}`;
  const reference = str(body.externalId, 80);
  const notes = [reference ? `External reference: ${reference}` : "", str(body.notes, 2000)].filter(Boolean).join("\n");
  const lat = typeof body.lat === "number" && Math.abs(body.lat) <= 90 ? body.lat : null;
  const lng = typeof body.lng === "number" && Math.abs(body.lng) <= 180 ? body.lng : null;
  const lead = await createLead(
    installer,
    {
      source,
      name,
      email,
      phone,
      address,
      lat: lat !== null && lng !== null ? lat : null,
      lng: lat !== null && lng !== null ? lng : null,
      selections: normalizeSelections(body.selections ?? { service: body.service }),
      photos: [],
      bookingDate: body.bookingDate,
      notes,
    },
    ctx.origin,
  );
  notify(ctx, installer, lead, "lead.created");
  return json({ leadId: lead.id, status: lead.status, dashboardUrl: `${ctx.origin}/app#lead=${lead.id}` }, 201);
}
