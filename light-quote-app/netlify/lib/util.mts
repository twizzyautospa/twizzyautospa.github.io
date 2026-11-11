import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Read an environment variable in both Netlify's runtime and plain Node. */
export function env(name: string): string {
  const fromNetlify = (globalThis as any).Netlify?.env?.get?.(name);
  return (fromNetlify ?? process.env[name] ?? "").toString();
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export const newId = () => randomUUID();
export const newToken = (bytes = 24) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Parse a JSON body. Requiring the JSON content type also blocks cross-site form posts. */
export async function readJson(req: Request, maxBytes = 5_500_000): Promise<any> {
  const type = req.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) fail(415, "Send JSON");
  const text = await req.text();
  if (text.length > maxBytes) fail(413, "That upload is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    fail(400, "Invalid request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(400, "Invalid request");
  return parsed;
}

export function str(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function num(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function int(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(num(value, min, max, fallback));
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Sign-in names ignore case, spaces and punctuation, so "Bright Home Care" and "brighthomecare" are the same. */
export function toUsername(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 40);
}

export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 200;

export const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);

export const money = (n: number) => Math.round(n * 100) / 100;
