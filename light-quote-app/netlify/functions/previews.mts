import type { Config } from "@netlify/functions";
import { generatePreview } from "../lib/ai.mts";
import { safeEqual, sign } from "../lib/auth.mts";
import { j, sql } from "../lib/db.mts";
import { readFile, saveFile, sniffImage } from "../lib/files.mts";
import { leadById } from "../lib/leads.mts";
import { COLORS } from "../lib/pricing.mts";

/**
 * Background job: makes one lighting preview per colour for a lead.
 * Only the API can start it, because the request must carry a signature made with the server secret.
 */
export default async (req: Request) => {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return;
  }
  const leadId = String(body?.leadId ?? "");
  const run = String(body?.run ?? "");
  const sig = String(body?.sig ?? "");
  if (!leadId || !run || !safeEqual(sig, await sign(`previews:${leadId}:${run}`))) {
    console.warn("Rejected unsigned preview request");
    return;
  }

  const lead = await leadById(leadId);
  // A newer run replaces this one if the customer changed their options in the meantime.
  if (!lead || lead.previews.run !== run || !lead.photos.length) return;

  const source = await readFile(leadId, lead.photos[0]);
  if (!source) {
    await finish(leadId, run, "failed");
    return;
  }
  const photo = { bytes: Buffer.from(source.bytes), mime: source.mime };

  const results = await Promise.all(
    COLORS.map(async (color) => {
      try {
        const image = await generatePreview(photo, lead.selections, color);
        const kind = sniffImage(image.bytes);
        if (!kind) throw new Error("Model returned something that is not an image");
        const name = `preview-${color}-${lead.previews.regen}-${run.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}.${kind.ext}`;
        await saveFile(leadId, name, image.bytes, kind.mime);
        await setColor(leadId, run, color, { status: "ready", file: name });
        return true;
      } catch (err) {
        console.error(`Preview ${color} failed for lead ${leadId}:`, (err as Error).message);
        await setColor(leadId, run, color, { status: "failed" });
        return false;
      }
    }),
  );
  await finish(leadId, run, results.some(Boolean) ? "ready" : "failed");
};

async function setColor(leadId: string, run: string, color: string, value: unknown): Promise<void> {
  await sql()`
    UPDATE leads SET previews = jsonb_set(previews, ARRAY['colors', ${color}]::text[], ${j(value)}::jsonb, true), updated_at = now()
    WHERE id = ${leadId} AND previews->>'run' = ${run}`;
}

async function finish(leadId: string, run: string, status: "ready" | "failed"): Promise<void> {
  await sql()`
    UPDATE leads SET previews = jsonb_set(previews, '{status}', ${j(status)}::jsonb, true), updated_at = now()
    WHERE id = ${leadId} AND previews->>'run' = ${run}`;
}

export const config: Config = { background: true, path: "/bg/previews" };
