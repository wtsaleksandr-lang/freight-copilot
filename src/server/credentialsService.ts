import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { carrierCredentials } from '../db/schema.js';
import { getCarrier } from '../carriers/registry.js';
import { encryptSecret, decryptSecret } from './secretsCrypto.js';

export interface CredentialSummary {
  carrierCode: string;
  username: string;
  hasPassword: boolean;
  notes: string | null;
  updatedAt: string;
}

export interface CredentialFull extends CredentialSummary {
  password: string;
}

export interface UpsertCredentialInput {
  carrierCode: string;
  username: string;
  password: string;
  notes?: string | null;
}

export async function listCredentials(): Promise<CredentialSummary[]> {
  const db = createDbClient();
  const rows = await db.select().from(carrierCredentials);
  return rows.map((r) => ({
    carrierCode: r.carrierCode,
    username: r.username,
    hasPassword: !!r.passwordEncrypted,
    notes: r.notes,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function upsertCredential(
  input: UpsertCredentialInput
): Promise<CredentialSummary> {
  // Validate carrier code against the registry so we don't silently store
  // creds for a typo'd carrier.
  const carrier = getCarrier(input.carrierCode);
  if (!input.username.trim()) throw new Error('username is required');
  if (!input.password) throw new Error('password is required');

  const db = createDbClient();
  const passwordEncrypted = await encryptSecret(input.password);
  const now = new Date();

  const [existing] = await db
    .select()
    .from(carrierCredentials)
    .where(eq(carrierCredentials.carrierCode, carrier.code));

  if (existing) {
    await db
      .update(carrierCredentials)
      .set({
        username: input.username,
        passwordEncrypted,
        notes: input.notes ?? null,
        updatedAt: now,
      })
      .where(eq(carrierCredentials.id, existing.id));
  } else {
    await db.insert(carrierCredentials).values({
      carrierCode: carrier.code,
      username: input.username,
      passwordEncrypted,
      notes: input.notes ?? null,
      updatedAt: now,
    });
  }

  return {
    carrierCode: carrier.code,
    username: input.username,
    hasPassword: true,
    notes: input.notes ?? null,
    updatedAt: now.toISOString(),
  };
}

export async function revealCredential(
  carrierCode: string
): Promise<CredentialFull | null> {
  const db = createDbClient();
  const [row] = await db
    .select()
    .from(carrierCredentials)
    .where(eq(carrierCredentials.carrierCode, carrierCode));
  if (!row) return null;
  const password = await decryptSecret(row.passwordEncrypted);
  return {
    carrierCode: row.carrierCode,
    username: row.username,
    password,
    hasPassword: true,
    notes: row.notes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function deleteCredential(carrierCode: string): Promise<boolean> {
  const db = createDbClient();
  const result = await db
    .delete(carrierCredentials)
    .where(eq(carrierCredentials.carrierCode, carrierCode));
  // libsql returns { rowsAffected }
  const ra =
    (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
  return ra > 0;
}
