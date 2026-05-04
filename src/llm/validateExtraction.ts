// Post-extraction validators for the AI-driven parse pipelines.
// The model is mostly accurate but occasionally drops a discount line,
// double-counts a multiplier, or rounds inconsistently. This module
// audits the structured output and surfaces actionable discrepancies
// the route layer can either log, return as a quality_warning, or
// (for the per-row drop path) silently fix.

export interface ExtractionWarning {
  field: string;
  message: string;
  hint?: string;
}

export interface CostShape {
  cost_items?: Array<{ name: string; amount: number; currency?: string }>;
  sold_items?: Array<{ name: string; amount: number; currency?: string }>;
  sold_rate?: number | null;
  container_quantity?: number | null;
}

const EPSILON = 0.01;

/**
 * Verify that sold_items (when present) sum to sold_rate within $0.01.
 * Discrepancy → warning. Caller decides what to do.
 */
export function validateSoldItemsTotal(b: CostShape): ExtractionWarning | null {
  const items = b.sold_items ?? [];
  if (items.length === 0) return null;
  if (b.sold_rate == null) return null;
  const sum = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  if (Math.abs(sum - b.sold_rate) > EPSILON) {
    return {
      field: 'sold_rate',
      message: `sold_items sum to ${sum.toFixed(2)} but sold_rate is ${b.sold_rate}`,
      hint:
        'Check whether a line item was missed, double-counted, or whether the per-container × quantity multiplication is consistent across all items.',
    };
  }
  return null;
}

/**
 * Sanity-check container_quantity against any "(×N)" markers in
 * cost_items / sold_items names. If half the items say "(×3)" but
 * container_quantity = 1, the AI is inconsistent — flag it.
 */
export function validateQuantityConsistency(b: CostShape): ExtractionWarning | null {
  const items = [...(b.cost_items ?? []), ...(b.sold_items ?? [])];
  if (items.length === 0) return null;
  const multipliers = items
    .map((i) => /\(×\s*(\d+)\)/.exec(i.name)?.[1])
    .filter(Boolean)
    .map(Number);
  if (multipliers.length === 0) return null;
  const claimedQty = b.container_quantity ?? 1;
  const stated = new Set(multipliers);
  if (stated.size > 1) {
    return {
      field: 'container_quantity',
      message: `Mixed multipliers in line items (${[...stated].join(', ')}) — should be consistent.`,
    };
  }
  const used = multipliers[0];
  if (used !== claimedQty) {
    return {
      field: 'container_quantity',
      message: `Items annotated "(×${used})" but container_quantity is ${claimedQty}`,
      hint: 'Either set container_quantity to match the multiplier, or clear the (×N) annotations from item names.',
    };
  }
  return null;
}

/**
 * Aggregate every validator and return a deduplicated list of
 * warnings. An empty array means the extraction passes audit.
 */
export function auditBriefing(b: CostShape): ExtractionWarning[] {
  const warnings: ExtractionWarning[] = [];
  const sold = validateSoldItemsTotal(b);
  if (sold) warnings.push(sold);
  const qty = validateQuantityConsistency(b);
  if (qty) warnings.push(qty);
  return warnings;
}

/**
 * Build a short, human-readable correction prompt the AI can use to
 * self-correct on the second pass. Returns null when nothing to fix.
 */
export function buildCorrectionPrompt(warnings: ExtractionWarning[]): string | null {
  if (warnings.length === 0) return null;
  const bullets = warnings
    .map((w) => `  • ${w.field}: ${w.message}${w.hint ? '\n    Hint: ' + w.hint : ''}`)
    .join('\n');
  return [
    'Your previous extraction had the following internal inconsistencies:',
    '',
    bullets,
    '',
    'Please re-extract from the same documents, this time ensuring math',
    "is internally consistent. The numbers must reconcile end-to-end.",
  ].join('\n');
}
