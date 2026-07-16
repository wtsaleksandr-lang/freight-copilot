export type RateFreshnessStatus =
  | 'fresh'
  | 'expiring_soon'
  | 'expired'
  | 'likely_stale'
  | 'unknown';

export interface RateFreshnessInput {
  validUntil?: string | null;
  parsedAt?: Date | string | null;
  now?: Date;
}

export interface RateFreshnessResult {
  status: RateFreshnessStatus;
  label: string;
  color: 'green' | 'yellow' | 'red' | 'gray';
  colorHex: string;
  message: string;
  validUntil: string | null;
  sourceAgeDays: number | null;
  daysUntilExpiry: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_SOON_DAYS = 7;
const SOURCE_FRESH_DAYS = 14;
const SOURCE_STALE_DAYS = 30;

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function wholeDays(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Classify a carrier rate by its explicit validity first. When validity is not
 * available, fall back to the age of the captured source as a practical signal.
 * The result is advisory: red means refresh before using, not that the rate is
 * mathematically proven incorrect.
 */
export function evaluateRateFreshness(input: RateFreshnessInput): RateFreshnessResult {
  const now = input.now ?? new Date();
  const validUntil = parseDate(input.validUntil);
  const parsedAt = parseDate(input.parsedAt);
  const sourceAgeDays = parsedAt ? Math.max(0, wholeDays(parsedAt, now)) : null;

  if (validUntil) {
    // Treat the stated valid-through date as inclusive through the end of day.
    const expiryEnd = new Date(validUntil);
    expiryEnd.setHours(23, 59, 59, 999);
    const daysUntilExpiry = Math.ceil((expiryEnd.getTime() - now.getTime()) / DAY_MS);

    if (expiryEnd.getTime() < now.getTime()) {
      return {
        status: 'expired',
        label: 'Expired',
        color: 'red',
        colorHex: '#ef4444',
        message: `Carrier validity ended ${Math.abs(daysUntilExpiry)} day${Math.abs(daysUntilExpiry) === 1 ? '' : 's'} ago. Refresh this rate before quoting.`,
        validUntil: validUntil.toISOString().slice(0, 10),
        sourceAgeDays,
        daysUntilExpiry,
      };
    }

    if (daysUntilExpiry <= EXPIRING_SOON_DAYS) {
      return {
        status: 'expiring_soon',
        label: 'Expiring soon',
        color: 'yellow',
        colorHex: '#f59e0b',
        message: `Rate validity ends in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}. Confirm before sending if shipment timing may change.`,
        validUntil: validUntil.toISOString().slice(0, 10),
        sourceAgeDays,
        daysUntilExpiry,
      };
    }

    return {
      status: 'fresh',
      label: 'Current',
      color: 'green',
      colorHex: '#22c55e',
      message: `Rate is within the carrier's stated validity through ${validUntil.toISOString().slice(0, 10)}.`,
      validUntil: validUntil.toISOString().slice(0, 10),
      sourceAgeDays,
      daysUntilExpiry,
    };
  }

  if (sourceAgeDays == null) {
    return {
      status: 'unknown',
      label: 'Unknown age',
      color: 'gray',
      colorHex: '#94a3b8',
      message: 'No validity date or reliable source date is available. Confirm the rate before quoting.',
      validUntil: null,
      sourceAgeDays: null,
      daysUntilExpiry: null,
    };
  }

  if (sourceAgeDays <= SOURCE_FRESH_DAYS) {
    return {
      status: 'fresh',
      label: 'Recently captured',
      color: 'green',
      colorHex: '#22c55e',
      message: `No validity date was captured, but the source is ${sourceAgeDays} day${sourceAgeDays === 1 ? '' : 's'} old.`,
      validUntil: null,
      sourceAgeDays,
      daysUntilExpiry: null,
    };
  }

  if (sourceAgeDays <= SOURCE_STALE_DAYS) {
    return {
      status: 'expiring_soon',
      label: 'Aging',
      color: 'yellow',
      colorHex: '#f59e0b',
      message: `No validity date was captured and the source is ${sourceAgeDays} days old. Consider refreshing it.`,
      validUntil: null,
      sourceAgeDays,
      daysUntilExpiry: null,
    };
  }

  return {
    status: 'likely_stale',
    label: 'Likely outdated',
    color: 'red',
    colorHex: '#ef4444',
    message: `No validity date was captured and the source is ${sourceAgeDays} days old. Refresh before quoting.`,
    validUntil: null,
    sourceAgeDays,
    daysUntilExpiry: null,
  };
}
