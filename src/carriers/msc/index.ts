import type { CarrierAdapter, QuoteInput, FetchRatesResult } from '../types.js';
import { genericLogin } from '../genericLogin.js';

export const code = 'MSC';
export const name = 'MSC';
// Best-guess login URL. Correct during onboarding if different.
export const homeUrl = 'https://www.msc.com/';
export const isActive = false;

export async function login(): Promise<void> {
  return genericLogin({ carrierCode: code, carrierName: name, homeUrl });
}

export async function fetchRates(_input: QuoteInput): Promise<FetchRatesResult> {
  throw new Error(
    `${name} rate fetch is not yet onboarded. See docs/onboarding-checklist.md — ` +
      'need login + rate-search URLs, form screenshots, and one results page HTML.'
  );
}

const _assertAdapter: CarrierAdapter = { code, name, homeUrl, isActive, login, fetchRates };
void _assertAdapter;
