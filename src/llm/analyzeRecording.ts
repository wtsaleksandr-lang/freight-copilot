import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { loadEnv } from '../config.js';

const MODEL = 'claude-sonnet-4-6';
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const SYSTEM_PROMPT = `You convert raw browser-automation recordings into a clean, human-readable workflow plus the structured information our system needs to replay it later.

You may receive ONE of three formats — handle whichever appears:

A) Playwright Codegen output (JavaScript/TypeScript) — typical content includes
   "import { test } from '@playwright/test'", "await page.goto(...)",
   "await page.getByRole(...).click()", "await page.getByLabel(...).fill(...)".

B) Chrome DevTools Recorder export (JSON) — typical content is an object with
   "title", "steps": [...]. Each step has "type" (navigate, click, change,
   keyDown, keyUp, scroll), "url" (for navigate), "selectors" (an array of
   selector arrays — each variant is a different way to find the same
   element: CSS, ARIA-role, text, XPath, pierce), and "value" for change steps.

C) Puppeteer JS export from DevTools Recorder — looks like the Playwright
   form but uses puppeteer API.

For ALL formats, produce the same output:

1. A concise human-readable summary (one sentence) of what the workflow does.
2. Numbered steps in plain English ("1. Navigate to login. 2. Type username.
   3. Click Sign in.") — describe what each step ACCOMPLISHES, not the
   verbatim selector. For DevTools JSON, infer the action from the step type
   plus the most readable selector (prefer aria-name from selectors, then
   text, then the last segment of CSS).
3. Parameterized fields — inputs the user would change per run (origin,
   destination, container type, weight, dates) vs things that stay the same
   (fixed buttons, account-specific data).
4. Readiness: "ready_to_replay" if it looks complete + replayable from this
   capture; "needs_review" with a brief reason otherwise. Things that count
   as "needs review": recording that starts mid-action, login flow visible
   (passwords should not be in recordings — flag it), captcha solve
   visible (random challenge can't be replayed).

Skip / clean:
- Boilerplate (imports, test wrappers).
- Obvious noise (random scroll events, hover-only events).
- Sensitive values like passwords — DO NOT echo the actual value back.
  Describe them as "<your password>" or "<sensitive>".

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

  // Save analysis next to the raw recording. Strip any known extension so
  // we never overwrite the source file (Codegen .ts/.js OR uploaded .json).
  const savedTo = input.recordingPath.replace(/\.(ts|js|json|txt)$/i, '') + '.analysis.json';
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
