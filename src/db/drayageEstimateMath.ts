export type DrayageEndLike = {
  type: 'CY' | 'DOOR';
  portCode?: string | null;
  portName?: string | null;
  terminal?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
};

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function sameValue(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return left.length > 0 && left === right;
}

function zipPrefix(value: string | null | undefined): string {
  return normalize(value).slice(0, 3);
}

export function scoreDrayageEndpoint(target: DrayageEndLike, historical: DrayageEndLike): number {
  if (target.type !== historical.type) return -100;
  if (target.type === 'CY') {
    if (sameValue(target.portCode, historical.portCode)) return sameValue(target.terminal, historical.terminal) ? 6 : 5;
    if (sameValue(target.portName, historical.portName)) return 4;
    if (sameValue(target.terminal, historical.terminal)) return 3;
    return -100;
  }

  if (sameValue(target.zip, historical.zip)) return 6;
  const leftPrefix = zipPrefix(target.zip);
  const rightPrefix = zipPrefix(historical.zip);
  if (leftPrefix.length === 3 && leftPrefix === rightPrefix && sameValue(target.country, historical.country)) return 4;
  if (sameValue(target.city, historical.city) && sameValue(target.state, historical.state)) return 4;
  if (sameValue(target.state, historical.state) && sameValue(target.country, historical.country)) return 2;
  return -100;
}

export function normalizeHistoricalCost(amount: number, historicalCount: number, requestedCount: number): number {
  const sourceCount = Number.isFinite(historicalCount) && historicalCount > 0 ? historicalCount : 1;
  const targetCount = Number.isFinite(requestedCount) && requestedCount > 0 ? requestedCount : 1;
  return (amount / sourceCount) * targetCount;
}

export function weightMatchScore(
  requestedWeightKg: number | undefined,
  requestedCount: number,
  historicalWeightKg: number | null,
  historicalCount: number
): number {
  if (!requestedWeightKg || !historicalWeightKg) return 0;
  const requestedPerContainer = requestedWeightKg / Math.max(1, requestedCount);
  const historicalPerContainer = historicalWeightKg / Math.max(1, historicalCount);
  if (historicalPerContainer < requestedPerContainer * 0.8) return -100;
  const ratio = historicalPerContainer / requestedPerContainer;
  if (ratio >= 0.9 && ratio <= 1.2) return 2;
  if (ratio >= 0.8 && ratio <= 1.5) return 1;
  return 0;
}
