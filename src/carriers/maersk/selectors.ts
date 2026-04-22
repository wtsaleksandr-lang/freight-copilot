/**
 * Maersk DOM selectors.
 * Isolated in one file so the yearly portal redesign only hits this file.
 * All selectors use Playwright's accessibility-based locators (role + accessible name),
 * which survive Shadow DOM and are more stable than CSS classes / ids.
 */

export const MAERSK_URLS = {
  home: 'https://www.maersk.com/',
  book: 'https://www.maersk.com/book/',
  sailingsPattern: /\/book\/sailings/,
};

export const MAERSK_LABELS = {
  fromCombobox: 'From (City, Country/Region)',
  toCombobox: 'To (City, Country/Region)',
  containerTypeCombobox: 'Container type and size',
  cargoWeightTextbox: 'Cargo weight per container',
  priceOwnerRadio: 'I am the price owner',
  selectTomorrow: /select tomorrow/i,
  continueToBook: /continue to book/i,
  searchMoreSailings: /search more sailing options/i,
  priceBreakdownDetails: /price breakdown & details/i,
};
