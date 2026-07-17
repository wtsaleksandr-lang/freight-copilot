import type { Express, Request, Response } from 'express';
import { neon } from '@neondatabase/serverless';
import { loadEnv } from '../config.js';

const REQUIRED_TABLES = [
  'shipments',
  'quote_bundles',
  'drayage_quotes',
  'trucking_quotes',
  'shipment_containers',
  'shipment_follow_ups',
] as const;

export function registerRuntimeHealthRoute(app: Express): void {
  app.get('/api/health/ready', async (_req: Request, res: Response) => {
    const started = Date.now();
    try {
      const sql = neon(loadEnv().DATABASE_URL);
      const rows = await sql`
        SELECT
          to_regclass('public.shipments')::text AS shipments,
          to_regclass('public.quote_bundles')::text AS quote_bundles,
          to_regclass('public.drayage_quotes')::text AS drayage_quotes,
          to_regclass('public.trucking_quotes')::text AS trucking_quotes,
          to_regclass('public.shipment_containers')::text AS shipment_containers,
          to_regclass('public.shipment_follow_ups')::text AS shipment_follow_ups
      `;
      const row = (rows[0] ?? {}) as Record<string, string | null>;
      const tables = Object.fromEntries(REQUIRED_TABLES.map((name) => [name, Boolean(row[name])]));
      const missingTables = REQUIRED_TABLES.filter((name) => !tables[name]);
      const ready = missingTables.length === 0;
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'degraded',
        database: 'connected',
        latencyMs: Date.now() - started,
        tables,
        missingTables,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        status: 'unavailable',
        database: 'unavailable',
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    }
  });
}
