/**
 * OOCL FreightSmart selectors. Based on a 2-part DevTools Recording —
 * search → Get Quote spawns a new tab with the e-quote summary, which
 * the recorder doesn't follow. The adapter handles the popup.
 *
 * NOTE: OOCL realistically only returns rates for Canadian origins
 * (per onboarding feedback). Other lanes will likely return no e-quote.
 */

export const OOCL_URLS = {
  home: 'https://freightsmart.oocl.com/ui/',
  /** Pattern that matches the e-quote summary detail URL. */
  detailPattern: /e-spot-detail\/summary/i,
};

export const OOCL_SELECTORS = {
  /** First and second port inputs in the search bar. */
  originInput: 'div.control-bar > div > div:nth-of-type(1) input',
  destinationInput: 'div.control-bar > div > div:nth-of-type(2) input',
  /** Dropdown options under either port input — match by inner text. */
  locationOption: 'div.location-text',
  /** Container-type dropdown trigger (Quasar-style placeholder wrap). */
  containerTypeTrigger: 'div.placeholder-wrap',
  /** Container quantity input (3rd input in the data-wrap row). */
  quantityInput: 'div.data-wrap > div > div:nth-of-type(3) input',
  /** "No e-quote yet — click HERE to create one" prompt that sometimes
   *  appears between Get Quote and the results table. */
  noEquoteHereLink: '#noEquoteAndHasCreate',
};

/**
 * Map our internal Maersk-style container labels → OOCL's dropdown text.
 * OOCL labels containers by short codes ("20DV", "40HC") and sometimes
 * combined like "40HQ / 40RQ (NOR)" for high cube non-op reefer.
 * Match by visible text — adapter uses partial match.
 */
export const OOCL_CONTAINER_LABELS: Record<string, string> = {
  '20 Dry Standard': '20DV',
  '40 Dry Standard': '40DV',
  '40 Dry High': '40HQ',
  '20 Reefer': '20RF',
  '40 Reefer': '40RF',
  '40 Reefer High Cube': '40RH',
  '40 NOR (Non-Operating Reefer)': '40HQ / 40RQ (NOR)',
  '20 Open Top': '20OT',
  '40 Open Top': '40OT',
  '20 Flat Rack': '20FR',
  '40 Flat Rack': '40FR',
  '20 Tank': '20TK',
};
