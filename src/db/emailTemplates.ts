import { getPostgresPool } from './client.js';

/**
 * Persistent ocean email templates + the shared fine-print disclaimer.
 *
 * Problem this solves: template edits used to live only in the browser's
 * localStorage (per-device, never seen by the server), so the "accurate,
 * reused-on-every-quote" template the owner wants never actually reached the
 * generate path. These now live in the DB and are the source of truth; the
 * front-end still keeps localStorage as an offline cache.
 *
 * The 3 default bodies here MUST stay byte-identical to EMAIL_TEMPLATES in
 * public/app.js so a brand-new (un-saved) install and a healed DB agree.
 */

export const OCEAN_DISCLAIMER_KEY = '_ocean_disclaimer';

export const DEFAULT_OCEAN_DISCLAIMER =
  'Please note: This quotation is provided for rate-reference purposes and is subject to carrier confirmation. It does not guarantee vessel space or a specific departure date. Space and sailing are secured only upon order nomination and receipt of the carrier’s formal booking confirmation. While a limited number of carriers offer live space availability, with most carriers space is confirmed only at the time of booking. To secure your preferred sailing, we recommend confirming the booking as early as possible.';

/**
 * Canonical-token default templates. Uses the deterministic vocabulary from
 * emailSubstitute.ts — NO <ETD>/<ETA>/<VESSEL> (can't be honestly confirmed at
 * quote stage).
 */
export const DEFAULT_EMAIL_TEMPLATES: Record<string, string> = {
  concise: `Dear <CLIENT>,

Please find our quote below:
<EACH_LANE>
POL: <POL>  ->  POD: <POD>
<EACH_RATE>  $<PRICE> / <CONTAINER></EACH_RATE>
Carrier: <CARRIER>, transit <TRANSIT> days
Destination charges: $<DEST_CHARGES> / cntr (on collect, paid by consignee)
Validity: <VALIDITY>
</EACH_LANE>
<SURCHARGES>
All origin charges (ocean carrier and terminal) are included.`,
  structured: `Hi <CLIENT>,

Thanks for your enquiry. Below is our quote:
<EACH_LANE>
Routing: <POL> -> <POD>
Carrier: <CARRIER>   |   Transit: <TRANSIT> days   |   Validity: <VALIDITY>

Rates:
<EACH_RATE>  - <CONTAINER>: $<PRICE></EACH_RATE>
Destination charges (on collect, paid by consignee): $<DEST_CHARGES> / cntr
</EACH_LANE>
<SURCHARGES>
All origin charges (ocean carrier and terminal) are included.
Please confirm and we will proceed with booking.`,
  conversational: `Hello <CLIENT>,

Pleased to share our rates as follows.
<EACH_LANE>
We can move <POL> to <POD> with <CARRIER>, transit around <TRANSIT> days:
<EACH_RATE>  - <CONTAINER> at $<PRICE> per container</EACH_RATE>
Destination charges are paid on collect at <POD>: $<DEST_CHARGES>/cntr.
These rates are valid <VALIDITY>.
</EACH_LANE>
<SURCHARGES>
All origin handling (ocean carrier and terminal) is included.
Let me know how you'd like to proceed.`,
};

const DEFAULT_TEMPLATE_KEYS = Object.keys(DEFAULT_EMAIL_TEMPLATES);

/**
 * Self-heal on first use. The Replit deploy runs NO migration step, so a fresh
 * Publish ships code that reads `email_templates` against a table that may not
 * exist yet. This creates it lazily + seeds the defaults, mirroring
 * ensureShipmentColumns()/ensureShipmentOperationTables().
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING),
 * run-once-per-process (cached promise), and deliberately NON-fatal: it never
 * rethrows, so a DB blip cannot 500 boot or a request. On failure the cache is
 * cleared so a later call retries, and callers fall back to the in-code defaults.
 */
let tableReady: Promise<void> | null = null;
export function ensureEmailTemplateTable(): Promise<void> {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    const pool = getPostgresPool();
    await pool.query(
      'CREATE TABLE IF NOT EXISTS email_templates (template_key text PRIMARY KEY, body text NOT NULL, updated_at timestamptz NOT NULL DEFAULT NOW())'
    );
    // Seed the 3 default bodies + the disclaimer only if absent — never
    // overwrite an owner's saved edits.
    for (const [key, body] of Object.entries(DEFAULT_EMAIL_TEMPLATES)) {
      await pool.query(
        'INSERT INTO email_templates (template_key, body) VALUES ($1, $2) ON CONFLICT (template_key) DO NOTHING',
        [key, body]
      );
    }
    await pool.query(
      'INSERT INTO email_templates (template_key, body) VALUES ($1, $2) ON CONFLICT (template_key) DO NOTHING',
      [OCEAN_DISCLAIMER_KEY, DEFAULT_OCEAN_DISCLAIMER]
    );
  })().catch((error) => {
    tableReady = null;
    console.error(
      '[db] ensureEmailTemplateTable failed — email templates fall back to in-code defaults until this heals:',
      error
    );
  });
  return tableReady;
}

export interface EmailTemplatesPayload {
  templates: Record<string, string>;
  disclaimer: string;
}

/**
 * Read the 3 template bodies + the disclaimer. Always returns a complete
 * payload: on any DB error it falls back to the in-code defaults so a page load
 * can never 500 on this.
 */
export async function getEmailTemplates(): Promise<EmailTemplatesPayload> {
  await ensureEmailTemplateTable();
  const templates: Record<string, string> = { ...DEFAULT_EMAIL_TEMPLATES };
  let disclaimer = DEFAULT_OCEAN_DISCLAIMER;
  try {
    const { rows } = await getPostgresPool().query(
      'SELECT template_key, body FROM email_templates'
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      const key = String(row.template_key);
      const body = row.body == null ? '' : String(row.body);
      if (key === OCEAN_DISCLAIMER_KEY) disclaimer = body;
      else templates[key] = body;
    }
  } catch (error) {
    console.error(
      '[db] getEmailTemplates failed — using in-code defaults:',
      error
    );
  }
  return { templates, disclaimer };
}

/** Just the disclaimer (used by the generate path to auto-append). */
export async function getOceanDisclaimer(): Promise<string> {
  const { disclaimer } = await getEmailTemplates();
  return disclaimer;
}

/**
 * Upsert one template body (by key) and/or the disclaimer. Accepts a partial
 * map of {key: body}; the disclaimer is saved under OCEAN_DISCLAIMER_KEY.
 * Unknown keys are rejected so the table can't be polluted with arbitrary rows.
 */
export async function saveEmailTemplates(input: {
  templates?: Record<string, string>;
  disclaimer?: string;
}): Promise<void> {
  await ensureEmailTemplateTable();
  const pool = getPostgresPool();
  const upsert = (key: string, body: string) =>
    pool.query(
      'INSERT INTO email_templates (template_key, body, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (template_key) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW()',
      [key, body]
    );
  if (input.templates) {
    for (const [key, body] of Object.entries(input.templates)) {
      if (!DEFAULT_TEMPLATE_KEYS.includes(key)) continue; // ignore unknown keys
      await upsert(key, String(body ?? ''));
    }
  }
  if (typeof input.disclaimer === 'string') {
    await upsert(OCEAN_DISCLAIMER_KEY, input.disclaimer);
  }
}
