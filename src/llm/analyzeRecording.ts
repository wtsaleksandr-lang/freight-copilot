import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { loadEnv } from '../config.js';

const MODEL = 'claude-sonnet-4-6';
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const SYSTEM_PROMPT = `You convert raw Playwright Codegen recordings into a clean, human-readable workflow plus the structured information our system needs to replay it later.

The user pasted a URL into a dashboard, a browser opened, they did a workflow (login / search / form fill / etc.), and Playwright captured every action as JavaScript. Now you read that captured code and produce:

1. A concise human-readable summary (one sentence).
2. Numbered steps in plain English ("1. Navigates to login page. 2. Types username. 3. Clicks Sign in.").
3. Identification of which fields are PARAMETERIZED — i.e. things the user would change for each run (origin, destination, container type, weight, dates) vs things that stay the same (their username, fixed buttons).
4. A "ready" assessment: "ready_to_replay" if the recording looks complete and replayable, "needs_review" if something seems missing or off, with a brief reason.

Skip:
- The Playwright boilerplate (test wrappers, imports).
- Obviously broken steps (like recordings that ended mid-action).
- Sensitive values like passwords — describe them as "<your password>" instead of the actual string.

Return via the analyze_recording tool.`;

const ANALYZE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One sentence describing what the workflow does.' },
    starting_url: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          description: { type: 'string', description: 'Plain English what this step does.' },
          playwright_call: { type: 'string', description: 'The corresponding Playwright code, trimmed.' },
        },
        required: ['n', 'description', 'playwright_call'],
      },
    },
    parameters: {
      type: 'array',
      description: 'Inputs the user changes for each run (lane, container, etc.).',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short identifier, e.g. "origin"' },
          description: { type: 'string' },
          example_value: { type: 'string' },
          step_number: { type: 'integer', description: 'Which step uses this parameter.' },
        },
        required: ['name', 'description', 'example_value', 'step_number'],
      },
    },
    readiness: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ready_to_replay', 'needs_review'] },
        reason: { type: 'string' },
      },
      required: ['status', 'reason'],
    },
  },
  required: ['summary', 'starting_url', 'steps', 'parameters', 'readiness'],
} as const;

const AnalysisSchema = z.object({
  summary: z.string(),
  starting_url: z.string(),
  steps: z.array(
    z.object({
      n: z.number().int(),
      description: z.string(),
      playwright_call: z.string(),
    })
  ),
  parameters: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      example_value: z.string(),
      step_number: z.number().int(),
    })
  ),
  readiness: z.object({
    status: z.enum(['ready_to_replay', 'needs_review']),
    reason: z.string(),
  }),
});

export type RecordingAnalysis = z.infer<typeof AnalysisSchema> & {
  /** Path to the saved analysis JSON. */
  saved_to: string;
  /** Original recording context. */
  recorded_url: string;
  carrier_code: string | null;
  description: string | null;
};

export interface AnalyzeRecordingInput {
  recordingPath: string;
  recordingCode: string;
  url: string;
  carrierCode: string | null;
  description: string | null;
}

export async function analyzeRecording(
  input: AnalyzeRecordingInput
): Promise<RecordingAnalysis> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error('ANTHROPIC_API_KEY is still the placeholder.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const carrierContext = input.carrierCode
    ? `\nThis recording was captured during onboarding for carrier code ${input.carrierCode}.`
    : '';
  const descContext = input.description ? `\nUser's description: ${input.description}` : '';

  console.log('[analyzeRecording] Sending recording to Claude...');
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      {
        name: 'analyze_recording',
        description: 'Return the structured analysis of the recording.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: ANALYZE_TOOL_SCHEMA as any,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: 'analyze_recording' },
    messages: [
      {
        role: 'user',
        content:
          `Recorded against URL: ${input.url}` +
          carrierContext +
          descContext +
          `\n\nPlaywright Codegen output:\n\`\`\`javascript\n${input.recordingCode}\n\`\`\``,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a tool_use block');
  }
  const parsed = AnalysisSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    console.error('[analyzeRecording] Zod issues:', parsed.error.issues);
    throw new Error('Analyzer output failed schema validation');
  }

  // Save analysis next to the raw recording.
  const savedTo = input.recordingPath.replace(/\.ts$/, '.analysis.json');
  const full: RecordingAnalysis = {
    ...parsed.data,
    saved_to: savedTo,
    recorded_url: input.url,
    carrier_code: input.carrierCode,
    description: input.description,
  };
  await writeFile(savedTo, JSON.stringify(full, null, 2));
  console.log(
    `[analyzeRecording] Done — ${parsed.data.steps.length} steps, ${parsed.data.parameters.length} params, status=${parsed.data.readiness.status}`
  );
  return full;
}
