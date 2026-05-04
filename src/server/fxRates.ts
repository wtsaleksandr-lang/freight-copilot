/**
 * Currency conversion to USD. Used by the shipment parse endpoints
 * to normalise every cost / sold line item to USD before persistence,
 * so the breakdown panels and totals are always in a single currency.
 *
 * Rate semantics: rates[X] = "1 X = N USD".
 *   amountUsd = amount * rates[currency]
 *
 * Built-in defaults are rough approximations — the dashboard sends
 * its own override map (sourced from the floating calc panel's CAD
 * rate plus any other currencies the user has set), so the served
 * value typically wins. If a currency isn't in either map, the
 * amount is left unchanged and `converted: false` is returned so
 * the caller can decide how to surface that.
 */

export const DEFAULT_FX_TO_USD: Record<string, number> = {
  USD: 1,
  CAD: 0.73,
  EUR: 1.08,
  GBP: 1.27,
  AUD: 0.65,
  JPY: 0.0064,
  CNY: 0.14,
  CHF: 1.13,
  HKD: 0.128,
  SGD: 0.74,
  MXN: 0.058,
};

export interface ToUsdResult {
  /** Converted amount, rounded to 2 decimal places. */
  amount: number;
  /** Rate used (1 source-currency = rate USD). */
  rate: number;
  /** True if a conversion happened. False for USD pass-through or
   *  for unknown currencies (left as-is). */
  converted: boolean;
  /** The original (pre-conversion) currency code, upper-cased. */
  fromCurrency: string;
  /** The pre-conversion amount (round-tripped for display). */
  fromAmount: number;
}

export function toUsd(
  amount: number,
  currency: string,
  overrides: Record<string, number> = {}
): ToUsdResult {
  const cur = (currency || 'USD').toUpperCase();
  if (cur === 'USD') {
    return {
      amount,
      rate: 1,
      converted: false,
      fromCurrency: 'USD',
      fromAmount: amount,
    };
  }
  const rate = overrides[cur] ?? DEFAULT_FX_TO_USD[cur];
  if (rate == null || !Number.isFinite(rate) || rate <= 0) {
    return {
      amount,
      rate: 1,
      converted: false,
      fromCurrency: cur,
      fromAmount: amount,
    };
  }
  const usd = Math.round(amount * rate * 100) / 100;
  return {
    amount: usd,
    rate: rate as number,
    converted: true,
    fromCurrency: cur,
    fromAmount: amount,
  };
}

/**
 * Format a label that records what the original amount was before
 * conversion, so the user can audit it. Returns null if no conversion
 * happened.
 *   "(was CAD 5,400 @ 0.7299 → USD 3,941.46)"
 */
export function conversionAnnotation(r: ToUsdResult): string | null {
  if (!r.converted) return null;
  const fromFmt = r.fromAmount.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  const usdFmt = r.amount.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  return `(was ${r.fromCurrency} ${fromFmt} @ ${r.rate.toFixed(4)} → USD ${usdFmt})`;
}
