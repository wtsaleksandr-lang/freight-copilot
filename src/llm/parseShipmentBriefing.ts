import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import { z } from 'zod';
import { loadEnv } from '../config.js';

import { getAiConfig } from './model.js';
import { callGeminiTool } from './geminiAdapter.js';
// MODEL / FALLBACK_MODEL / PROVIDER are now resolved per-call (see
// parseShipmentBriefing) so the dashboard's secrets page can swap
// them at runtime without a server restart.
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
- container_quantity: how many containers in this shipment, as an integer. Look for "Quantity x 3", "3 x 40HC", "Container quantity: 2", "Qty: 5", or simply "3 x 40HC" in a heading. If the document only mentions one container or doesn't state a quantity, return 1. This number drives all per-container math — when set to N, every per-container line item in cost_items must be multiplied by N.
- cargo_type: 'general' / 'hazmat' / 'reefer' / 'oog' (out-of-gauge) / 'high_value'. Default 'general' unless explicitly stated.
- cargo_name: human-readable description of what's being shipped (e.g. "auto parts", "frozen seafood", "machinery", "personal effects"). Free text.
- sold_rate: the price quoted to the customer in numeric form (no currency symbol). If multiple rates appear (e.g. one per container size), pick the one that's clearly "the agreed rate" or highest-priority — use notes for the rest.
  When multiple components add up to the customer-facing total (e.g. base ocean freight + export-declaration fee + customer-side markup), set sold_rate to the SUM of those components, and itemise them in sold_items below.
- sold_currency: 'USD' / 'CAD' / 'EUR' / 'GBP' / etc. Default 'USD'.
- sold_items: line-item breakdown of what makes up the customer's TOTAL price. Each item: { name, amount, currency }. This is the SELL side (what we charge the customer), distinct from cost_items (what WE pay). Examples of typical sold_items:
  • "Base ocean freight quote" — the base lane rate quoted to the customer.
  • "Export declaration fee" — a fixed fee like $65 added to every shipment.
  • "Customer-side markup" — our profit margin (could be a fixed % over cost, or a flat amount).
  • Any additional service charges the customer is paying for.
  Same multipliers / discount rules as cost_items: multiply per-container amounts by container_quantity, record discounts as negative items so the sum equals sold_rate. If the document only states a single sold_rate with no breakdown, leave sold_items empty (the user will add items manually in the Sell panel).
- carrier_preference: which ocean carrier was preferred or selected (Maersk, MSC, CMA CGM, Hapag-Lloyd, ONE, OOCL, ZIM, COSCO, etc.). Use the carrier's full name or 3-letter code (MSK/MSC/CMA/HLC/ONE/OOC/ZIM/COS).

- shipment_type: shipment mode abbreviation. One of:
  • 'FCL' — Full Container Load (ocean, dedicated container)
  • 'LCL' — Less than Container Load (ocean, shared container)
  • 'RORO' — Roll-on / Roll-off (ocean, vehicles or wheeled cargo)
  • 'BreakBulk' — non-containerized ocean cargo (project, oversized)
  • 'FTL' — Full Truckload (road)
  • 'LTL' — Less Than Truckload (road)
  • 'AIR' — Air freight
  Default null if not stated. If the document mentions a container type or ocean carrier, infer FCL unless LCL is explicit. If it mentions a vessel like "RoRo carrier", "vehicle vessel", or vehicle cargo, infer RORO. If it mentions "project cargo", "BBK", or oversized non-containerized loads, infer BreakBulk. Truck pricing → FTL/LTL based on stated mode. Air waybill / AWB / airline → AIR.

- our_reference_number: any reference number that already identifies THIS shipment in our system, in the S0xxxx format (e.g. S00045, S00123). Look in subject lines, email signatures, and quoted thread text. Leave null if no S0xxxx-style ref appears. Do NOT invent a reference. Do NOT use carrier booking numbers, customer POs, or any other format here.

- booking_ref: the ocean carrier's booking number / BL number for this shipment, if mentioned (e.g. "MSCU2185714", "MAEU-9032111", "BKG-2024-9931"). This is the carrier's reference, NOT our internal S0xxxx ref. Leave null if not mentioned.

- fpol: First Port of Loading / inland origin terminal when the shipment starts inland and rails to an ocean port. Examples: "Kansas City, MO", "Chicago, IL", "Memphis, TN", "Toronto, ON". This is DISTINCT from pol (which is the actual ocean port — Newark, Long Beach, Halifax). For pure port-to-port ocean lanes with no inland leg, leave fpol null. If the email mentions e.g. "load at Chicago, sail from Newark to Hamburg", then fpol = "Chicago, IL" and pol = "Newark".
- fpol_code: UN/LOCODE for fpol if mentioned (USCHI, USKCK, etc.).

- cost_items: line-by-line costs WE PAY (ocean freight, fuel surcharge, BAF, ENS, doc fee, terminal handling at origin, drayage, etc.). Each item: { name, amount, currency }. Skip costs that are clearly the customer's price (the SOLD rate) — those go in sold_rate. Skip destination charges that are on collect at destination (paid by the consignee, not us). If unsure whether an amount is our cost or our sold rate, leave it out. Examples of OUR costs: carrier invoice line items, drayage company quotes, fees we have to pay forward.
  CURRENCY HANDLING: extract amounts in the document's NATIVE currency. Set the "currency" field to whatever the document shows (USD / CAD / EUR / GBP / etc.). Do NOT convert currencies yourself — the server normalises everything to USD using known FX rates after you return. If a document shows "CAD 5,400" for ocean freight, return: name = "Ocean Freight", amount = 5400, currency = "CAD". The server will convert.
  CRITICAL — line items MUST reflect what we ACTUALLY PAY end-to-end:
  • Quantity multiplier: when the document shows per-container charges plus a quantity ("Quantity x 3", "3 x 40HC", "Container quantity: 2"), MULTIPLY each per-container line item by the quantity. Do not record per-container amounts when there are multiple containers — record the multiplied amount. Add a parenthetical "(x N)" to the item name so the user can audit it (e.g. "Ocean Freight (x3)", "BAF (x3)").
  • Discounts / loyalty credits / nautical-mile credits: when the document subtracts an amount from the total (e.g. "1031 NAUTICAL MILES SPENT (- 774 USD)", strikethrough total replaced with a lower one, "Loyalty discount", "Volume credit"), record this as a NEGATIVE cost_item with a clear name (e.g. "Loyalty discount (nautical miles)").
  • All-in / total-price reconciliation: when the document shows an "ALL IN RATE" or "TOTAL PRICE" (often the prominent number at the bottom of the rate block, sometimes with a strikethrough alongside), the SUM of your cost_items must equal that all-in total. If it doesn't match after you've extracted every visible line, add an "Adjustment to all-in total" item for the difference. The all-in total is the source of truth.
  • Strikethrough patterns: when two amounts appear together with one struck through (e.g. "12123 USD 11349 USD"), the LOWER one is the actual cost; the difference is a discount you must record.
- notes: anything else worth keeping — secondary rates, ready dates, reefer temp, special instructions, document references. Keep concise (2-3 sentences max).

- questions: when the document contains MULTIPLE plausible candidates for a field that you cannot disambiguate yourself, populate this array instead of guessing. The dashboard will surface each question to the user with clickable answer buttons, then re-call you with the user's answers as authoritative.

  Use questions for:
  - Multiple booking / reference / contract numbers in a thread (which one is THIS shipment's ref?)
  - Multiple parties named with overlapping roles (which is the shipper vs. the receiver vs. the customer?)
  - Multiple POL or POD candidates
  - Ambiguous container counts ("we'll take 2-3 x 40HC" — which?)
  - Conflicting rate quotes within the same thread (which is the agreed rate?)

  *** MONEY FIELDS — ALWAYS OFFER OPTIONS WHEN MULTIPLE INTERPRETATIONS EXIST ***
  Cost / sell totals are high-stakes. Even if one interpretation seems most likely,
  if there are 2+ plausible totals, ASK rather than silently picking one. Concretely:

  - OUR COST ambiguity: any time the document shows multiple plausible "total cost"
    interpretations (per-container vs all-in vs with-vs-without surcharges vs
    pre-discount vs post-discount), surface a question with each candidate as a
    separate option. Each option must be a short labelled total so the user can
    pick at a glance, e.g.:
      Q: "Which total cost should we use for this shipment?"
      Options:
        "$4,041 — per container (one 40HC)"
        "$12,123 — 3 × per-container subtotal, before loyalty"
        "$11,349 — all-in after −$774 nautical-miles credit"
    The user's pick will become the authoritative figure for cost_items and
    container_quantity in the re-extraction call.

  - SOLD RATE ambiguity: same — when the document hints at multiple possible
    sold/customer rates (a quoted rate, a mark-up'd rate, a promotional rate,
    a per-container vs all-in customer price), list each as an option with its
    source labelled, e.g.:
      Q: "Which sold rate should we record (price quoted to customer)?"
      Options:
        "$4,310 per container"
        "$12,930 total for 3 containers"
        "Add $65 export-declaration fee on top of base"

  Even if the document only contains supplier/cost data and no clear sell rate,
  it's fine to ASK what the sold rate should be — list any plausible figures from
  context plus an empty-string "—" option for free-text entry.

  Each question is { text: clear sentence ending in '?', options: 2-6 short candidate strings to pick from }. Add an empty-string option ONLY if the user might want to type a free-text answer.

  Don't ask trivial questions for non-money fields — if only one candidate is plausible, just extract it.
  For money fields, the bar is lower: if 2+ totals are plausible, ASK.
  Don't ask more than 4 questions per call; pick the most ambiguous fields, prioritising money.

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
  container_quantity: z.number().int().nullable().optional(),
  cargo_type: z.string().nullable().optional(),
  cargo_name: z.string().nullable().optional(),
  sold_rate: z.number().nullable().optional(),
  sold_currency: z.string().nullable().optional(),
  carrier_preference: z.string().nullable().optional(),
  shipment_type: z.string().nullable().optional(),
  our_reference_number: z.string().nullable().optional(),
  booking_ref: z.string().nullable().optional(),
  fpol: z.string().nullable().optional(),
  fpol_code: z.string().nullable().optional(),
  cost_items: z
    .array(
      z.object({
        name: z.string(),
        amount: z.number(),
        currency: z.string().default('USD'),
      })
    )
    .default([])
    .optional(),
  sold_items: z
    .array(
      z.object({
        name: z.string(),
        amount: z.number(),
        currency: z.string().default('USD'),
      })
    )
    .default([])
    .optional(),
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
    container_quantity: { type: ['integer', 'null'] },
    cargo_type: { type: ['string', 'null'] },
    cargo_name: { type: ['string', 'null'] },
    sold_rate: { type: ['number', 'null'] },
    sold_currency: { type: ['string', 'null'] },
    carrier_preference: { type: ['string', 'null'] },
    shipment_type: {
      type: ['string', 'null'],
      enum: ['FCL', 'LCL', 'RORO', 'BreakBulk', 'FTL', 'LTL', 'AIR', null],
    },
    our_reference_number: { type: ['string', 'null'] },
    booking_ref: { type: ['string', 'null'] },
    fpol: { type: ['string', 'null'] },
    fpol_code: { type: ['string', 'null'] },
    cost_items: {
      type: 'array',
      description:
        'Line-item costs WE pay (carrier invoice items, drayage quotes, etc.). Empty array if none found.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string' },
        },
        required: ['name', 'amount'],
      },
    },
    sold_items: {
      type: 'array',
      description:
        'Line-item breakdown of what we CHARGE the customer (base sell rate, export-declaration fee, markup, etc.). Sum equals sold_rate. Empty array if no breakdown is given.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string' },
        },
        required: ['name', 'amount'],
      },
    },
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
/**
 * Optional extraction-mode directive prepended to the user message.
 * Used by the dashboard to narrow Claude's focus when the user
 * dropped a file onto a specific cell (e.g. money-only re-check).
 */
export type ExtractionDirective = string | null;

export async function parseShipmentBriefing(
  files: BriefingFile[],
  userAnswers: ClarificationAnswer[] = [],
  extractionDirective: ExtractionDirective = null
): Promise<ShipmentBriefing> {
  const env = loadEnv();
  if (files.length === 0) {
    throw new Error('No files provided to parseShipmentBriefing');
  }
  // Resolve provider + models PER CALL (settings page can swap them
  // without a server restart).
  const aiCfg = await getAiConfig();
  // Prefer the DB-vaulted key over .env (Carrier secrets → AI keys).
  const { loadAiKey } = await import('../server/apiKeysService.js');
  const apiKey =
    aiCfg.provider === 'anthropic'
      ? (await loadAiKey('anthropic')) ?? env.ANTHROPIC_API_KEY
      : env.ANTHROPIC_API_KEY;
  if (apiKey === PLACEHOLDER_KEY && aiCfg.provider === 'anthropic') {
    throw new Error(
      'No Anthropic API key set. Add one in the Carrier secrets page or set ANTHROPIC_API_KEY in .env.'
    );
  }
  const client = new Anthropic({ apiKey: apiKey || PLACEHOLDER_KEY });

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
  if (extractionDirective) {
    content.push({ type: 'text', text: extractionDirective });
  }
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

  // First-pass extraction with the cheap primary model.
  let parsedData = await callExtract(client, content, aiCfg.model, aiCfg.provider);

  // Audit math + quantity consistency. On discrepancy, retry — and
  // when fallback is enabled, the retry uses the STRONGER model so
  // we only pay Sonnet/Opus prices on the tail of difficult docs,
  // while 90%+ of clean extractions stay on cheap Haiku.
  const { auditBriefing, buildCorrectionPrompt } = await import('./validateExtraction.js');
  const warnings = auditBriefing(parsedData);
  if (warnings.length > 0) {
    const correction = buildCorrectionPrompt(warnings);
    if (correction) {
      const useFallback =
        aiCfg.fallback !== '' && aiCfg.fallback !== aiCfg.model;
      const retryModel = useFallback ? aiCfg.fallback : aiCfg.model;
      console.log(
        `[parseShipmentBriefing] audit found ${warnings.length} issue(s) — retrying with ${retryModel}`
      );
      const retryContent = [
        ...content,
        { type: 'text', text: correction },
      ];
      try {
        const retried = await callExtract(client, retryContent, retryModel, aiCfg.provider);
        const reaudit = auditBriefing(retried);
        if (reaudit.length < warnings.length) {
          parsedData = retried;
        }
      } catch (err) {
        console.warn('[parseShipmentBriefing] retry failed:', err);
      }
    }
  }

  return parsedData;
}

// Inner caller: shape the API call once so the retry can reuse it
// with a different model. Routes by configured provider — Anthropic
// SDK or Gemini fetch — both produce the same Zod-validated output.
async function callExtract(
  client: Anthropic,
  content: Array<{ type: string; [k: string]: unknown }>,
  modelName: string,
  provider: 'anthropic' | 'gemini'
): Promise<ShipmentBriefing> {
  let toolInput: unknown;
  if (provider === 'gemini') {
    toolInput = await callGeminiTool({
      modelName,
      systemPrompt: SYSTEM_PROMPT,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: content as any,
      tool: {
        name: 'extract_shipment_briefing',
        description:
          'Return structured shipment fields extracted from the documents.',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: TOOL_SCHEMA as any,
      },
      maxTokens: 2048,
    });
  } else {
    const response = await client.messages.create({
      model: modelName,
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
          description:
            'Return structured shipment fields extracted from the documents.',
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
    toolInput = toolUse.input;
  }

  const parsed = ShipmentSchema.safeParse(toolInput);
  if (!parsed.success) {
    console.error('[parseShipmentBriefing] Zod issues:', parsed.error.issues);
    throw new Error('Briefing extractor output failed schema validation');
  }
  return parsed.data;
}
