import { z } from 'zod';
import type { RateOption } from '../types.js';
import {
  PARSE_RATES_SYSTEM_PROMPT,
  PARSE_RATES_TOOL_NAME,
  PARSE_RATES_TOOL_SCHEMA,
} from './prompts.js';

import { callAiTool } from './callAiTool.js';

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
  console.log('[parseRates] Calling AI provider to parse aria tree...');

  const toolInput = await callAiTool({
    system: PARSE_RATES_SYSTEM_PROMPT,
    content: `Parse the rate options from this Maersk Spot sailings page. Return via the parse_rate_options tool.\n\n${ariaTree}`,
    tool: {
      name: PARSE_RATES_TOOL_NAME,
      description:
        'Return the list of ocean freight rate options extracted from the accessibility tree.',
      input_schema: PARSE_RATES_TOOL_SCHEMA,
    },
    maxTokens: 4096,
  });

  const parsed = ParseResponseSchema.safeParse(toolInput);
  if (!parsed.success) {
    console.error('[parseRates] Zod validation failed:', parsed.error.issues);
    throw new Error('Tool output failed schema validation');
  }

  console.log(`[parseRates] Parsed ${parsed.data.rates.length} rate option(s).`);

  return parsed.data.rates;
}
