// Generic key/value app-settings store. Plain text — for SECRETS
// (API keys, passwords) use apiKeysService.ts / credentialsService.ts
// which encrypt at rest. This module is for non-sensitive runtime
// config the user can change from the dashboard.

import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { appSettings } from '../db/schema.js';

export async function getSetting(key: string): Promise<string | undefined> {
  const db = createDbClient();
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key));
  return row?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = createDbClient();
  const [existing] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key));
  if (existing) {
    await db
      .update(appSettings)
      .set({ value, updatedAt: new Date() })
      .where(eq(appSettings.key, key));
  } else {
    await db.insert(appSettings).values({ key, value });
  }
}

export async function deleteSetting(key: string): Promise<boolean> {
  const db = createDbClient();
  const result = await db.delete(appSettings).where(eq(appSettings.key, key));
  const ra = (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
  return ra > 0;
}

export async function listSettings(): Promise<Record<string, string>> {
  const db = createDbClient();
  const rows = await db.select().from(appSettings);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
