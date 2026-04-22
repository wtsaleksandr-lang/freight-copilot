import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { z } from 'zod';
import { loadEnv } from '../config.js';

const MODEL = 'claude-sonnet-4-6';
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const INTAKE_SYSTEM_PROMPT = `You are an intake assistant for an ocean freight forwarder.
You receive a message or screenshot from a client requesting a quote, and you extract the
shipment details into a structured form.

Target fields (all optional — return null if not stated):

- from: city or port of origin (e.g. "Newark", "Shanghai", "CNSHA"). Prefer the city name over the port code.
- fromRegion: state/country to disambiguate the city, e.g. "New Jersey", "China". Only include if explicit or strongly implied.
- to: destination city or port.
- toRegion: destination state/country disambiguator.
- container: Maersk container label. Map client terms to Maersk's:
    "20ft", "20'", "20 STD"  -> "20 Dry Standard"
    "40ft", "40'", "40 STD"  -> "40 Dry Standard"
    "40HC", "40 high cube"   -> "40 Dry High"
    "20 reefer"              -> "20 Reefer Standard"
    "40 reefer"              -> "40 Reefer Standard"
  If unspecified, return null.
- weight: cargo weight **per container** in kg (number). If the client gives total weight,
  divide by number of containers. If in tonnes, multiply by 1000. If not stated, return null.
- commodity: what's being shipped. If unspecified, return null.
- notes: free text for anything else worth knowing — ready dates, container count, urgency, special handling.
- confidence: "high" if all key fields were explicit; "medium" if some were inferred; "low" if a lot of guessing.

Return through the parse_quote_intake tool.`;

const INTAKE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: ['string', 'null'] },
    fromRegion: { type: ['string', 'null'] },
    to: { type: ['string', 'null'] },
    toRegion: { type: ['string', 'null'] },
    container: { type: ['string', 'null'] },
    weight: { type: ['number', 'null'] },
    commodity: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'from',
    'fromRegion',
    'to',
    'toRegion',
    'container',
    'weight',
    'commodity',
    'notes',
    'confidence',
  ],
} as const;

const IntakeSchema = z.object({
  from: z.string().nullable(),
  fromRegion: z.string().nullable(),
  to: z.string().nullable(),
  toRegion: z.string().nullable(),
  container: z.string().nullable(),
  weight: z.number().nullable(),
  commodity: z.string().nullable(),
  notes: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export type IntakeResult = z.infer<typeof IntakeSchema>;

export type IntakeInput =
  | { text: string }
  | { imageBase64: string; imageMediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' };

export async function parseIntake(input: IntakeInput): Promise<IntakeResult> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is still the placeholder. Set a real key in .env'
    );
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const userMessage: MessageParam =
    'text' in input
      ? {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Client request:\n\n${input.text}`,
            },
          ],
        }
      : {
          role: 'user',
          content: [
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
          ],
        };

  console.log('[parseIntake] Calling Claude for intake extraction...');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: INTAKE_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'parse_quote_intake',
        description:
          'Extract structured lane, container, weight, and commodity info from a client quote request.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: INTAKE_TOOL_SCHEMA as any,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: 'parse_quote_intake' },
    messages: [userMessage],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a tool_use block');
  }

  const parsed = IntakeSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    console.error('[parseIntake] Zod validation failed:', parsed.error.issues);
    throw new Error('Intake tool output failed schema validation');
  }

  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  const cacheCreate = response.usage.cache_creation_input_tokens ?? 0;
  console.log(
    `[parseIntake] Done (confidence=${parsed.data.confidence}). ` +
      `Tokens: in=${response.usage.input_tokens}, cache_read=${cacheRead}, cache_create=${cacheCreate}, out=${response.usage.output_tokens}`
  );

  return parsed.data;
}
