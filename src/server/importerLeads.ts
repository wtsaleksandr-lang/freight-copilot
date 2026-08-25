/**
 * Importer-Leads engine — Stream 1 of the ImportYeti lead-gen pipeline.
 *
 * Pipeline:  ImportYeti bill-of-lading pull → drop forwarders/NVOCCs/confidential
 *            → dedup to unique real importers → (optional) enrich a decision-maker
 *            contact via Hunter → merge to a clean lead → (optional) AI-draft a
 *            personalized cold email via Anthropic.
 *
 * This spends paid API credits, so it lives behind the app's Basic-auth gate and a
 * hard per-request cap (see MAX_LEADS_CAP). It reads its keys straight from
 * process.env — an unset key surfaces as a clean runtime error to the caller
 * rather than crashing boot (config.ts does NOT require these).
 *
 * Env: IMPORTYETI_API_KEY, HUNTER_API_KEY, ANTHROPIC_API_KEY
 *
 * Ported verbatim (logic-wise) from the validated live-tested engine; adapted only
 * to the repo's TypeScript + error conventions.
 */

/** Never pull / enrich / draft more than this many leads in one paid request. */
export const MAX_LEADS_CAP = 25;

/** A raw ImportYeti bill-of-lading record. ImportYeti returns arbitrary JSON, so
 *  every field is optional; we read only the ones the lead needs. */
export interface BolRecord {
  company_name?: string;
  company_basename?: string;
  company_state?: string;
  company_address?: string;
  company_manifest_confidentiality?: boolean;
  company_shipments_12m?: number;
  company_total_shipments?: number;
  company_main_phone_number?: string;
  company_website?: string;
  supplier_name?: string;
  supplier_country_code?: string;
  product_description?: string;
  hs_code_description?: string;
  hs_code?: string;
  entry_port?: string;
  arrival_date?: string;
  notify_party_name?: string;
  [key: string]: unknown;
}

/** A resolved decision-maker contact (Hunter enrichment). */
export interface Contact {
  domain: string;
  contact_name: string | null;
  title: string | null;
  email: string | null;
  email_confidence: number | null;
  linkedin: string | null;
}

/** A clean, deliverable importer lead. */
export interface Lead {
  company: string | null;
  state: string | null;
  supplier: string | null;
  supplier_country: string | null;
  product: string | null;
  hs_code: string | null;
  entry_port: string | null;
  ships_12m: number | null;
  total_shipments: number | null;
  last_shipment: string | null;
  phone: string | null;
  website: string | null;
  incumbent_forwarder: string | null;
  contact_name: string | null;
  title: string | null;
  email: string | null;
  email_confidence: number | null;
  draft_email?: string | null;
}

export interface FindImporterLeadsParams {
  entryPort?: string;
  product?: string;
  hsCode?: string;
  supplierCountry?: string;
  startDate?: string;
  endDate?: string;
  maxLeads?: number;
  withEnrichment?: boolean;
  withEmails?: boolean;
}

export interface FindImporterLeadsResult {
  leads: Lead[];
  creditsRemaining: number | null;
  cost: number | null;
}

/* ── 1. ImportYeti: pull US-import bill-of-lading records ────────────────────
 * VERIFIED live API: GET https://data.importyeti.com/v1.0/powerquery/us-import/bols
 * (data.importyeti.com — NOT api.importyeti.com, which is Cloudflare-blocked.)
 * Auth: Bearer. Cost scales with page_size (~10 records per credit). Response:
 * { requestCost, creditsRemaining, data:{ data:[ <bol records> ] } }.
 * bol_type "H" (house) = the REAL consignee, not the NVOCC master. */
export interface PullBolsParams {
  entryPort?: string;
  product?: string;
  hsCode?: string;
  supplierCountry?: string;
  startDate?: string;
  endDate?: string;
  bolType?: string;
  pageSize?: number;
  page?: number;
}

export async function pullImportBols(params: PullBolsParams = {}): Promise<{
  rows: BolRecord[];
  cost: number | null;
  creditsRemaining: number | null;
}> {
  const key = process.env.IMPORTYETI_API_KEY;
  if (!key) throw new Error('IMPORTYETI_API_KEY not set');
  const { entryPort, product, hsCode, supplierCountry, startDate, endDate, bolType = 'H', pageSize = 50, page = 1 } = params;
  const qs = new URLSearchParams();
  if (entryPort) qs.set('entry_port', entryPort);
  if (product) qs.set('product_description', product);
  if (hsCode) qs.set('hs_code', hsCode);
  if (supplierCountry) qs.set('supplier_country', supplierCountry);
  if (startDate) qs.set('start_date', startDate);
  if (endDate) qs.set('end_date', endDate);
  if (bolType) qs.set('bol_type', bolType);
  qs.set('page_size', String(pageSize));
  qs.set('page', String(page));
  const r = await fetch(`https://data.importyeti.com/v1.0/powerquery/us-import/bols?${qs}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`ImportYeti ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as {
    requestCost?: number;
    creditsRemaining?: number;
    data?: { data?: BolRecord[] };
  };
  return {
    rows: j.data?.data ?? [],
    cost: j.requestCost ?? null,
    creditsRemaining: j.creditsRemaining ?? null,
  };
}

/* ── 2. Filter out forwarders / NVOCCs / brokers ────────────────────────────
 * The #1 data trap: the consignee is often the forwarder (Expeditors, DHL,
 * Autico…), not the real buyer. Enriching those returns another forwarder's
 * contact, so we drop them before dedup and enrichment. */
const FORWARDER_TERMS = [
  'expeditors', 'kuehne', 'nagel', 'dhl', 'db schenker', 'dsv', 'ceva', 'nippon express',
  'geodis', 'panalpina', 'dachser', 'bollore', 'hellmann', 'yusen', 'kintetsu', 'agility',
  'flexport', 'forward air', 'autico', 'cargo', 'logistics', 'forwarding', 'forwarder',
  'nvocc', 'freight', 'customs broker', 'brokerage', 'supply chain solutions', '3pl',
  'worldwide express', 'transport', 'shipping line', 'consolidat', "int'l", 'international freight',
];

export function isForwarder(companyName = ''): boolean {
  const n = companyName.toLowerCase();
  return FORWARDER_TERMS.some((t) => n.includes(t));
}

/** Dedup BOL rows → unique real importers (drop forwarders + confidential),
 *  keeping the highest-recent-volume row per company. */
export function dedupImporters(rows: BolRecord[]): BolRecord[] {
  const byCo = new Map<string, BolRecord>();
  for (const r of rows) {
    if (!r.company_name || r.company_manifest_confidentiality || isForwarder(r.company_name)) continue;
    const key = r.company_basename || r.company_name;
    const cur = byCo.get(key);
    if (!cur || (r.company_shipments_12m || 0) > (cur.company_shipments_12m || 0)) byCo.set(key, r);
  }
  return [...byCo.values()].sort((a, b) => (b.company_shipments_12m || 0) - (a.company_shipments_12m || 0));
}

/* ── 3. Enrich: domain + decision-maker + email (Hunter) ─────────────────────
 * ONE call does it all: Hunter domain-search?company=NAME fuzzy-resolves the
 * company to its DOMAIN and returns indexed employees with titles + confidence.
 * ImportYeti carries no website, so this name→domain→people resolution IS the
 * enrichment. `limit` MUST be ≤ 10 — Hunter's free plan returns HTTP 400 above.
 * Guarded: a fuzzy match can drift (Bosch Tool → motopaja.fi), so we reject any
 * resolved domain whose HOST shares no meaningful token with the input name. */
const TARGET_TITLE_RX = /logistic|supply|import|procure|operation|purchas|owner|president|founder|ceo|coo|director|vp|head/i;
const STOP_TOKENS = new Set([
  'inc', 'llc', 'corp', 'co', 'ltd', 'america', 'american', 'usa', 'us', 'the', 'company', 'group',
  'north', 'corporation', 'ab', 'gmbh', 'international', 'intl', 'holdings', 'industries', 'na',
]);

function nameTokens(s = ''): Set<string> {
  return new Set(
    String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP_TOKENS.has(t)),
  );
}

/** True if the resolved DOMAIN plausibly IS the input company (host shares a
 *  distinctive token). We deliberately IGNORE Hunter's `organization` field — it
 *  echoes the searched name back, so it always "matches" and can't catch a fuzzy
 *  drift. Strict host-token match trades recall for precision — the right call
 *  for a paid lead product, where a wrong email burns sender reputation.
 *  Unmatched companies stay un-enriched (honest). */
export function domainMatchesCompany(companyName: string, domain: string | null | undefined): boolean {
  const want = nameTokens(companyName);
  if (!want.size) return true; // nothing distinctive to check against → don't block
  const host = new Set(nameTokens((domain || '').split('.').slice(0, -1).join(' ')));
  for (const t of want) if (host.has(t)) return true;
  // also accept a solid substring hit (e.g. "globalstoneimpex" host vs "Global Stone Impex")
  const joined = (domain || '').split('.')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  for (const t of want) if (t.length >= 4 && joined.includes(t)) return true;
  return false;
}

interface HunterEmail {
  value?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  confidence?: number;
  linkedin?: string;
}

export async function enrichContact(companyName: string): Promise<Contact | null> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) throw new Error('HUNTER_API_KEY not set');
  const r = await fetch(
    `https://api.hunter.io/v2/domain-search?company=${encodeURIComponent(companyName)}&api_key=${key}&limit=10`,
  );
  if (!r.ok) return null;
  const j = (await r.json()) as { data?: { domain?: string; emails?: HunterEmail[] } };
  const d = j.data || {};
  const domain = d.domain || null;
  const emails = d.emails || [];
  if (!domain || !emails.length) return null;
  if (!domainMatchesCompany(companyName, domain)) return null; // fuzzy-drift guard
  // Prefer a real decision-maker; fall back to highest-confidence indexed email.
  const ranked = [...emails].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const dm = ranked.find((e) => TARGET_TITLE_RX.test(e.position || '')) || ranked[0];
  if (!dm) return null;
  const name = [dm.first_name, dm.last_name].filter(Boolean).join(' ') || null;
  return {
    domain,
    contact_name: name,
    title: dm.position || null,
    email: dm.value || null,
    email_confidence: dm.confidence ?? null,
    linkedin: dm.linkedin || null,
  };
}

/* ── 4. Merge BOL record (+ optional enrichment) → clean lead ────────────────*/
export function toLead(r: BolRecord, contact: Contact | null): Lead {
  const stateFromAddress = r.company_address?.match(/,\s*([A-Z]{2})\s/);
  return {
    company: r.company_name ?? null,
    state: (stateFromAddress && stateFromAddress[1]) || r.company_state || null,
    supplier: r.supplier_name || null,
    supplier_country: r.supplier_country_code || null,
    product: r.product_description || r.hs_code_description || null,
    hs_code: r.hs_code || null,
    entry_port: r.entry_port || null,
    ships_12m: r.company_shipments_12m ?? null,
    total_shipments: r.company_total_shipments ?? null,
    last_shipment: r.arrival_date || null,
    phone: r.company_main_phone_number || null,
    website: contact?.domain || r.company_website || null, // ImportYeti rarely has it → Hunter resolves it
    incumbent_forwarder: r.notify_party_name || null, // who you're displacing
    contact_name: contact?.contact_name || null,
    title: contact?.title || null,
    email: contact?.email || null,
    email_confidence: contact?.email_confidence ?? null,
  };
}

/* ── 5. AI-draft personalized outreach (Anthropic) ──────────────────────────
 * KEEP the retry-with-backoff that handles BOTH non-2xx overload (429/500/502/
 * 503/529) AND HTTP-200-with-empty-content (join all type==="text" blocks; retry
 * if empty). claude-sonnet-5. */
export interface DraftOptions {
  fromName?: string;
  company?: string;
  service?: string;
}

interface AnthropicBlock {
  type?: string;
  text?: string;
}

export async function draftEmail(lead: Lead, opts: DraftOptions = {}): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const { fromName = 'Alex', company = 'our logistics team', service = 'freight forwarding' } = opts;
  const lane = [lead.entry_port && `into ${lead.entry_port}`, lead.supplier && `from ${lead.supplier}`]
    .filter(Boolean)
    .join(' ');
  const prompt =
    `You write short, specific B2B cold emails for a ${service} business. Write ONE 90-word email to ` +
    `${lead.contact_name || 'the logistics lead'} at ${lead.company}. Use their VERIFIED shipping activity to be ` +
    `specific and credible, never generic. Facts: they import ${lead.product || 'goods'} from ` +
    `${lead.supplier || 'overseas'}${lead.supplier_country ? ' (' + lead.supplier_country + ')' : ''} ${lane}, ` +
    `~${lead.ships_12m ?? 'regular'} shipments in the last 12 months, most recent ${lead.last_shipment || 'recently'}, ` +
    `currently routing through ${lead.incumbent_forwarder || 'an incumbent forwarder'}. Offer a sharper rate on that ` +
    `exact lane. Plain text, one clear CTA, no fluff, no subject line. Sign off as ${fromName}, ${company}.`;
  const body = JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    });
    if (r.ok) {
      const j = (await r.json()) as { content?: AnthropicBlock[]; stop_reason?: string };
      const text = (j.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join('')
        .trim();
      if (text) return text;
      last = `Anthropic 200 but empty content (stop_reason=${j.stop_reason})`; // intermittent under load → retry
    } else {
      last = `Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`;
      if (![429, 500, 502, 503, 529].includes(r.status)) throw new Error(last);
    }
    await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
  }
  throw new Error(last);
}

/* ── Orchestration: one paid request → leads (+ optional enrichment/drafts) ──
 * The cost guard caps how many enrichments/drafts run so spend can never exceed
 * the requested maxLeads (hard-capped at MAX_LEADS_CAP). */
export async function findImporterLeads(params: FindImporterLeadsParams = {}): Promise<FindImporterLeadsResult> {
  const {
    entryPort, product, hsCode, supplierCountry, startDate, endDate,
    withEnrichment = false, withEmails = false,
  } = params;
  const requested = Number(params.maxLeads);
  const maxLeads = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 10, MAX_LEADS_CAP));

  const { rows, creditsRemaining, cost } = await pullImportBols({
    entryPort, product, hsCode, supplierCountry, startDate, endDate,
    pageSize: Math.max(50, maxLeads * 4),
  });
  const importers = dedupImporters(rows).slice(0, maxLeads);

  const leads: Lead[] = [];
  for (const r of importers) {
    const contact = withEnrichment ? await enrichContact(r.company_name || '').catch(() => null) : null;
    const lead = toLead(r, contact);
    if (withEmails) lead.draft_email = await draftEmail(lead).catch(() => null);
    leads.push(lead);
  }
  return { leads, creditsRemaining, cost };
}

/* ── CSV export ─────────────────────────────────────────────────────────────*/
const CSV_COLS: (keyof Lead)[] = [
  'company', 'state', 'supplier', 'supplier_country', 'product', 'hs_code', 'entry_port',
  'ships_12m', 'total_shipments', 'last_shipment', 'phone', 'website', 'incumbent_forwarder',
  'contact_name', 'title', 'email', 'email_confidence',
];

export function toCSV(leads: Lead[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [CSV_COLS.join(','), ...leads.map((l) => CSV_COLS.map((c) => esc(l[c])).join(','))].join('\n');
}
