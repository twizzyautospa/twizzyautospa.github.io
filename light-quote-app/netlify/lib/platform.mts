import { PREVIEW_MODELS, type PreviewQuality } from "./ai.mts";
import { getSetting, setSetting } from "./db.mts";
import { str } from "./util.mts";

/** Settings the platform owner controls for every installer. */
export interface Platform {
  name: string;
  /** Whether installers may run previews on their own Google AI key. Off: everything runs on the platform's allowance. */
  ownKeys: boolean;
  /** Installers without their own Google AI key get previews on the platform's allowance. Off means they get none. */
  previewFallback: boolean;
  /** Which image model previews use: "standard" looks best, "economy" costs about half. */
  previewQuality: PreviewQuality;
}

export const DEFAULT_PLATFORM: Platform = { name: "Lumiquote", ownKeys: false, previewFallback: true, previewQuality: "standard" };

export async function getPlatform(): Promise<Platform> {
  const saved = (await getSetting<Partial<Platform>>("platform")) ?? {};
  return {
    name: typeof saved.name === "string" && saved.name.length >= 2 ? saved.name : DEFAULT_PLATFORM.name,
    ownKeys: typeof saved.ownKeys === "boolean" ? saved.ownKeys : DEFAULT_PLATFORM.ownKeys,
    previewFallback: typeof saved.previewFallback === "boolean" ? saved.previewFallback : DEFAULT_PLATFORM.previewFallback,
    previewQuality: saved.previewQuality && saved.previewQuality in PREVIEW_MODELS ? saved.previewQuality : DEFAULT_PLATFORM.previewQuality,
  };
}

/** Apply the fields that were sent, keep the rest. Returns null when the name is too short. */
export async function updatePlatform(input: any): Promise<Platform | null> {
  const current = await getPlatform();
  const name = input?.name === undefined ? current.name : str(input.name, 40);
  if (name.length < 2) return null;
  const next: Platform = {
    name,
    ownKeys: typeof input?.ownKeys === "boolean" ? input.ownKeys : current.ownKeys,
    previewFallback: typeof input?.previewFallback === "boolean" ? input.previewFallback : current.previewFallback,
    previewQuality: input?.previewQuality in PREVIEW_MODELS ? input.previewQuality : current.previewQuality,
  };
  await setSetting("platform", next);
  return next;
}
