import { z } from 'zod';
import { executeStructuredAiTask } from './sharedAiExecutor.js';

/**
 * Bulk import of a company shipment-tracking sheet (CSV / PDF / screenshot).
 * The AI reads EVERY row and maps it to the LoadMode shipment board, splitting
 * combined cells (e.g. "1*40HQ" → qty 1 + type 40HQ) and normalizing dates.
 * The ref number is ALWAYS taken from the sheet's File# column — LoadMode
 * never mints refs.
 */
const SHEET_SYSTEM_PROMPT = `You import a freight forwarder's shipment-tracking spreadsheet into a shipment board. Read EVERY data row (skip the header row and any blank/spacer rows) and output one shipment object per row.

Column mapping (the sheet's headers → output fields). Headers may be abbreviated/renamed; map by meaning:
- File / File# / S-number  → ref_id  (ALWAYS keep the exact value, e.g. "S00043252". This is the company ref — never invent, renumber, or blank it. A row with no ref is invalid; omit it.)
- Status                   → operational_status  (keep the sheet's word: "PAID?", "INVOICE", etc.)
- BKC / Booking            → booking_ref
- Client                   → customer_name
- Shipper                  → shipper_name
- Receiver / Consignee     → receiver_name
- EXP place / Export       → fpol   (the inland export origin, e.g. "Montreal")
- POL                      → pol
- POD                      → pod
- FPOD / Final POD / Final destination / Delivery terminal / On-carriage to → fpod (the final inland delivery terminal/ramp the cargo moves to AFTER the discharge port, e.g. "Chicago Ramp")
- SS line / Line / Carrier → carrier_preference
- Type  (e.g. "1*40HQ", "6*40HC")  → SPLIT into container_quantity (the number before *) and container_type (after *, e.g. "40HQ"). "2x40HC" → qty 2, type "40HC".
- Cut off                  → cut_off_date
- SI                       → si_date
- SEA-AIR Cargo            → sea_air_cargo
- VGM                      → vgm
- Draft                    → draft_date
- Loading                  → loading_date
- Trucker                  → trucker
- ETD/ETA (free text like "Vancouver ETD Jul 27/ YN")  → put the departure date in etd and the arrival date in eta; if only one is given, fill that one; keep any extra text (initials, port) in notes.
- BOL type                 → bol_type
- QUOTE                    → quote_ref
- AES                      → aes
- Notes                    → notes
Ignore the columns "Sales" and "Handler" entirely (not imported). Ignore cell colours/formatting.

Date rules: reproduce dates as written; when a date has no year (e.g. "Jul 10"), format it YYYY-MM-DD using the year the sheet clearly belongs to (infer from other dated cells; default to the current year). Leave a field null if the cell is empty.

Rules: never merge two rows; never invent data not present; leave unknown fields null. Return JSON only.`;

const ShipmentImportSchema = z.object({
  ref_id: z.string().min(1),
  operational_status: z.string().nullable().optional(),
  booking_ref: z.string().nullable().optional(),
  customer_name: z.string().nullable().optional(),
  shipper_name: z.string().nullable().optional(),
  receiver_name: z.string().nullable().optional(),
  fpol: z.string().nullable().optional(),
  pol: z.string().nullable().optional(),
  pod: z.string().nullable().optional(),
  fpod: z.string().nullable().optional(),
  carrier_preference: z.string().nullable().optional(),
  container_type: z.string().nullable().optional(),
  container_quantity: z.number().int().nullable().optional(),
  cut_off_date: z.string().nullable().optional(),
  si_date: z.string().nullable().optional(),
  sea_air_cargo: z.string().nullable().optional(),
  vgm: z.string().nullable().optional(),
  draft_date: z.string().nullable().optional(),
  loading_date: z.string().nullable().optional(),
  trucker: z.string().nullable().optional(),
  etd: z.string().nullable().optional(),
  eta: z.string().nullable().optional(),
  bol_type: z.string().nullable().optional(),
  quote_ref: z.string().nullable().optional(),
  aes: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
const SheetSchema = z.object({ shipments: z.array(ShipmentImportSchema) });

export type ShipmentImportRow = z.infer<typeof ShipmentImportSchema>;
export type ShipmentSheetMediaType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'text/csv'
  | 'text/plain';
export interface ShipmentSheetInput {
  fileBase64: string;
  mediaType: ShipmentSheetMediaType;
  filename?: string;
}

const SCHEMA_DESCRIPTION = `{
  "shipments": [{
    "ref_id": "string (company File#, e.g. S00043252 — required)",
    "operational_status": "string|null",
    "booking_ref": "string|null",
    "customer_name": "string|null",
    "shipper_name": "string|null",
    "receiver_name": "string|null",
    "fpol": "string|null",
    "pol": "string|null",
    "pod": "string|null",
    "fpod": "string|null",
    "carrier_preference": "string|null",
    "container_type": "string|null",
    "container_quantity": "integer|null",
    "cut_off_date": "string|null",
    "si_date": "string|null",
    "sea_air_cargo": "string|null",
    "vgm": "string|null",
    "draft_date": "string|null",
    "loading_date": "string|null",
    "trucker": "string|null",
    "etd": "string|null",
    "eta": "string|null",
    "bol_type": "string|null",
    "quote_ref": "string|null",
    "aes": "string|null",
    "notes": "string|null"
  }]
}`;

export async function parseShipmentSheet(
  input: ShipmentSheetInput
): Promise<{ shipments: ShipmentImportRow[] }> {
  const isText = input.mediaType === 'text/csv' || input.mediaType === 'text/plain';
  const result = await executeStructuredAiTask({
    kind: 'shipment-sheet-import',
    systemPrompt: SHEET_SYSTEM_PROMPT,
    userPrompt: isText
      ? `Import every data row from this spreadsheet (CSV below). Output one shipment per row.\n\n${Buffer.from(input.fileBase64, 'base64').toString('utf8').slice(0, 60000)}`
      : 'Import every data row from this shipment-tracking spreadsheet. Output one shipment object per row.',
    schemaDescription: SCHEMA_DESCRIPTION,
    media: isText
      ? undefined
      : { mediaType: input.mediaType, base64: input.fileBase64, filename: input.filename },
    highStakes: true,
    validate(value) {
      const parsed = SheetSchema.safeParse(value);
      if (!parsed.success)
        throw new Error(
          `Shipment-sheet output failed schema validation: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`
        );
      return parsed.data;
    },
  });
  return result.value;
}
