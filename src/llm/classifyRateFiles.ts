import { z } from 'zod';
import { callAiTool, type AiContentBlock } from './callAiTool.js';
import { normalizeUniversalFile, type UniversalFileInput } from './universalFileText.js';

const ClassificationSchema = z.object({
  rateType: z.enum(['ocean', 'drayage', 'trucking', 'ambiguous']),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string(),
  alternatives: z.array(z.enum(['ocean', 'drayage', 'trucking'])).default([]),
});

const TOOL = {
  type: 'object',
  properties: {
    rateType: { type: 'string', enum: ['ocean', 'drayage', 'trucking', 'ambiguous'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
    alternatives: { type: 'array', items: { type: 'string', enum: ['ocean', 'drayage', 'trucking'] } },
  },
  required: ['rateType', 'confidence', 'reason', 'alternatives'],
} as const;

export async function classifyRateFiles(files: UniversalFileInput[]) {
  const normalized = files.map(normalizeUniversalFile);
  const content: AiContentBlock[] = [{
    type: 'text',
    text: 'Classify this batch as ocean, drayage, trucking, or ambiguous. Ocean means carrier port-to-port/container ocean freight. Drayage means container trucking tied to a port, rail ramp, terminal, chassis, pre-pull, detention, or CY/door move. Trucking means standalone FTL/LTL, dry van, flatbed, reefer, step deck, hotshot, or broker lane pricing. Use ambiguous when the files contain multiple unrelated modes or the evidence is insufficient. Do not extract rates and do not guess.',
  }];

  for (const file of normalized) {
    content.push({ type: 'text', text: `SOURCE FILE: ${file.filename}` });
    if (file.kind === 'text') content.push({ type: 'text', text: file.text!.slice(0, 120000) });
    else if (file.kind === 'pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.fileBase64! } });
    else content.push({ type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.fileBase64! } });
  }

  const toolInput = await callAiTool({
    system: 'You classify freight rate documents. Accuracy is more important than forcing a category.',
    content,
    tool: { name: 'classify_rate_files', description: 'Return one classification for the supplied rate-file batch.', input_schema: TOOL },
    maxTokens: 1024,
  });
  return {
    ...ClassificationSchema.parse(toolInput),
    files: normalized.map((file) => ({ filename: file.filename, kind: file.kind, warnings: file.warnings })),
  };
}
