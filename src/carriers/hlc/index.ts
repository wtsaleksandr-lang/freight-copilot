import type { CarrierAdapter, QuoteInput, FetchRatesResult } from '../types.js';
import { genericLogin } from '../genericLogin.js';
import { HLC_URLS } from './selectors.js';
import { fetchHlcRates } from './fetchRates.js';

export const code = 'HLC';
export const name = 'Hapag-Lloyd';
export const homeUrl = HLC_URLS.home;
export const rateUrl = HLC_URLS.newQuote;
export const isActive = true;

export async function login(): Promise<void> {
  return genericLogin({
    carrierCode: code,
    carrierName: name,
    homeUrl,
    loggedInHint:
      'Log in at hapag-lloyd.com. Once you can see the "New Quote" link in the left menu, the cookies are good.',
  });
}

export async function fetchRates(input: QuoteInput): Promise<FetchRatesResult> {
  return fetchHlcRates(input);
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
