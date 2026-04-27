export const PARSE_RATES_TOOL_NAME = 'parse_rate_options';

export const PARSE_RATES_SYSTEM_PROMPT = `You parse ocean freight rate listings from Maersk Spot sailings pages.
You will receive a YAML-formatted Playwright accessibility tree.

For each sailing (each "- article:" block containing a headline price like "USD 1,122.00"), extract one rate option.

# Top-level fields per sailing

- service_name: product label, e.g. "Maersk Spot" or "Maersk Spot Rollable".
- sailing_date: departure day as-shown, e.g. "28 Apr 2026".
- departure_datetime: full departure, e.g. "28 Apr 2026, 06:00".
- arrival_datetime: full arrival, e.g. "4 Jun 2026, 22:00".
- gate_in_deadline: gate-in deadline, e.g. "23 Apr 2026, 16:00".
- transit_days, transit_hours: parsed from "Transit time" (e.g. "37 days 10 hours" -> 37, 10).
- vessel_voyage: e.g. "SFL HAWAII / 618E".
- headline_price_amount: number from the headline price line. Strip currency, commas. Round half-up if there are decimals.
- headline_price_currency: 3-letter ISO code, e.g. "USD", "EUR".
- rollable: true if "Cargo may be rolled" text appears.
- detention_freetime_days: from phrases like "Incl. 4 days of detention" -> 4.
- demurrage_freetime_days: from "... 5 days of demurrage freetime" -> 5.

# Itemized charges (only present if the breakdown panel was expanded)

When a sailing's "Price breakdown & details" panel is expanded in the aria tree, you'll see rows under headers like
"Freight charges" and "Destination charges". Each row has columns: charge name, Basis, Quantity, Currency,
Unit price, Total price.

- freight_charges: array of objects for EVERY row under "Freight charges" (in order). Each:
  - name: row label, e.g. "Basic Ocean Freight"
  - basis: "Container" or "Bill of Lading" or null
  - quantity: integer
  - unit_price: number
  - total: number from the "Total price" cell (round half-up)
  - currency: 3-letter ISO

- destination_charges: same shape, for rows under "Destination charges".

# Rules

- If breakdown rows are NOT visible for a sailing in the input, return EMPTY ARRAYS for freight_charges and destination_charges. Do not invent rows.
- If a field is not present, return null (or false for rollable).
- Skip any sailing that has no headline price.
- Do not infer or hallucinate values. Only extract what the text says.
- Return one tool call to parse_rate_options.`;

const CHARGE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    basis: { type: ['string', 'null'] },
    quantity: { type: ['integer', 'null'] },
    unit_price: { type: ['number', 'null'] },
    total: { type: 'number' },
    currency: { type: 'string' },
  },
  required: ['name', 'basis', 'quantity', 'unit_price', 'total', 'currency'],
} as const;

export const PARSE_RATES_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    rates: {
      type: 'array',
      description: 'One entry per sailing with a visible price.',
      items: {
        type: 'object',
        properties: {
          service_name: { type: 'string' },
          sailing_date: { type: ['string', 'null'] },
          departure_datetime: { type: ['string', 'null'] },
          arrival_datetime: { type: ['string', 'null'] },
          gate_in_deadline: { type: ['string', 'null'] },
          transit_days: { type: ['integer', 'null'] },
          transit_hours: { type: ['integer', 'null'] },
          vessel_voyage: { type: ['string', 'null'] },
          headline_price_amount: { type: ['number', 'null'] },
          headline_price_currency: { type: ['string', 'null'] },
          rollable: { type: 'boolean' },
          detention_freetime_days: { type: ['integer', 'null'] },
          demurrage_freetime_days: { type: ['integer', 'null'] },
          freight_charges: {
            type: 'array',
            description:
              'Every row under "Freight charges" in the breakdown panel, in order. Empty array if breakdown not visible.',
            items: CHARGE_SCHEMA,
          },
          destination_charges: {
            type: 'array',
            description:
              'Every row under "Destination charges". Often in EUR. Empty array if breakdown not visible.',
            items: CHARGE_SCHEMA,
          },
        },
        required: [
          'service_name',
          'sailing_date',
          'departure_datetime',
          'arrival_datetime',
          'gate_in_deadline',
          'transit_days',
          'transit_hours',
          'vessel_voyage',
          'headline_price_amount',
          'headline_price_currency',
          'rollable',
          'detention_freetime_days',
          'demurrage_freetime_days',
          'freight_charges',
          'destination_charges',
        ],
      },
    },
  },
  required: ['rates'],
} as const;
