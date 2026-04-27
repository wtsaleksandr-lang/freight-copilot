/**
 * Hapag-Lloyd selectors. Most are stable data-testid attributes captured in
 * the recorded session. The container-type label comes from a Quasar
 * dropdown — we match by visible text since HL uses words like
 * "20' General Purpose" rather than carrier codes.
 */

export const HLC_URLS = {
  home: 'https://www.hapag-lloyd.com/en/home.html',
  /** Quote form — `/simple` lands directly on the search inputs. */
  newQuote: 'https://www.hapag-lloyd.com/solutions/new-quote/#/simple?language=en',
  newQuotePattern: /\/new-quote/,
};

export const HLC_TESTIDS = {
  startInput: '[data-testid="start-input"]',
  endInput: '[data-testid="end-input"]',
  containerInput: '[data-testid="container-input"]',
  validityInput: '[data-testid="validity-input"]',
  weightInput: '[data-testid="weight-input"]',
  amountInput: '[data-testid="amount-input"]',
  searchSubmit: '[data-testid="search-submit"]',
  /** "Select" button on each offer card (the visible result list). */
  offerSelect: '[data-testid^="offer-card-select-button"]',
};

/**
 * Map our internal container labels (Maersk-style) → HLC's dropdown labels.
 * If the requested label isn't in this table, we pass it through unchanged
 * so the adapter degrades gracefully if HL adds a new size.
 */
/**
 * HL relabeled all standard sizes "General Purpose" as the prefix; high
 * cubes are now "General Purpose High Cube". Match the *current* portal
 * text exactly — these strings are passed to page.getByText() so a substring
 * match would also catch "General Purpose" when we want "General Purpose
 * High Cube". Use exact-ish phrases.
 */
export const HLC_CONTAINER_LABELS: Record<string, string> = {
  '20 Dry Standard': "20' General Purpose",
  '40 Dry Standard': "40' General Purpose",
  '40 Dry High': "40' General Purpose High Cube",
  '20 Reefer': "20' Reefer",
  '40 Reefer': "40' Reefer",
  '40 Reefer High Cube': "40' Reefer High Cube",
  '20 Open Top': "20' Open Top",
  '40 Open Top': "40' Open Top",
  '20 Flat Rack': "20' Flat",
  '40 Flat Rack': "40' Flat",
  '20 Tank': "20' Tank",
};
