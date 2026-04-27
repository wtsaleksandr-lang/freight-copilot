import type { CarrierAdapter, QuoteInput, FetchRatesResult } from '../types.js';
import { genericLogin } from '../genericLogin.js';
import { MSC_URLS } from './selectors.js';
import { fetchMscRates } from './fetchRates.js';

export const code = 'MSC';
export const name = 'MSC';
export const homeUrl = MSC_URLS.home;
export const rateUrl = MSC_URLS.instantQuote;
export const isActive = true;

export async function login(): Promise<void> {
  return genericLogin({
    carrierCode: code,
    carrierName: name,
    homeUrl: 'https://www.mymsc.com/',
    loggedInHint:
      'Log into myMSC at https://www.mymsc.com/. Once you can see your account dashboard, the cookies are good.',
  });
}

export async function fetchRates(input: QuoteInput): Promise<FetchRatesResult> {
  return fetchMscRates(input);
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
