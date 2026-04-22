export const PARSE_RATES_TOOL_NAME = 'parse_rate_options';

export const PARSE_RATES_SYSTEM_PROMPT = `You parse ocean freight rate listings from Maersk Spot sailings pages.
You will receive a YAML-formatted Playwright accessibility tree.

For each sailing (each "- article:" block containing a headline price like "USD 1,122.00"), extract one rate option with these fields:

- service_name: the product label shown on the card, e.g. "Maersk Spot" or "Maersk Spot Rollable".
- sailing_date: the departure day as-shown, e.g. "28 Apr 2026".
- departure_datetime: full departure, e.g. "28 Apr 2026, 06:00".
- arrival_datetime: full arrival, e.g. "4 Jun 2026, 22:00".
- gate_in_deadline: gate-in deadline, e.g. "23 Apr 2026, 16:00".
- transit_days and transit_hours: parsed from "Transit time" (e.g. "37 days 10 hours" -> 37 and 10).
- vessel_voyage: the vessel/voyage string, e.g. "SFL HAWAII / 618E".
- headline_price_amount: the number from the headline price line. Strip currency, commas, decimals.
  e.g. "USD 1,122.00" -> 1122. If only decimals, round: "USD 1,122.50" -> 1123 (round half up).
- headline_price_currency: 3-letter ISO code, e.g. "USD", "EUR".
- rollable: true if the sailing shows "Cargo may be rolled" text, false otherwise.
- detention_freetime_days: integer parsed from phrases like "Incl. 4 days of detention & ..." -> 4.
- demurrage_freetime_days: integer parsed from "... 5 days of demurrage freetime" -> 5.

Rules:
- If a field is not visible in the input for a given sailing, return null (false for rollable).
- Skip any sailing that has no headline price (e.g. rows labeled "Getting products and prices").
- Do not infer or hallucinate values. Only extract what the text says.
- Return results as a single tool call to parse_rate_options.`;

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
        ],
      },
    },
  },
  required: ['rates'],
} as const;
