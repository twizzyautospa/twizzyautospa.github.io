import type { Config } from "@netlify/functions";
import { generatePreview, previewProvider } from "../lib/ai.mts";
import { safeEqual, sign, unseal } from "../lib/auth.mts";
import { j, sql } from "../lib/db.mts";
import { readFile, saveFile, sniffImage } from "../lib/files.mts";
import { countPreview, installerById, leadById, type PreviewColor } from "../lib/leads.mts";
import { getPlatform } from "../lib/platform.mts";
import { COLORS, type Color } from "../lib/pricing.mts";

/**
 * Background job: makes the lighting previews that were asked for. The first run for a lead makes only the
 * customer's chosen colour; each further colour is its own run, started when someone taps it.
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
  const colors: Color[] = (Array.isArray(body?.colors) ? body.colors : []).filter((c: unknown): c is Color => COLORS.includes(c as Color));
  if (!leadId || !run || !colors.length || !safeEqual(sig, await sign(`previews:${leadId}:${run}:${colors.join(",")}`))) {
    console.warn("Rejected unsigned preview request");
    return;
  }

  const lead = await leadById(leadId);
  // A newer run replaces this one if the customer changed their options in the meantime.
  if (!lead || lead.previews.run !== run || !lead.photos.length) return;
  // The first run decides the overall state; adding a colour later leaves the finished ones on screen.
  const first = lead.previews.status === "pending";
  const tries = (color: Color) => lead.previews.colors[color]?.tries ?? 1;
  const failAll = async (reason: string) => {
    for (const color of colors) await setColor(leadId, run, color, { status: "failed", tries: tries(color), error: reason });
    if (first) await finish(leadId, run, "failed", reason);
  };

  const installer = await installerById(lead.installerId);
  const source = await readFile(leadId, lead.photos[0]);
  if (!installer || !source) return failAll("The photo could not be read");

  const platform = await getPlatform();
  const apiKey = platform.ownKeys ? await unseal(installer.previewKey) : "";
  if (!apiKey && ((platform.ownKeys && !platform.previewFallback) || previewProvider() === "off")) {
    return failAll("No Google AI key is saved for this account");
  }
  const photo = { bytes: Buffer.from(source.bytes), mime: source.mime };

  const errors: string[] = [];
  const results = await Promise.all(
    colors.map(async (color) => {
      try {
        const image = await generatePreview(photo, lead.selections, color, { apiKey, quality: platform.previewQuality });
        const kind = sniffImage(image.bytes);
        if (!kind) throw new Error("Model returned something that is not an image");
        const name = `preview-${color}-${lead.previews.regen}-${run.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}.${kind.ext}`;
        await saveFile(leadId, name, image.bytes, kind.mime);
        await setColor(leadId, run, color, { status: "ready", file: name, tries: tries(color) });
        await countPreview(installer.id, !apiKey).catch((err) => console.warn("Preview usage not counted:", err.message));
        return true;
      } catch (err) {
        const reason = readable((err as Error).message);
        errors.push(reason);
        console.error(`Preview ${color} failed for lead ${leadId}:`, reason);
        await setColor(leadId, run, color, { status: "failed", tries: tries(color), error: reason });
        return false;
      }
    }),
  );
  if (first) await finish(leadId, run, results.some(Boolean) ? "ready" : "failed", errors[0]);
};

/** Google's errors arrive as JSON text; keep the human sentence. */
function readable(message: string): string {
  try {
    const parsed = JSON.parse(message);
    return String(parsed?.error?.message ?? message).slice(0, 240);
  } catch {
    return message.slice(0, 240);
  }
}

async function setColor(leadId: string, run: string, color: string, value: PreviewColor): Promise<void> {
  await sql()`
    UPDATE leads SET previews = jsonb_set(previews, ARRAY['colors', ${color}]::text[], ${j(value)}::jsonb, true), updated_at = now()
    WHERE id = ${leadId} AND previews->>'run' = ${run}`;
}

async function finish(leadId: string, run: string, status: "ready" | "failed", error?: string): Promise<void> {
  const patch = status === "failed" && error ? { status, error } : { status };
  await sql()`
    UPDATE leads SET previews = (previews - 'error') || ${j(patch)}::jsonb, updated_at = now()
    WHERE id = ${leadId} AND previews->>'run' = ${run}`;
}

export const config: Config = { background: true, path: "/bg/previews" };
