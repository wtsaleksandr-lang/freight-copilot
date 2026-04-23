// Tool definitions Claude uses while driving the browser.
// Each tool name maps to a single Playwright operation in runAgent.ts.

export const AGENT_TOOL_DEFS = [
  {
    name: 'navigate',
    description:
      'Navigate the browser to an absolute URL. Use this to jump between pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to navigate to.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description:
      'Click an element identified by its visible text or accessible name. Use the most specific text you see. Example targets: "Next question", "Submit", "Option A".',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Visible text or accessible name of the element to click.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'type',
    description:
      'Type text into a form field identified by its label. Replaces existing value.',
    input_schema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Label, placeholder, or accessible name of the input.',
        },
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['label', 'text'],
    },
  },
  {
    name: 'press',
    description: 'Press a single key. Useful for Enter, Tab, Escape, ArrowDown.',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name, e.g. "Enter", "Tab", "Escape".',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'done',
    description:
      'The task is complete. Call this with a short summary of what was accomplished.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of actions taken and result.' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'abort',
    description:
      'Abort the task (unsafe, impossible, or stuck). Provide reason.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason for aborting.' },
      },
      required: ['reason'],
    },
  },
] as const;

// Simple safety: refuse interactions whose target/text hint at money, account deletion,
// or other irreversible actions. The user can widen this later.
const DANGEROUS_PATTERNS = [
  /\bpay\b/i,
  /\bpayment\b/i,
  /\bcharge\b/i,
  /\bconfirm (?:purchase|order|payment)\b/i,
  /\bplace order\b/i,
  /\bdelete (?:account|data|everything)\b/i,
  /\bunsubscribe\b/i,
];

export function isDangerous(text: string): string | null {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(text)) return p.source;
  }
  return null;
}
