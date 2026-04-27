/**
 * CMA CGM SpotOn (instant quote) selectors. The portal uses Element Plus +
 * its own custom components — most stable hooks are the dropdown ids
 * (#DdlCommodity, #DdlCustomerRole, #SelectVoyage), the section CSS
 * classes (.o-search-port, .destination-search), and the hidden ARIA
 * names captured in the recording.
 */

export const CMA_URLS = {
  home: 'https://www.cma-cgm.com/ebusiness/customer-hub/',
  /** Direct deep link to SpotOn quoting (skips menu navigation when possible). */
  spotOn: 'https://www.cma-cgm.com/ebusiness/customer-hub/spoton',
  spotOnPattern: /spoton/i,
};

export const CMA_SELECTORS = {
  originInput: 'div.o-search-port > div > div:nth-of-type(1) input',
  /** First option in the origin autocomplete result list. */
  originFirstOption: 'div.l-zone__main li:nth-of-type(1) div.capsule',
  destinationInput: 'div.destination-search input',
  destinationFirstOption: 'div.destination-search li:nth-of-type(1)',
  /** "Add" button on each container size tile. li:nth-of-type(N) selects size N. */
  containerAddButton: (n: number) =>
    `li:nth-of-type(${n}) button.add-button`,
  /** Weight input becomes available on the active (.is-checked) container tile. */
  weightInput: 'li.is-checked input[type="text"], li.is-checked input[type="number"]',
  commodityDropdown: '#DdlCommodity',
  customerRoleDropdown: '#DdlCustomerRole',
  /** Final submit on the SpotOn form. */
  submitButton: 'text=Get My Quote',
  /** First sailing card on the results page. */
  firstSailingCard: 'section.results li:nth-of-type(1) > button',
};

/**
 * Map our internal Maersk-style container labels → CMA's "Add" button position.
 * CMA's container picker is a horizontal row of size tiles in fixed order.
 * Indices may shift if CMA reorders — verify on the first real run.
 */
export const CMA_CONTAINER_INDEX: Record<string, number> = {
  '20 Dry Standard': 1,
  '40 Dry Standard': 2,
  '40 Dry High': 3,
  '20 Reefer': 4,
  '40 Reefer High Cube': 5,
};

/** Dashboard label → CMA's commodity dropdown text. */
export const CMA_COMMODITY_DEFAULT = 'Freight All Kinds';

/** Default customer role for a freight forwarder. */
export const CMA_CUSTOMER_ROLE_DEFAULT = 'NVOCC';
