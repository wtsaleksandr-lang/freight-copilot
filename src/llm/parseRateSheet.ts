import { z } from 'zod';
import { executeStructuredAiTask } from './sharedAiExecutor.js';

const RATE_SHEET_SYSTEM_PROMPT = `You read freight rate sheets supplied to freight forwarders and extract every lane and rate into structured JSON.

Rules:
1. Identify the ocean carrier from branding. Use MSK, MSC, CMA, HLC, ONE, OOC, ZIM, COS, EVG, YML, HMM, PIL, WHL or UNK.
2. Keep destination charges separate from freight charges and never add destination charges to freight_total.
3. Return one rates_per_container entry for every equipment size shown.
4. Normalize equipment codes to 20GP, 40GP, 40HC, 45HC, 20RF, 40RF, 40RH, 20OT, 40OT, 20FR, 40FR, 20TK or 40NOR.
5. Return every specific POL/POD combination as its own lane. Regions, countries and service names are not ports.
6. Preserve each charge currency. Do not assume USD.
7. Capture destination detention and demurrage free time when stated.
8. Capture transit_days as an integer; for a range use the lower value.
9. Return validity dates as YYYY-MM-DD when shown.
10. Read amounts exactly. Do not round, summarize, skip or invent charges — including surcharges and fees that appear ONLY in prose, footnotes or a "Notes" section, not just the charge tables.
11. Charges are frequently written as prose, e.g. "Subject to <name>: <amount> <currency> per Bill of Lading" (or per container / per shipment). These are REAL charges — never skip them. Put each into freight_charges (origin, documentation, security-manifest, B/L and other freight-side fees) or destination_charges (destination fees) with basis set to the stated per-unit basis plus any condition, e.g. "per Bill of Lading" or "per Bill of Lading; only on service WC4". Be consistent across currencies: if you fold a "per Bill of Lading" fee into a total for one side (e.g. a destination documentation fee), do the same for the freight side (e.g. security-manifest and document fees).
12. Include per-Bill-of-Lading document/security/B-L fees in the matching total for ONE Bill of Lading, EXCEPT charges gated by a condition that clearly does not apply to this lane/service — capture those as line items but keep them out of the total.
13. Leave fields null when unsupported by the source.
14. Return JSON only.`;

const ChargeSchema = z.object({
  name: z.string(), amount: z.number(), currency: z.string(),
  basis: z.string().nullable().optional(), quantity: z.number().int().nullable().optional(), unit_price: z.number().nullable().optional(),
});
const RatesPerContainerSchema = z.object({
  container_type: z.string(), freight_charges: z.array(ChargeSchema).default([]), freight_total: z.number(), freight_currency: z.string(),
  destination_charges: z.array(ChargeSchema).default([]), destination_total: z.number().nullable().optional(), destination_currency: z.string().nullable().optional(),
});
const LaneSchema = z.object({
  origin: z.string(), origin_code: z.string().nullable().optional(), destination: z.string(), destination_code: z.string().nullable().optional(),
  service_name: z.string().nullable().optional(), vessel_voyage: z.string().nullable().optional(), transit_days: z.number().int().nullable().optional(),
  detention_freetime_days: z.number().int().nullable().optional(), demurrage_freetime_days: z.number().int().nullable().optional(),
  rates_per_container: z.array(RatesPerContainerSchema).min(1),
});
const RateSheetSchema = z.object({
  carrier_code: z.string(), carrier_name_raw: z.string().nullable().optional(), validity_from: z.string().nullable().optional(),
  validity_to: z.string().nullable().optional(), lanes: z.array(LaneSchema), notes: z.string().nullable().optional(),
});

export type RateSheetResult = z.infer<typeof RateSheetSchema>;
export type RateSheetMediaType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export interface RateSheetInput { fileBase64: string; mediaType: RateSheetMediaType; filename?: string; }

const SCHEMA_DESCRIPTION = `{
  "carrier_code": "string",
  "carrier_name_raw": "string|null",
  "validity_from": "YYYY-MM-DD|null",
  "validity_to": "YYYY-MM-DD|null",
  "lanes": [{
    "origin": "specific port",
    "origin_code": "string|null",
    "destination": "specific port",
    "destination_code": "string|null",
    "service_name": "string|null",
    "vessel_voyage": "string|null",
    "transit_days": "integer|null",
    "detention_freetime_days": "integer|null",
    "demurrage_freetime_days": "integer|null",
    "rates_per_container": [{
      "container_type": "string",
      "freight_charges": [{"name":"string","amount":"number","currency":"string","basis":"string|null","quantity":"integer|null","unit_price":"number|null"}],
      "freight_total": "number",
      "freight_currency": "string",
      "destination_charges": [{"name":"string","amount":"number","currency":"string","basis":"string|null","quantity":"integer|null","unit_price":"number|null"}],
      "destination_total": "number|null",
      "destination_currency": "string|null"
    }]
  }],
  "notes": "string|null"
}`;

export async function parseRateSheet(input: RateSheetInput): Promise<RateSheetResult> {
  console.log(`[parseRateSheet] Routed extraction (${input.mediaType}, ${Math.round(input.fileBase64.length / 1024)} KB base64)`);
  const result = await executeStructuredAiTask({
    kind: 'ocean-rate-sheet-extraction',
    systemPrompt: RATE_SHEET_SYSTEM_PROMPT,
    userPrompt: 'Extract every rate from this document. Keep destination charges strictly separate and preserve exact amounts, currencies, equipment and validity.',
    schemaDescription: SCHEMA_DESCRIPTION,
    media: { mediaType: input.mediaType, base64: input.fileBase64, filename: input.filename },
    highStakes: true,
    validate(value) {
      const parsed = RateSheetSchema.safeParse(value);
      if (!parsed.success) throw new Error(`Rate-sheet output failed schema validation: ${parsed.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
      return parsed.data;
    },
  });
  const laneCount = result.value.lanes.length;
  const rateCount = result.value.lanes.reduce((sum, lane) => sum + lane.rates_per_container.length, 0);
  console.log(`[parseRateSheet] ${result.value.carrier_code}: ${laneCount} lane(s), ${rateCount} rate row(s), ${result.provider}/${result.model}, candidates=${result.candidateCount}, disagreement=${result.disagreement}, estimated=$${result.usage.estimatedCostUsd.toFixed(4)}`);
  return result.value;
}
