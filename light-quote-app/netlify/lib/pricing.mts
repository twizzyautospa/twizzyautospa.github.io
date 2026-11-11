import { int, isEmail, isHexColor, money, num, oneOf, str } from "./util.mts";

export const SERVICES = ["roofline", "trees", "full"] as const;
export const HOME_SIZES = ["small", "medium", "large", "xl"] as const;
export const SCOPES = ["front", "frontSides", "full"] as const;
export const COLORS = ["warm", "cool", "multi"] as const;
export const PRICE_MODES = ["range", "instant", "hidden"] as const;

export type Service = (typeof SERVICES)[number];
export type Color = (typeof COLORS)[number];

export interface Selections {
  service: Service;
  homeSize: (typeof HOME_SIZES)[number];
  stories: 1 | 2 | 3;
  scope: (typeof SCOPES)[number];
  trees: { small: number; medium: number; large: number };
  shrubs: number;
  color: Color;
  notes: string;
}

export interface InstallerSettings {
  brand: { color: string; logo: string; tagline: string };
  priceMode: (typeof PRICE_MODES)[number];
  pricing: {
    rooflinePerFt: number;
    minimumJob: number;
    rangePct: number;
    /** Typical front-facing roofline, in feet, by home size. */
    sizes: { small: number; medium: number; large: number; xl: number };
    /** Multiplier on front roofline feet for how much of the house is lit. */
    scope: { front: number; frontSides: number; full: number };
    storyMultiplier: { 1: number; 2: number; 3: number };
    treeSmall: number;
    treeMedium: number;
    treeLarge: number;
    shrub: number;
  };
  aiPreviews: boolean;
  dailyLeadCap: number;
  webhookUrl: string;
  notifyEmail: string;
}

export const DEFAULT_SETTINGS: InstallerSettings = {
  brand: { color: "#b3202a", logo: "", tagline: "See your home lit up, and get a price, in two minutes." },
  priceMode: "range",
  pricing: {
    rooflinePerFt: 6,
    minimumJob: 350,
    rangePct: 15,
    sizes: { small: 70, medium: 110, large: 160, xl: 220 },
    scope: { front: 1, frontSides: 1.6, full: 2.2 },
    storyMultiplier: { 1: 1, 2: 1.2, 3: 1.4 },
    treeSmall: 60,
    treeMedium: 140,
    treeLarge: 300,
    shrub: 20,
  },
  aiPreviews: true,
  dailyLeadCap: 40,
  webhookUrl: "",
  notifyEmail: "",
};

const MAX_LOGO_CHARS = 220_000; // about 160 KB of image as a data URL

function cleanLogo(value: unknown, fallback: string): string {
  if (value === "") return "";
  if (typeof value !== "string") return fallback;
  if (value.length > MAX_LOGO_CHARS) return fallback;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : fallback;
}

/** Only https URLs to public hostnames are accepted, so a webhook cannot be pointed at internal services. */
export function cleanWebhookUrl(value: unknown): string {
  const raw = str(value, 500);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const privateHost =
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
      host.includes(":") ||
      !host.includes(".");
    if (url.protocol !== "https:" || privateHost || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Merge stored or submitted settings over the defaults, clamping every value to a sane range. */
export function normalizeSettings(input: any, base: InstallerSettings = DEFAULT_SETTINGS): InstallerSettings {
  const src = input && typeof input === "object" ? input : {};
  const brand = src.brand ?? {};
  const p = src.pricing ?? {};
  const b = base.pricing;
  const notifyEmail = str(src.notifyEmail ?? base.notifyEmail, 200).toLowerCase();
  return {
    brand: {
      color: isHexColor(brand.color) ? brand.color.toLowerCase() : base.brand.color,
      logo: cleanLogo(brand.logo, base.brand.logo),
      tagline: typeof brand.tagline === "string" ? str(brand.tagline, 140) : base.brand.tagline,
    },
    priceMode: oneOf(src.priceMode, PRICE_MODES, base.priceMode),
    pricing: {
      rooflinePerFt: num(p.rooflinePerFt, 0, 100, b.rooflinePerFt),
      minimumJob: num(p.minimumJob, 0, 100_000, b.minimumJob),
      rangePct: num(p.rangePct, 0, 50, b.rangePct),
      sizes: {
        small: num(p.sizes?.small, 10, 2000, b.sizes.small),
        medium: num(p.sizes?.medium, 10, 2000, b.sizes.medium),
        large: num(p.sizes?.large, 10, 2000, b.sizes.large),
        xl: num(p.sizes?.xl, 10, 2000, b.sizes.xl),
      },
      scope: {
        front: num(p.scope?.front, 0.5, 5, b.scope.front),
        frontSides: num(p.scope?.frontSides, 0.5, 5, b.scope.frontSides),
        full: num(p.scope?.full, 0.5, 5, b.scope.full),
      },
      storyMultiplier: {
        1: num(p.storyMultiplier?.[1], 0.5, 5, b.storyMultiplier[1]),
        2: num(p.storyMultiplier?.[2], 0.5, 5, b.storyMultiplier[2]),
        3: num(p.storyMultiplier?.[3], 0.5, 5, b.storyMultiplier[3]),
      },
      treeSmall: num(p.treeSmall, 0, 10_000, b.treeSmall),
      treeMedium: num(p.treeMedium, 0, 10_000, b.treeMedium),
      treeLarge: num(p.treeLarge, 0, 10_000, b.treeLarge),
      shrub: num(p.shrub, 0, 10_000, b.shrub),
    },
    aiPreviews: typeof src.aiPreviews === "boolean" ? src.aiPreviews : base.aiPreviews,
    dailyLeadCap: int(src.dailyLeadCap, 1, 1000, base.dailyLeadCap),
    webhookUrl: src.webhookUrl === undefined ? base.webhookUrl : cleanWebhookUrl(src.webhookUrl),
    notifyEmail: notifyEmail === "" || isEmail(notifyEmail) ? notifyEmail : base.notifyEmail,
  };
}

export function normalizeSelections(input: any): Selections {
  const src = input && typeof input === "object" ? input : {};
  const trees = src.trees ?? {};
  return {
    service: oneOf(src.service, SERVICES, "roofline"),
    homeSize: oneOf(src.homeSize, HOME_SIZES, "medium"),
    stories: int(src.stories, 1, 3, 1) as 1 | 2 | 3,
    scope: oneOf(src.scope, SCOPES, "front"),
    trees: {
      small: int(trees.small, 0, 50, 0),
      medium: int(trees.medium, 0, 50, 0),
      large: int(trees.large, 0, 50, 0),
    },
    shrubs: int(src.shrubs, 0, 200, 0),
    color: oneOf(src.color, COLORS, "warm"),
    notes: str(src.notes, 1000),
  };
}

export interface QuoteItem {
  label: string;
  qty: number;
  unit: string;
  unitPrice: number;
}

const wantsRoofline = (s: Selections) => s.service !== "trees";
const wantsTrees = (s: Selections) => s.service !== "roofline";

/** Estimated roofline length in feet from the quiz answers, before the installer measures. */
export function estimateFeet(s: Selections, settings: InstallerSettings): number {
  if (!wantsRoofline(s)) return 0;
  return Math.round(settings.pricing.sizes[s.homeSize] * settings.pricing.scope[s.scope]);
}

/** Line items the installer starts from. `feet` overrides the quiz estimate once the roofline is measured. */
export function suggestedItems(s: Selections, settings: InstallerSettings, feet?: number): QuoteItem[] {
  const p = settings.pricing;
  const items: QuoteItem[] = [];
  if (wantsRoofline(s)) {
    const length = feet && feet > 0 ? Math.round(feet) : estimateFeet(s, settings);
    const storyNote = s.stories > 1 ? `, ${s.stories}-storey` : "";
    items.push({
      label: `Roofline lighting${storyNote}`,
      qty: length,
      unit: "ft",
      unitPrice: money(p.rooflinePerFt * p.storyMultiplier[s.stories]),
    });
  }
  if (wantsTrees(s)) {
    if (s.trees.small) items.push({ label: "Small tree wrap", qty: s.trees.small, unit: "each", unitPrice: p.treeSmall });
    if (s.trees.medium) items.push({ label: "Medium tree wrap", qty: s.trees.medium, unit: "each", unitPrice: p.treeMedium });
    if (s.trees.large) items.push({ label: "Large tree wrap", qty: s.trees.large, unit: "each", unitPrice: p.treeLarge });
    if (s.shrubs) items.push({ label: "Shrub lighting", qty: s.shrubs, unit: "each", unitPrice: p.shrub });
  }
  return items;
}

export const itemsTotal = (items: QuoteItem[]) => money(items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0));

const round25 = (n: number) => Math.round(n / 25) * 25;

export interface Estimate {
  feet: number;
  mid: number;
  low: number;
  high: number;
}

export function computeEstimate(s: Selections, settings: InstallerSettings): Estimate {
  const p = settings.pricing;
  const raw = itemsTotal(suggestedItems(s, settings));
  const mid = Math.max(p.minimumJob, raw);
  const low = Math.max(p.minimumJob, round25(raw * (1 - p.rangePct / 100)));
  const high = Math.max(low, round25(raw * (1 + p.rangePct / 100)));
  return { feet: estimateFeet(s, settings), mid: round25(mid), low, high };
}

export interface Quote {
  items: QuoteItem[];
  total: number;
  dates: string[];
  note: string;
  sentAt: string;
  auto?: boolean;
}

export function cleanItems(input: unknown): QuoteItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 30)
    .map((raw: any) => ({
      label: str(raw?.label, 120),
      qty: num(raw?.qty, 0, 100_000, 0),
      unit: str(raw?.unit, 12),
      unitPrice: num(raw?.unitPrice, -100_000, 100_000, 0),
    }))
    .filter((item) => item.label && item.qty > 0);
}

export function buildQuote(items: QuoteItem[], dates: string[], note: string, auto = false): Quote {
  const total = Math.max(0, itemsTotal(items));
  return {
    items,
    total,
    dates,
    note,
    sentAt: new Date().toISOString(),
    ...(auto ? { auto: true } : {}),
  };
}
