import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { loadEnv } from '../config.js';
import type { RateOption } from '../types.js';
import {
  PARSE_RATES_SYSTEM_PROMPT,
  PARSE_RATES_TOOL_NAME,
  PARSE_RATES_TOOL_SCHEMA,
} from './prompts.js';

import { getModel } from './model.js';
// MODEL resolved per-call below (async)
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const ChargeSchema = z.object({
  name: z.string(),
  basis: z.string().nullable(),
  quantity: z.number().int().nullable(),
  unit_price: z.number().nullable(),
  total: z.number(),
  currency: z.string(),
});

const RateOptionSchema = z.object({
  service_name: z.string(),
  sailing_date: z.string().nullable(),
  departure_datetime: z.string().nullable(),
  arrival_datetime: z.string().nullable(),
  gate_in_deadline: z.string().nullable(),
  transit_days: z.number().int().nullable(),
  transit_hours: z.number().int().nullable(),
  vessel_voyage: z.string().nullable(),
  headline_price_amount: z.number().nullable(),
  headline_price_currency: z.string().nullable(),
  rollable: z.boolean(),
  detention_freetime_days: z.number().int().nullable(),
  demurrage_freetime_days: z.number().int().nullable(),
  freight_charges: z.array(ChargeSchema).default([]),
  destination_charges: z.array(ChargeSchema).default([]),
});

const ParseResponseSchema = z.object({
  rates: z.array(RateOptionSchema),
});

export async function parseRates(ariaTree: string): Promise<RateOption[]> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is still the placeholder. Paste a real key from https://console.anthropic.com into .env'
    );
  }

  const client = new Anthropic({ apiKey: (await (await import('../server/apiKeysService.js')).loadAiKey('anthropic')) ?? env.ANTHROPIC_API_KEY });

  console.log('[parseRates] Calling Claude to parse aria tree...');

  const response = await client.messages.create({
    model: await getModel(),
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: PARSE_RATES_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: PARSE_RATES_TOOL_NAME,
        description:
          'Return the list of ocean freight rate options extracted from the accessibility tree.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: PARSE_RATES_TOOL_SCHEMA as any,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: PARSE_RATES_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: `Parse the rate options from this Maersk Spot sailings page. Return via the parse_rate_options tool.\n\n${ariaTree}`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a tool_use block');
  }

  const parsed = ParseResponseSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    console.error('[parseRates] Zod validation failed:', parsed.error.issues);
    throw new Error('Tool output failed schema validation');
  }

  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  const cacheCreate = response.usage.cache_creation_input_tokens ?? 0;
  console.log(
    `[parseRates] Parsed ${parsed.data.rates.length} rate option(s). ` +
      `Tokens: in=${response.usage.input_tokens}, cache_read=${cacheRead}, cache_create=${cacheCreate}, out=${response.usage.output_tokens}`
  );

  return parsed.data.rates;
}
