import { getSetting, j, setSetting, sql } from "./db.mts";
import {
  addNote,
  addTags,
  createContactField,
  createOpportunity,
  findOpportunity,
  getContactAddress,
  ghlReady,
  listContactFields,
  listOpportunities,
  removeTags,
  setContactFields,
  updateOpportunity,
  upsertContact,
} from "./ghl.mts";
import { geocode, type Installer, type Lead } from "./leads.mts";
import { buildQuote, normalizeSelections } from "./pricing.mts";
import { newId, newToken } from "./util.mts";
import { FOLLOW_UP_TAG, type CrmConfig, type LeadCrm } from "./crm-config.mts";

export { cleanCrmConfig, FOLLOW_UP_TAG, suggestStages, type CrmConfig, type LeadCrm } from "./crm-config.mts";

/**
 * Two-way sync between an installer's leads and their CRM pipeline.
 *
 * Out: a new request creates (or links to) a contact and an opportunity; quotes, bookings and status changes
 *      move the opportunity to the matching stage and set its value.
 * In:  on a schedule, opportunities moved to the booked, completed or lost stage in the CRM update the linked
 *      lead, and jobs booked in the CRM that started elsewhere are added to the dashboard.
 */
export const crmActive = (installer: Installer): installer is Installer & { crm: CrmConfig } =>
  installer.crm !== null && ghlReady();

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function requestNote(lead: Lead, origin: string): string {
  const s = lead.selections;
  const wants = { roofline: "Roofline", trees: "Trees and shrubs", full: "Full house" }[s.service];
  const needs = {
    full: "Lights supplied, installed and taken down",
    installTakedown: "Installation and takedown (customer has lights)",
    install: "Installation only (customer has lights)",
    other: `Custom request: ${s.planNote || "see notes"}`,
  }[s.plan];
  const lines = [`Lumiquote request: ${wants}.`, `Needs: ${needs}.`];
  if (lead.address) lines.push(`Address: ${lead.address}`);
  if (lead.estimate) lines.push(`Estimate shown: ${usd(lead.estimate.low)} to ${usd(lead.estimate.high)}`);
  if (s.notes) lines.push(`Customer note: ${s.notes}`);
  lines.push(`Open in Lumiquote: ${origin}/app#lead=${lead.id}`);
  return lines.join("\n");
}

/** Which CRM stage a lead's current status belongs in. "new" is only used when the opportunity is first created. */
function stageFor(status: string, config: CrmConfig): string | undefined {
  if (status === "quoted") return config.stages.quoted;
  if (status === "booked") return config.stages.booked;
  if (status === "completed") return config.stages.completed;
  if (status === "declined" || status === "lost") return config.stages.lost;
  return undefined;
}

/**
 * Contact fields a reminder message can use: {{contact.lumiquote_quote_link}}, {{contact.lumiquote_quote_total}}
 * and {{contact.lumiquote_company}}. Created in the CRM account the first time they are needed.
 */
const QUOTE_FIELDS = { link: "Lumiquote quote link", total: "Lumiquote quote total", company: "Lumiquote company" } as const;
type QuoteFieldIds = Record<keyof typeof QUOTE_FIELDS, string>;

async function quoteFieldIds(): Promise<QuoteFieldIds> {
  const saved = await getSetting<QuoteFieldIds>("crmQuoteFields");
  if (saved?.link && saved.total && saved.company) return saved;
  const existing = await listContactFields();
  const ids = {} as QuoteFieldIds;
  for (const key of Object.keys(QUOTE_FIELDS) as (keyof typeof QUOTE_FIELDS)[]) {
    const name = QUOTE_FIELDS[key];
    ids[key] = existing.find((field) => field.name.toLowerCase() === name.toLowerCase())?.id ?? (await createContactField(name));
  }
  await setSetting("crmQuoteFields", ids);
  return ids;
}

/** Put the quote's link, total and the installer's name on the contact, for the reminder message to use. */
async function saveQuoteFields(contactId: string, installer: Installer, lead: Lead, origin: string): Promise<void> {
  if (!lead.quote) return;
  const ids = await quoteFieldIds();
  await setContactFields(contactId, [
    { id: ids.link, value: `${origin}/r/${lead.publicToken}` },
    { id: ids.total, value: usd(lead.quote.total) },
    { id: ids.company, value: installer.companyName },
  ]);
}

export type CrmEvent = "lead.created" | "quote.sent" | "quote.accepted" | "quote.declined" | "status.changed";

/** Push one lead's current state to the CRM. Never throws: the result, or the error, is saved on the lead. */
export async function pushLeadToCrm(installer: Installer, lead: Lead, event: CrmEvent, origin: string): Promise<void> {
  if (!crmActive(installer)) return;
  const config = installer.crm;
  const crm: LeadCrm = { ...(lead.crm ?? {}) };
  try {
    if (!crm.opportunityId) {
      if (!lead.customerEmail && !lead.customerPhone) throw new Error("No phone or email to match a CRM contact");
      const contactId =
        crm.contactId ??
        (await upsertContact({ name: lead.customerName, email: lead.customerEmail, phone: lead.customerPhone, address: lead.address }));
      crm.contactId = contactId;
      const existing = await findOpportunity(config.pipelineId, contactId);
      if (existing) {
        crm.opportunityId = existing.id;
        crm.linkedExisting = true;
      } else {
        crm.opportunityId = await createOpportunity({
          pipelineId: config.pipelineId,
          stageId: config.stages.new,
          contactId,
          name: `${lead.customerName} - Holiday lighting`,
          value: lead.quote?.total ?? lead.estimate?.mid ?? 0,
        });
      }
      await addNote(contactId, requestNote(lead, origin)).catch((err) => console.warn("CRM note failed:", err.message));
    }

    const stageId = stageFor(lead.status, config);
    const value = lead.quote?.total;
    if (stageId || value !== undefined) await updateOpportunity(crm.opportunityId, { stageId, value });

    if (crm.contactId && lead.quote && (event === "quote.sent" || event === "lead.created")) {
      await saveQuoteFields(crm.contactId, installer, lead, origin).catch((err) => console.warn("CRM quote fields failed:", err.message));
    }
    // The customer answered, the job moved on, or a new quote restarts the clock: take the reminder tag off.
    if (crm.contactId && crm.followUpAt && (lead.status !== "quoted" || event === "quote.sent")) {
      try {
        await removeTags(crm.contactId, [FOLLOW_UP_TAG]);
        delete crm.followUpAt;
      } catch (err) {
        // Left in place for the scheduled job to retry; a stuck tag must not mark the whole lead as unsynced.
        console.warn(`CRM follow-up tag not removed for lead ${lead.id}:`, (err as Error).message);
      }
    }
    if (crm.contactId && event === "quote.sent" && lead.quote) {
      await addNote(crm.contactId, `Quote sent through Lumiquote: ${usd(lead.quote.total)}.\nCustomer page: ${origin}/r/${lead.publicToken}`).catch(() => {});
    }
    if (crm.contactId && event === "quote.accepted" && lead.quote) {
      const when = lead.booking?.date ? ` Install date: ${lead.booking.date}.` : "";
      await addNote(crm.contactId, `Customer accepted the ${usd(lead.quote.total)} quote in Lumiquote.${when}`).catch(() => {});
    }
    delete crm.error;
  } catch (err) {
    crm.error = String((err as Error).message || err).slice(0, 200);
    console.error(`CRM push failed for lead ${lead.id}:`, crm.error);
  }
  crm.syncedAt = new Date().toISOString();
  await sql()`UPDATE leads SET crm = ${j(crm)}::jsonb WHERE id = ${lead.id}`;
}

const RANK: Record<string, number> = { new: 0, quoted: 1, booked: 2, completed: 3 };

/** A CRM stage change wins when it moves the job forward, closes it as lost, or reopens a lost one. */
function shouldApply(current: string, target: string): boolean {
  if (current === target) return false;
  if (target === "lost") return current !== "declined";
  if (current === "lost" || current === "declined") return true;
  return (RANK[target] ?? 0) > (RANK[current] ?? 0);
}

export interface PullResult {
  installer: string;
  checked: number;
  updated: number;
  imported: number;
  /** Quotes that had gone unanswered and were tagged for a reminder on this run. */
  followedUp: number;
  error?: string;
}

/** Read the installer's pipeline and bring booked, completed and lost jobs into the dashboard. */
export async function pullFromCrm(installer: Installer): Promise<PullResult> {
  const result: PullResult = { installer: installer.companyName, checked: 0, updated: 0, imported: 0, followedUp: 0 };
  if (!crmActive(installer)) return result;
  const config = installer.crm;
  try {
    const opportunities = await listOpportunities(config.pipelineId);
    result.checked = opportunities.length;
    const rows = await sql()`
      SELECT id, status, crm->>'opportunityId' AS opportunity_id FROM leads
      WHERE installer_id = ${installer.id} AND crm->>'opportunityId' IS NOT NULL`;
    const linked = new Map<string, { id: string; status: string }>(rows.map((r: any) => [r.opportunity_id, { id: r.id, status: r.status }]));
    const statusByStage: Record<string, string> = {
      [config.stages.booked]: "booked",
      [config.stages.completed]: "completed",
      [config.stages.lost]: "lost",
    };
    const since = Date.parse(config.since);

    for (const opp of opportunities) {
      const target = statusByStage[opp.pipelineStageId];
      if (!target) continue;
      const lead = linked.get(opp.id);
      if (lead) {
        if (!shouldApply(lead.status, target)) continue;
        await sql()`UPDATE leads SET status = ${target}, updated_at = now() WHERE id = ${lead.id}`;
        result.updated += 1;
        continue;
      }
      const changed = Date.parse(opp.lastStageChangeAt);
      if (!config.importBooked || target === "lost" || !(changed >= since)) continue;
      await importBookedJob(installer, opp, target);
      result.imported += 1;
    }
  } catch (err) {
    result.error = String((err as Error).message || err).slice(0, 200);
    console.error(`CRM pull failed for ${installer.companyName}:`, result.error);
  }
  return result;
}

async function importBookedJob(installer: Installer, opp: Awaited<ReturnType<typeof listOpportunities>>[number], status: string): Promise<void> {
  const address = opp.contactId ? await getContactAddress(opp.contactId).catch(() => "") : "";
  const spot = address ? await geocode(address) : null;
  const quote =
    opp.monetaryValue > 0
      ? buildQuote([{ label: "Booked in LeadThru portal", qty: 1, unit: "", unitPrice: opp.monetaryValue }], [], "")
      : null;
  const crm: LeadCrm = { contactId: opp.contactId, opportunityId: opp.id, imported: true, syncedAt: new Date().toISOString() };
  const notes = "Booked in your LeadThru portal. The appointment date and details are on the portal calendar.";
  await sql()`
    INSERT INTO leads (id, installer_id, public_token, status, source, customer_name, customer_email, customer_phone,
                       address, lat, lng, selections, estimate, photos, previews, quote, booking, notes, crm)
    VALUES (${newId()}, ${installer.id}, ${newToken(24)}, ${status}, 'crm', ${opp.contact.name || opp.name}, ${opp.contact.email.toLowerCase()},
            ${opp.contact.phone}, ${address}, ${spot?.lat ?? null}, ${spot?.lng ?? null}, ${j(normalizeSelections({}))}::jsonb, NULL,
            '[]'::jsonb, ${j({ status: "none", regen: 0, colors: {} })}::jsonb, ${j(quote)}::jsonb, NULL, ${notes}, ${j(crm)}::jsonb)`;
}

/**
 * Tag the contact of every quote that has sat unanswered for the installer's follow-up period, so a CRM workflow
 * can send the reminder. Each quote is chased once. Also takes the tag off contacts whose job has since moved on
 * without passing through a push (booked in the CRM, for example). Returns how many were tagged.
 */
export async function followUpQuotes(installer: Installer): Promise<number> {
  if (!crmActive(installer)) return 0;
  const config = installer.crm;
  const save = (id: string, crm: LeadCrm) => sql()`UPDATE leads SET crm = ${j(crm)}::jsonb WHERE id = ${id}`;

  const stale = await sql()`
    SELECT id, crm FROM leads
    WHERE installer_id = ${installer.id} AND status <> 'quoted' AND crm->>'followUpAt' IS NOT NULL AND crm->>'contactId' IS NOT NULL
    LIMIT 25`;
  for (const row of stale) {
    const crm: LeadCrm = { ...row.crm };
    try {
      await removeTags(crm.contactId!, [FOLLOW_UP_TAG]);
      delete crm.followUpAt;
      await save(row.id, crm);
    } catch (err) {
      console.warn(`CRM follow-up tag not removed for lead ${row.id}:`, (err as Error).message);
    }
  }

  if (!(config.followUpDays > 0)) return 0;
  const due = await sql()`
    SELECT id, crm, quote->>'sentAt' AS sent_at, (quote->>'total')::numeric AS total FROM leads
    WHERE installer_id = ${installer.id} AND status = 'quoted'
      AND crm->>'contactId' IS NOT NULL AND crm->>'followUpAt' IS NULL
      AND quote->>'sentAt' IS NOT NULL
      AND (quote->>'sentAt')::timestamptz <= now() - (${config.followUpDays}::int * interval '1 day')
      AND (quote->>'sentAt')::timestamptz >= ${config.since}::timestamptz
      AND crm->>'followUpFor' IS DISTINCT FROM quote->>'sentAt'
    ORDER BY created_at
    LIMIT 25`;
  let tagged = 0;
  for (const row of due) {
    const crm: LeadCrm = { ...row.crm };
    try {
      await addTags(crm.contactId!, [FOLLOW_UP_TAG]);
      crm.followUpAt = new Date().toISOString();
      crm.followUpFor = row.sent_at;
      await save(row.id, crm);
      tagged += 1;
      const days = `${config.followUpDays} day${config.followUpDays === 1 ? "" : "s"}`;
      await addNote(crm.contactId!, `Lumiquote: the ${usd(Number(row.total))} quote has had no answer for ${days}. Tagged "${FOLLOW_UP_TAG}" for a reminder.`).catch(() => {});
    } catch (err) {
      console.warn(`CRM follow-up tag failed for lead ${row.id}:`, (err as Error).message);
    }
  }
  return tagged;
}

/** Run the inbound sync, then the quote follow-ups, for every installer that has a CRM link. */
export async function pullAll(installers: Installer[]): Promise<PullResult[]> {
  const results: PullResult[] = [];
  for (const installer of installers) {
    if (installer.status !== "active" || !crmActive(installer)) continue;
    const result = await pullFromCrm(installer);
    result.followedUp = await followUpQuotes(installer).catch((err) => {
      console.error(`CRM follow-ups failed for ${installer.companyName}:`, err.message);
      return 0;
    });
    results.push(result);
  }
  return results;
}
