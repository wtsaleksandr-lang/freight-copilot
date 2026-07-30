/**
 * Idempotent merge of AI-extracted charge line items into an existing
 * shipment breakdown (cost side or sell side).
 *
 * Problem this solves: charge lines are ACCUMULATED across every file dropped
 * onto a shipment row. Re-uploading the same file used to append its lines a
 * second time, doubling the charges in the Cost / Sell / Profit columns.
 *
 * Two guards make a re-apply safe:
 *   1. Per-source-file replace — any line previously contributed by the SAME
 *      source file/set is dropped before the incoming lines are added, so a
 *      re-upload (even one with corrected figures) replaces its own prior
 *      contribution instead of stacking on top of it.
 *   2. Exact-duplicate net — an incoming line whose (name, amount, currency)
 *      already exists in the retained set is skipped. Catches the same charge
 *      arriving from a differently-named file/set, and identical duplicate
 *      lines within a single upload.
 *
 * The AI cannot do this itself — it only ever sees the current document and
 * has no memory of what was previously applied — so dedup MUST be enforced
 * deterministically here.
 */

export interface BreakdownLine {
  name: string;
  amount: number;
  currency: string;
  sourceFile?: string | null;
  addedAt?: string;
}

/** Normalized signature for exact-duplicate detection. addedAt is ignored
 *  (it differs on every upload); name is whitespace/case-normalized so a
 *  re-extraction of the same charge collapses cleanly. */
function signature(line: BreakdownLine): string {
  const name = String(line.name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const cents = Math.round((Number(line.amount) || 0) * 100);
  const currency = String(line.currency ?? 'USD').toUpperCase();
  return `${name}|${cents}|${currency}`;
}

export function mergeBreakdownLines(opts: {
  /** Line items already stored on the shipment for this side. */
  existing: BreakdownLine[] | null | undefined;
  /** New line items from this upload — already converted/stamped by caller. */
  incoming: BreakdownLine[];
  /** The sourceFile string stamped on the incoming lines (joined filenames),
   *  or null when the upload is anonymous. */
  incomingSourceFile: string | null;
  /** The shipment's stored side total (ourCost / soldRate) if the user had
   *  manually overridden it above the sum of items; null → derive from items. */
  priorTotalOverride: number | null;
  /** Currency to stamp a preserved manual-override "Previous adjustment". */
  adjustmentCurrency: string | null;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}): { items: BreakdownLine[]; total: number } {
  const now = opts.now || (() => new Date().toISOString());
  const existing = Array.isArray(opts.existing) ? opts.existing : [];
  const incoming = Array.isArray(opts.incoming) ? opts.incoming : [];
  const hasIncoming = incoming.length > 0;

  // Preserve any manual override the user typed above the current sum of
  // items, measured against the FULL prior breakdown (before any removal),
  // so replacing a file's lines never silently drops that delta.
  const oldSum = existing.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const priorTotal =
    typeof opts.priorTotalOverride === 'number' ? opts.priorTotalOverride : oldSum;
  const orphan = priorTotal - oldSum;

  // Guard 1: drop the prior contribution of this exact source file/set.
  const retained =
    hasIncoming && opts.incomingSourceFile
      ? existing.filter((c) => (c.sourceFile ?? null) !== opts.incomingSourceFile)
      : existing.slice();

  const items: BreakdownLine[] = retained.slice();

  if (items.length > 0 && Math.abs(orphan) > 0.005 && hasIncoming) {
    items.push({
      name: 'Previous adjustment',
      amount: Math.round(orphan * 100) / 100,
      currency: opts.adjustmentCurrency || 'USD',
      sourceFile: 'reconciled',
      addedAt: now(),
    });
  }

  // Guard 2: skip incoming lines that exactly duplicate one already present.
  const present = new Set(items.map(signature));
  for (const line of incoming) {
    const key = signature(line);
    if (present.has(key)) continue;
    present.add(key);
    items.push(line);
  }

  const total = items.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  return { items, total };
}
