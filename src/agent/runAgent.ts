import Anthropic from '@anthropic-ai/sdk';
import { type Page } from 'playwright';
import { loadEnv } from '../config.js';
import { AGENT_TOOL_DEFS, isDangerous } from './tools.js';
import { createBrowserContext } from '../carriers/browserContext.js';

const MODEL = 'claude-sonnet-4-6';
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const SYSTEM_PROMPT = `You are a careful web-automation agent.
Given a goal and a starting URL, drive the browser step-by-step to accomplish the goal.

Rules:
- Call exactly one tool per turn.
- Re-read the current page before each action — do not assume anything you haven't seen.
- If a field needs text, use "type"; if you need to pick a button/link/option, use "click" with its visible text.
- For multiple-choice questions, read the question carefully. Pick the best-supported answer. Click its label.
- If you are blocked (captcha, paywall, login required, cannot find the element), call "abort" with a clear reason.
- Never click any element that looks irreversible — real-money payments, order confirmations, account deletion.
- When finished, call "done" with a short summary.`;

export interface AgentStep {
  iteration: number;
  url: string;
  action: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
}

export interface AgentResult {
  goal: string;
  startUrl: string;
  finalUrl: string;
  steps: AgentStep[];
  finished: boolean;
  finishReason: string;
}

export interface RunAgentOptions {
  url: string;
  goal: string;
  maxIterations?: number;
  onStep?: (step: AgentStep) => void;
}

async function currentAriaTree(page: Page): Promise<string> {
  try {
    const tree = await page.locator('body').ariaSnapshot();
    // Trim very large pages — keep first ~7000 chars (roughly 2000 tokens).
    return tree.length > 7000 ? tree.slice(0, 7000) + '\n…(truncated)…' : tree;
  } catch (e) {
    return `(could not capture aria tree: ${(e as Error).message})`;
  }
}

async function executeTool(
  page: Page,
  tool: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (tool) {
    case 'navigate': {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//.test(url)) return `Error: url must be absolute (got "${url}")`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      return `Navigated to ${page.url()}`;
    }
    case 'click': {
      const target = String(args.target ?? '');
      if (!target) return 'Error: target required';
      const danger = isDangerous(target);
      if (danger) return `BLOCKED: refused to click "${target}" (matches dangerous pattern /${danger}/).`;
      try {
        await page.getByText(target, { exact: false }).first().click({ timeout: 5000 });
        await page.waitForTimeout(1200);
        return `Clicked "${target}" — URL now ${page.url()}`;
      } catch (e) {
        // Fallback: try role-based
        try {
          await page.getByRole('button', { name: new RegExp(target, 'i') }).first().click({ timeout: 5000 });
          await page.waitForTimeout(1200);
          return `Clicked button "${target}" (role fallback)`;
        } catch {
          return `Error: could not click "${target}" — ${(e as Error).message}`;
        }
      }
    }
    case 'type': {
      const label = String(args.label ?? '');
      const text = String(args.text ?? '');
      if (!label) return 'Error: label required';
      const danger = isDangerous(text);
      if (danger) return `BLOCKED: refused to type value matching dangerous pattern /${danger}/.`;
      try {
        const field = page.getByLabel(label, { exact: false }).first();
        await field.fill(text, { timeout: 5000 });
        return `Typed "${text.length > 40 ? text.slice(0, 40) + '…' : text}" into "${label}".`;
      } catch (e) {
        try {
          const field = page.getByPlaceholder(label).first();
          await field.fill(text, { timeout: 5000 });
          return `Typed into placeholder "${label}" (fallback).`;
        } catch {
          return `Error: could not type into "${label}" — ${(e as Error).message}`;
        }
      }
    }
    case 'press': {
      const key = String(args.key ?? '');
      if (!key) return 'Error: key required';
      await page.keyboard.press(key);
      await page.waitForTimeout(500);
      return `Pressed ${key}`;
    }
    default:
      return `Error: unknown tool "${tool}"`;
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error('ANTHROPIC_API_KEY is still the placeholder.');
  }

  const maxIterations = opts.maxIterations ?? 25;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const ctxResult = await createBrowserContext();
  const { context, close, usingRealChrome } = ctxResult;
  console.log(
    `[agent] ${usingRealChrome ? 'Connected to real Chrome (CDP)' : 'Launched bundled Chromium'}`
  );
  const page = await context.newPage();

  const steps: AgentStep[] = [];
  let finished = false;
  let finishReason = '';

  try {
    console.log(`[agent] Navigating to starting URL: ${opts.url}`);
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Each turn we send: goal, current URL, current aria tree, last N steps' results.
    for (let i = 1; i <= maxIterations; i++) {
      const ariaTree = await currentAriaTree(page);
      const stepsSummary = steps
        .slice(-8) // keep context bounded
        .map(
          (s) =>
            `  ${s.iteration}. ${s.action}(${JSON.stringify(s.args)}) → ${s.result}`
        )
        .join('\n');

      const userContent =
        `Goal: ${opts.goal}\n\n` +
        `Iteration: ${i} of ${maxIterations}\n` +
        `Current URL: ${page.url()}\n\n` +
        `Recent actions (most recent last):\n${stepsSummary || '  (none)'}\n\n` +
        `Current page (accessibility tree):\n\`\`\`yaml\n${ariaTree}\n\`\`\`\n\n` +
        `Decide the next single action. Call exactly one tool.`;

      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: AGENT_TOOL_DEFS as any,
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: userContent }],
      });

      const toolUse = response.content.find((b) => b.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        finishReason = 'Claude returned no tool_use block';
        break;
      }

      const action = toolUse.name;
      const args = (toolUse.input as Record<string, unknown>) ?? {};

      if (action === 'done') {
        const summary = String(args.summary ?? 'Task complete');
        steps.push({
          iteration: i,
          url: page.url(),
          action,
          args,
          result: summary,
          ok: true,
        });
        opts.onStep?.(steps[steps.length - 1]!);
        finished = true;
        finishReason = summary;
        break;
      }
      if (action === 'abort') {
        const reason = String(args.reason ?? 'No reason given');
        steps.push({
          iteration: i,
          url: page.url(),
          action,
          args,
          result: reason,
          ok: false,
        });
        opts.onStep?.(steps[steps.length - 1]!);
        finishReason = `Aborted: ${reason}`;
        break;
      }

      const result = await executeTool(page, action, args);
      const ok = !result.startsWith('Error') && !result.startsWith('BLOCKED');
      const step: AgentStep = {
        iteration: i,
        url: page.url(),
        action,
        args,
        result,
        ok,
      };
      steps.push(step);
      opts.onStep?.(step);
      console.log(`[agent] ${i}. ${action}(${JSON.stringify(args)}) → ${result}`);

      if (!finishReason && i === maxIterations) {
        finishReason = `Hit iteration cap (${maxIterations}) without done/abort.`;
      }
    }

    return {
      goal: opts.goal,
      startUrl: opts.url,
      finalUrl: page.url(),
      steps,
      finished,
      finishReason: finishReason || 'Loop ended',
    };
  } finally {
    await page.close().catch(() => undefined);
    await close();
  }
}
