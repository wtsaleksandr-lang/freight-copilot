import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { z } from 'zod';
import { loadEnv } from '../config.js';

const MODEL = 'claude-sonnet-4-6';
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const SYSTEM_PROMPT = `You read freight forwarder email exchanges, booking briefings, screenshots, and PDFs, and extract the shipment details into a structured form.

Target fields (all optional — leave null if not stated):

- shipper_name: the company sending the cargo (origin / consignor).
- receiver_name: the company receiving the cargo (destination / consignee).
- customer_name: the user's actual paying customer. Often the shipper, sometimes the receiver, sometimes a third-party broker. If only one party is named, use that one for both customer_name and the appropriate shipper/receiver field. If multiple are named, prefer whoever is addressing the freight forwarder directly.
- loading_address: the physical pickup address (street, city, state/region, country, ZIP) at origin. Be specific — a full address is better than just a city.
- pol: port of loading (specific port name, e.g. "Charleston", "Montreal", "Shanghai"). NOT a region (Mediterranean, Far East), NOT a country (USA, China). If only an inland origin is given, leave pol null.
- pol_code: UN/LOCODE for POL if mentioned (e.g. "USCHS").
- pod: port of discharge (destination port, e.g. "Hamburg", "Constanta", "Izmir"). Same rules as pol — must be a specific port.
- pod_code: UN/LOCODE for POD if mentioned (e.g. "DEHAM").
- container_type: 20GP / 40GP / 40HC / 20RF / 40RF / 40RH / 40NOR / 20OT / 40OT / 20FR / 40FR / 20TK. Translate equivalents: "20'std", "20DV", "20 dry standard" → 20GP. "40HQ", "40' high cube" → 40HC. If multiple types, list them comma-separated (e.g. "20GP, 40HC").
- cargo_type: 'general' / 'hazmat' / 'reefer' / 'oog' (out-of-gauge) / 'high_value'. Default 'general' unless explicitly stated.
- cargo_name: human-readable description of what's being shipped (e.g. "auto parts", "frozen seafood", "machinery", "personal effects"). Free text.
- sold_rate: the price quoted to the customer in numeric form (no currency symbol). If multiple rates appear (e.g. one per container size), pick the one that's clearly "the agreed rate" or highest-priority — use notes for the rest.
- sold_currency: 'USD' / 'CAD' / 'EUR' / 'GBP' / etc. Default 'USD'.
- carrier_preference: which ocean carrier was preferred or selected (Maersk, MSC, CMA CGM, Hapag-Lloyd, ONE, OOCL, ZIM, COSCO, etc.). Use the carrier's full name or 3-letter code (MSK/MSC/CMA/HLC/ONE/OOC/ZIM/COS).
- notes: anything else worth keeping — secondary rates, ready dates, reefer temp, special instructions, document references. Keep concise (2-3 sentences max).

Rules:
- Be conservative. Null beats a guess.
- If multiple pages or images describe ONE shipment, merge into a single record.
- If they describe MULTIPLE shipments, only output the first one (caller will re-call for additional shipments).
- Do not invent ports, addresses, or carrier names.

Return through the extract_shipment_briefing tool.`;

const ShipmentSchema = z.object({
  shipper_name: z.string().nullable().optional(),
  receiver_name: z.string().nullable().optional(),
  customer_name: z.string().nullable().optional(),
  loading_address: z.string().nullable().optional(),
  pol: z.string().nullable().optional(),
  pol_code: z.string().nullable().optional(),
  pod: z.string().nullable().optional(),
  pod_code: z.string().nullable().optional(),
  container_type: z.string().nullable().optional(),
  cargo_type: z.string().nullable().optional(),
  cargo_name: z.string().nullable().optional(),
  sold_rate: z.number().nullable().optional(),
  sold_currency: z.string().nullable().optional(),
  carrier_preference: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type ShipmentBriefing = z.infer<typeof ShipmentSchema>;

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    shipper_name: { type: ['string', 'null'] },
    receiver_name: { type: ['string', 'null'] },
    customer_name: { type: ['string', 'null'] },
    loading_address: { type: ['string', 'null'] },
    pol: { type: ['string', 'null'] },
    pol_code: { type: ['string', 'null'] },
    pod: { type: ['string', 'null'] },
    pod_code: { type: ['string', 'null'] },
    container_type: { type: ['string', 'null'] },
    cargo_type: { type: ['string', 'null'] },
    cargo_name: { type: ['string', 'null'] },
    sold_rate: { type: ['number', 'null'] },
    sold_currency: { type: ['string', 'null'] },
    carrier_preference: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
  },
  required: [],
} as const;

export type BriefingMediaType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

export interface BriefingFile {
  fileBase64: string;
  mediaType: BriefingMediaType;
  filename?: string;
}

/**
 * Extract one shipment record from a set of email screenshots / PDFs.
 * All files are sent to Claude in a single call — they describe the
 * same shipment together (e.g. one booking thread split across multiple
 * screenshots).
 */
export async function parseShipmentBriefing(
  files: BriefingFile[]
): Promise<ShipmentBriefing> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error('ANTHROPIC_API_KEY is still the placeholder.');
  }
  if (files.length === 0) {
    throw new Error('No files provided to parseShipmentBriefing');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const content: Array<{ type: string; [k: string]: unknown }> = [
    {
      type: 'text',
      text:
        files.length === 1
          ? 'Extract the shipment details from this document.'
          : `Extract the shipment details from these ${files.length} documents — they describe ONE shipment together.`,
    },
  ];
  for (const f of files) {
    if (f.mediaType === 'application/pdf') {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: f.fileBase64,
        },
      });
    } else {
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

  console.log(
    `[parseShipmentBriefing] Calling Claude with ${files.length} file(s)…`
  );

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'extract_shipment_briefing',
        description: 'Return structured shipment fields extracted from the documents.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: TOOL_SCHEMA as any,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_shipment_briefing' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: 'user', content: content as any }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a tool_use block');
  }
  const parsed = ShipmentSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    console.error('[parseShipmentBriefing] Zod issues:', parsed.error.issues);
    throw new Error('Briefing extractor output failed schema validation');
  }
  return parsed.data;
}
