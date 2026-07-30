import { ensureShipmentColumns } from '../db/shipmentBoard.js';
import { ensureEmailTemplateTable } from '../db/emailTemplates.js';
import { ensureCompaniesTable } from '../db/companies.js';
import { ensureShipmentOperationTables } from '../db/shipmentOperations.js';

/**
 * Run every additive schema self-heal once, eagerly, at server startup.
 *
 * The deploy pipeline runs no migrations, so tables/columns are created
 * lazily by the individual `ensure*` helpers. Those previously only fired
 * when a request hit `/api/health/ready`. That left a gap: a dev workspace
 * running the app but never polling that route kept a stale database — and
 * Replit's publish flow then diffed that stale dev DB and proposed dropping
 * the (correctly declared, self-healed) tables as "orphans".
 *
 * Running the same self-heals eagerly on boot closes that gap: merely
 * starting the app — in dev or prod — brings the database in line with
 * schema.ts, so the publish diff no longer sees phantom drops.
 *
 * Every step is best-effort and non-fatal: a self-heal failure must never
 * stop the server from coming up (it degrades to lazy creation on first use).
 */
export async function runBootSelfHeal(): Promise<void> {
  const steps: Array<[string, () => Promise<void>]> = [
    ['shipment operation tables', ensureShipmentOperationTables],
    ['shipment columns', ensureShipmentColumns],
    ['email templates table', ensureEmailTemplateTable],
    ['companies table', ensureCompaniesTable],
  ];
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (error) {
      console.warn(`[self-heal] ${label} skipped:`, (error as Error)?.message ?? error);
    }
  }
}
