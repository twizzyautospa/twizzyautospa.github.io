import { sign } from "./auth.mts";
import { j, sql } from "./db.mts";
import { deleteLeadFiles, saveFile, type ImageFile } from "./files.mts";
import { previewProvider } from "./ai.mts";
import {
  buildQuote,
  COLORS,
  computeEstimate,
  normalizeSettings,
  suggestedItems,
  type Estimate,
  type InstallerSettings,
  type Quote,
  type Selections,
} from "./pricing.mts";
import { newId, newToken } from "./util.mts";

export const STATUSES = ["new", "quoted", "booked", "completed", "declined", "lost"] as const;
export const MAX_CUSTOMER_REGENS = 2;
const PREVIEW_STALE_MS = 6 * 60_000;

export interface Installer {
  id: string;
  slug: string;
  companyName: string;
  email: string;
  phone: string;
  status: string;
  settings: InstallerSettings;
  inboundKey: string;
  createdAt: string;
}

export function toInstaller(row: any): Installer {
  return {
    id: row.id,
    slug: row.slug,
    companyName: row.company_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    settings: normalizeSettings(row.settings),
    inboundKey: row.inbound_key,
    createdAt: new Date(row.created_at).toISOString(),
  };
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
  colors: Partial<Record<(typeof COLORS)[number], { status: "ready" | "failed"; file?: string }>>;
}

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
  createdAt: string;
  updatedAt: string;
}

export function toLead(row: any): Lead {
  const previews: PreviewState = { status: "none", regen: 0, colors: {}, ...(row.previews || {}) };
  // A background run that never reported back should not spin forever on the customer's screen.
  if (previews.status === "pending" && previews.startedAt) {
    if (Date.now() - new Date(previews.startedAt).getTime() > PREVIEW_STALE_MS) previews.status = "failed";
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
  return {
    installer: publicInstaller(installer),
    lead: {
      status: lead.status,
      firstName: lead.customerName.split(/\s+/)[0] || "",
      address: lead.address,
      lat: lead.lat,
      lng: lead.lng,
      selections: lead.selections,
      estimate: mode === "hidden" || !lead.estimate ? null : { low: lead.estimate.low, high: lead.estimate.high },
      photos: lead.photos.map((name) => fileUrl(lead, name, true)),
      previews: {
        status: lead.previews.status,
        regensLeft: Math.max(0, MAX_CUSTOMER_REGENS - lead.previews.regen),
        colors: previewUrls(lead, true),
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
  if (installer.settings.priceMode === "instant" && input.source === "quiz") {
    const items = suggestedItems(input.selections, installer.settings);
    const subtotal = items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
    const minimum = installer.settings.pricing.minimumJob;
    if (subtotal < minimum) items.push({ label: "Minimum service charge", qty: 1, unit: "", unitPrice: Math.round((minimum - subtotal) * 100) / 100 });
    quote = buildQuote(items, [], "", true);
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

  if (photoNames.length && installer.settings.aiPreviews && previewProvider() !== "off") {
    await startPreviews(id, 0, origin);
  }
  return (await leadById(id))!;
}

/** Mark previews as pending and hand the work to the background function. */
export async function startPreviews(leadId: string, regen: number, origin: string): Promise<void> {
  const run = newToken(9);
  const state: PreviewState = { status: "pending", run, regen, startedAt: new Date().toISOString(), colors: {} };
  await sql()`UPDATE leads SET previews = ${j(state)}::jsonb, updated_at = now() WHERE id = ${leadId}`;
  try {
    const res = await fetch(`${origin}/bg/previews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leadId, run, sig: await sign(`previews:${leadId}:${run}`) }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status >= 400) throw new Error(`background function answered ${res.status}`);
  } catch (err) {
    console.error("Could not start preview generation:", (err as Error).message);
    await sql()`
      UPDATE leads SET previews = jsonb_set(previews, '{status}', '"failed"'::jsonb), updated_at = now()
      WHERE id = ${leadId} AND previews->>'run' = ${run}`;
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
