/**
 * MSC DOM selectors. MyMSC Instant Quote uses Material UI plus its own
 * data-test-id attributes — we lean on the test-ids since they're the most
 * stable target. CSS-class selectors (MuiGrid-*) shift on portal updates.
 */

export const MSC_URLS = {
  home: 'https://www.msc.com/',
  /** myMSC Instant Quote — the page captured in the recording. */
  instantQuote: 'https://www.mymsc.com/myMSC/instantquote',
  resultsHashPattern: /instantquote/i,
};

/**
 * Map our internal Maersk-style container labels to a list of patterns that
 * MSC's checkboxes might use. Multiple aliases per slot because MSC has
 * shown variations like "20DV" / "20'GP" / "20GP" / "20 STANDARD" across
 * accounts and views.
 */
export const MSC_CONTAINER_PATTERNS: Record<string, RegExp[]> = {
  '20 Dry Standard': [/^20'?\s*(GP|DV|STD|STANDARD|DRY)\b/i],
  '40 Dry Standard': [/^40'?\s*(GP|DV|STD|STANDARD|DRY)$/i, /^40'?\s*(GP|DV|STD)\s/i],
  '40 Dry High': [/^40'?\s*(HC|HQ|HIGH)\b/i],
  '20 Reefer': [/^20'?\s*(RF|REEFER|REE)\b/i],
  '40 Reefer': [/^40'?\s*(RF|REEFER|REE)\b/i],
  '40 Reefer High Cube': [/^40'?\s*(RH|HRF|REEFER\s*HC|RE\s*HC)\b/i],
  '20 Open Top': [/^20'?\s*(OT|OPEN)\b/i],
  '40 Open Top': [/^40'?\s*(OT|OPEN)\b/i],
  '20 Flat Rack': [/^20'?\s*(FR|FLAT)\b/i],
  '40 Flat Rack': [/^40'?\s*(FR|FLAT)\b/i],
  '20 Tank': [/^20'?\s*(TK|TANK)\b/i],
};

export const MSC_SELECTORS = {
  /** All container/equipment checkboxes share this prefix; index varies. */
  equipmentInputPrefix: '[data-test-id^="equipment-sizetype-input-"]',
  /** Origin port autocomplete trigger + input + first option. */
  originDropdownTrigger: '[data-test-id="originDropDown"] > div > div',
  originInput: '#origin',
  originFirstOption: '#origin-option-0',
  /** Destination port autocomplete trigger + input + first option. */
  destinationDropdownTrigger: '[data-test-id="destinationDropDown"] > div > div',
  destinationInput: '#destination',
  destinationFirstOption: '#destination-option-0',
  /** Submit. */
  searchRateButton: '[data-test-id="search-rate-button"]',
  /** Each rate result card (used to scope aria snapshot). */
  resultCard: 'div.MuiGrid-grid-xs-2',
};
