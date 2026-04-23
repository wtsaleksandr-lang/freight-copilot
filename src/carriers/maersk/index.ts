import type { CarrierAdapter, QuoteInput, FetchRatesResult } from '../types.js';
import { MAERSK_URLS } from './selectors.js';
import { maerskLogin } from './login.js';
import { fetchMaerskRates } from './fetchRates.js';

export const code = 'MSK';
export const name = 'Maersk';
export const homeUrl = MAERSK_URLS.home;
export const rateUrl = MAERSK_URLS.book;
export const isActive = true;

export async function login(): Promise<void> {
  return maerskLogin();
}

export async function fetchRates(input: QuoteInput): Promise<FetchRatesResult> {
  return fetchMaerskRates(input);
}

// Compile-time check: this module satisfies the CarrierAdapter interface.
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
