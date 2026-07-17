import type { ParsedTruckingRate } from '../llm/parseTruckingRateFiles.js';

export type ReviewSeverity = 'warning' | 'blocking';

export interface ReviewIssue {
  field: string;
  severity: ReviewSeverity;
  message: string;
}

export interface ReviewedTruckingRate extends ParsedTruckingRate {
  reviewIssues: ReviewIssue[];
  readyToImport: boolean;
}

export function reviewTruckingRate(rate: ParsedTruckingRate): ReviewedTruckingRate {
  const issues: ReviewIssue[] = [];
  const blocking = (field: string, message: string) => issues.push({ field, severity: 'blocking', message });
  const warning = (field: string, message: string) => issues.push({ field, severity: 'warning', message });

  if (!rate.provider_name?.trim()) blocking('provider_name', 'Provider is required.');
  if (!rate.pickup_city?.trim()) blocking('pickup_city', 'Pickup city is required.');
  if (!rate.delivery_city?.trim()) blocking('delivery_city', 'Delivery city is required.');
  if (!rate.equipment_type?.trim()) blocking('equipment_type', 'Equipment type is required.');
  if (!(rate.base_rate >= 0)) blocking('base_rate', 'Base rate must be zero or greater.');
  if (!(rate.total_cost >= 0)) blocking('total_cost', 'Total cost must be zero or greater.');
  if (rate.total_cost < rate.base_rate) warning('total_cost', 'All-in cost is lower than the base rate. Verify both amounts.');
  if (!/^[A-Z]{3}$/.test(rate.currency?.toUpperCase() ?? '')) blocking('currency', 'Currency must be a three-letter code.');
  if (!rate.pickup_state && !rate.pickup_zip) warning('pickup_location', 'Pickup state and ZIP are both missing; future matching will be weaker.');
  if (!rate.delivery_state && !rate.delivery_zip) warning('delivery_location', 'Delivery state and ZIP are both missing; future matching will be weaker.');
  if (!rate.valid_until) warning('valid_until', 'No validity date was found.');
  if (!rate.source_filename?.trim()) blocking('source_filename', 'Source filename is required for evidence.');
  if (rate.hazmat && rate.cargo_type !== 'hazmat') warning('cargo_type', 'Hazmat is true but cargo type is not hazmat.');
  if (rate.temp_controlled && rate.cargo_type !== 'reefer') warning('cargo_type', 'Temperature control is true but cargo type is not reefer.');

  return {
    ...rate,
    currency: rate.currency.toUpperCase(),
    reviewIssues: issues,
    readyToImport: !issues.some((issue) => issue.severity === 'blocking'),
  };
}

export function reviewTruckingRates(rates: ParsedTruckingRate[]): ReviewedTruckingRate[] {
  return rates.map(reviewTruckingRate);
}
