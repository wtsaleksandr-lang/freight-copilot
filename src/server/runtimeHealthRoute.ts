import type { Express, Request, Response } from 'express';
import { loadEnv } from '../config.js';
import { getAiRoutingProfile } from './aiRoutingService.js';
import { listConfiguredAiProviders, type AiProvider } from './aiProviderKeys.js';
import { getProviderStatuses, type ProviderStatus } from './apiKeysService.js';
import { describeMasterKey } from './secretsCrypto.js';
import { getDatabaseDiagnostics, type DatabaseDiagnostics } from './dbDiagnostics.js';
import { ensureShipmentOperationTables } from '../db/shipmentOperations.js';

const REQUIRED_TABLES = ['shipments', 'quote_bundles', 'drayage_quotes', 'trucking_quotes', 'shipment_containers', 'shipment_follow_ups'] as const;
type FeatureState = 'ready' | 'review_required' | 'setup_required' | 'experimental' | 'unavailable';
type FeatureReadiness = { id: string; name: string; area: string; state: FeatureState; summary: string; action?: string };

// Strip anything credential-bearing from a raw driver error before it reaches
// the client (raw pg errors can echo host/user: ENOTFOUND <host>, "password
// authentication failed for user X").
function sanitizeDbError(raw: string): string {
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[connection-hidden]')
    .replace(/for user ["'][^"']+["']/gi, 'for user [hidden]')
    .replace(/\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\s+\S+/gi, (m) => m.split(/\s+/)[0]!)
    .slice(0, 160);
}

function conciseDatabaseError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    code: 'database_unavailable',
    message:
      'The application database could not be reached. Configuration checks remain valid, but database-backed features could not be verified.',
    action: `Verify the PostgreSQL connection and run the readiness check again. ${sanitizeDbError(raw)}`,
  };
}

function featureReadiness(tables: Record<string, boolean>, env: ReturnType<typeof loadEnv>, providers: string[], databaseAvailable = true): FeatureReadiness[] {
  const aiConfigured = providers.length > 0;
  const databaseAction = databaseAvailable ? 'Run the schema repair or deployment migration.' : 'Restore database access, then check again.';
  return [
    { id: 'shipments', name: 'Shipment workspace', area: 'Core operations', state: tables.shipments ? 'ready' : 'unavailable', summary: 'Editable shipment board, document uploads, notes and history.', action: tables.shipments ? undefined : databaseAction },
    { id: 'shipment-operations', name: 'Containers, milestones and follow-ups', area: 'Core operations', state: tables.shipment_containers && tables.shipment_follow_ups ? 'ready' : 'unavailable', summary: 'Container-level tracking, reminders and operational notes.', action: tables.shipment_containers && tables.shipment_follow_ups ? undefined : databaseAction },
    { id: 'shipment-ai-intake', name: 'Shipment document extraction', area: 'AI-assisted work', state: aiConfigured ? 'review_required' : 'unavailable', summary: 'Reads PDFs, screenshots and email files into shipment fields.', action: aiConfigured ? 'Verify extracted fields before accepting them.' : 'Add at least one AI provider key in Secrets.' },
    { id: 'ocean-sheets', name: 'Routed ocean rate-sheet analysis', area: 'AI-assisted work', state: aiConfigured ? 'review_required' : 'unavailable', summary: 'Uses the active AI mode, provider fallback and budget controls to extract lanes and charges.', action: aiConfigured ? 'Verify lane, equipment, validity, disagreements and totals.' : 'Add at least one AI provider key in Secrets.' },
    { id: 'drayage', name: 'Drayage quote workspace', area: 'Quotation tools', state: tables.drayage_quotes ? 'review_required' : 'unavailable', summary: 'Stores provider quotes and compares historical lanes.', action: tables.drayage_quotes ? 'Confirm rates and accessorials with the provider.' : databaseAction },
    { id: 'trucking', name: 'Regular trucking quotes', area: 'Quotation tools', state: tables.trucking_quotes ? 'review_required' : 'unavailable', summary: 'Stores and compares FTL and LTL pricing.', action: tables.trucking_quotes ? 'Confirm equipment, validity and accessorials.' : databaseAction },
    { id: 'customs', name: 'Customs clearance quote builder', area: 'Quotation tools', state: 'review_required', summary: 'Builds USA import, Canada import and export-clearance quotations.', action: 'Verify classification, statutory charges, duties and taxes.' },
    { id: 'client-quotes', name: 'Client quote preview and PDF', area: 'Quotation tools', state: 'ready', summary: 'Creates customer-facing previews while keeping markup internal.' },
    { id: 'ai-routing', name: 'Shared multi-provider AI executor', area: 'AI system', state: aiConfigured ? 'ready' : 'setup_required', summary: `Executable providers: ${providers.join(', ') || 'none'}. Applies mode routing, fallbacks, parallel Ultimate analysis and estimated spending limits.`, action: aiConfigured ? undefined : 'Add provider keys to enable model routing.' },
    { id: 'ocean-live', name: 'Carrier portal browser automation', area: 'Optional integrations', state: 'experimental', summary: 'Runs recorded browser workflows against carrier websites.', action: env.USE_REAL_CHROME ? 'Verify every result because carrier sites can change.' : 'Optional: enable real Chrome and create carrier sessions.' },
    { id: 'tracking', name: 'DelayPredict tracking', area: 'Optional integrations', state: env.DELAYPREDICT_URL ? 'ready' : 'experimental', summary: 'Adds external prediction data to shipment rows.', action: env.DELAYPREDICT_URL ? undefined : 'Optional: connect a DelayPredict service URL.' },
    { id: 'scheduled-agents', name: 'Scheduled AI agents', area: 'Optional integrations', state: aiConfigured ? 'experimental' : 'setup_required', summary: 'Runs configured background automation tasks.', action: aiConfigured ? 'Review unattended outputs regularly.' : 'Add an AI provider key before enabling agents.' },
    { id: 'security', name: 'Dashboard login protection', area: 'Security', state: env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS ? 'ready' : 'setup_required', summary: 'Protects the deployed dashboard with HTTP Basic authentication.', action: env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS ? undefined : 'Set BASIC_AUTH_USER and BASIC_AUTH_PASS.' },
  ];
}

// ---- Objective 7: prioritized status groups with strict colour semantics ----
export type StatusColor = 'red' | 'amber' | 'blue' | 'green' | 'gray' | 'purple';
export type StatusGroupId =
  | 'critical' // red — real blocking failures / data risk ONLY
  | 'setup' // amber — setup/action needed
  | 'verify' // blue — works, needs human verification before sending
  | 'operational' // green — working normally
  | 'optional' // gray — disabled optional integrations
  | 'experimental'; // purple — experimental

const GROUP_COLOR: Record<StatusGroupId, StatusColor> = {
  critical: 'red',
  setup: 'amber',
  verify: 'blue',
  operational: 'green',
  optional: 'gray',
  experimental: 'purple',
};

export interface StatusItem {
  id: string;
  name: string;
  detail: string;
  action?: string;
}
export interface StatusGroup {
  group: StatusGroupId;
  color: StatusColor;
  items: StatusItem[];
}

export function buildStatusGroups(input: {
  masterKey: ReturnType<typeof describeMasterKey>;
  diagnostics: DatabaseDiagnostics;
  providers: ProviderStatus[];
  env: ReturnType<typeof loadEnv>;
}): { groups: StatusGroup[]; overall: StatusGroupId } {
  const { masterKey, diagnostics, providers, env } = input;
  const critical: StatusItem[] = [];
  const setup: StatusItem[] = [];
  const verify: StatusItem[] = [];
  const operational: StatusItem[] = [];
  const optional: StatusItem[] = [];
  const experimental: StatusItem[] = [];

  // Secret encryption status. AI provider keys are ENVIRONMENT-ONLY now, so the
  // master key only affects the optional carrier-login vault — not the core AI
  // path — hence this is setup-level guidance, never a blocking red.
  if (masterKey.configured) {
    operational.push({ id: 'secrets-key', name: 'Carrier-secret encryption', detail: `SECRETS_MASTER_KEY configured (source: ${masterKey.source}). Used only for stored carrier logins; AI keys are read from the environment.` });
  } else {
    setup.push({ id: 'secrets-key', name: 'Carrier-secret encryption', detail: 'SECRETS_MASTER_KEY is not set. Only needed if you store carrier login credentials in-app; AI provider keys do not use it.', action: 'Set SECRETS_MASTER_KEY in Secrets only if you use the carrier-rate bots.' });
  }

  // Database connection + schema.
  if (!diagnostics.connected) {
    critical.push({ id: 'database', name: 'Database connection', detail: `Not connected (${diagnostics.hostCategory}). Database-backed features are unavailable.`, action: 'Restore database access, then re-check.' });
  } else {
    operational.push({ id: 'database', name: 'Database connection', detail: `Connected to a ${diagnostics.hostCategory} PostgreSQL database${diagnostics.databaseName ? ` (${diagnostics.databaseName})` : ''}.` });
    const missing = Object.entries(diagnostics.tableCounts).filter(([, v]) => v === null).map(([k]) => k);
    if (missing.length) {
      critical.push({ id: 'schema', name: 'Database schema', detail: `Missing tables: ${missing.join(', ')}.`, action: 'Run pnpm db:push to create the additive schema.' });
    }
    if (diagnostics.databaseChanged) {
      critical.push({ id: 'db-drift', name: 'Production vs development database', detail: 'This environment now points at a DIFFERENT database than it was first initialized with. Copying development to production will OVERWRITE production data.', action: 'Confirm backup + migration before any database copy; do not enable "Copy development database to production".' });
    }
  }

  // AI provider keys — environment-only, so a provider is simply configured or
  // not. Nothing can be "locked".
  const usable = providers.filter((p) => p.usable);
  if (usable.length === 0) {
    setup.push({ id: 'providers', name: 'AI provider keys', detail: 'No AI provider key found in the environment. AI-assisted features are disabled.', action: 'Set a provider key as a Secret (e.g. ANTHROPIC_API_KEY) and republish.' });
  } else {
    verify.push({ id: 'ai', name: 'AI-assisted features', detail: `Configured providers: ${usable.map((p) => p.provider).join(', ')}. Verify AI output before sending to customers.` });
  }

  // Security.
  if (!(env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS)) {
    setup.push({ id: 'basic-auth', name: 'Dashboard login protection', detail: 'HTTP Basic auth is not configured.', action: 'Set BASIC_AUTH_USER and BASIC_AUTH_PASS if exposed beyond localhost.' });
  } else {
    operational.push({ id: 'basic-auth', name: 'Dashboard login protection', detail: 'HTTP Basic auth is enabled.' });
  }

  // Optional / experimental integrations.
  optional.push(
    env.DELAYPREDICT_URL
      ? { id: 'delaypredict', name: 'DelayPredict tracking', detail: 'Connected — adds tracking status to shipments.' }
      : { id: 'delaypredict', name: 'DelayPredict tracking', detail: 'Disabled (optional). Set DELAYPREDICT_URL to enable.' },
  );
  experimental.push({ id: 'carrier-automation', name: 'Carrier portal automation', detail: env.USE_REAL_CHROME ? 'Enabled (experimental) — verify every result.' : 'Disabled (experimental). Enable real Chrome to use.' });
  experimental.push({ id: 'scheduled-agents', name: 'Scheduled AI agents', detail: 'Background automation (experimental) — review unattended output.' });

  const groups: StatusGroup[] = [
    { group: 'critical', color: GROUP_COLOR.critical, items: critical },
    { group: 'setup', color: GROUP_COLOR.setup, items: setup },
    { group: 'verify', color: GROUP_COLOR.verify, items: verify },
    { group: 'operational', color: GROUP_COLOR.operational, items: operational },
    { group: 'optional', color: GROUP_COLOR.optional, items: optional },
    { group: 'experimental', color: GROUP_COLOR.experimental, items: experimental },
  ];
  const overall: StatusGroupId = critical.length ? 'critical' : setup.length ? 'setup' : 'operational';
  return { groups, overall };
}

export function registerRuntimeHealthRoute(app: Express): void {
  app.get('/api/health/ready', async (_req: Request, res: Response) => {
    const started = Date.now();
    const env = loadEnv();
    try {
      // Best-effort: make sure the lazily-created operations tables exist so a
      // fresh deploy doesn't report them missing. Never fails the check.
      await ensureShipmentOperationTables().catch(() => {});
      const [diagnostics, profile, providerStatuses, providers] = await Promise.all([
        getDatabaseDiagnostics(),
        getAiRoutingProfile(),
        getProviderStatuses(),
        listConfiguredAiProviders(),
      ]);
      const masterKey = describeMasterKey();
      const tables = Object.fromEntries(
        REQUIRED_TABLES.map((name) => [name, diagnostics.tableCounts[name] != null]),
      ) as Record<string, boolean>;
      const missingTables = REQUIRED_TABLES.filter((name) => !tables[name]);
      const { groups, overall } = buildStatusGroups({ masterKey, diagnostics, providers: providerStatuses, env });
      const aiConfigured = providers.length > 0;
      const ready = diagnostics.connected && missingTables.length === 0 && overall !== 'critical';
      res.status(ready ? 200 : overall === 'critical' ? 503 : 200).json({
        status: overall === 'critical' ? 'critical' : ready ? 'ready' : 'setup_required',
        database: 'connected',
        databaseDriver: 'postgres',
        databaseInfo: {
          connected: diagnostics.connected,
          hostCategory: diagnostics.hostCategory,
          databaseName: diagnostics.databaseName,
          fingerprint: diagnostics.fingerprint,
          databaseChanged: diagnostics.databaseChanged,
          apiKeysTableExists: diagnostics.apiKeysTableExists,
          tableCounts: diagnostics.tableCounts,
        },
        secretsKey: masterKey,
        providers: providerStatuses,
        latencyMs: Date.now() - started,
        tables,
        missingTables,
        features: featureReadiness(tables, env, providers as AiProvider[]),
        statusGroups: groups,
        configuration: { source: 'encrypted app secrets and environment fallback', aiProvider: profile.mode, aiMode: profile.label, aiConfigured, configuredProviders: providers, sharedExecutor: true, webPolicy: profile.webPolicy, promptCaching: profile.promptCaching, maxTaskCostUsd: profile.maxTaskCostUsd, realChrome: env.USE_REAL_CHROME, delayPredict: Boolean(env.DELAYPREDICT_URL), basicAuth: Boolean(env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS) },
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      const databaseError = conciseDatabaseError(error);
      const tables = Object.fromEntries(REQUIRED_TABLES.map((name) => [name, false]));
      const providers = await listConfiguredAiProviders().catch(() => [] as AiProvider[]);
      res.status(503).json({ status: 'unavailable', database: 'unavailable', databaseDriver: 'postgres', latencyMs: Date.now() - started, tables: null, missingTables: [], features: featureReadiness(tables, env, providers, false), configuration: { source: 'environment fallback', aiProvider: env.AI_PROVIDER, aiConfigured: providers.length > 0, configuredProviders: providers, sharedExecutor: true, realChrome: env.USE_REAL_CHROME, delayPredict: Boolean(env.DELAYPREDICT_URL), basicAuth: Boolean(env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS) }, errorCode: databaseError.code, error: databaseError.message, action: databaseError.action, checkedAt: new Date().toISOString() });
    }
  });

  // Objective 4 — safe DB diagnostics (no host/user/password/connection string).
  app.get('/api/health/database', async (_req: Request, res: Response) => {
    try {
      const diagnostics = await getDatabaseDiagnostics();
      res.json({
        ...diagnostics,
        advisories: [
          'Copying development to production will overwrite production data.',
          'Do not enable "Copy development database to production" unless backup and migration are confirmed.',
          ...(diagnostics.databaseChanged
            ? ['Production database appears to differ from the database this environment was initialized with.']
            : []),
        ],
      });
    } catch (err) {
      console.error('[api/health/database] error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Could not read database diagnostics.' });
    }
  });
}
