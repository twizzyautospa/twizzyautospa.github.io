import { sign } from "./auth.mts";
import { j, sql } from "./db.mts";
import { deleteLeadFiles, saveFile, type ImageFile } from "./files.mts";
import { previewProvider } from "./ai.mts";
import {
  buildQuote,
  COLORS,
  computeEstimate,
  estimateBreakdown,
  normalizeSettings,
  suggestedItems,
  type Color,
  type Estimate,
  type InstallerSettings,
  type Quote,
  type Selections,
} from "./pricing.mts";
import { newId, newToken } from "./util.mts";
import { getPlatform } from "./platform.mts";
import { cleanCrmConfig, type CrmConfig, type LeadCrm } from "./crm-config.mts";

export const STATUSES = ["new", "quoted", "booked", "completed", "declined", "lost"] as const;
export const MAX_CUSTOMER_REGENS = 2;
const PREVIEW_STALE_MS = 6 * 60_000;

export interface Installer {
  id: string;
  slug: string;
  companyName: string;
  /** Sign-in name, derived from the business name. */
  username: string;
  /** Optional contact email, used for alerts. Not used to sign in. */
  email: string;
  canSignIn: boolean;
  phone: string;
  status: string;
  settings: InstallerSettings;
  inboundKey: string;
  createdAt: string;
  /** Link to a CRM pipeline. Set by the platform owner only, never by the installer. */
  crm: CrmConfig | null;
  /** The installer's own Google AI key, encrypted. Never sent to a browser. */
  previewKey: string | null;
}

export function toInstaller(row: any): Installer {
  return {
    id: row.id,
    slug: row.slug,
    companyName: row.company_name,
    username: row.username ?? "",
    email: row.email ?? "",
    canSignIn: typeof row.password_hash === "string" && row.password_hash.startsWith("scrypt$"),
    phone: row.phone,
    status: row.status,
    settings: normalizeSettings(row.settings),
    inboundKey: row.inbound_key,
    createdAt: new Date(row.created_at).toISOString(),
    crm: cleanCrmConfig(row.crm),
    previewKey: typeof row.preview_key === "string" && row.preview_key ? row.preview_key : null,
  };
}

/** Whose AI allowance an installer's previews run on: their own key, the platform's, or nobody's. */
export async function previewSource(installer: Installer): Promise<"own" | "platform" | "none"> {
  const platform = await getPlatform();
  if (platform.ownKeys && installer.previewKey) return "own";
  // With own keys switched off, every installer is on the platform's allowance.
  return (!platform.ownKeys || platform.previewFallback) && previewProvider() !== "off" ? "platform" : "none";
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Count one finished preview image against the installer for this month. */
export async function countPreview(installerId: string, onPlatform: boolean): Promise<void> {
  await sql()`
    INSERT INTO preview_usage (installer_id, month, images, platform_images) VALUES (${installerId}, ${thisMonth()}, 1, ${onPlatform ? 1 : 0})
    ON CONFLICT (installer_id, month) DO UPDATE
      SET images = preview_usage.images + 1, platform_images = preview_usage.platform_images + ${onPlatform ? 1 : 0}`;
}

export async function previewUsage(installerId: string): Promise<{ images: number; platformImages: number }> {
  const rows = await sql()`SELECT images, platform_images FROM preview_usage WHERE installer_id = ${installerId} AND month = ${thisMonth()}`;
  return { images: rows[0]?.images ?? 0, platformImages: rows[0]?.platform_images ?? 0 };
}

export async function installerById(id: string): Promise<Installer | null> {
  const rows = await sql()`SELECT * FROM installers WHERE id = ${id}`;
  return rows.length ? toInstaller(rows[0]) : null;
}

export async function installerBySlug(slug: string): Promise<Installer | null> {
  const rows = await sql()`SELECT * FROM installers WHERE slug = ${slug}`;
  return rows.length ? toInstaller(rows[0]) : null;
}

/** What a homeowner's browser is allowed to know about an installer. No pricing, no contact email. */
export function publicInstaller(installer: Installer) {
  return {
    slug: installer.slug,
    companyName: installer.companyName,
    phone: installer.phone,
    brand: installer.settings.brand,
    priceMode: installer.settings.priceMode,
  };
}

export interface PreviewState {
  status: "none" | "pending" | "ready" | "failed";
  run?: string;
  regen: number;
  startedAt?: string;
  /** Why the last run failed, for the installer to read. Never shown to the customer. */
  error?: string;
  /**
   * One entry per colour that has been asked for. Only the customer's chosen colour is made up front; the others
   * are made when someone taps them, so nobody pays for pictures that are never looked at.
   */
  colors: Partial<Record<Color, PreviewColor>>;
}

export interface PreviewColor {
  status: "pending" | "ready" | "failed";
  file?: string;
  startedAt?: string;
  /** How many times this colour has been attempted in this run. */
  tries?: number;
  error?: string;
}

/** A colour can be retried once after a failure, so a broken key cannot be hammered from a customer's phone. */
export const MAX_COLOR_TRIES = 2;

export interface Lead {
  id: string;
  installerId: string;
  publicToken: string;
  status: string;
  source: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  address: string;
  lat: number | null;
  lng: number | null;
  selections: Selections;
  estimate: Estimate | null;
  photos: string[];
  previews: PreviewState;
  measurement: { lines: [number, number][][]; feet: number } | null;
  quote: Quote | null;
  booking: { date: string; acceptedAt: string } | null;
  notes: string;
  crm: LeadCrm | null;
  createdAt: string;
  updatedAt: string;
}

export function toLead(row: any): Lead {
  const previews: PreviewState = { status: "none", regen: 0, colors: {}, ...(row.previews || {}) };
  // A background run that never reported back should not spin forever on the customer's screen.
  const stale = (startedAt?: string) => Boolean(startedAt) && Date.now() - new Date(startedAt!).getTime() > PREVIEW_STALE_MS;
  if (previews.status === "pending" && stale(previews.startedAt)) previews.status = "failed";
  previews.colors = { ...previews.colors };
  for (const color of COLORS) {
    const entry = previews.colors[color];
    if (entry?.status === "pending" && stale(entry.startedAt)) previews.colors[color] = { ...entry, status: "failed" };
  }
  return {
    id: row.id,
    installerId: row.installer_id,
    publicToken: row.public_token,
    status: row.status,
    source: row.source,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    address: row.address,
    lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
    lng: row.lng === null || row.lng === undefined ? null : Number(row.lng),
    selections: row.selections,
    estimate: row.estimate ?? null,
    photos: Array.isArray(row.photos) ? row.photos : [],
    previews,
    measurement: row.measurement ?? null,
    quote: row.quote ?? null,
    booking: row.booking ?? null,
    notes: row.notes,
    crm: row.crm ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function leadByToken(token: string): Promise<Lead | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await sql()`SELECT * FROM leads WHERE public_token = ${token}`;
  return rows.length ? toLead(rows[0]) : null;
}

export async function leadById(id: string): Promise<Lead | null> {
  const rows = await sql()`SELECT * FROM leads WHERE id = ${id}`;
  return rows.length ? toLead(rows[0]) : null;
}

export const fileUrl = (lead: Lead, name: string, withToken: boolean) =>
  `/api/file/${lead.id}/${name}${withToken ? `?t=${lead.publicToken}` : ""}`;

function previewUrls(lead: Lead, withToken: boolean) {
  const colors: Record<string, string | null> = {};
  for (const color of COLORS) {
    const entry = lead.previews.colors[color];
    colors[color] = entry?.status === "ready" && entry.file ? fileUrl(lead, entry.file, withToken) : null;
  }
  return colors;
}

/** The homeowner's view: reached by the unguessable link, shows only their own request. */
export function customerView(lead: Lead, installer: Installer) {
  const mode = installer.settings.priceMode;
  // A custom request has no standard price, so nothing is shown until the installer quotes it.
  const showEstimate = mode !== "hidden" && lead.estimate !== null && lead.selections.plan !== "other";
  // First-time setups: the same job next year, without buying the lights again.
  const later = showEstimate && lead.selections.plan === "full" ? computeEstimate({ ...lead.selections, plan: "installTakedown" }, installer.settings) : null;
  return {
    installer: publicInstaller(installer),
    lead: {
      status: lead.status,
      firstName: lead.customerName.split(/\s+/)[0] || "",
      address: lead.address,
      lat: lead.lat,
      lng: lead.lng,
      selections: lead.selections,
      estimate: showEstimate ? { low: lead.estimate!.low, high: lead.estimate!.high } : null,
      /** How the estimate is made up, so the customer sees what each part costs before the exact quote. */
      nextYear: later && later.high < lead.estimate!.high ? { low: later.low, high: later.high } : null,
      breakdown: showEstimate ? estimateBreakdown(lead.selections, installer.settings, lead.estimate!) : [],
      photos: lead.photos.map((name) => fileUrl(lead, name, true)),
      previews: {
        status: lead.previews.status,
        regensLeft: Math.max(0, MAX_CUSTOMER_REGENS - lead.previews.regen),
        colors: previewUrls(lead, true),
        /** Colours being made right now, and colours that can still be asked for with a tap. */
        making: COLORS.filter((color) => lead.previews.colors[color]?.status === "pending"),
        available: COLORS.filter((color) => canAddColor(lead, installer, color)),
      },
      quote: lead.quote,
      booking: lead.booking,
    },
  };
}

/** The installer's and admin's view: everything on the lead. */
export function staffView(lead: Lead, installer: Installer) {
  return {
    ...lead,
    publicToken: undefined,
    customerLink: `/r/${lead.publicToken}`,
    photoUrls: lead.photos.map((name) => fileUrl(lead, name, false)),
    previewUrls: previewUrls(lead, false),
    suggestedItems: suggestedItems(lead.selections, installer.settings, lead.measurement?.feet),
    installer: { id: installer.id, companyName: installer.companyName, slug: installer.slug },
  };
}

export function listView(row: any) {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    address: row.address,
    service: row.selections?.service ?? "",
    estimate: row.estimate ? { low: row.estimate.low, high: row.estimate.high } : null,
    quoteTotal: row.quote?.total ?? null,
    bookingDate: row.booking?.date ?? null,
    hasPhotos: Array.isArray(row.photos) && row.photos.length > 0,
    createdAt: new Date(row.created_at).toISOString(),
    installerId: row.installer_id,
    installerName: row.company_name,
  };
}

/** Payload sent to webhooks. Links are absolute so a CRM can store them. */
export function webhookPayload(lead: Lead, installer: Installer, origin: string) {
  return {
    leadId: lead.id,
    status: lead.status,
    source: lead.source,
    installer: { id: installer.id, slug: installer.slug, companyName: installer.companyName },
    customer: { name: lead.customerName, email: lead.customerEmail, phone: lead.customerPhone },
    address: lead.address,
    selections: lead.selections,
    estimate: lead.estimate,
    quote: lead.quote,
    booking: lead.booking,
    customerUrl: `${origin}/r/${lead.publicToken}`,
    dashboardUrl: `${origin}/app#lead=${lead.id}`,
  };
}

/** Best-effort address lookup, used when a lead arrives without coordinates. */
export async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  if (address.length < 6) return null;
  try {
    const res = await fetch(`https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const coords = data?.features?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || typeof coords[0] !== "number" || typeof coords[1] !== "number") return null;
    return { lat: coords[1], lng: coords[0] };
  } catch {
    return null;
  }
}

export interface NewLead {
  source: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  lat: number | null;
  lng: number | null;
  selections: Selections;
  photos: ImageFile[];
  bookingDate?: string;
  notes?: string;
  ipHash?: string;
}

export async function createLead(installer: Installer, input: NewLead, origin: string): Promise<Lead> {
  const id = newId();
  const token = newToken(24);
  let { lat, lng } = input;
  if (lat === null || lng === null) {
    const found = await geocode(input.address);
    lat = found?.lat ?? null;
    lng = found?.lng ?? null;
  }
  const estimate = computeEstimate(input.selections, installer.settings);

  // "Instant" mode: the estimate is the quote, so the homeowner can book straight away.
  let quote: Quote | null = null;
  let status = "new";
  if (installer.settings.priceMode === "instant" && input.source === "quiz" && input.selections.plan !== "other") {
    const items = suggestedItems(input.selections, installer.settings);
    const subtotal = items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
    const minimum = installer.settings.pricing.minimumJob;
    if (subtotal < minimum) items.push({ label: "Minimum service charge", qty: 1, unit: "", unitPrice: Math.round((minimum - subtotal) * 100) / 100 });
    quote = buildQuote(items, [], "", true, minimum);
    status = "quoted";
  }
  let booking: Lead["booking"] = null;
  if (input.bookingDate) {
    booking = { date: input.bookingDate, acceptedAt: new Date().toISOString() };
    status = "booked";
  }

  const photoNames = input.photos.map((photo, index) => `photo-${index}.${photo.ext}`);
  await Promise.all(input.photos.map((photo, index) => saveFile(id, photoNames[index], photo.bytes, photo.mime)));

  await sql()`
    INSERT INTO leads (id, installer_id, public_token, status, source, customer_name, customer_email, customer_phone,
                       address, lat, lng, selections, estimate, photos, previews, quote, booking, notes, ip_hash)
    VALUES (${id}, ${installer.id}, ${token}, ${status}, ${input.source}, ${input.name}, ${input.email}, ${input.phone},
            ${input.address}, ${lat}, ${lng}, ${j(input.selections)}::jsonb, ${j(estimate)}::jsonb, ${j(photoNames)}::jsonb,
            ${j({ status: "none", regen: 0, colors: {} })}::jsonb, ${j(quote)}::jsonb, ${j(booking)}::jsonb,
            ${input.notes ?? ""}, ${input.ipHash ?? ""})`;

  if (photoNames.length && installer.settings.aiPreviews && (await previewSource(installer)) !== "none") {
    await startPreviews(id, 0, origin, [input.selections.color]);
  }
  return (await leadById(id))!;
}

/** Ask the background function to make these colours for this run. Throws if it could not be reached. */
async function fireBackground(origin: string, leadId: string, run: string, colors: Color[]): Promise<void> {
  const res = await fetch(`${origin}/bg/previews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leadId, run, colors, sig: await sign(`previews:${leadId}:${run}:${colors.join(",")}`) }),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status >= 400) throw new Error(`background function answered ${res.status}`);
}

/** Start a fresh set of previews: everything made before is dropped and only `colors` are made now. */
export async function startPreviews(leadId: string, regen: number, origin: string, colors: Color[]): Promise<void> {
  const run = newToken(9);
  const state: PreviewState = { status: "pending", run, regen, startedAt: new Date().toISOString(), colors: {} };
  await sql()`UPDATE leads SET previews = ${j(state)}::jsonb, updated_at = now() WHERE id = ${leadId}`;
  try {
    await fireBackground(origin, leadId, run, colors);
  } catch (err) {
    console.error("Could not start preview generation:", (err as Error).message);
    await sql()`
      UPDATE leads SET previews = jsonb_set(previews, '{status}', '"failed"'::jsonb), updated_at = now()
      WHERE id = ${leadId} AND previews->>'run' = ${run}`;
  }
}

/** Whether one more colour can be made for this lead right now. */
export function canAddColor(lead: Lead, installer: Installer, color: Color): boolean {
  if (!lead.photos.length || !installer.settings.aiPreviews || lead.previews.status !== "ready" || !lead.previews.run) return false;
  const entry = lead.previews.colors[color];
  if (!entry) return true;
  return entry.status === "failed" && (entry.tries ?? 1) < MAX_COLOR_TRIES;
}

/** Make one more colour alongside the ones already there. The caller checks `canAddColor` first. */
export async function addPreviewColor(lead: Lead, color: Color, origin: string): Promise<void> {
  const run = lead.previews.run!;
  const entry: PreviewColor = { status: "pending", startedAt: new Date().toISOString(), tries: (lead.previews.colors[color]?.tries ?? 0) + 1 };
  const setColor = (value: PreviewColor) => sql()`
    UPDATE leads SET previews = jsonb_set(previews, ARRAY['colors', ${color}]::text[], ${j(value)}::jsonb, true), updated_at = now()
    WHERE id = ${lead.id} AND previews->>'run' = ${run}`;
  await setColor(entry);
  try {
    await fireBackground(origin, lead.id, run, [color]);
  } catch (err) {
    console.error("Could not start preview generation:", (err as Error).message);
    await setColor({ ...entry, status: "failed" });
  }
}

export async function deleteLead(leadId: string): Promise<void> {
  await sql()`DELETE FROM leads WHERE id = ${leadId}`;
  await deleteLeadFiles(leadId);
}

const FEET_PER_METRE = 3.28084;

function haversineMetres(a: [number, number], b: [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Validate traced roofline segments and compute their total length in feet on the server. */
export function cleanMeasurement(input: any): Lead["measurement"] {
  if (!input || !Array.isArray(input.lines)) return null;
  const lines: [number, number][][] = [];
  for (const rawLine of input.lines.slice(0, 60)) {
    if (!Array.isArray(rawLine)) continue;
    const line: [number, number][] = [];
    for (const point of rawLine.slice(0, 300)) {
      if (!Array.isArray(point)) continue;
      const lat = Number(point[0]);
      const lng = Number(point[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) line.push([lat, lng]);
    }
    if (line.length >= 2) lines.push(line);
  }
  let metres = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) metres += haversineMetres(line[i - 1], line[i]);
  }
  return { lines, feet: Math.round(metres * FEET_PER_METRE) };
}
