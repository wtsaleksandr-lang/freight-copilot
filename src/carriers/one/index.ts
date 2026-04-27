import type { CarrierAdapter, QuoteInput, FetchRatesResult } from '../types.js';
import { genericLogin } from '../genericLogin.js';
import { ONE_URLS } from './selectors.js';
import { fetchOneRates } from './fetchRates.js';

export const code = 'ONE';
export const name = 'ONE Line';
export const homeUrl = ONE_URLS.home;
export const rateUrl = ONE_URLS.home;
export const isActive = true;

export async function login(): Promise<void> {
  return genericLogin({
    carrierCode: code,
    carrierName: name,
    homeUrl,
    loggedInHint:
      'Log into ONE Line eCommerce. Once the PRICES menu is clickable, the cookies are good.',
  });
}

export async function fetchRates(input: QuoteInput): Promise<FetchRatesResult> {
  return fetchOneRates(input);
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
