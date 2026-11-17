import type { Config } from "@netlify/functions";
import { pullAll } from "../lib/crm.mts";
import { sql } from "../lib/db.mts";
import { toInstaller } from "../lib/leads.mts";

/**
 * Every 15 minutes: bring jobs that were booked, completed or lost in the CRM into the dashboards, and tag the
 * contacts of quotes that have gone unanswered so a CRM workflow can send a reminder.
 */
export default async () => {
  const rows = await sql()`SELECT * FROM installers WHERE crm IS NOT NULL AND status = 'active'`;
  const results = await pullAll(rows.map(toInstaller));
  for (const r of results) {
    console.log(`CRM pull ${r.installer}: checked ${r.checked}, updated ${r.updated}, imported ${r.imported}, followed up ${r.followedUp}${r.error ? `, error: ${r.error}` : ""}`);
  }
};

export const config: Config = { schedule: "*/15 * * * *" };
