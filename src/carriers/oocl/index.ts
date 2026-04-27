import type { CarrierAdapter, QuoteInput, FetchRatesResult } from '../types.js';
import { genericLogin } from '../genericLogin.js';
import { OOCL_URLS } from './selectors.js';
import { fetchOoclRates } from './fetchRates.js';

export const code = 'OOC';
export const name = 'OOCL';
export const homeUrl = OOCL_URLS.home;
export const rateUrl = OOCL_URLS.home;
export const isActive = true;

export async function login(): Promise<void> {
  return genericLogin({
    carrierCode: code,
    carrierName: name,
    homeUrl,
    loggedInHint:
      'Log into OOCL FreightSmart at freightsmart.oocl.com. Once you can see the search bar without a login overlay, the cookies are good.',
  });
}

export async function fetchRates(input: QuoteInput): Promise<FetchRatesResult> {
  return fetchOoclRates(input);
}

const _assertAdapter: CarrierAdapter = {
  code,
  name,
  homeUrl,
  rateUrl,
  isActive,
  login,
  fetchRates,
};
void _assertAdapter;
