/**
 * ONE Line eCommerce selectors. ONE's portal uses Headless UI and downshift,
 * both of which generate dynamic ids per render (#headlessui-combobox-input-:r2q:,
 * #downshift-33-input). Those ids change between sessions, so the adapter
 * targets ARIA labels and stable data-cy hooks captured in the recording.
 */

export const ONE_URLS = {
  home: 'https://ecomm.one-line.com/one-ecom',
  /** SPA route reached after PRICES → Launch ONE QUOTE. */
  quotePattern: /one-ecom\/aoq/i,
};

export const ONE_LABELS = {
  prices: 'PRICES',
  launchQuote: 'Launch ONE QUOTE',
  cargoOwnerRadio: 'Cargo Owner',
  equipmentTypeCombobox: 'Select an Equipment Type',
  commodityCombobox: 'Please input Commodity Name or HS code',
  vesselDateLabel: 'Vessel Available Date',
  vesselDateField: 'Please select vessel departure date at origin',
  getQuote: 'GetQuote',
};

export const ONE_SELECTORS = {
  /** Booking field input (date trigger). */
  bookingFieldValue: '[data-cy="booking-field-value"]',
  /** Loading overlay we tap to dismiss the date picker. */
  loadingIndicator: '[data-cy="loading-indicator"]',
  /** Cargo weight input — id ends with _cargo_weight after a UUID prefix. */
  cargoWeightInput: 'input[id$="_cargo_weight"]',
  /** Results summary container. */
  summaryView: '#summary-view',
  /** Calendar day cells inside the date picker. */
  calendarDay: 'div.DateContent_container-quote__egx0o',
};

/**
 * Map our internal Maersk-style container labels → ONE's equipment-dropdown
 * text. ONE prefixes all dry sizes with "DRY " and reefer with "REEF ".
 */
export const ONE_CONTAINER_LABELS: Record<string, string> = {
  '20 Dry Standard': 'DRY 20',
  '40 Dry Standard': 'DRY 40',
  '40 Dry High': 'DRY 40 HC',
  '20 Reefer': 'REEF 20',
  '40 Reefer': 'REEF 40',
  '40 Reefer High Cube': 'REEF 40 HC',
};
