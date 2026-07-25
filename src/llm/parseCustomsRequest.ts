import { z } from 'zod';
import { executeStructuredAiTask } from './sharedAiExecutor.js';

/**
 * Extract the fields needed to price a customs entry from a quote-request
 * screenshot, email, or pasted text. Feeds the Customs workspace so the
 * operator drops a document and the duty/tax + fee estimate auto-populates.
 * Classification is still the operator's / broker's call — this only pre-fills.
 */
const CUSTOMS_SYSTEM_PROMPT = `You read a customs-clearance quote request — a screenshot, an email, or pasted text from an importer or freight forwarder — and extract only the fields needed to price a customs entry. Output ONE JSON object.

Fields:
- movement_type: which movement this is. "import_usa" if the goods are being imported INTO the United States; "import_canada" if imported INTO Canada; "export_clearance" if this is an export leaving the country. Infer from the destination / delivery country. If genuinely unclear, null.
- hs_code: the HS / HTS / tariff classification code if stated (keep digits and dots, e.g. "6109.10.00"). null if not present. Do NOT invent one.
- commodity: short description of the goods (e.g. "cotton T-shirts", "machinery parts"). null if absent.
- commercial_value: the commercial / customs value as a NUMBER ONLY — strip currency symbols, codes, and thousands separators ("USD 25,000" -> 25000). If a range is given, use the higher. null if absent.
- country_of_origin: where the goods were MADE / manufactured, as a full country name ("China", "United States", "Germany", "Vietnam"). Not the shipping port. null if absent.
- incoterms: the Incoterm if stated (EXW, FOB, CIF, DDP, etc.). null if absent.
- port_or_crossing: the port of entry / border crossing if stated. null if absent.
- notes: any other detail useful to a broker (entry type, bond, PGA/permit, exam, special docs). null if none.

Rules: extract only what is actually present; never invent values; leave unknown fields null. Return JSON only.`;

const CustomsExtractSchema = z.object({
  movement_type: z.enum(['import_usa', 'import_canada', 'export_clearance']).nullable().optional(),
  hs_code: z.string().nullable().optional(),
  commodity: z.string().nullable().optional(),
  commercial_value: z.number().nullable().optional(),
  country_of_origin: z.string().nullable().optional(),
  incoterms: z.string().nullable().optional(),
  port_or_crossing: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type CustomsExtract = z.infer<typeof CustomsExtractSchema>;

export type CustomsMediaType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'message/rfc822'
  | 'text/html'
  | 'text/plain';

export interface CustomsRequestInput {
  fileBase64?: string;
  mediaType?: CustomsMediaType;
  filename?: string;
  text?: string;
}

const SCHEMA_DESCRIPTION = `{
  "movement_type": "import_usa|import_canada|export_clearance|null",
  "hs_code": "string|null",
  "commodity": "string|null",
  "commercial_value": "number|null",
  "country_of_origin": "string|null (full country name)",
  "incoterms": "string|null",
  "port_or_crossing": "string|null",
  "notes": "string|null"
}`;

function isTextMedia(m?: CustomsMediaType): boolean {
  return m === 'message/rfc822' || m === 'text/html' || m === 'text/plain';
}

export async function parseCustomsRequest(input: CustomsRequestInput): Promise<CustomsExtract> {
  const hasImage = input.fileBase64 && input.mediaType && !isTextMedia(input.mediaType);
  const inlineText =
    input.text ??
    (input.fileBase64 && isTextMedia(input.mediaType)
      ? Buffer.from(input.fileBase64, 'base64').toString('utf8').slice(0, 40000)
      : undefined);

  const result = await executeStructuredAiTask({
    kind: 'customs-request-extract',
    systemPrompt: CUSTOMS_SYSTEM_PROMPT,
    userPrompt: inlineText
      ? `Extract the customs entry fields from this quote request:\n\n${inlineText}`
      : 'Extract the customs entry fields from this quote-request document.',
    schemaDescription: SCHEMA_DESCRIPTION,
    media: hasImage
      ? { mediaType: input.mediaType as string, base64: input.fileBase64 as string, filename: input.filename }
      : undefined,
    highStakes: false,
    validate(value) {
      const parsed = CustomsExtractSchema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `Customs-extract output failed schema validation: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`,
        );
      }
      return parsed.data;
    },
  });
  return result.value;
}
