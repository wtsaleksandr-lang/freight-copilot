import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { z } from 'zod';
import { loadEnv } from '../config.js';
import { getModel } from './model.js';
import { normalizeUniversalFile, type UniversalFileInput } from './universalFileText.js';

const ChargeSchema = z.object({ name: z.string(), amount: z.number(), currency: z.string() });
const RateSchema = z.object({
  provider_name: z.string(), provider_code: z.string().nullable().optional(),
  cargo_type: z.enum(['general','hazmat','high_value','reefer']).default('general'),
  container_type: z.string(), container_count: z.number().int().positive().default(1), weight_kg: z.number().nullable().optional(),
  origin_type: z.enum(['CY','DOOR']), origin_port_code: z.string().nullable().optional(), origin_port_name: z.string().nullable().optional(), origin_terminal: z.string().nullable().optional(), origin_address: z.string().nullable().optional(), origin_city: z.string().nullable().optional(), origin_state: z.string().nullable().optional(), origin_zip: z.string().nullable().optional(), origin_country: z.string().nullable().optional(),
  destination_type: z.enum(['CY','DOOR']), destination_port_code: z.string().nullable().optional(), destination_port_name: z.string().nullable().optional(), destination_terminal: z.string().nullable().optional(), destination_address: z.string().nullable().optional(), destination_city: z.string().nullable().optional(), destination_state: z.string().nullable().optional(), destination_zip: z.string().nullable().optional(), destination_country: z.string().nullable().optional(),
  base_rate: z.number(), total_cost: z.number(), currency: z.string(), transit_days: z.number().int().nullable().optional(), valid_until: z.string().nullable().optional(), free_time_days: z.number().int().nullable().optional(),
  special_equipment: z.array(z.string()).default([]), accessorials: z.array(z.string()).default([]), charges: z.array(ChargeSchema).default([]), notes: z.string().nullable().optional(), source_filename: z.string(),
});
const ResultSchema = z.object({ rates: z.array(RateSchema), warnings: z.array(z.string()).default([]) });
export type ParsedDrayageRate = z.infer<typeof RateSchema>;

const TOOL = { type:'object', properties:{ rates:{ type:'array', items:{ type:'object', properties:{
  provider_name:{type:'string'}, provider_code:{type:['string','null']}, cargo_type:{type:'string',enum:['general','hazmat','high_value','reefer']}, container_type:{type:'string'}, container_count:{type:'integer'}, weight_kg:{type:['number','null']},
  origin_type:{type:'string',enum:['CY','DOOR']}, origin_port_code:{type:['string','null']}, origin_port_name:{type:['string','null']}, origin_terminal:{type:['string','null']}, origin_address:{type:['string','null']}, origin_city:{type:['string','null']}, origin_state:{type:['string','null']}, origin_zip:{type:['string','null']}, origin_country:{type:['string','null']},
  destination_type:{type:'string',enum:['CY','DOOR']}, destination_port_code:{type:['string','null']}, destination_port_name:{type:['string','null']}, destination_terminal:{type:['string','null']}, destination_address:{type:['string','null']}, destination_city:{type:['string','null']}, destination_state:{type:['string','null']}, destination_zip:{type:['string','null']}, destination_country:{type:['string','null']},
  base_rate:{type:'number'}, total_cost:{type:'number'}, currency:{type:'string'}, transit_days:{type:['integer','null']}, valid_until:{type:['string','null']}, free_time_days:{type:['integer','null']}, special_equipment:{type:'array',items:{type:'string'}}, accessorials:{type:'array',items:{type:'string'}}, charges:{type:'array',items:{type:'object',properties:{name:{type:'string'},amount:{type:'number'},currency:{type:'string'}},required:['name','amount','currency']}}, notes:{type:['string','null']}, source_filename:{type:'string'}
}, required:['provider_name','container_type','origin_type','destination_type','base_rate','total_cost','currency','source_filename'] } }, warnings:{type:'array',items:{type:'string'}} }, required:['rates'] } as const;

export async function parseDrayageRateFiles(files: UniversalFileInput[]) {
  const normalized = files.map(normalizeUniversalFile);
  const content: MessageParam['content'] = [{ type:'text', text:'Extract every distinct container drayage rate. One row per provider/lane/container/rate. CY means port or rail terminal; DOOR means street address. Preserve source filename. Never invent ports, addresses, charges, validity, free time, or amounts. Base rate excludes separately listed mandatory charges; total cost includes them.' }];
  for (const file of normalized) {
    content.push({ type:'text', text:`SOURCE FILE: ${file.filename}` });
    if (file.kind === 'text') content.push({ type:'text', text:file.text!.slice(0,180000) });
    else if (file.kind === 'pdf') content.push({ type:'document', source:{ type:'base64', media_type:'application/pdf', data:file.fileBase64! } });
    else content.push({ type:'image', source:{ type:'base64', media_type:file.mediaType as 'image/png'|'image/jpeg'|'image/webp'|'image/gif', data:file.fileBase64! } });
  }
  const client = new Anthropic({ apiKey: (await (await import('../server/apiKeysService.js')).loadAiKey('anthropic')) ?? loadEnv().ANTHROPIC_API_KEY });
  const response = await client.messages.create({ model:await getModel(), max_tokens:8192, system:'You extract freight-forwarding drayage rates accurately. Distinguish CY and DOOR endpoints. Do not guess missing commercial facts.', tools:[{name:'extract_drayage_rates',description:'Return structured drayage rates.',input_schema:TOOL as never}], tool_choice:{type:'tool',name:'extract_drayage_rates'}, messages:[{role:'user',content}] });
  const tool = response.content.find((block) => block.type === 'tool_use');
  if (!tool || tool.type !== 'tool_use') throw new Error('Drayage-rate extractor did not return structured output');
  const parsed = ResultSchema.parse(tool.input);
  return { ...parsed, normalizedFiles: normalized.map((file) => ({ filename:file.filename, kind:file.kind, warnings:file.warnings })) };
}
