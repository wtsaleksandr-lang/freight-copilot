import type { CarrierAdapter, QuoteInput, FetchRatesResult } from '../types.js';
import { genericLogin } from '../genericLogin.js';
import { CMA_URLS } from './selectors.js';
import { fetchCmaRates } from './fetchRates.js';

export const code = 'CMA';
export const name = 'CMA CGM';
export const homeUrl = CMA_URLS.home;
export const rateUrl = CMA_URLS.spotOn;
export const isActive = true;

export async function login(): Promise<void> {
  return genericLogin({
    carrierCode: code,
    carrierName: name,
    homeUrl,
    loggedInHint:
      'Log into CMA CGM eBusiness. Once your account name shows in the header, the cookies are good.',
  });
}

export async function fetchRates(input: QuoteInput): Promise<FetchRatesResult> {
  return fetchCmaRates(input);
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
