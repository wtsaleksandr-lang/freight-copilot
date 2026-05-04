import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { z } from 'zod';
import { loadEnv } from '../config.js';

import { getModel } from './model.js';
// MODEL resolved per-call below (async)
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const SYSTEM_PROMPT = `You are an intake assistant for an ocean freight forwarder, parsing drayage requests
(port ↔ address container truck moves) from emails or chat messages.

Drayage has an "origin" and a "destination". Each side is either:
- CY: a port / container yard / terminal (use port code + name + optional specific terminal)
- DOOR: a street address (warehouse, factory, customer site)

Typical patterns:
- Import drayage: origin CY (port the container arrived at) → destination DOOR (consignee)
- Export drayage: origin DOOR (shipper) → destination CY (port the container leaves from)
- Mixed: rare (port-to-port truck or yard-to-yard reposition) — still capture both ends.

Cargo types you classify into:
- 'general' — default, regular dry cargo
- 'hazmat' — DG / hazmat / dangerous goods mentioned
- 'high_value' — high-value goods, electronics, jewelry, anything mentioning "high value" / "white-glove"
- 'reefer' — refrigerated/temperature-controlled

Container types — map client wording to standard labels (extend as needed):
"20ft", "20 std", "20'" -> "20 Dry Standard"
"40ft", "40 std", "40'" -> "40 Dry Standard"
"40HC", "40 high cube" -> "40 Dry High"
"20 reefer" -> "20 Reefer"
"40 reefer" -> "40 Reefer"

Other extracted fields:
- containerCount (default 1 if not stated)
- weightKg (convert from tons -> *1000)
- pickupDate, deliveryDate (ISO YYYY-MM-DD; "next Monday" -> resolve to actual date if obvious, else null)
- specialEquipment[] — tri-axle, gen-set, hazmat permit, overweight permit, etc.
- accessorials[] — prepull, storage, detention notes
- clientName, notes

Rules:
- Be conservative: leave a field null rather than guess. The user will manually fill anything you missed.
- Do NOT invent port codes or addresses. If the email says "Newark" but no specific terminal, use port code "USEWR" and leave terminal null.
- Distinguish carefully: "delivery to 1234 Main St, Chicago" = DESTINATION DOOR. "Pickup from APM Terminals Newark" = ORIGIN CY.
- Set readiness 'ready_to_run' if all required-for-run fields look present (cargo type, container, both ends fully populated). Otherwise 'needs_review' with a brief reason.

Return via the parse_drayage_intake tool.`;

const PARSE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    cargoType: {
      type: ['string', 'null'],
      enum: ['general', 'hazmat', 'high_value', 'reefer', null],
    },
    containerType: { type: ['string', 'null'] },
    containerCount: { type: ['integer', 'null'] },
    weightKg: { type: ['number', 'null'] },

    originType: { type: ['string', 'null'], enum: ['CY', 'DOOR', null] },
    originPortCode: { type: ['string', 'null'] },
    originPortName: { type: ['string', 'null'] },
    originTerminal: { type: ['string', 'null'] },
    originAddressLine1: { type: ['string', 'null'] },
    originCity: { type: ['string', 'null'] },
    originState: { type: ['string', 'null'] },
    originZip: { type: ['string', 'null'] },
    originCountry: { type: ['string', 'null'] },

    destinationType: { type: ['string', 'null'], enum: ['CY', 'DOOR', null] },
    destinationPortCode: { type: ['string', 'null'] },
    destinationPortName: { type: ['string', 'null'] },
    destinationTerminal: { type: ['string', 'null'] },
    destinationAddressLine1: { type: ['string', 'null'] },
    destinationCity: { type: ['string', 'null'] },
    destinationState: { type: ['string', 'null'] },
    destinationZip: { type: ['string', 'null'] },
    destinationCountry: { type: ['string', 'null'] },

    pickupDate: { type: ['string', 'null'] },
    deliveryDate: { type: ['string', 'null'] },
    specialEquipment: { type: 'array', items: { type: 'string' } },
    accessorials: { type: 'array', items: { type: 'string' } },
    clientName: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    readiness: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ready_to_run', 'needs_review'] },
        reason: { type: 'string' },
      },
      required: ['status', 'reason'],
    },
  },
  required: [
    'cargoType',
    'containerType',
    'containerCount',
    'weightKg',
    'originType',
    'destinationType',
    'specialEquipment',
    'accessorials',
    'readiness',
  ],
} as const;

const Schema = z.object({
  cargoType: z.enum(['general', 'hazmat', 'high_value', 'reefer']).nullable(),
  containerType: z.string().nullable(),
  containerCount: z.number().int().nullable(),
  weightKg: z.number().nullable(),
  originType: z.enum(['CY', 'DOOR']).nullable(),
  originPortCode: z.string().nullable().optional(),
  originPortName: z.string().nullable().optional(),
  originTerminal: z.string().nullable().optional(),
  originAddressLine1: z.string().nullable().optional(),
  originCity: z.string().nullable().optional(),
  originState: z.string().nullable().optional(),
  originZip: z.string().nullable().optional(),
  originCountry: z.string().nullable().optional(),
  destinationType: z.enum(['CY', 'DOOR']).nullable(),
  destinationPortCode: z.string().nullable().optional(),
  destinationPortName: z.string().nullable().optional(),
  destinationTerminal: z.string().nullable().optional(),
  destinationAddressLine1: z.string().nullable().optional(),
  destinationCity: z.string().nullable().optional(),
  destinationState: z.string().nullable().optional(),
  destinationZip: z.string().nullable().optional(),
  destinationCountry: z.string().nullable().optional(),
  pickupDate: z.string().nullable().optional(),
  deliveryDate: z.string().nullable().optional(),
  specialEquipment: z.array(z.string()),
  accessorials: z.array(z.string()),
  clientName: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  readiness: z.object({
    status: z.enum(['ready_to_run', 'needs_review']),
    reason: z.string(),
  }),
});

export type DrayageIntake = z.infer<typeof Schema>;

export type DrayageIntakeInput =
  | { text: string }
  | {
      imageBase64: string;
      imageMediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    };

export async function parseDrayageIntake(
  input: DrayageIntakeInput
): Promise<DrayageIntake> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error('ANTHROPIC_API_KEY is still the placeholder.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const userMessage: MessageParam =
    'text' in input
      ? {
          role: 'user',
          content: [
            { type: 'text', text: `Drayage request:\n\n${input.text}` },
          ],
        }
      : {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract drayage details from this client message screenshot.',
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: input.imageMediaType,
                data: input.imageBase64,
              },
            },
          ],
        };

  console.log('[parseDrayageIntake] Calling Claude...');
  const response = await client.messages.create({
    model: await getModel(),
    max_tokens: 1500,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      {
        name: 'parse_drayage_intake',
        description: 'Extract structured drayage form fields from the email/screenshot.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: PARSE_TOOL_SCHEMA as any,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: 'parse_drayage_intake' },
    messages: [userMessage],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a tool_use block');
  }
  const parsed = Schema.safeParse(toolUse.input);
  if (!parsed.success) {
    console.error('[parseDrayageIntake] Zod issues:', parsed.error.issues);
    throw new Error('Drayage intake validation failed');
  }
  console.log(
    `[parseDrayageIntake] Done — readiness=${parsed.data.readiness.status}`
  );
  return parsed.data;
}
