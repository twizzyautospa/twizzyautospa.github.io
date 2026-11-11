import { getDatabase } from "@netlify/database";

let cached: ReturnType<typeof getDatabase> | null = null;

/** Tagged-template SQL client. Values are always sent as parameters. */
export function sql() {
  if (!cached) cached = getDatabase();
  return cached.sql;
}

/** Stringify a value for a `::jsonb` parameter. */
export const j = (value: unknown) => JSON.stringify(value ?? null);

export async function getSetting<T>(key: string): Promise<T | null> {
  const rows = await sql()`SELECT value FROM app_settings WHERE key = ${key}`;
  return rows.length ? (rows[0].value as T) : null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await sql()`
    INSERT INTO app_settings (key, value) VALUES (${key}, ${j(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}
