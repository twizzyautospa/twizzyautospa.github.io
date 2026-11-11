import type { Config } from "@netlify/functions";
import { pullAll } from "../lib/crm.mts";
import { sql } from "../lib/db.mts";
import { toInstaller } from "../lib/leads.mts";

/**
 * Every 15 minutes: bring jobs that were booked, completed or lost in the CRM into the dashboards.
 */
export default async () => {
  const rows = await sql()`SELECT * FROM installers WHERE crm IS NOT NULL AND status = 'active'`;
  const results = await pullAll(rows.map(toInstaller));
  for (const r of results) {
    console.log(`CRM pull ${r.installer}: checked ${r.checked}, updated ${r.updated}, imported ${r.imported}${r.error ? `, error: ${r.error}` : ""}`);
  }
};

export const config: Config = { schedule: "*/15 * * * *" };
