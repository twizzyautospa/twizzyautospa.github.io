import { GoogleGenAI } from "@google/genai";
import type { Color, Selections } from "./pricing.mts";
import { env } from "./util.mts";

/**
 * Lighting previews.
 *
 * Whose AI allowance pays for an image:
 *  - the installer's own Google AI key, when one is saved on their account (billed to them by Google);
 *  - otherwise the platform's: on Netlify, AI Gateway injects GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL, so no
 *    key needs to be set. The owner can switch this fallback off so installers without a key get no previews.
 *
 * PREVIEW_PROVIDER=off disables the platform's allowance; PREVIEW_PROVIDER=mock returns the original photo (local
 * testing). PREVIEW_MODEL overrides the image model. PREVIEW_API_BASE points own-key calls at another host (tests).
 */
export type PreviewProvider = "gemini" | "mock" | "off";

/** The two image models offered, by cost. Google's list prices per 1K image, November 2026. */
export const PREVIEW_MODELS = {
  standard: { id: "gemini-3.1-flash-image", usd: 0.067 },
  economy: { id: "gemini-3.1-flash-lite-image", usd: 0.034 },
} as const;
export type PreviewQuality = keyof typeof PREVIEW_MODELS;

const GOOGLE_API = "https://generativelanguage.googleapis.com";
const ownKeyBase = () => (env("PREVIEW_API_BASE") || GOOGLE_API).replace(/\/+$/, "");

/** The platform's own allowance: what is used when an installer has no key of their own. */
export function previewProvider(): PreviewProvider {
  const forced = env("PREVIEW_PROVIDER").toLowerCase();
  if (forced === "mock" || forced === "off" || forced === "gemini") return forced;
  return env("GEMINI_API_KEY") || env("GOOGLE_GEMINI_BASE_URL") ? "gemini" : "off";
}

/** Google AI keys are 39 characters starting "AIza"; newer ones can be longer. Loose on purpose, checked for real by `checkKey`. */
export const looksLikeKey = (key: string) => /^[A-Za-z0-9_-]{30,120}$/.test(key);

/** Ask Google whether a key is live. Listing models is free, so this costs the installer nothing. */
export async function checkKey(key: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${ownKeyBase()}/v1beta/models?pageSize=1`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true };
    const data: any = await res.json().catch(() => ({}));
    return { ok: false, reason: String(data?.error?.message || `Google answered ${res.status}`).slice(0, 200) };
  } catch (err) {
    return { ok: false, reason: `Could not reach Google (${(err as Error).message})`.slice(0, 200) };
  }
}

const COLOR_TEXT: Record<Color, string> = {
  warm: "warm white (soft golden, about 2700K)",
  cool: "cool bright white (crisp, icy, about 6000K)",
  multi: "multicolour (alternating red, green, blue, yellow and orange)",
};

const ROOF_TEXT: Record<Selections["scope"], string> = {
  front: "along the front-facing roofline only: the eaves, fascia edges and gable peaks that face the camera",
  frontSides: "along the roofline edges on the front and on any visible sides of the house",
  full: "along every visible roofline edge of the house, including all eaves, ridges facing the street and gable peaks",
};

/** The prompt is built only from the customer's selections, so the picture matches what gets quoted. */
export function buildPrompt(selections: Selections, color: Color): string {
  const areas: string[] = [];
  if (selections.service !== "trees") {
    areas.push(`evenly spaced C9-style LED bulbs in clean, straight, professional lines ${ROOF_TEXT[selections.scope]}`);
  }
  if (selections.service !== "roofline") {
    areas.push("mini LED string lights wrapped neatly around the trunks and main branches of the trees and draped over the shrubs in the front yard");
  }
  const forbidden =
    selections.service === "trees"
      ? "Do not put any lights on the house or roofline."
      : selections.service === "roofline"
        ? "Do not put any lights on trees, shrubs, windows, doors, fences or the ground."
        : "Do not put lights on windows, doors, fences or the ground.";
  return [
    "Edit this photograph of a real home to show what professionally installed Christmas lights would look like.",
    "Keep the house, roof shape, windows, doors, driveway, landscaping, camera angle and framing exactly as they are. Do not add, remove or redesign any part of the building or yard.",
    "Change the time of day to early evening dusk with a deep blue sky so the lights glow realistically and cast a soft glow on nearby surfaces. Interior windows may glow faintly.",
    `Add ${COLOR_TEXT[color]} lights: ${areas.join("; and ")}.`,
    forbidden,
    "No inflatables, wreaths, snow, people, vehicles that were not there, text, logos or watermarks. Photorealistic result.",
  ].join(" ");
}

export interface GeneratedImage {
  bytes: Buffer;
  mime: string;
}

export interface PreviewOptions {
  /** The installer's own Google AI key. Empty to use the platform's allowance. */
  apiKey?: string;
  quality?: PreviewQuality;
}

export async function generatePreview(
  photo: { bytes: Buffer; mime: string },
  selections: Selections,
  color: Color,
  options: PreviewOptions = {},
): Promise<GeneratedImage> {
  const provider = previewProvider();
  if (!options.apiKey && provider === "off") throw new Error("Previews are not enabled");
  if (!options.apiKey && provider === "mock") return { bytes: photo.bytes, mime: photo.mime };

  // With the installer's key the call goes straight to Google; the gateway address in the environment is ignored.
  const client = options.apiKey ? new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { baseUrl: ownKeyBase(), apiVersion: "v1beta" } }) : new GoogleGenAI({});
  const response = await client.models.generateContent({
    model: env("PREVIEW_MODEL") || PREVIEW_MODELS[options.quality ?? "standard"].id,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: photo.mime, data: photo.bytes.toString("base64") } },
          { text: buildPrompt(selections, color) },
        ],
      },
    ],
    // No size is set: the default, 1K, is already the smallest and cheapest the models offer.
    config: { responseModalities: ["TEXT", "IMAGE"] },
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((part) => part.inlineData?.data);
  if (!image?.inlineData?.data) {
    const reason = response.candidates?.[0]?.finishReason ?? "no image returned";
    throw new Error(`Preview model returned no image (${reason})`);
  }
  return {
    bytes: Buffer.from(image.inlineData.data, "base64"),
    mime: image.inlineData.mimeType || "image/png",
  };
}
