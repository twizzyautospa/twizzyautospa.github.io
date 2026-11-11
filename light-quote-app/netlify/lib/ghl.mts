import { env } from "./util.mts";

/**
 * Thin client for the GoHighLevel (LeadConnector) API.
 * Needs GHL_TOKEN and GHL_LOCATION_ID. GHL_API_BASE overrides the host for local testing.
 */
const API_VERSION = "2021-07-28";

export const ghlReady = () => env("GHL_TOKEN").length > 0 && env("GHL_LOCATION_ID").length > 0;

const base = () => (env("GHL_API_BASE") || "https://services.leadconnectorhq.com").replace(/\/+$/, "");
const location = () => env("GHL_LOCATION_ID");

export class GhlError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base() + path, {
    method,
    headers: {
      authorization: `Bearer ${env("GHL_TOKEN")}`,
      version: API_VERSION,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const detail = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
    throw new GhlError(res.status, `CRM answered ${res.status}${detail ? `: ${String(detail).slice(0, 140)}` : ""}`);
  }
  return data;
}

/** North American numbers typed without a country code get +1; anything else is passed through with its digits. */
export function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  if (phone.trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export interface ContactInput {
  name: string;
  email: string;
  phone: string;
  address: string;
}

/** Create the contact, or return the existing one that matches by phone or email. */
export async function upsertContact(input: ContactInput): Promise<string> {
  const [firstName, ...rest] = input.name.trim().split(/\s+/);
  const body: Record<string, unknown> = {
    locationId: location(),
    firstName: firstName || input.name,
    lastName: rest.join(" "),
    name: input.name,
    source: "Lumiquote",
    tags: ["lumiquote"],
  };
  if (input.email) body.email = input.email;
  if (input.phone) body.phone = toE164(input.phone);
  if (input.address) body.address1 = input.address;
  const data = await request("POST", "/contacts/upsert", body);
  const id = data?.contact?.id;
  if (!id) throw new GhlError(502, "CRM did not return a contact");
  return id;
}

export interface Opportunity {
  id: string;
  name: string;
  contactId: string;
  pipelineStageId: string;
  monetaryValue: number;
  lastStageChangeAt: string;
  contact: { name: string; email: string; phone: string };
}

function toOpportunity(raw: any): Opportunity {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ""),
    contactId: String(raw.contactId ?? raw.contact?.id ?? ""),
    pipelineStageId: String(raw.pipelineStageId ?? ""),
    monetaryValue: Number(raw.monetaryValue) || 0,
    lastStageChangeAt: String(raw.lastStageChangeAt ?? raw.updatedAt ?? raw.createdAt ?? ""),
    contact: {
      name: String(raw.contact?.name ?? raw.name ?? ""),
      email: String(raw.contact?.email ?? ""),
      phone: String(raw.contact?.phone ?? ""),
    },
  };
}

const searchPath = (pipelineId: string, extra: string) =>
  `/opportunities/search?location_id=${encodeURIComponent(location())}&pipeline_id=${encodeURIComponent(pipelineId)}${extra}`;

export async function findOpportunity(pipelineId: string, contactId: string): Promise<Opportunity | null> {
  const data = await request("GET", searchPath(pipelineId, `&contact_id=${encodeURIComponent(contactId)}&limit=1`));
  const first = data?.opportunities?.[0];
  return first ? toOpportunity(first) : null;
}

/** Every opportunity in a pipeline, read page by page. */
export async function listOpportunities(pipelineId: string, maxPages = 30): Promise<Opportunity[]> {
  const all: Opportunity[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await request("GET", searchPath(pipelineId, `&limit=100&page=${page}`));
    const batch: any[] = data?.opportunities ?? [];
    all.push(...batch.map(toOpportunity));
    if (batch.length < 100) break;
  }
  return all;
}

export async function createOpportunity(input: {
  pipelineId: string;
  stageId: string;
  contactId: string;
  name: string;
  value: number;
}): Promise<string> {
  const data = await request("POST", "/opportunities/", {
    locationId: location(),
    pipelineId: input.pipelineId,
    pipelineStageId: input.stageId,
    contactId: input.contactId,
    name: input.name,
    status: "open",
    monetaryValue: Math.max(0, Math.round(input.value)),
    source: "Lumiquote",
  });
  const id = data?.opportunity?.id;
  if (!id) throw new GhlError(502, "CRM did not return an opportunity");
  return id;
}

export async function updateOpportunity(id: string, change: { stageId?: string; value?: number }): Promise<void> {
  const body: Record<string, unknown> = {};
  if (change.stageId) body.pipelineStageId = change.stageId;
  if (change.value !== undefined) body.monetaryValue = Math.max(0, Math.round(change.value));
  if (!Object.keys(body).length) return;
  await request("PUT", `/opportunities/${encodeURIComponent(id)}`, body);
}

export async function addNote(contactId: string, body: string): Promise<void> {
  await request("POST", `/contacts/${encodeURIComponent(contactId)}/notes`, { body: body.slice(0, 4000) });
}

export async function getContactAddress(contactId: string): Promise<string> {
  const data = await request("GET", `/contacts/${encodeURIComponent(contactId)}`);
  const c = data?.contact ?? {};
  return [c.address1, c.city, c.state, c.postalCode].filter(Boolean).join(", ");
}
