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
