import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from '../config.js';
import type { RankedRateOption } from '../types.js';

const MODEL = 'claude-sonnet-4-6';
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const REPLY_SYSTEM_PROMPT = `You compose short, professional ocean freight quote replies on behalf of a freight forwarder.

Given a lane, container type, and a ranked list of Maersk Spot sailing options, write a message
the forwarder can paste back to a client. Format:

- Start with a one-line greeting (assume the forwarder will edit/customise as needed).
- Present the top 2-3 rate options in a clean bullet or table-like list, including:
  - Departure date
  - Transit time
  - Vessel/voyage (if provided)
  - Price + currency
  - Any relevant flags (e.g., "Rollable" means space may be bumped to a later sailing)
- If the #1 option is "Rollable", point it out and note the safer non-rollable alternative if any.
- Close with a short line about next steps ("let me know if you'd like to book...").
- Keep the total under 250 words.
- Do not invent information not present in the input.
- Do not quote any charges beyond what's provided. Do not add your own markups.
- Plain text. No markdown headers, no asterisks, no emojis.`;

export interface GenerateReplyInput {
  origin: string;
  destination: string;
  containerType: string;
  ranked: RankedRateOption[];
}

export async function generateClientReply(
  input: GenerateReplyInput
): Promise<string> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error('ANTHROPIC_API_KEY is still the placeholder.');
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const rateSummary = input.ranked
    .slice(0, 5)
    .map((r) => {
      const price = `${r.headline_price_currency ?? ''} ${(r.headline_price_amount ?? 0).toLocaleString()}`;
      const transit =
        r.transit_days != null
          ? `${r.transit_days} days${r.transit_hours ? ` ${r.transit_hours}h` : ''}`
          : '(transit unknown)';
      const flags: string[] = [];
      if (r.rollable) flags.push('Rollable');
      if (r.close_to_lowest) flags.push('within 3% of lowest');
      const flagStr = flags.length > 0 ? ` — ${flags.join(', ')}` : '';
      return (
        `#${r.rank}: ${r.service_name}\n` +
        `   Departure: ${r.sailing_date ?? '?'}\n` +
        `   Arrival: ${r.arrival_datetime ?? '?'}\n` +
        `   Transit: ${transit}\n` +
        `   Vessel/voyage: ${r.vessel_voyage ?? '?'}\n` +
        `   Price: ${price}${flagStr}`
      );
    })
    .join('\n\n');

  const userText = `Lane: ${input.origin} -> ${input.destination}
Container: ${input.containerType}

Options (ranked by price):

${rateSummary}`;

  console.log('[generateReply] Asking Claude to compose client reply...');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: REPLY_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: userText,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text block');
  }
  return textBlock.text;
}
