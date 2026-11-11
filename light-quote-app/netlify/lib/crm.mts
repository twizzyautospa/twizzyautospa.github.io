import { j, sql } from "./db.mts";
import {
  addNote,
  createOpportunity,
  findOpportunity,
  getContactAddress,
  ghlReady,
  listOpportunities,
  updateOpportunity,
  upsertContact,
} from "./ghl.mts";
import { geocode, type Installer, type Lead } from "./leads.mts";
import { buildQuote, normalizeSelections } from "./pricing.mts";
import { newId, newToken } from "./util.mts";
import type { CrmConfig, LeadCrm } from "./crm-config.mts";

export { cleanCrmConfig, type CrmConfig, type LeadCrm } from "./crm-config.mts";

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
  const lines = [`Lumiquote request: ${wants}.`];
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
  error?: string;
}

/** Read the installer's pipeline and bring booked, completed and lost jobs into the dashboard. */
export async function pullFromCrm(installer: Installer): Promise<PullResult> {
  const result: PullResult = { installer: installer.companyName, checked: 0, updated: 0, imported: 0 };
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

/** Run the inbound sync for every installer that has a CRM link. */
export async function pullAll(installers: Installer[]): Promise<PullResult[]> {
  const results: PullResult[] = [];
  for (const installer of installers) {
    if (installer.status === "active" && crmActive(installer)) results.push(await pullFromCrm(installer));
  }
  return results;
}
