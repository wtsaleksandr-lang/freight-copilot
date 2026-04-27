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

export interface GenerateBundleReplyInput {
  clientName?: string;
  origin: string;
  destination: string;
  containerType: string;
  cargoWeightKg: number;
  commodity?: string;
  markupPct: number;
  markupFlat: number;
  emailTemplate?: string;
  carriers: Array<{
    carrierCode: string;
    carrierName: string;
    status: string;
    ranked: RankedRateOption[];
    reason?: string;
  }>;
}

const BUNDLE_REPLY_SYSTEM_PROMPT = `You compose ocean freight quote replies on behalf of a freight forwarder.

You will receive:
- A lane (origin → destination), container type, cargo info.
- Ranked rate options from one or more carriers (each with itemized Freight charges, Destination charges, transit, vessel, D&D free time, rollable flag).
- A markup the forwarder applies on top: a percentage and/or a flat amount in USD. Apply it to each option's freight cost (your_price = cost * (1 + pct/100) + flat) and present the final "your price" — never expose the raw carrier cost.
- Optionally an email template the forwarder typically sends. If provided, follow its structure, tone, length, and formatting EXACTLY — substituting in the lane and rates. If not provided, use a clean default.

Rules:
- Quote ONLY the marked-up "your price". Never show the carrier's raw cost.
- Show the top 2-3 options unless the template indicates otherwise.
- For each option, show: departure date, transit time, vessel/voyage, your price, and Det/Dem free time (e.g. "4 days detention + 5 days demurrage free").
- Note any "Rollable" sailings as offering reduced space guarantee.
- Mention destination charges as "on collect" (paid by receiver) — show them as reference if the template asks for it.
- If carriers had no rates / failed, omit them silently. Don't mention failures in the email.
- Use the client's name if provided; otherwise a neutral salutation.
- Plain text. No markdown headers, no asterisks, no emojis (unless the template uses them).
- Don't invent vessel names, transit times, or charges.`;

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

export async function generateBundleReply(
  input: GenerateBundleReplyInput
): Promise<string> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error('ANTHROPIC_API_KEY is still the placeholder.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Build the user prompt with all carrier data + markup + template
  const carrierBlocks = input.carriers
    .filter((c) => c.status === 'ok' && c.ranked.length > 0)
    .map((c) => {
      const rateLines = c.ranked
        .slice(0, 5)
        .map((r) => {
          const yourPrice = Math.round(
            r.freight_total * (1 + input.markupPct / 100) + input.markupFlat
          );
          const transit =
            r.transit_days != null
              ? `${r.transit_days}d${r.transit_hours ? ` ${r.transit_hours}h` : ''}`
              : '?';
          const flags: string[] = [];
          if (r.rollable) flags.push('Rollable');
          const flagStr = flags.length ? ` — ${flags.join(', ')}` : '';
          const dnd =
            r.detention_freetime_days != null || r.demurrage_freetime_days != null
              ? `Det/Dem free: ${r.detention_freetime_days ?? '?'}d / ${r.demurrage_freetime_days ?? '?'}d`
              : '';
          const dest =
            r.destination_charges.length > 0 && r.destination_currency
              ? `Destination charges (on collect, paid by receiver): ${r.destination_currency} ${r.destination_total.toLocaleString()}`
              : '';
          return [
            `  Option (rank #${r.rank}) — ${c.carrierName}`,
            `    Departure: ${r.sailing_date ?? '?'}`,
            `    Arrival: ${r.arrival_datetime ?? '?'}`,
            `    Transit: ${transit}`,
            `    Vessel/voyage: ${r.vessel_voyage ?? '?'}`,
            `    Your price: ${r.freight_currency} ${yourPrice.toLocaleString()} (carrier cost: do not show client)`,
            dnd ? `    ${dnd}` : '',
            dest ? `    ${dest}` : '',
            flagStr ? `    Notes:${flagStr}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n');
      return `### ${c.carrierName} (${c.carrierCode})\n${rateLines}`;
    })
    .join('\n\n');

  const userText =
    (input.clientName ? `Client name: ${input.clientName}\n` : '') +
    `Lane: ${input.origin} -> ${input.destination}\n` +
    `Container: ${input.containerType}, ${input.cargoWeightKg}kg per container\n` +
    (input.commodity ? `Commodity: ${input.commodity}\n` : '') +
    `Markup applied: +${input.markupPct}% and +${input.markupFlat} USD flat\n\n` +
    `Carrier rate options:\n\n${carrierBlocks || '(none — all carriers failed or had no rates)'}\n\n` +
    (input.emailTemplate
      ? `EMAIL TEMPLATE TO FOLLOW EXACTLY (substitute in the lane and rates above):\n\n---BEGIN TEMPLATE---\n${input.emailTemplate}\n---END TEMPLATE---\n\nWrite the reply.`
      : 'Write a clean, professional default reply.');

  console.log('[generateBundleReply] Asking Claude to compose bundle reply...');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: [
      {
        type: 'text',
        text: BUNDLE_REPLY_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userText }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text block');
  }
  return textBlock.text;
}
