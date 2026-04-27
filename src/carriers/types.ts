/**
 * Shared types for all carrier adapters.
 *
 * Each carrier lives under src/carriers/<code>/ with its own index.ts that
 * implements CarrierAdapter. The registry (src/carriers/registry.ts) exposes
 * them all keyed by carrier code.
 */

export interface QuoteInput {
  origin: string;
  originRegion?: string;
  /** UN/LOCODE for the origin port (e.g. "USSAV") if the user picked a port
   *  from the typeahead. Adapters prefer this when set — it's a 5-char
   *  unambiguous match in carrier autocompletes. */
  originPortCode?: string;
  destination: string;
  destinationRegion?: string;
  destinationPortCode?: string;
  containerType: string;
  cargoWeightKg: number;
  commodity?: string;
}

export interface FetchRatesResult {
  finalUrl: string;
  /** Raw HTML of the rendered sailings page (may miss Shadow DOM). */
  sailingsHtml: string;
  /** YAML-ish aria tree — what the LLM actually parses. */
  sailingsAriaTree: string;
  htmlPath: string;
  ariaTreePath: string;
  screenshotPath: string;
}

export interface CarrierAdapter {
  /** 3-letter carrier code used throughout the app (MSK, MSC, etc.). */
  readonly code: string;
  /** Human-readable carrier name. */
  readonly name: string;
  /** Starting URL for headed-browser login. */
  readonly homeUrl: string;
  /** URL that the fetch flow navigates to after login (can be same as homeUrl). */
  readonly rateUrl?: string;
  /** `false` for adapters whose fetchRates throws because onboarding isn't complete. */
  readonly isActive: boolean;
  /** Open a headed browser at homeUrl, wait for user login, save session to DB. */
  login(): Promise<void>;
  /** Drive the carrier's rate search portal and return captured HTML + aria tree. */
  fetchRates(input: QuoteInput): Promise<FetchRatesResult>;
}
