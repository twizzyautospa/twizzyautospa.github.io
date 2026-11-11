import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getSetting, sql } from "./db.mts";
import { env, fail, sha256, toUsername } from "./util.mts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = "lq_session";
const SESSION_DAYS = 14;

export type Session =
  | { role: "admin"; exp: number }
  | { role: "installer"; id: string; exp: number; viaAdmin?: boolean };

export type NewSession = { role: "admin" } | { role: "installer"; id: string; viaAdmin?: boolean };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < 8) fail(400, "Password must be at least 8 characters");
  if (password.length > 200) fail(400, "Password is too long");
  return password;
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

let secretCache: string | null = null;

/** Signing secret: SESSION_SECRET if set, otherwise generated once and kept in the database. */
export async function getSecret(): Promise<string> {
  if (secretCache) return secretCache;
  const fromEnv = env("SESSION_SECRET");
  if (fromEnv.length >= 32) return (secretCache = fromEnv);
  const candidate = randomBytes(48).toString("base64url");
  await sql()`
    INSERT INTO app_settings (key, value) VALUES ('session_secret', ${JSON.stringify(candidate)}::jsonb)
    ON CONFLICT (key) DO NOTHING`;
  const stored = await getSetting<string>("session_secret");
  if (!stored) fail(500, "Could not initialise sessions");
  return (secretCache = stored);
}

export async function sign(value: string): Promise<string> {
  return createHmac("sha256", await getSecret()).update(value).digest("base64url");
}

function isSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

export async function sessionCookie(req: Request, session: NewSession): Promise<string> {
  const payload = { ...session, exp: Date.now() + SESSION_DAYS * 86_400_000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const value = `${body}.${await sign(body)}`;
  const secure = isSecure(req) ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure}`;
}

export function clearCookie(req: Request): string {
  const secure = isSecure(req) ? "; Secure" : "";
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function getSession(req: Request): Promise<Session | null> {
  const header = req.headers.get("cookie") || "";
  const match = header.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const [body, signature] = match.slice(COOKIE.length + 1).split(".");
  if (!body || !signature) return null;
  if (!safeEqual(signature, await sign(body))) return null;
  try {
    const session = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    if (!session.exp || session.exp < Date.now()) return null;
    if (session.role !== "admin" && session.role !== "installer") return null;
    return session;
  } catch {
    return null;
  }
}

/** The platform owner's sign-in name. ADMIN_EMAIL is still read so older set-ups keep working. */
export function adminUsername(): string {
  return toUsername(env("ADMIN_USERNAME") || env("ADMIN_EMAIL"));
}

export function adminConfigured(): boolean {
  return adminUsername().length > 0 && env("ADMIN_PASSWORD").length >= 8;
}

export function isAdminLogin(username: string, password: string): boolean {
  if (!adminConfigured()) return false;
  const nameOk = safeEqual(toUsername(username), adminUsername());
  const passwordOk = safeEqual(password, env("ADMIN_PASSWORD"));
  return nameOk && passwordOk;
}

const MAX_FAILS = 6;
const LOCK_MINUTES = 15;

/** Throws if this login identifier is temporarily locked. */
export async function assertNotLocked(identifier: string): Promise<void> {
  const rows = await sql()`SELECT locked_until FROM login_attempts WHERE identifier = ${identifier}`;
  const until = rows[0]?.locked_until ? new Date(rows[0].locked_until).getTime() : 0;
  if (until > Date.now()) fail(429, "Too many attempts. Try again in a few minutes.");
}

export async function recordLoginFailure(identifier: string): Promise<void> {
  const rows = await sql()`SELECT fails, locked_until FROM login_attempts WHERE identifier = ${identifier}`;
  const previous = rows[0];
  const expired = previous?.locked_until && new Date(previous.locked_until).getTime() < Date.now();
  const fails = previous && !expired ? Number(previous.fails) + 1 : 1;
  const lockedUntil = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
  await sql()`
    INSERT INTO login_attempts (identifier, fails, locked_until)
    VALUES (${identifier}, ${fails}, ${lockedUntil})
    ON CONFLICT (identifier) DO UPDATE SET fails = EXCLUDED.fails, locked_until = EXCLUDED.locked_until`;
}

export async function clearLoginFailures(identifier: string): Promise<void> {
  await sql()`DELETE FROM login_attempts WHERE identifier = ${identifier}`;
}
