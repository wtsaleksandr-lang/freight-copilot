// Secure audit trail (Objective 11). Records credential- and AI-configuration
// events for later review. NEVER stores a key value, fragment, plaintext
// password, or ciphertext — only event type, provider name, source, outcome,
// and a sanitized human-readable message.
//
// recordAuditEvent() is best-effort: it must NEVER throw into the calling
// request path (an audit-write failure must not break saving a key). Failures
// are logged (without secrets) and swallowed.

import { desc } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { auditEvents } from '../db/schema.js';

export type AuditEventType =
  | 'api_key.added'
  | 'api_key.replaced'
  | 'api_key.removed'
  | 'connection.tested'
  | 'env_migration.completed'
  | 'master_key.status_changed'
  | 'ai_mode.changed';

export interface AuditEventInput {
  eventType: AuditEventType;
  provider?: string | null;
  source?: string | null;
  success: boolean;
  sanitizedMessage?: string | null;
}

// Defence-in-depth: strip anything that even looks like a real key so a caller
// mistake can never persist a secret. Redacts long provider-key-shaped tokens.
const KEYISH = /\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/g;

export function sanitizeAuditMessage(message: string | null | undefined): string | null {
  if (!message) return message ?? null;
  return message.replace(KEYISH, '[redacted]').slice(0, 500);
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    const db = createDbClient();
    await db.insert(auditEvents).values({
      eventType: input.eventType,
      provider: input.provider ?? null,
      source: input.source ?? null,
      success: input.success,
      sanitizedMessage: sanitizeAuditMessage(input.sanitizedMessage),
    });
  } catch (err) {
    // Never surface to the caller; never include secrets.
    console.error('[audit] could not record event', input.eventType, err instanceof Error ? err.message : err);
  }
}

export interface AuditEventRow {
  id: number;
  eventType: string;
  provider: string | null;
  source: string | null;
  success: boolean;
  sanitizedMessage: string | null;
  createdAt: string;
}

/** Recent events, newest first, for the settings/readiness UI. Never secrets. */
export async function listRecentAuditEvents(limit = 50): Promise<AuditEventRow[]> {
  try {
    const db = createDbClient();
    const rows = await db
      .select()
      .from(auditEvents)
      .orderBy(desc(auditEvents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      provider: r.provider,
      source: r.source,
      success: r.success,
      sanitizedMessage: r.sanitizedMessage,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}
