import type { SheetReplyRow } from './generateReply.js';

/**
 * Deterministic token substitution for ocean rate-quote emails.
 *
 * Accuracy is the requirement: the LLM is NOT trusted to fill in POL/POD,
 * carrier, transit, prices, etc. Instead every value comes straight from the
 * parsed `SheetReplyRow[]` via literal `.split().join()` replacement here, so a
 * price on the email is exactly `freightTotal * (1 + pct/100) + flat`, never a
 * hallucinated number.
 *
 * Canonical token vocabulary (case-sensitive):
 *   <CLIENT>        — client name (opts.clientName), blank if none
 *   <POL>           — port of loading, "City (CODE)" when a code exists
 *   <POD>           — port of discharge, "City (CODE)"
 *   <CARRIER>       — carrier(s) in scope, unique, joined by " / "
 *   <TRANSIT>       — transit days (number), blank if unknown
 *   <VALIDITY>      — "from -> to" (either side may be blank)
 *   <DEST_CHARGES>  — destination-charge total for the lane (number, no symbol)
 *   <PRICE>         — marked-up price of the current row/first row (number)
 *   <CONTAINER>     — container type of the current row/first row
 *   <20GP_PRICE>    — marked-up price of the 20' GP row in scope (blank if none)
 *   <40GP_PRICE>    — marked-up price of the 40' GP row in scope
 *   <40HQ_PRICE>    — marked-up price of the 40' HQ/HC row in scope
 *   <SURCHARGES>    — one line per applicable surcharge (blank if none)
 *
 * Repeating blocks (expanded, not per-token):
 *   <EACH_LANE> … </EACH_LANE>   — repeated once per lane (POL→POD group)
 *   <EACH_RATE> … </EACH_RATE>   — repeated once per rate row in the current
 *                                  scope (a lane's rows, or all rows at top level)
 *
 * NOTE: <ETD>/<ETA>/<VESSEL> are intentionally NOT part of the vocabulary —
 * departure/arrival/vessel cannot be honestly confirmed at rate-quote stage, so
 * they are never emitted or fabricated on the sheet path.
 */

export interface SubstituteOpts {
  markupPct?: number;
  markupFlat?: number;
  clientName?: string;
  surcharges?: Array<{
    label: string;
    amount: number;
    currency?: string;
    basis?: string;
  }>;
}

type Bucket = '20GP' | '40GP' | '40HQ';

function money(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function priceOf(row: SheetReplyRow, opts: SubstituteOpts): number {
  return (
    row.freightTotal * (1 + (opts.markupPct ?? 0) / 100) + (opts.markupFlat ?? 0)
  );
}

/** Map a free-text container type to one of the three canonical buckets. */
function containerBucket(containerType: string): Bucket | null {
  const s = (containerType || '').toLowerCase();
  const is40 = s.includes('40');
  const is20 = s.includes('20');
  const isHi =
    s.includes('hq') ||
    s.includes('hc') ||
    s.includes('high') ||
    s.includes('hi-cube') ||
    s.includes('highcube');
  if (is40 && isHi) return '40HQ';
  if (is40) return '40GP';
  if (is20) return '20GP';
  return null;
}

function polLabel(row: SheetReplyRow): string {
  return row.polCode ? `${row.pol} (${row.polCode})` : row.pol;
}
function podLabel(row: SheetReplyRow): string {
  return row.podCode ? `${row.pod} (${row.podCode})` : row.pod;
}

function carriersOf(rows: SheetReplyRow[]): string {
  const seen: string[] = [];
  for (const r of rows) {
    if (r.carrier && !seen.includes(r.carrier)) seen.push(r.carrier);
  }
  return seen.join(' / ');
}

function transitOf(rows: SheetReplyRow[]): string {
  const r = rows.find((x) => x.transitDays != null);
  return r && r.transitDays != null ? String(r.transitDays) : '';
}

function validityOf(rows: SheetReplyRow[]): string {
  const r = rows.find((x) => x.validityFrom || x.validityTo) ?? rows[0];
  if (!r || (!r.validityFrom && !r.validityTo)) return '';
  return `${r.validityFrom ?? ''} -> ${r.validityTo ?? ''}`.trim();
}

function destOf(rows: SheetReplyRow[]): string {
  const r = rows.find((x) => x.destinationTotal != null);
  return r && r.destinationTotal != null ? money(r.destinationTotal) : '';
}

function bucketPrice(
  rows: SheetReplyRow[],
  bucket: Bucket,
  opts: SubstituteOpts
): string {
  const r = rows.find((x) => containerBucket(x.containerType) === bucket);
  return r ? money(priceOf(r, opts)) : '';
}

function surchargeLines(opts: SubstituteOpts): string {
  const list = (opts.surcharges ?? []).filter((s) => s && s.amount > 0);
  if (list.length === 0) return '';
  return list
    .map(
      (s) =>
        `${s.label}: ${s.currency ?? 'USD'} ${money(s.amount)}${s.basis ? ` (${s.basis})` : ''}`
    )
    .join('\n');
}

/**
 * Replace every scalar token in `text` using `rows` as the resolution scope.
 * When `rows` is a single row (inside an <EACH_RATE> expansion) the price /
 * container / dest tokens resolve to that one row; when it is a lane's rows or
 * all rows, they resolve to the first matching row in that scope.
 */
function replaceScalars(
  text: string,
  rows: SheetReplyRow[],
  opts: SubstituteOpts
): string {
  const first = rows[0];
  const map: Record<string, string> = {
    '<CLIENT>': opts.clientName?.trim() || '',
    '<POL>': first ? polLabel(first) : '',
    '<POD>': first ? podLabel(first) : '',
    '<CARRIER>': carriersOf(rows),
    '<TRANSIT>': transitOf(rows),
    '<VALIDITY>': validityOf(rows),
    '<DEST_CHARGES>': destOf(rows),
    '<PRICE>': first ? money(priceOf(first, opts)) : '',
    '<CONTAINER>': first ? first.containerType : '',
    '<20GP_PRICE>': bucketPrice(rows, '20GP', opts),
    '<40GP_PRICE>': bucketPrice(rows, '40GP', opts),
    '<40HQ_PRICE>': bucketPrice(rows, '40HQ', opts),
    '<SURCHARGES>': surchargeLines(opts),
  };
  let out = text;
  for (const [token, value] of Object.entries(map)) {
    out = out.split(token).join(value);
  }
  return out;
}

/** Expand `<EACH_RATE>…</EACH_RATE>` blocks, one rendering per row in scope. */
function expandEachRate(
  text: string,
  rows: SheetReplyRow[],
  opts: SubstituteOpts
): string {
  return text.replace(
    /<EACH_RATE>([\s\S]*?)<\/EACH_RATE>/g,
    (_m, inner: string) =>
      rows.map((r) => replaceScalars(inner, [r], opts)).join('\n')
  );
}

/** Group rows into lanes by POL|POD (mirrors generateSheetReply grouping). */
function groupLanes(rows: SheetReplyRow[]): SheetReplyRow[][] {
  const lanes = new Map<string, SheetReplyRow[]>();
  for (const r of rows) {
    const key = `${r.pol}|${r.polCode ?? ''}|${r.pod}|${r.podCode ?? ''}`;
    const list = lanes.get(key);
    if (list) list.push(r);
    else lanes.set(key, [r]);
  }
  return [...lanes.values()];
}

/**
 * Substitute canonical tokens in `template` deterministically from `rows`.
 * Returns the resolved email BODY (no disclaimer — the caller appends that).
 * Tokens outside the vocabulary are left untouched (never invented); known
 * tokens with no backing data resolve to an empty string.
 */
export function substituteTokens(
  template: string,
  rows: SheetReplyRow[],
  opts: SubstituteOpts = {}
): string {
  const lanes = groupLanes(rows);

  // 1) Expand lane blocks first (outer). Each lane fully resolves its own
  //    <EACH_RATE> blocks + scalars against that lane's rows.
  let out = template.replace(
    /<EACH_LANE>([\s\S]*?)<\/EACH_LANE>/g,
    (_m, inner: string) =>
      lanes
        .map((laneRows) => {
          let piece = expandEachRate(inner, laneRows, opts);
          piece = replaceScalars(piece, laneRows, opts);
          return piece.replace(/^\n+|\n+$/g, '');
        })
        .join('\n\n')
  );

  // 2) Any remaining top-level <EACH_RATE> resolves against all rows.
  out = expandEachRate(out, rows, opts);

  // 3) Remaining scalars resolve against all rows (first lane semantics).
  out = replaceScalars(out, rows, opts);

  // 4) Tidy: collapse the blank lines left by empty tokens / block seams.
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}
