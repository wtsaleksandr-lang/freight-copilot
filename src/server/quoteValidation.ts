import type { StoredCharge } from '../db/schema.js';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
}

export interface QuoteValidationInput {
  carrierCode?: string | null;
  serviceName?: string | null;
  sailingDate?: string | null;
  validUntil?: string | null;
  transitDays?: number | null;
  detentionFreetimeDays?: number | null;
  demurrageFreetimeDays?: number | null;
  currency?: string | null;
  totalCostCents?: number | null;
  charges?: StoredCharge[] | null;
  destinationCharges?: StoredCharge[] | null;
  destinationTotal?: number | null;
  destinationCurrency?: string | null;
  headlineMismatch?: boolean | null;
  rawHtmlRef?: string | null;
}

export interface QuoteValidationResult {
  ready: boolean;
  score: number;
  issues: ValidationIssue[];
}

const TOLERANCE_CENTS = 2;

function isCurrency(value: string | null | undefined): boolean {
  return /^[A-Z]{3}$/.test((value ?? '').trim().toUpperCase());
}

function sumChargesCents(charges: StoredCharge[] | null | undefined): number | null {
  if (!charges || charges.length === 0) return null;
  return Math.round(charges.reduce((sum, row) => sum + Number(row.total || 0), 0) * 100);
}

export function validateQuoteRate(input: QuoteValidationInput): QuoteValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (code: string, severity: ValidationSeverity, message: string): void => {
    issues.push({ code, severity, message });
  };

  if (!input.carrierCode) add('carrier_missing', 'error', 'Carrier is missing.');
  if (!input.serviceName) add('service_missing', 'warning', 'Service name is missing.');
  if (!input.sailingDate) add('sailing_date_missing', 'warning', 'Sailing date is missing.');
  if (!input.validUntil) add('validity_missing', 'error', 'Rate validity is missing.');
  if (input.transitDays == null) add('transit_missing', 'warning', 'Transit time is missing.');
  if (input.detentionFreetimeDays == null) add('detention_missing', 'warning', 'Detention free time is missing.');
  if (input.demurrageFreetimeDays == null) add('demurrage_missing', 'warning', 'Demurrage free time is missing.');
  if (!isCurrency(input.currency)) add('currency_invalid', 'error', 'Freight currency is missing or invalid.');
  if (input.totalCostCents == null || input.totalCostCents <= 0) {
    add('total_invalid', 'error', 'Freight total is missing or not positive.');
  }
  if (!input.charges || input.charges.length === 0) {
    add('charges_missing', 'error', 'No itemized freight charges were captured.');
  }
  if (!input.rawHtmlRef) add('evidence_missing', 'error', 'Carrier evidence file is missing.');
  if (input.headlineMismatch) add('headline_mismatch', 'error', 'Carrier headline total does not match parsed charges.');

  const freightSum = sumChargesCents(input.charges);
  if (
    freightSum != null &&
    input.totalCostCents != null &&
    Math.abs(freightSum - input.totalCostCents) > TOLERANCE_CENTS
  ) {
    add(
      'freight_sum_mismatch',
      'error',
      `Itemized freight charges total ${(freightSum / 100).toFixed(2)}, but stored total is ${(input.totalCostCents / 100).toFixed(2)}.`
    );
  }

  if (input.destinationCharges && input.destinationCharges.length > 0) {
    if (!isCurrency(input.destinationCurrency)) {
      add('destination_currency_invalid', 'error', 'Destination-charge currency is missing or invalid.');
    }
    const destinationSum = sumChargesCents(input.destinationCharges);
    if (
      destinationSum != null &&
      input.destinationTotal != null &&
      Math.abs(destinationSum - input.destinationTotal) > TOLERANCE_CENTS
    ) {
      add('destination_sum_mismatch', 'error', 'Destination charge total does not match its itemized rows.');
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const score = Math.max(0, 100 - errorCount * 20 - warningCount * 5);

  return {
    ready: errorCount === 0,
    score,
    issues,
  };
}
