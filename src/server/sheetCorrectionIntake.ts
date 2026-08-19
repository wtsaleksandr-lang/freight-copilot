// Plain-English correction of a saved ocean rate-sheet upload. Mirrors
// shipmentUpdateIntake.ts: a deterministic, dependency-free extractor that
// turns a natural-language note ("the MSC validity is actually through Sept 30,
// and POD should be Rotterdam not Antwerp") into reviewable field proposals with
// a confidence level. No LLM/provider is added — the shipments AI-update intake
// this parallels is itself pure regex, so this stays consistent with it.

export type SheetCorrectionField =
  | 'carrierCode'
  | 'pol'
  | 'pod'
  | 'containerType'
  | 'validityFrom'
  | 'validityTo';

export type ProposalConfidence = 'high' | 'medium' | 'low';

export interface SheetCorrectionSource {
  carriers: string[];
  pols: string[];
  pods: string[];
  containerTypes: string[];
  validityFrom: string | null;
  validityTo: string | null;
}

export interface SheetCorrectionProposal {
  field: SheetCorrectionField;
  /** Existing value being replaced (the "not X" side, or the sole current one). */
  currentValue: string | null;
  proposedValue: string;
  /**
   * When set, only rates whose `field` currently equals this are changed. When
   * absent AND the upload holds several distinct values for the field, the
   * proposal is ambiguous and the route asks a clarifying question.
   */
  from?: string;
  /** Distinct current values, supplied for ambiguous proposals so the UI can ask. */
  options?: string[];
  ambiguous?: boolean;
  confidence: ProposalConfidence;
  evidence: string;
}

// Known ocean-carrier names → the short code stored in carrier_code. Kept small
// and local (no import coupling to the shipments intake).
const CARRIER_CODES: Array<[RegExp, string]> = [
  [/\b(?:maersk|maeu|msk)\b/i, 'MSK'],
  [/\b(?:msc|mediterranean shipping)\b/i, 'MSC'],
  [/\b(?:cma\s*cgm|cmdu)\b/i, 'CMA'],
  [/\b(?:hapag[- ]?lloyd|hlcu)\b/i, 'HLC'],
  [/\boocl\b/i, 'OOCL'],
  [/\b(?:ocean network express|one line|\bone\b)\b/i, 'ONE'],
  [/\bzim\b/i, 'ZIM'],
  [/\b(?:evergreen|eglv)\b/i, 'EMC'],
  [/\b(?:cosco|cosu)\b/i, 'COSCO'],
  [/\b(?:yang ming|ymlu)\b/i, 'YML'],
  [/\b(?:hmm|hyundai merchant)\b/i, 'HMM'],
];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function evidenceLine(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', index) + 1);
  const next = text.indexOf('\n', index);
  return text
    .slice(start, next === -1 ? text.length : next)
    .trim()
    .slice(0, 220);
}

/** Parse a loose date phrase into ISO YYYY-MM-DD, or null. */
export function parseLooseDate(raw: string): string | null {
  const s = clean(raw);
  if (!s) return null;
  // ISO 2026-09-30
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
  if (iso) {
    const mm = String(Number(iso[2])).padStart(2, '0');
    const dd = String(Number(iso[3])).padStart(2, '0');
    return `${iso[1]}-${mm}-${dd}`;
  }
  // Numeric d/m/y or m/d — assume day/month order only when day > 12.
  const num = /\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/.exec(s);
  if (num) {
    let a = Number(num[1]);
    let b = Number(num[2]);
    let month: number;
    let day: number;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
    const year = num[3]
      ? Number(num[3].length === 2 ? `20${num[3]}` : num[3])
      : new Date().getFullYear();
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  // Month-name forms: "Sept 30", "September 30 2026", "30 Sep 2026".
  const mName =
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/i.exec(
      s
    ) ||
    /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:\s*,?\s*(\d{4}))?\b/i.exec(
      s
    );
  if (mName) {
    const g1 = mName[1] ?? '';
    const g2 = mName[2] ?? '';
    const monthTok = /[a-z]/i.test(g1) ? g1 : g2;
    const dayTok = /[a-z]/i.test(g1) ? g2 : g1;
    const key = monthTok.toLowerCase();
    const month = MONTHS[key.slice(0, 4)] ?? MONTHS[key.slice(0, 3)];
    const day = Number(dayTok);
    const year = mName[3] ? Number(mName[3]) : new Date().getFullYear();
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

/** Normalize a free-text container spec to the app's stored form (e.g. 40HC). */
function normalizeContainer(raw: string): string {
  const s = clean(raw).toUpperCase();
  const m = /\b(20|40|45)\s*['’]?\s*(HC|HQ|DV|GP|RF|RH|OT|FR|NOR|REEFER|DRY|STANDARD)?\b/.exec(
    s
  );
  if (!m) return s;
  const size = m[1];
  const codeMap: Record<string, string> = {
    HC: 'HC', HQ: 'HC', DV: 'DV', GP: 'GP', RF: 'RF', RH: 'RH',
    OT: 'OT', FR: 'FR', NOR: 'NOR', REEFER: 'RF', DRY: 'DV', STANDARD: 'GP',
  };
  const code = m[2] ? codeMap[m[2]] ?? m[2] : size === '40' ? 'HC' : 'GP';
  return `${size}${code}`;
}

// Grab "<to> (not <from>)" after a label, or "<to>" alone. Returns the raw
// captured to/from strings plus the match index, or null.
function captureChange(
  source: string,
  labelRe: string
): { to: string; from?: string; index: number; explicit: boolean } | null {
  const re = new RegExp(
    `(?:${labelRe})\\s*(?:should\\s+be|is|are|=|:|to|actually|→|->)\\s*["'“]?([^,.;\\n"'”()]{2,48}?)["'”]?` +
      `(?:\\s*[\\(]?\\s*(?:not|instead of|rather than|was|previously|currently)\\s+["'“]?([^,.;\\n"'”()]{2,48}?)["'”]?[\\)]?)?` +
      `(?=[,.;\\n)]|$)`,
    'i'
  );
  const m = re.exec(source);
  if (!m) return null;
  const to = clean(m[1]);
  if (!to) return null;
  const from = m[2] ? clean(m[2]) : undefined;
  return { to, from, index: m.index, explicit: /should\s+be|not|instead of|rather than/i.test(m[0]) };
}

function resolveTarget(
  from: string | undefined,
  current: string[]
): { from?: string; ambiguous: boolean; options?: string[]; currentValue: string | null } {
  if (from) return { from, ambiguous: false, currentValue: from };
  const only = current[0];
  if (current.length === 1 && only) return { from: only, ambiguous: false, currentValue: only };
  if (current.length === 0) return { ambiguous: false, currentValue: null };
  return { ambiguous: true, options: current, currentValue: null };
}

export function extractSheetCorrectionProposals(
  text: string,
  source: SheetCorrectionSource
): SheetCorrectionProposal[] {
  const src = clean(text.replace(/\r\n?/g, '\n'));
  if (!src) return [];
  const out: SheetCorrectionProposal[] = [];
  const push = (p: SheetCorrectionProposal) => {
    if (!out.some((q) => q.field === p.field && q.from === p.from)) out.push(p);
  };

  // --- Validity (to / through, and from / effective) ---
  const valTo = captureChange(src, 'valid(?:ity)?(?:\\s+(?:through|thru|until|till|to|expiring|expires?))?|expiry|expires?|good\\s+(?:through|until|till)');
  if (valTo) {
    const iso = parseLooseDate(valTo.to);
    if (iso) {
      push({
        field: 'validityTo',
        currentValue: source.validityTo,
        proposedValue: iso,
        confidence: valTo.explicit ? 'high' : 'medium',
        evidence: evidenceLine(src, valTo.index),
      });
    }
  }
  const valFrom = captureChange(src, 'valid(?:ity)?\\s+from|effective(?:\\s+from)?|starts?(?:\\s+on)?|valid\\s+starting');
  if (valFrom) {
    const iso = parseLooseDate(valFrom.to);
    if (iso) {
      push({
        field: 'validityFrom',
        currentValue: source.validityFrom,
        proposedValue: iso,
        confidence: valFrom.explicit ? 'high' : 'medium',
        evidence: evidenceLine(src, valFrom.index),
      });
    }
  }

  // --- POD ---
  const pod = captureChange(src, 'pod|port of discharge|discharge port|destination(?:\\s+port)?|dest');
  if (pod) {
    const t = resolveTarget(pod.from, source.pods);
    push({
      field: 'pod',
      currentValue: t.currentValue,
      proposedValue: pod.to,
      from: t.from,
      options: t.options,
      ambiguous: t.ambiguous,
      confidence: t.ambiguous ? 'low' : pod.explicit ? 'high' : 'medium',
      evidence: evidenceLine(src, pod.index),
    });
  }

  // --- POL ---
  const pol = captureChange(src, 'pol|port of loading|load(?:ing)?\\s+port|origin(?:\\s+port)?');
  if (pol) {
    const t = resolveTarget(pol.from, source.pols);
    push({
      field: 'pol',
      currentValue: t.currentValue,
      proposedValue: pol.to,
      from: t.from,
      options: t.options,
      ambiguous: t.ambiguous,
      confidence: t.ambiguous ? 'low' : pol.explicit ? 'high' : 'medium',
      evidence: evidenceLine(src, pol.index),
    });
  }

  // --- Container ---
  const cntr = captureChange(src, 'container(?:\\s+type)?|equipment|box|cntr');
  if (cntr) {
    const t = resolveTarget(cntr.from ? normalizeContainer(cntr.from) : undefined, source.containerTypes);
    push({
      field: 'containerType',
      currentValue: t.currentValue,
      proposedValue: normalizeContainer(cntr.to),
      from: t.from,
      options: t.options,
      ambiguous: t.ambiguous,
      confidence: t.ambiguous ? 'low' : cntr.explicit ? 'high' : 'medium',
      evidence: evidenceLine(src, cntr.index),
    });
  }

  // --- Carrier: labelled change, else a bare known-carrier mention ---
  const carrierLabelled = captureChange(src, 'carrier|shipping\\s+line|line|scac');
  let carrierDone = false;
  if (carrierLabelled) {
    for (const [re, code] of CARRIER_CODES) {
      if (re.test(carrierLabelled.to)) {
        push({
          field: 'carrierCode',
          currentValue: source.carriers[0] ?? null,
          proposedValue: code,
          confidence: carrierLabelled.explicit ? 'high' : 'medium',
          evidence: evidenceLine(src, carrierLabelled.index),
        });
        carrierDone = true;
        break;
      }
    }
  }
  if (!carrierDone) {
    for (const [re, code] of CARRIER_CODES) {
      const m = re.exec(src);
      if (m && !source.carriers.includes(code)) {
        push({
          field: 'carrierCode',
          currentValue: source.carriers[0] ?? null,
          proposedValue: code,
          confidence: 'low',
          evidence: evidenceLine(src, m.index),
        });
        break;
      }
    }
  }

  return out;
}

/** Build clarify-modal questions for any ambiguous proposals (stable order). */
export function clarifyingQuestions(
  proposals: SheetCorrectionProposal[]
): Array<{ text: string; options: string[] }> {
  return proposals
    .filter((p) => p.ambiguous && (p.options?.length ?? 0) > 0)
    .map((p) => ({
      text: `This upload has several ${labelFor(p.field)} values. Which one should change to "${p.proposedValue}"?`,
      options: [...(p.options ?? []), 'All of them'],
    }));
}

/**
 * Fold clarify-modal answers back onto the ambiguous proposals, in the same
 * order clarifyingQuestions produced them. "All of them" leaves `from` unset
 * (change every rate); any other pick sets `from` to that value.
 */
export function applyClarifyAnswers(
  proposals: SheetCorrectionProposal[],
  answers: Array<{ answer?: string }>
): SheetCorrectionProposal[] {
  let i = 0;
  return proposals.map((p) => {
    if (!p.ambiguous) return p;
    const answer = clean(answers[i]?.answer);
    i++;
    if (!answer) return p;
    if (/^all of them$/i.test(answer)) {
      return { ...p, ambiguous: false, options: undefined, from: undefined, currentValue: 'all lanes' };
    }
    return { ...p, ambiguous: false, options: undefined, from: answer, currentValue: answer };
  });
}

function labelFor(field: SheetCorrectionField): string {
  switch (field) {
    case 'pol': return 'POL';
    case 'pod': return 'POD';
    case 'containerType': return 'container';
    case 'carrierCode': return 'carrier';
    case 'validityFrom': return 'validity-from';
    case 'validityTo': return 'validity-to';
  }
}
