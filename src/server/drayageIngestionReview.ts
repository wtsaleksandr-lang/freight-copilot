import type { ParsedDrayageRate } from '../llm/parseDrayageRateFiles.js';

export type DrayageReviewSeverity = 'warning' | 'blocking';
export interface DrayageReviewIssue { field: string; severity: DrayageReviewSeverity; message: string; }
export interface ReviewedDrayageRate extends ParsedDrayageRate { reviewIssues: DrayageReviewIssue[]; readyToImport: boolean; }

function endpointHasIdentity(rate: ParsedDrayageRate, side: 'origin'|'destination'): boolean {
  const type = rate[`${side}_type`];
  if (type === 'CY') return Boolean(rate[`${side}_port_code`] || rate[`${side}_port_name`] || rate[`${side}_terminal`]);
  return Boolean(rate[`${side}_address`] || rate[`${side}_city`] || rate[`${side}_zip`]);
}

export function reviewDrayageRate(rate: ParsedDrayageRate): ReviewedDrayageRate {
  const reviewIssues: DrayageReviewIssue[] = [];
  const blocking = (field:string,message:string) => reviewIssues.push({field,severity:'blocking',message});
  const warning = (field:string,message:string) => reviewIssues.push({field,severity:'warning',message});
  if (!rate.provider_name?.trim()) blocking('provider_name','Provider is required.');
  if (!rate.container_type?.trim()) blocking('container_type','Container type is required.');
  if (!(rate.container_count > 0)) blocking('container_count','Container count must be greater than zero.');
  if (!endpointHasIdentity(rate,'origin')) blocking('origin','Origin does not identify a port/terminal or door location.');
  if (!endpointHasIdentity(rate,'destination')) blocking('destination','Destination does not identify a port/terminal or door location.');
  if (rate.origin_type === rate.destination_type) warning('route_type','Typical drayage has one CY endpoint and one DOOR endpoint. Verify this move.');
  if (!(rate.base_rate >= 0)) blocking('base_rate','Base rate must be zero or greater.');
  if (!(rate.total_cost >= 0)) blocking('total_cost','Total cost must be zero or greater.');
  if (rate.total_cost < rate.base_rate) warning('total_cost','All-in cost is lower than the base rate.');
  if (!/^[A-Z]{3}$/.test(rate.currency?.toUpperCase() ?? '')) blocking('currency','Currency must be a three-letter code.');
  if (!rate.valid_until) warning('valid_until','No validity date was found.');
  if (!rate.source_filename?.trim()) blocking('source_filename','Source filename is required for evidence.');
  if (rate.cargo_type === 'hazmat' && !rate.accessorials.some((value) => /haz/i.test(value))) warning('hazmat','Hazmat cargo is shown without a hazmat accessorial. Verify inclusion.');
  if (rate.container_count > 1) warning('container_count','Verify whether the quoted amount is per container or for the full quantity.');
  return { ...rate, currency:rate.currency.toUpperCase(), reviewIssues, readyToImport:!reviewIssues.some((issue)=>issue.severity==='blocking') };
}

export function reviewDrayageRates(rates: ParsedDrayageRate[]): ReviewedDrayageRate[] { return rates.map(reviewDrayageRate); }
