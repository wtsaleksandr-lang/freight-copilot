import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { z } from 'zod';
import { loadEnv } from '../config.js';

const MODEL = 'claude-sonnet-4-6';
const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

const SYSTEM_PROMPT = `You read freight forwarder email exchanges, booking briefings, screenshots, and PDFs, and extract the shipment details into a structured form.

Target fields (all optional — leave null if not stated):

- shipper_name: the company sending the cargo (origin / consignor).
- receiver_name: the company receiving the cargo (destination / consignee).
- customer_name: the user's actual paying customer. Often the shipper, sometimes the receiver, sometimes a third-party broker. If only one party is named, use that one for both customer_name and the appropriate shipper/receiver field. If multiple are named, prefer whoever is addressing the freight forwarder directly.
- loading_address: the physical pickup address (street, city, state/region, country, ZIP) at origin. Be specific — a full address is better than just a city.
- pol: port of loading (specific port name, e.g. "Charleston", "Montreal", "Shanghai"). NOT a region (Mediterranean, Far East), NOT a country (USA, China). If only an inland origin is given, leave pol null.
- pol_code: UN/LOCODE for POL if mentioned (e.g. "USCHS").
- pod: port of discharge (destination port, e.g. "Hamburg", "Constanta", "Izmir"). Same rules as pol — must be a specific port.
- pod_code: UN/LOCODE for POD if mentioned (e.g. "DEHAM").
- container_type: 20GP / 40GP / 40HC / 20RF / 40RF / 40RH / 40NOR / 20OT / 40OT / 20FR / 40FR / 20TK. Translate equivalents: "20'std", "20DV", "20 dry standard" → 20GP. "40HQ", "40' high cube" → 40HC. If multiple types, list them comma-separated (e.g. "20GP, 40HC").
- cargo_type: 'general' / 'hazmat' / 'reefer' / 'oog' (out-of-gauge) / 'high_value'. Default 'general' unless explicitly stated.
- cargo_name: human-readable description of what's being shipped (e.g. "auto parts", "frozen seafood", "machinery", "personal effects"). Free text.
- sold_rate: the price quoted to the customer in numeric form (no currency symbol). If multiple rates appear (e.g. one per container size), pick the one that's clearly "the agreed rate" or highest-priority — use notes for the rest.
- sold_currency: 'USD' / 'CAD' / 'EUR' / 'GBP' / etc. Default 'USD'.
- carrier_preference: which ocean carrier was preferred or selected (Maersk, MSC, CMA CGM, Hapag-Lloyd, ONE, OOCL, ZIM, COSCO, etc.). Use the carrier's full name or 3-letter code (MSK/MSC/CMA/HLC/ONE/OOC/ZIM/COS).
- notes: anything else worth keeping — secondary rates, ready dates, reefer temp, special instructions, document references. Keep concise (2-3 sentences max).

- questions: when the document contains MULTIPLE plausible candidates for a field that you cannot disambiguate yourself, populate this array instead of guessing. The dashboard will surface each question to the user with clickable answer buttons, then re-call you with the user's answers as authoritative.

  Use questions for:
  - Multiple booking / reference / contract numbers in a thread (which one is THIS shipment's ref?)
  - Multiple parties named with overlapping roles (which is the shipper vs. the receiver vs. the customer?)
  - Multiple POL or POD candidates
  - Ambiguous container counts ("we'll take 2-3 x 40HC" — which?)
  - Conflicting rate quotes within the same thread (which is the agreed rate?)

  Each question is { text: clear sentence ending in '?', options: 2-6 short candidate strings to pick from }. Add an empty-string option ONLY if the user might want to type a free-text answer.

  Don't ask trivial questions — if only one candidate is plausible, just extract it. Don't ask more than 3 questions per call; pick the most ambiguous fields.

Rules:
- Be conservative. Null beats a guess.
- If multiple pages or images describe ONE shipment, merge into a single record.
- If they describe MULTIPLE shipments, only output the first one (caller will re-call for additional shipments).
- Do not invent ports, addresses, or carrier names.

Return through the extract_shipment_briefing tool.`;

const QuestionSchema = z.object({
  text: z.string(),
  options: z.array(z.string()).default([]),
});

const ShipmentSchema = z.object({
  shipper_name: z.string().nullable().optional(),
  receiver_name: z.string().nullable().optional(),
  customer_name: z.string().nullable().optional(),
  loading_address: z.string().nullable().optional(),
  pol: z.string().nullable().optional(),
  pol_code: z.string().nullable().optional(),
  pod: z.string().nullable().optional(),
  pod_code: z.string().nullable().optional(),
  container_type: z.string().nullable().optional(),
  cargo_type: z.string().nullable().optional(),
  cargo_name: z.string().nullable().optional(),
  sold_rate: z.number().nullable().optional(),
  sold_currency: z.string().nullable().optional(),
  carrier_preference: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  questions: z.array(QuestionSchema).default([]).optional(),
});

export type ShipmentBriefing = z.infer<typeof ShipmentSchema>;

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    shipper_name: { type: ['string', 'null'] },
    receiver_name: { type: ['string', 'null'] },
    customer_name: { type: ['string', 'null'] },
    loading_address: { type: ['string', 'null'] },
    pol: { type: ['string', 'null'] },
    pol_code: { type: ['string', 'null'] },
    pod: { type: ['string', 'null'] },
    pod_code: { type: ['string', 'null'] },
    container_type: { type: ['string', 'null'] },
    cargo_type: { type: ['string', 'null'] },
    cargo_name: { type: ['string', 'null'] },
    sold_rate: { type: ['number', 'null'] },
    sold_currency: { type: ['string', 'null'] },
    carrier_preference: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    questions: {
      type: 'array',
      description:
        'Clarification questions to surface to the user when the document contains multiple plausible candidates for a field. Empty array if no ambiguity.',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['text'],
      },
    },
  },
  required: [],
} as const;

export type BriefingMediaType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  /** Raw email file (RFC 822 / MIME). Sent to Claude as text. */
  | 'message/rfc822'
  /** Email saved as HTML, or any HTML document. Sent as text. */
  | 'text/html'
  /** Plain text dumps. */
  | 'text/plain';

export interface BriefingFile {
  /** Base64-encoded content for binary types (PDF/image). */
  fileBase64?: string;
  /** Pre-decoded text content for email/HTML/plain text. */
  textContent?: string;
  mediaType: BriefingMediaType;
  filename?: string;
}

/**
 * Detect media type from filename extension. Used by the route layer
 * which receives a Blob and just knows the filename.
 *
 * Note: .msg files are routed through the route layer's MSG converter
 * before reaching parseShipmentBriefing — by the time we get here they
 * become text/plain, so .msg isn't returned as its own media type.
 */
export function detectMediaType(filename: string): BriefingMediaType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.eml')) return 'message/rfc822';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return null;
}

/** True when the filename indicates an Outlook .msg item we can decode. */
export function isMsgFile(filename: string | undefined): boolean {
  return !!filename && filename.toLowerCase().endsWith('.msg');
}

const TEXT_TYPES = new Set<BriefingMediaType>([
  'message/rfc822',
  'text/html',
  'text/plain',
]);

/**
 * Optional user-provided clarifications, keyed by question text.
 * When the previous extraction returned questions[], the dashboard
 * collects answers from the user and re-calls with them populated.
 */
export interface ClarificationAnswer {
  question: string;
  answer: string;
}

/**
 * Extract one shipment record from a set of email screenshots / PDFs.
 * All files are sent to Claude in a single call — they describe the
 * same shipment together (e.g. one booking thread split across multiple
 * screenshots).
 *
 * If userAnswers is non-empty, the prompt includes them as authoritative
 * clarifications. Claude should NOT re-ask the same question and should
 * fill the relevant fields per the user's answer.
 */
export async function parseShipmentBriefing(
  files: BriefingFile[],
  userAnswers: ClarificationAnswer[] = []
): Promise<ShipmentBriefing> {
  const env = loadEnv();
  if (env.ANTHROPIC_API_KEY === PLACEHOLDER_KEY) {
    throw new Error('ANTHROPIC_API_KEY is still the placeholder.');
  }
  if (files.length === 0) {
    throw new Error('No files provided to parseShipmentBriefing');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const textCount = files.filter((f) => TEXT_TYPES.has(f.mediaType)).length;
  const visionCount = files.length - textCount;
  const introBits: string[] = [];
  if (visionCount > 0) {
    introBits.push(
      visionCount === 1
        ? '1 visual document (PDF or screenshot)'
        : `${visionCount} visual documents (PDFs or screenshots)`
    );
  }
  if (textCount > 0) {
    introBits.push(
      textCount === 1 ? '1 email/text body' : `${textCount} email/text bodies`
    );
  }
  const intro =
    files.length === 1
      ? 'Extract the shipment details from this document.'
      : `Extract the shipment details from these ${introBits.join(' + ')} — they describe ONE shipment together.`;

  const content: Array<{ type: string; [k: string]: unknown }> = [
    { type: 'text', text: intro },
  ];
  if (userAnswers.length > 0) {
    const answersBlock =
      'USER CLARIFICATIONS (authoritative — do NOT re-ask, do NOT contradict, populate the relevant fields accordingly):\n' +
      userAnswers
        .map((a, i) => `  ${i + 1}. Q: ${a.question}\n     A: ${a.answer}`)
        .join('\n');
    content.push({ type: 'text', text: answersBlock });
  }
  for (const f of files) {
    if (f.mediaType === 'application/pdf') {
      if (!f.fileBase64) throw new Error('PDF missing fileBase64');
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: f.fileBase64,
        },
      });
    } else if (TEXT_TYPES.has(f.mediaType)) {
      const body = f.textContent ?? '';
      const label =
        f.mediaType === 'message/rfc822'
          ? 'Email file (.eml — full MIME headers + body)'
          : f.mediaType === 'text/html'
            ? 'HTML email body'
            : 'Plain text';
      content.push({
        type: 'text',
        text:
          `--- ${f.filename ?? 'file'} (${label}) ---\n` +
          body +
          '\n--- end ---',
      });
    } else {
      if (!f.fileBase64) throw new Error('Image missing fileBase64');
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: f.mediaType,
          data: f.fileBase64,
        },
      });
    }
  }

  console.log(
    `[parseShipmentBriefing] Calling Claude with ${files.length} file(s)…`
  );

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: 'extract_shipment_briefing',
        description: 'Return structured shipment fields extracted from the documents.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: TOOL_SCHEMA as any,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: 'extract_shipment_briefing' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: 'user', content: content as any }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Claude did not return a tool_use block');
  }
  const parsed = ShipmentSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    console.error('[parseShipmentBriefing] Zod issues:', parsed.error.issues);
    throw new Error('Briefing extractor output failed schema validation');
  }
  return parsed.data;
}
