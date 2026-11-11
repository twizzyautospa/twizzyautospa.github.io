import { GoogleGenAI } from "@google/genai";
import type { Color, Selections } from "./pricing.mts";
import { env } from "./util.mts";

/**
 * Lighting previews.
 *
 * On Netlify, AI Gateway injects GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL, so no key needs to be set.
 * Set PREVIEW_PROVIDER=off to disable, or PREVIEW_PROVIDER=mock to return the original photo (local testing).
 * PREVIEW_MODEL overrides the image model.
 */
export type PreviewProvider = "gemini" | "mock" | "off";

const DEFAULT_MODEL = "gemini-3.1-flash-image";

export function previewProvider(): PreviewProvider {
  const forced = env("PREVIEW_PROVIDER").toLowerCase();
  if (forced === "mock" || forced === "off" || forced === "gemini") return forced;
  return env("GEMINI_API_KEY") || env("GOOGLE_GEMINI_BASE_URL") ? "gemini" : "off";
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

export async function generatePreview(
  photo: { bytes: Buffer; mime: string },
  selections: Selections,
  color: Color,
): Promise<GeneratedImage> {
  const provider = previewProvider();
  if (provider === "off") throw new Error("Previews are not enabled");
  if (provider === "mock") return { bytes: photo.bytes, mime: photo.mime };

  const client = new GoogleGenAI({});
  const response = await client.models.generateContent({
    model: env("PREVIEW_MODEL") || DEFAULT_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: photo.mime, data: photo.bytes.toString("base64") } },
          { text: buildPrompt(selections, color) },
        ],
      },
    ],
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
