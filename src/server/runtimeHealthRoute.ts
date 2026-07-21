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

type FeatureState = 'ready' | 'review_required' | 'setup_required' | 'experimental' | 'unavailable';

type FeatureReadiness = {
  id: string;
  name: string;
  area: string;
  state: FeatureState;
  summary: string;
  action?: string;
};

function featureReadiness(
  tables: Record<string, boolean>,
  env: ReturnType<typeof loadEnv>
): FeatureReadiness[] {
  const aiConfigured = env.AI_PROVIDER === 'gemini' ? Boolean(env.GEMINI_API_KEY) : Boolean(env.ANTHROPIC_API_KEY);
  const authConfigured = Boolean(env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS);

  return [
    {
      id: 'shipments',
      name: 'Shipment spreadsheet',
      area: 'Shipments',
      state: tables.shipments ? 'ready' : 'unavailable',
      summary: 'Create, edit, filter, upload documents, and maintain current and historical shipments.',
      action: tables.shipments ? undefined : 'Apply the database schema before using shipments.',
    },
    {
      id: 'shipment-operations',
      name: 'Containers, follow-ups, reports and updates',
      area: 'Shipments',
      state: tables.shipment_containers && tables.shipment_follow_ups ? 'ready' : 'unavailable',
      summary: 'Operational details, milestones, reminders, reports and shipment-update intake.',
      action: tables.shipment_containers && tables.shipment_follow_ups ? undefined : 'Required shipment operation tables are missing.',
    },
    {
      id: 'shipment-ai-intake',
      name: 'AI shipment document extraction',
      area: 'Shipments',
      state: aiConfigured ? 'review_required' : 'unavailable',
      summary: 'Extracts shipment data from PDFs, screenshots, email files and text into the shipment board.',
      action: aiConfigured ? 'Review extracted fields before accepting changes.' : 'Configure the selected AI provider key.',
    },
    {
      id: 'ocean-sheets',
      name: 'Ocean rate-sheet parsing',
      area: 'Ocean freight',
      state: aiConfigured ? 'review_required' : 'unavailable',
      summary: 'Parses uploaded carrier rate sheets, separates destination charges and prepares quote replies.',
      action: aiConfigured ? 'Review carrier, lane, validity and totals before quoting.' : 'Configure the selected AI provider key.',
    },
    {
      id: 'ocean-live',
      name: 'Live carrier portal automation',
      area: 'Ocean freight',
      state: env.USE_REAL_CHROME ? 'experimental' : 'setup_required',
      summary: 'Runs recorded or supported browser workflows against carrier portals.',
      action: env.USE_REAL_CHROME
        ? 'Carrier website changes can break workflows; verify every result.'
        : 'Enable real Chrome and create valid carrier sessions before use.',
    },
    {
      id: 'drayage',
      name: 'Drayage rates and estimates',
      area: 'Drayage',
      state: tables.drayage_quotes ? 'review_required' : 'unavailable',
      summary: 'Stores drayage quotations and estimates new lanes from verified historical matches.',
      action: tables.drayage_quotes ? 'Historical estimates are planning guidance, not firm trucker quotes.' : 'The drayage quote table is missing.',
    },
    {
      id: 'trucking',
      name: 'Regular trucking rates',
      area: 'Drayage',
      state: tables.trucking_quotes ? 'review_required' : 'unavailable',
      summary: 'Stores and compares FTL/LTL rates inside the Drayage workspace.',
      action: tables.trucking_quotes ? 'Confirm equipment, accessorials and validity with the provider.' : 'The trucking quote table is missing.',
    },
    {
      id: 'customs',
      name: 'Customs clearance quotations',
      area: 'Customs clearance',
      state: 'review_required',
      summary: 'Builds USA import, Canada import and export-clearance client quotations.',
      action: 'Verify classification, statutory charges, duties/taxes and customs requirements before release.',
    },
    {
      id: 'client-quotes',
      name: 'Client quotation preview and PDF',
      area: 'Quotes',
      state: 'ready',
      summary: 'Creates client-facing quote previews and downloadable PDFs while keeping markup internal.',
    },
    {
      id: 'tracking',
      name: 'DelayPredict shipment tracking',
      area: 'Shipments',
      state: env.DELAYPREDICT_URL ? 'ready' : 'setup_required',
      summary: 'Joins shipment rows with the external DelayPredict tracker.',
      action: env.DELAYPREDICT_URL ? undefined : 'Set DELAYPREDICT_URL to connect shipment tracking.',
    },
    {
      id: 'scheduled-agents',
      name: 'Scheduled AI agents',
      area: 'Automation',
      state: aiConfigured ? 'experimental' : 'unavailable',
      summary: 'Runs configured periodic automation tasks from the server tick loop.',
      action: aiConfigured ? 'Review task definitions and outputs before relying on unattended actions.' : 'Configure the selected AI provider key.',
    },
    {
      id: 'security',
      name: 'Dashboard access protection',
      area: 'System',
      state: authConfigured ? 'ready' : 'setup_required',
      summary: 'Protects the deployed dashboard with HTTP Basic authentication.',
      action: authConfigured ? undefined : 'Set BASIC_AUTH_USER and BASIC_AUTH_PASS before exposing the app publicly.',
    },
  ];
}

export function registerRuntimeHealthRoute(app: Express): void {
  app.get('/api/health/ready', async (_req: Request, res: Response) => {
    const started = Date.now();
    const env = loadEnv();
    try {
      const sql = neon(env.DATABASE_URL);
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
        features: featureReadiness(tables, env),
        configuration: {
          aiProvider: env.AI_PROVIDER,
          aiConfigured: env.AI_PROVIDER === 'gemini' ? Boolean(env.GEMINI_API_KEY) : Boolean(env.ANTHROPIC_API_KEY),
          realChrome: env.USE_REAL_CHROME,
          delayPredict: Boolean(env.DELAYPREDICT_URL),
          basicAuth: Boolean(env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS),
        },
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        status: 'unavailable',
        database: 'unavailable',
        latencyMs: Date.now() - started,
        features: featureReadiness(Object.fromEntries(REQUIRED_TABLES.map((name) => [name, false])), env),
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    }
  });
}
