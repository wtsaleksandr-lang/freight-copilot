import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { loadEnv } from '../config.js';
import type {
  BriefingFile,
  BriefingMediaType,
} from './parseShipmentBriefing.js';

import { getAiConfig } from './model.js';
import { callGeminiTool } from './geminiAdapter.js';
// Provider + models resolved per-call so the dashboard's secrets
// page can swap them at runtime without a server restart.
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const SYSTEM_PROMPT = `You read drayage (port ↔ inland container truck) rate sheets, provider quotes, and email rate confirmations, and extract every rate row into a structured array.

Drayage = the truck/rail leg between an ocean container terminal and a shipper/consignee address. A rate sheet typically lists many lanes (origin → destination pairs), often broken out by container type, sometimes with multiple surcharges per lane.

================================================================
LOCATION RULES — read these before any extraction.
================================================================

Every rate row must have a recognisable PICKUP and a recognisable
DELIVERY. The user works with three location kinds — any one of them
is acceptable. The examples below are just to help you calibrate;
they are NOT exhaustive — any real-world terminal, port, region, or
postal address counts.

  KIND 1 — TERMINAL or PORT
    Any named ocean port, container yard (CY), inland port, or
    railway intermodal terminal — anywhere in the world. A few
    examples to anchor the pattern: Port of Houston, APM Newark,
    Port of Halifax, BNSF Memphis Intermodal, CSX Bedford Park,
    UP Global IV Joliet, CN Brampton, CP Vaughan, Port of Vancouver,
    Felixstowe, Rotterdam, Antwerp, Singapore PSA, etc. Don't limit
    to these — extract whatever the document names, large or small.
    Fill: pickup_label (e.g. "APM Terminal — Newark, NJ" or
    "BNSF Memphis Intermodal — Memphis, TN" or just the terminal
    name if no city is given), pickup_city, pickup_state,
    pickup_country. pickup_address and pickup_zip are usually null.

  KIND 2 — ADDRESS (loading / offloading point)
    A street address at a warehouse, factory, distribution centre,
    yard, or any other physical location. The reliable signal is a
    postal code (US ZIP "60601" / "60601-1234"; Canadian "M5V 3A8";
    other countries' equivalents). The address rarely names a
    terminal. Examples:
      • "1234 Main St, Chicago IL 60601"
      • "Suite 200, 500 Industrial Pkwy, Atlanta GA 30318"
      • "Chicago IL 60601" (no street is fine if a ZIP is present).
    Fill: pickup_address (street if given), pickup_city, pickup_state,
    pickup_zip (preferred for this kind), pickup_country,
    pickup_label (e.g. "1234 Main St — Chicago, IL 60601" or
    "Chicago, IL 60601").

  KIND 3 — REGION / ZONE
    Multi-point pricing for a named region. Examples: "All of NJ",
    "Chicagoland", "Greater Houston", "Texas zone 3", "Midwest",
    "Tri-state", "Lower Mainland BC", or any zone label the carrier
    defines.
    Fill: pickup_label (the region name verbatim from the document,
    e.g. "Chicagoland" or "NJ — All zones"), pickup_state if the
    region is state-bounded, pickup_country. pickup_city, pickup_zip,
    and pickup_address are usually null.

ONLY REJECT (set to null and skip the row):
  • Pure placeholder text with no geography: "TBD", "—", "various",
    "see attached", blank cells.
  • Locations so vague they don't pin down anywhere on a map
    (e.g. "global", "anywhere", "all destinations").

If both pickup and delivery fall into one of the three kinds above
(or a mix of kinds — e.g. terminal pickup, address delivery), EMIT
the row. Be generous: when in doubt, prefer to extract.

================================================================

For EACH rate row in the document, extract:

- rate_date: when the rate was quoted, valid from, or printed (ISO YYYY-MM-DD). Look for "Effective", "Rate as of", "Valid", "Quoted", "Date" headers. If only a month/year is shown, use the first of the month.
- provider_name: the carrier / drayage company offering the rate (e.g. "Hub Group", "STG Logistics", "Schneider Drayage"). Look in headers, footers, signatures.
- pickup_address: street address (KIND 2 only). Null for terminals/ports/regions.
- pickup_city: origin city name when explicitly stated. Null for region-only entries that don't pin a city.
- pickup_state: origin US state code or province code (e.g. "NJ", "ON"). Fill whenever the doc names a state, even for regions.
- pickup_zip: origin ZIP / postal code. Preferred for KIND 2; usually null for terminals and regions.
- pickup_country: origin country (US / CA / MX / etc.). Default "US" if context is North American.
- pickup_label: short human display matching the location KIND — see LOCATION RULES above.
- delivery_address / delivery_city / delivery_state / delivery_zip / delivery_country / delivery_label: same fields for the destination side, same rules as pickup.
- total_miles: one-way mileage. If the document states it explicitly, use that number. If the document does NOT state miles but you have a clearly-identifiable pickup and delivery (city + state for both, or two named ports), provide your best driving-distance estimate based on geographic knowledge. Round to the nearest 10 miles. NEVER invent a value if you don't know — leave null only when the locations are too vague to estimate (e.g. only a state, or "all of NJ"). Mark estimates by appending the rounded number; the user knows estimates are auto-filled.
- container_type: 20GP / 40GP / 40HC / 20RF / 40RF / 40RH / 40NOR / 20OT / 40OT / 20FR / 40FR / 20TK. Translate "20'std" → "20GP", "40HQ" → "40HC". If a row applies to multiple types (e.g. "all 20'/40'"), output ONE row per type.
- max_weight_kg: maximum cargo weight allowed at this rate, in kilograms. If the doc gives lbs/tons, convert (1 lb = 0.4536 kg, 1 short ton = 907.185 kg, 1 metric ton = 1000 kg).
- base_rate: linehaul / linehaul-only rate, numeric.
- surcharges: array of { name, amount, currency } — every additional fee line: FSC (fuel surcharge), chassis fee, prepull, detention, chassis split, terminal fee, hazmat, overweight, gate fee, congestion fee, etc. Empty array if none.
- total_rate: all-in total = base + sum(surcharges). If the doc doesn't show an explicit total, compute it. If only the total is shown without a breakdown, set base_rate = total_rate and surcharges = [].
- currency: native currency in the document (USD / CAD / etc.). The server will FX-normalise to USD after extraction. DO NOT convert yourself.
- notes: anything else worth keeping per row — validity period, conditions, "subject to chassis availability", weight tier (if a tiered structure), "round trip only", etc. Concise.

Return through the extract_drayage_rates tool. The output shape is { rates: RateEntry[] }. Even if the document has only one rate, return it as a single-element array. NEVER return an empty rates array if the document has visible rate data.

Rules:
- Be conservative with hallucinations. Null beats a guess.
- One row per (origin, destination, container_type, weight_tier) combination.
- If the same origin/destination is quoted at different weight tiers (e.g. 20GP up to 22 tons vs 20GP up to 25 tons), emit one row per tier.
- If the doc lists rates "from" a port to "all of NJ" (zone pricing), emit ONE row per discrete destination if listed; otherwise pickup_label = origin port and delivery_label = "Zone X — NJ" (or whatever the doc calls it).
- Maintain the document's native currency in each row. The server converts.
`;

const RateSchema = z.object({
  rate_date: z.string().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  pickup_address: z.string().nullable().optional(),
  pickup_city: z.string().nullable().optional(),
  pickup_state: z.string().nullable().optional(),
  pickup_zip: z.string().nullable().optional(),
  pickup_country: z.string().nullable().optional(),
  pickup_label: z.string().nullable().optional(),
  delivery_address: z.string().nullable().optional(),
  delivery_city: z.string().nullable().optional(),
  delivery_state: z.string().nullable().optional(),
  delivery_zip: z.string().nullable().optional(),
  delivery_country: z.string().nullable().optional(),
  delivery_label: z.string().nullable().optional(),
  total_miles: z.number().nullable().optional(),
  container_type: z.string().nullable().optional(),
  max_weight_kg: z.number().nullable().optional(),
  base_rate: z.number().nullable().optional(),
  surcharges: z
    .array(
      z.object({
        name: z.string(),
        amount: z.number(),
        currency: z.string().default('USD'),
      })
    )
    .default([])
    .optional(),
  total_rate: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const ResultSchema = z.object({
  rates: z.array(RateSchema).default([]),
});

export type DrayageRateEntry = z.infer<typeof RateSchema>;
export type DrayageRatesResult = z.infer<typeof ResultSchema>;

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    rates: {
      type: 'array',
      description:
        'One entry per distinct rate row in the document. Multi-lane rate sheets produce many entries.',
      items: {
        type: 'object',
        properties: {
          rate_date: { type: ['string', 'null'] },
          provider_name: { type: ['string', 'null'] },
          pickup_address: { type: ['string', 'null'] },
          pickup_city: { type: ['string', 'null'] },
          pickup_state: { type: ['string', 'null'] },
          pickup_zip: { type: ['string', 'null'] },
          pickup_country: { type: ['string', 'null'] },
          pickup_label: { type: ['string', 'null'] },
          delivery_address: { type: ['string', 'null'] },
          delivery_city: { type: ['string', 'null'] },
          delivery_state: { type: ['string', 'null'] },
          delivery_zip: { type: ['string', 'null'] },
          delivery_country: { type: ['string', 'null'] },
          delivery_label: { type: ['string', 'null'] },
          total_miles: { type: ['number', 'null'] },
          container_type: { type: ['string', 'null'] },
          max_weight_kg: { type: ['number', 'null'] },
          base_rate: { type: ['number', 'null'] },
          surcharges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                amount: { type: 'number' },
                currency: { type: 'string' },
              },
              required: ['name', 'amount'],
            },
          },
          total_rate: { type: ['number', 'null'] },
          currency: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
        },
      },
    },
  },
  required: ['rates'],
} as const;

const TEXT_TYPES = new Set<BriefingMediaType>([
  'message/rfc822',
  'text/html',
  'text/plain',
]);

export async function parseDrayageRates(
  files: BriefingFile[]
): Promise<DrayageRatesResult> {
  const env = loadEnv();
  if (files.length === 0) {
    throw new Error('No files provided to parseDrayageRates');
  }
  // Resolve provider + models per-call (settings page can change them
  // at runtime). Vault key beats .env.
  const aiCfg = await getAiConfig();
  const { loadAiKey } = await import('../server/apiKeysService.js');
  const apiKey =
    aiCfg.provider === 'anthropic'
      ? (await loadAiKey('anthropic')) ?? env.ANTHROPIC_API_KEY
      : env.ANTHROPIC_API_KEY;
  if (apiKey === PLACEHOLDER_KEY && aiCfg.provider === 'anthropic') {
    throw new Error(
      'No Anthropic API key set. Add one in the Carrier secrets page or set ANTHROPIC_API_KEY in .env.'
    );
  }
  const client = new Anthropic({ apiKey: apiKey || PLACEHOLDER_KEY });

  const intro =
    files.length === 1
      ? 'Extract every drayage rate row from this document.'
      : `Extract every drayage rate row from these ${files.length} documents — they describe one rate sheet together.`;

  const content: Array<{ type: string; [k: string]: unknown }> = [
    { type: 'text', text: intro },
  ];
  for (const f of files) {
    if (f.mediaType === 'application/pdf') {
      if (!f.fileBase64) throw new Error('PDF missing fileBase64');
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: f.fileBase64,
        },
      });
    } else if (TEXT_TYPES.has(f.mediaType)) {
      const body = f.textContent ?? '';
      const label =
        f.mediaType === 'message/rfc822'
          ? 'Email file (.eml — full MIME headers + body)'
          : f.mediaType === 'text/html'
            ? 'HTML email body'
            : 'Plain text';
      content.push({
        type: 'text',
        text:
          `--- ${f.filename ?? 'file'} (${label}) ---\n` + body + '\n--- end ---',
      });
    } else {
      if (!f.fileBase64) throw new Error('Image missing fileBase64');
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: f.mediaType,
          data: f.fileBase64,
        },
      });
    }
  }

  console.log(`[parseDrayageRates] Calling Claude with ${files.length} file(s)…`);

  // First-pass extraction with the cheap primary model.
  let result = await callDrayageExtract(client, content, aiCfg.model, aiCfg.provider);
  const issues = auditDrayageRates(result.rates ?? []);
  if (issues.length > 0) {
    const useFallback =
      aiCfg.fallback !== '' && aiCfg.fallback !== aiCfg.model;
    const retryModel = useFallback ? aiCfg.fallback : aiCfg.model;
    console.log(
      `[parseDrayageRates] audit found ${issues.length} math issue(s) — retrying with ${retryModel}`
    );
    const retryContent = [
      ...content,
      {
        type: 'text',
        text:
          'Your previous extraction had per-row math discrepancies. For each row below, base_rate + sum(surcharges) does not match total_rate within $0.50:\n\n' +
          issues.map((i) => `  • Row ${i.index}: ${i.message}`).join('\n') +
          '\n\nRe-extract the same rate sheet and ensure each row reconciles.',
      },
    ];
    try {
      const retried = await callDrayageExtract(client, retryContent, retryModel, aiCfg.provider);
      const reaudit = auditDrayageRates(retried.rates ?? []);
      if (reaudit.length < issues.length) {
        result = retried;
      }
    } catch (err) {
      console.warn('[parseDrayageRates] retry failed:', err);
    }
  }

  return result;
}

interface RateMathIssue { index: number; message: string }
function auditDrayageRates(rates: DrayageRateEntry[]): RateMathIssue[] {
  const issues: RateMathIssue[] = [];
  rates.forEach((r, idx) => {
    if (r.total_rate == null) return;
    if (r.base_rate == null && (!r.surcharges || r.surcharges.length === 0)) return;
    const base = r.base_rate ?? 0;
    const sur = (r.surcharges ?? []).reduce((s, x) => s + (x.amount || 0), 0);
    const computed = base + sur;
    if (Math.abs(computed - r.total_rate) > 0.5) {
      issues.push({
        index: idx,
        message: `base ${base} + surcharges ${sur.toFixed(2)} = ${computed.toFixed(2)}, but total_rate is ${r.total_rate}`,
      });
    }
  });
  return issues;
}

async function callDrayageExtract(
  client: Anthropic,
  content: Array<{ type: string; [k: string]: unknown }>,
  modelName: string,
  provider: 'anthropic' | 'gemini'
): Promise<DrayageRatesResult> {
  let toolInput: unknown;
  if (provider === 'gemini') {
    toolInput = await callGeminiTool({
      modelName,
      systemPrompt: SYSTEM_PROMPT,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: content as any,
      tool: {
        name: 'extract_drayage_rates',
        description:
          'Return every rate row from the document as a structured array.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: TOOL_SCHEMA as any,
      },
      maxTokens: 4096,
    });
  } else {
    const response = await client.messages.create({
      model: modelName,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [
        {
          name: 'extract_drayage_rates',
          description:
            'Return every rate row from the document as a structured array.',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input_schema: TOOL_SCHEMA as any,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_drayage_rates' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ role: 'user', content: content as any }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Claude did not return a tool_use block');
    }
    toolInput = toolUse.input;
  }
  const parsed = ResultSchema.safeParse(toolInput);
  if (!parsed.success) {
    console.error('[parseDrayageRates] Zod issues:', parsed.error.issues);
    throw new Error('Drayage-rates extractor output failed schema validation');
  }
  return parsed.data;
}
