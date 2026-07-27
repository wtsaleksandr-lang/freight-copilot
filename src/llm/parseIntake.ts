import { z } from 'zod';

import { callAiTool, type AiContentBlock } from './callAiTool.js';

const INTAKE_SYSTEM_PROMPT = `You are an intake assistant for an ocean freight forwarder.
You receive a message or screenshot from a client requesting a quote, and you extract the
shipment details into a structured form.

Each shipment has an ORIGIN and a DESTINATION. Each side is either:
- CY: a port / container yard / terminal — capture port code + name + optional terminal
- DOOR: a street address — capture full address fields

Target fields:

- cargoType: 'general' | 'hazmat' | 'high_value' | 'reefer'. Default 'general' if not stated. 'hazmat' for DG / dangerous goods. 'high_value' for "high value", electronics, jewelry, white-glove. 'reefer' if temperature controlled.
- container: Maersk container label.
    "20ft", "20'", "20 STD"  -> "20 Dry Standard"
    "40ft", "40'", "40 STD"  -> "40 Dry Standard"
    "40HC", "40 high cube"   -> "40 Dry High"
    "20 reefer" -> "20 Reefer", "40 reefer" -> "40 Reefer"
- weight: cargo weight per container in kg. Convert tonnes (×1000). Null if unstated.
- commodity: what's being shipped. Null if unstated.

- from: short legacy display name for the origin (city or port). Used by the autocomplete in the carrier portal.
- fromRegion: state/country disambiguator for "from".
- to: short legacy display name for the destination.
- toRegion: state/country disambiguator for "to".

- originType: 'CY' or 'DOOR'. For typical ocean port-to-port, both are 'CY'. If client explicitly says "pickup at our facility" / "door pickup" / gives a street address as the origin, use 'DOOR'.
- originPortCode, originPortName, originTerminal — when originType is CY.
- originAddressLine1, originCity, originState, originZip, originCountry — when originType is DOOR.

- destinationType, destinationPortCode/PortName/Terminal, or destinationAddress* — same pattern.

- notes: ready dates, urgency, container count, anything else worth keeping.
- confidence: 'high' if all key fields were explicit; 'medium' if some inferred; 'low' if a lot of guessing.
- documentType: "quote_request" when this is a customer/shipper request asking you to quote (the normal case for this intake); "rate_sheet" when the dropped file is actually a carrier/NVOCC ocean RATE SHEET or rate quotation (a pricing list to keep as reference, NOT a request to quote); "other" for anything else. When unsure, prefer "quote_request".

Rules:
- Be conservative. Null beats a guess. The user reviews and corrects manually.
- Default originType to 'CY' and destinationType to 'CY' for port-to-port ocean unless the email clearly says otherwise.
- Do not invent port codes or addresses.

Return through the parse_quote_intake tool.`;

const INTAKE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    cargoType: {
      type: ['string', 'null'],
      enum: ['general', 'hazmat', 'high_value', 'reefer', null],
    },
    container: { type: ['string', 'null'] },
    weight: { type: ['number', 'null'] },
    commodity: { type: ['string', 'null'] },

    from: { type: ['string', 'null'] },
    fromRegion: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    toRegion: { type: ['string', 'null'] },

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

    notes: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    documentType: {
      type: ['string', 'null'],
      enum: ['rate_sheet', 'quote_request', 'other', null],
    },
  },
  required: [
    'cargoType',
    'from',
    'fromRegion',
    'to',
    'toRegion',
    'originType',
    'destinationType',
    'container',
    'weight',
    'commodity',
    'notes',
    'confidence',
  ],
} as const;

const IntakeSchema = z.object({
  cargoType: z.enum(['general', 'hazmat', 'high_value', 'reefer']).nullable(),
  from: z.string().nullable(),
  fromRegion: z.string().nullable(),
  to: z.string().nullable(),
  toRegion: z.string().nullable(),
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
  container: z.string().nullable(),
  weight: z.number().nullable(),
  commodity: z.string().nullable(),
  notes: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  // Mis-drop safety net: classifies whether the dropped file is actually a
  // rate sheet (vs the expected client quote request). Additive/optional so
  // existing extraction is unaffected. Frontend offers to re-route if so.
  documentType: z
    .enum(['rate_sheet', 'quote_request', 'other'])
    .nullable()
    .optional()
    .default('quote_request'),
});

export type IntakeResult = z.infer<typeof IntakeSchema>;

export type IntakeInput =
  | { text: string }
  | { imageBase64: string; imageMediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' }
  // Pre-built content blocks (universal file drop: extracted text + notes as a
  // text block, plus image/PDF blocks). Lets one intake carry many files.
  | { content: AiContentBlock[] };

export async function parseIntake(input: IntakeInput): Promise<IntakeResult> {
  const content: AiContentBlock[] =
    'content' in input
      ? input.content
      : 'text' in input
      ? [{ type: 'text', text: `Client request:\n\n${input.text}` }]
      : [
          {
            type: 'text',
            text: 'Extract the quote details from this client message screenshot.',
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: input.imageMediaType,
              data: input.imageBase64,
            },
          },
        ];

  console.log('[parseIntake] Calling AI provider for intake extraction...');

  const toolInput = await callAiTool({
    system: INTAKE_SYSTEM_PROMPT,
    content,
    tool: {
      name: 'parse_quote_intake',
      description:
        'Extract structured lane, container, weight, and commodity info from a client quote request.',
      input_schema: INTAKE_TOOL_SCHEMA,
    },
    maxTokens: 1024,
  });

  const parsed = IntakeSchema.safeParse(toolInput);
  if (!parsed.success) {
    console.error('[parseIntake] Zod validation failed:', parsed.error.issues);
    throw new Error('Intake tool output failed schema validation');
  }

  console.log(`[parseIntake] Done (confidence=${parsed.data.confidence}).`);

  return parsed.data;
}
