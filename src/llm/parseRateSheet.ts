import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { z } from 'zod';
import { loadEnv } from '../config.js';

import { getModel } from './model.js';
// MODEL resolved per-call below (async)
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const RATE_SHEET_SYSTEM_PROMPT = `You read freight rate sheets — PDFs, screenshots, or scanned documents — that ocean carriers send to forwarders, and you extract every rate they contain into a clean structured form.

CRITICAL RULES:

1. **Identify the carrier first.** Look for the logo, header, footer, or any branding. Output a 3-letter code:
     MSK = Maersk, MSC = MSC, CMA = CMA CGM, HLC = Hapag-Lloyd,
     ONE = ONE Line, OOC = OOCL, ZIM = ZIM, COS = COSCO, EVG = Evergreen,
     YML = Yang Ming, HMM = HMM, PIL = PIL, WHL = Wan Hai
   If you can't identify the carrier with confidence, use "UNK" and put the carrier's literal text in carrier_name_raw.

2. **Separate freight charges from destination charges.** Freight charges (Ocean Freight, BAF, LSS, ENS, ISPS, BUC, PSS, GRI, peak season, security fee, doc fee at origin, etc.) are included in the freight_total. Destination charges (THC at destination, ISPS at destination, doc fee at destination, demurrage, detention, port security at destination, terminal handling DESTINATION, port congestion at destination) are listed separately and NEVER added to freight_total.

3. **Per-container output.** If the sheet shows rates for both 20'GP and 40'HQ on the same lane, output them as TWO separate entries in rates_per_container. Do not collapse or sum them.

4. **Container types — use these codes:**
     20GP = 20 ft general purpose / dry standard / 20DV
     40GP = 40 ft general purpose / dry standard / 40DV
     40HC = 40 ft high cube / 40HQ
     45HC = 45 ft high cube
     20RF = 20 ft reefer
     40RF = 40 ft reefer
     40RH = 40 ft reefer high cube
     20OT = 20 ft open top
     40OT = 40 ft open top
     20FR = 20 ft flat rack
     40FR = 40 ft flat rack
     20TK = 20 ft tank
     40NOR = 40 ft non-operating reefer

5. **Multi-lane sheets.** If the sheet has multiple origin/destination pairs (a typical contract sheet), output every lane as a separate entry in lanes[]. Don't merge lanes.

6. **Currency.** Capture the currency for every charge. Don't assume USD.

7. **Detention & demurrage at destination.** If the sheet states free time at destination (e.g. "14 days free time", "7+7", "combined free time 21 days"), capture detention_freetime_days + demurrage_freetime_days. If only a single combined number is given, put it in detention_freetime_days and leave demurrage null.

8. **Transit time.** Capture transit_days as integer. If a range (e.g. "30-32 days"), use the lower bound.

9. **Validity dates.** Capture validity_from and validity_to in YYYY-MM-DD format if shown.

10. **Be precise with numbers.** Read carefully. A rate sheet's whole purpose is the dollar amounts. Do not round, summarize, or skip charges.

11. **Don't invent.** If a field isn't on the sheet, leave it null.

12. **POL and POD must be SPECIFIC ports — not regions, services, or countries.** Common mistakes to avoid:
    - "Mediterranean" — that's a region/trade name, NOT a port. Look for the actual port (Algeciras, Genoa, Piraeus, Valencia…).
    - "Canada" or "USA" — countries are not ports. Look for the actual port (Montreal, Halifax, New York…).
    - "Far East", "North Europe", "USEC", "USWC" — these are trade lanes, NOT ports.
    - Service names like "MED CANADIAN SERVICE", "MEDCAN", "AE7", "EC1" — these are ROUTES, not ports. Put them in service_name, not in origin/destination.

    If a single sheet covers multiple POLs or PODs (e.g. "Origin: any of Halifax, Montreal, Toronto"), output ONE LANE per (POL, POD) combination. Don't merge them into one row.

    If you genuinely cannot identify a specific port for either side, leave that lane out rather than emit a placeholder. Better to extract fewer accurate lanes than many wrong ones.

13. **Validity dates apply to the whole sheet** — don't repeat per-lane.

Return through the extract_rate_sheet tool.`;

const ChargeSchema = z.object({
  name: z.string(),
  amount: z.number(),
  currency: z.string(),
  basis: z.string().nullable().optional(),
  quantity: z.number().int().nullable().optional(),
  unit_price: z.number().nullable().optional(),
});

const RatesPerContainerSchema = z.object({
  container_type: z.string(),
  freight_charges: z.array(ChargeSchema).default([]),
  freight_total: z.number(),
  freight_currency: z.string(),
  destination_charges: z.array(ChargeSchema).default([]),
  destination_total: z.number().nullable().optional(),
  destination_currency: z.string().nullable().optional(),
});

const LaneSchema = z.object({
  origin: z.string(),
  origin_code: z.string().nullable().optional(),
  destination: z.string(),
  destination_code: z.string().nullable().optional(),
  service_name: z.string().nullable().optional(),
  vessel_voyage: z.string().nullable().optional(),
  transit_days: z.number().int().nullable().optional(),
  detention_freetime_days: z.number().int().nullable().optional(),
  demurrage_freetime_days: z.number().int().nullable().optional(),
  rates_per_container: z.array(RatesPerContainerSchema).min(1),
});

const RateSheetSchema = z.object({
  carrier_code: z.string(),
  carrier_name_raw: z.string().nullable().optional(),
  validity_from: z.string().nullable().optional(),
  validity_to: z.string().nullable().optional(),
  lanes: z.array(LaneSchema),
  notes: z.string().nullable().optional(),
});

export type RateSheetResult = z.infer<typeof RateSheetSchema>;

const RATE_SHEET_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    carrier_code: {
      type: 'string',
      description:
        '3-letter carrier code (MSK/MSC/CMA/HLC/ONE/OOC/ZIM/COS/EVG/YML/HMM/PIL/WHL/UNK).',
    },
    carrier_name_raw: { type: ['string', 'null'] },
    validity_from: { type: ['string', 'null'] },
    validity_to: { type: ['string', 'null'] },
    lanes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          origin: { type: 'string' },
          origin_code: { type: ['string', 'null'] },
          destination: { type: 'string' },
          destination_code: { type: ['string', 'null'] },
          service_name: { type: ['string', 'null'] },
          vessel_voyage: { type: ['string', 'null'] },
          transit_days: { type: ['integer', 'null'] },
          detention_freetime_days: { type: ['integer', 'null'] },
          demurrage_freetime_days: { type: ['integer', 'null'] },
          rates_per_container: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                container_type: { type: 'string' },
                freight_charges: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      amount: { type: 'number' },
                      currency: { type: 'string' },
                      basis: { type: ['string', 'null'] },
                      quantity: { type: ['integer', 'null'] },
                      unit_price: { type: ['number', 'null'] },
                    },
                    required: ['name', 'amount', 'currency'],
                  },
                },
                freight_total: { type: 'number' },
                freight_currency: { type: 'string' },
                destination_charges: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      amount: { type: 'number' },
                      currency: { type: 'string' },
                      basis: { type: ['string', 'null'] },
                      quantity: { type: ['integer', 'null'] },
                      unit_price: { type: ['number', 'null'] },
                    },
                    required: ['name', 'amount', 'currency'],
                  },
                },
                destination_total: { type: ['number', 'null'] },
                destination_currency: { type: ['string', 'null'] },
              },
              required: ['container_type', 'freight_total', 'freight_currency'],
            },
          },
        },
        required: ['origin', 'destination', 'rates_per_container'],
      },
    },
    notes: { type: ['string', 'null'] },
  },
  required: ['carrier_code', 'lanes'],
} as const;

export type RateSheetMediaType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

export interface RateSheetInput {
  /** Base64-encoded file content (no data: prefix). */
  fileBase64: string;
  mediaType: RateSheetMediaType;
  /** Original filename (kept for diagnostics; not used in the LLM call). */
  filename?: string;
}

export async function parseRateSheet(
  input: RateSheetInput
): Promise<RateSheetResult> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error('ANTHROPIC_API_KEY is still the placeholder.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const isPdf = input.mediaType === 'application/pdf';
  const userMessage: MessageParam = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          'Extract every rate from this freight rate sheet. ' +
          'Read carefully — the dollar amounts are the whole point. ' +
          'Output one entry in rates_per_container per container size. ' +
          'Keep destination charges strictly separate from freight charges.',
      },
      isPdf
        ? {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: input.fileBase64,
            },
          }
        : {
            type: 'image',
            source: {
              type: 'base64',
              media_type: input.mediaType as
                | 'image/png'
                | 'image/jpeg'
                | 'image/webp'
                | 'image/gif',
              data: input.fileBase64,
            },
          },
    ],
  };

  console.log(
    `[parseRateSheet] Calling Claude (${input.mediaType}, ${Math.round(input.fileBase64.length / 1024)} KB base64)...`
  );

  const response = await client.messages.create({
    model: await getModel(),
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: RATE_SHEET_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'extract_rate_sheet',
        description: 'Return the structured rates extracted from the document.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: RATE_SHEET_TOOL_SCHEMA as any,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_rate_sheet' },
    messages: [userMessage],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a tool_use block');
  }
  const parsed = RateSheetSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    console.error('[parseRateSheet] Zod issues:', parsed.error.issues);
    throw new Error('Rate-sheet extractor output failed schema validation');
  }
  const totalLanes = parsed.data.lanes.length;
  const totalRates = parsed.data.lanes.reduce(
    (n, l) => n + l.rates_per_container.length,
    0
  );
  console.log(
    `[parseRateSheet] ${parsed.data.carrier_code} — ${totalLanes} lane(s), ${totalRates} rate row(s).`
  );
  return parsed.data;
}
