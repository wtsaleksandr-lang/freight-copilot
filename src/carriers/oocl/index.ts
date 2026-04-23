import type { CarrierAdapter, QuoteInput, FetchRatesResult } from '../types.js';
import { genericLogin } from '../genericLogin.js';

export const code = 'OOC';
export const name = 'OOCL';
export const homeUrl = 'https://www.oocl.com/eng/Pages/default.aspx';
export const isActive = false;

export async function login(): Promise<void> {
  return genericLogin({ carrierCode: code, carrierName: name, homeUrl });
}

export async function fetchRates(_input: QuoteInput): Promise<FetchRatesResult> {
  throw new Error(
    `${name} rate fetch is not yet onboarded. See docs/onboarding-checklist.md.`
  );
}

const _assertAdapter: CarrierAdapter = { code, name, homeUrl, isActive, login, fetchRates };
void _assertAdapter;
