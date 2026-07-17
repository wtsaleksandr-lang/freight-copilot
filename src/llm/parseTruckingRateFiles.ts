import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { loadEnv } from '../config.js';
import { getModel } from './model.js';
import { normalizeUniversalFile, type UniversalFileInput } from './universalFileText.js';

const RateSchema = z.object({
  provider_name: z.string(),
  provider_code: z.string().nullable().optional(),
  mode: z.enum(['ftl', 'ltl']),
  equipment_type: z.string(),
  pickup_address: z.string().nullable().optional(),
  pickup_city: z.string(),
  pickup_state: z.string().nullable().optional(),
  pickup_zip: z.string().nullable().optional(),
  pickup_country: z.string().default('US'),
  delivery_address: z.string().nullable().optional(),
  delivery_city: z.string(),
  delivery_state: z.string().nullable().optional(),
  delivery_zip: z.string().nullable().optional(),
  delivery_country: z.string().default('US'),
  cargo_type: z.enum(['general', 'hazmat', 'high_value', 'reefer']).default('general'),
  hazmat: z.boolean().default(false),
  temp_controlled: z.boolean().default(false),
  weight_kg: z.number().nullable().optional(),
  base_rate: z.number(),
  total_cost: z.number(),
  currency: z.string(),
  rate_per_mile: z.number().nullable().optional(),
  total_miles: z.number().int().nullable().optional(),
  transit_days: z.number().int().nullable().optional(),
  valid_until: z.string().nullable().optional(),
  charges: z.array(z.object({ name: z.string(), amount: z.number(), currency: z.string() })).default([]),
  notes: z.string().nullable().optional(),
  source_filename: z.string(),
});

const ResultSchema = z.object({ rates: z.array(RateSchema), warnings: z.array(z.string()).default([]) });
export type ParsedTruckingRate = z.infer<typeof RateSchema>;

const TOOL = {
  type: 'object',
  properties: {
    rates: { type: 'array', items: { type: 'object', properties: {
      provider_name: { type: 'string' }, provider_code: { type: ['string','null'] }, mode: { type: 'string', enum: ['ftl','ltl'] },
      equipment_type: { type: 'string' }, pickup_address: { type: ['string','null'] }, pickup_city: { type: 'string' }, pickup_state: { type: ['string','null'] }, pickup_zip: { type: ['string','null'] }, pickup_country: { type: 'string' },
      delivery_address: { type: ['string','null'] }, delivery_city: { type: 'string' }, delivery_state: { type: ['string','null'] }, delivery_zip: { type: ['string','null'] }, delivery_country: { type: 'string' },
      cargo_type: { type: 'string', enum: ['general','hazmat','high_value','reefer'] }, hazmat: { type: 'boolean' }, temp_controlled: { type: 'boolean' }, weight_kg: { type: ['number','null'] },
      base_rate: { type: 'number' }, total_cost: { type: 'number' }, currency: { type: 'string' }, rate_per_mile: { type: ['number','null'] }, total_miles: { type: ['integer','null'] }, transit_days: { type: ['integer','null'] }, valid_until: { type: ['string','null'] },
      charges: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' } }, required: ['name','amount','currency'] } }, notes: { type: ['string','null'] }, source_filename: { type: 'string' }
    }, required: ['provider_name','mode','equipment_type','pickup_city','delivery_city','base_rate','total_cost','currency','source_filename'] } },
    warnings: { type: 'array', items: { type: 'string' } }
  }, required: ['rates']
} as const;

export async function parseTruckingRateFiles(files: UniversalFileInput[]) {
  const normalized = files.map(normalizeUniversalFile);
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: 'Extract every distinct ground-trucking rate from the attached files. These may be emails, spreadsheets, Word documents, PDFs, screenshots, CSV exports, or presentations. One row per lane/equipment/rate. Never invent missing values. Preserve each source filename. Base rate excludes listed accessorials; total cost includes mandatory listed charges. Use ISO YYYY-MM-DD dates. If a file has no usable trucking rate, add a warning.' }];
  for (const file of normalized) {
    content.push({ type: 'text', text: `SOURCE FILE: ${file.filename}` });
    if (file.kind === 'text') content.push({ type: 'text', text: file.text!.slice(0, 180000) });
    else if (file.kind === 'pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.fileBase64! } });
    else content.push({ type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.fileBase64! } });
  }
  const env = loadEnv();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: await getModel(), max_tokens: 8192,
    system: 'You are a freight-forwarding trucking-rate data extractor. Accuracy is more important than quantity. Do not convert currencies or guess lanes, equipment, mileage, dates, or charges.',
    tools: [{ name: 'extract_trucking_rates', description: 'Return structured trucking rates from all supplied files.', input_schema: TOOL as never }],
    tool_choice: { type: 'tool', name: 'extract_trucking_rates' },
    messages: [{ role: 'user', content: content as never }]
  });
  const tool = response.content.find((b) => b.type === 'tool_use');
  if (!tool || tool.type !== 'tool_use') throw new Error('Trucking-rate extractor did not return structured output');
  const parsed = ResultSchema.parse(tool.input);
  return { ...parsed, normalizedFiles: normalized.map((f) => ({ filename: f.filename, kind: f.kind, warnings: f.warnings })) };
}
