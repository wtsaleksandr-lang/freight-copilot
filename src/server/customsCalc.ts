/**
 * Canada customs duty & tax engine — ported from the AccessToNorth CBSA
 * calculator (wtsaleksandr-lang/AccessToNorth) so LoadMode can turn an HS code
 * + origin country into a genuine duty rate, not a hand-typed guess.
 *
 * Data: src/data/caTariff.json — 7,050 CBSA tariff items (10-digit), each with
 * a sparse { treatment: rawRateString } map. Rates are the raw CBSA text
 * ("Free", "6.5%", "5.5¢/kg", "6.5% but not less than …"); all rate logic is
 * string parsing at calc time, matching the source engine exactly.
 *
 * Scope: Canada import only (CBSA). US import is handled separately.
 */
import { readFileSync } from 'node:fs';

export type CaTariffRow = { d: string; u: string | null; r: Record<string, string> };
type CaTariff = Record<string, CaTariffRow>;

let TARIFF: CaTariff | null = null;
function tariff(): CaTariff {
  if (!TARIFF) {
    try {
      TARIFF = JSON.parse(readFileSync(new URL('../data/caTariff.json', import.meta.url), 'utf-8')) as CaTariff;
    } catch {
      TARIFF = {};
    }
  }
  return TARIFF;
}

// ── Constants (verbatim from the CBSA engine) ────────────────────────────────
export const GST_RATE = 0.05;

type ProvTax = { name: string; rate: number; type: 'GST' | 'GST+PST' | 'GST+QST' | 'HST' };
export const PROVINCIAL_TAXES: Record<string, ProvTax> = {
  AB: { name: 'Alberta', rate: 0, type: 'GST' },
  BC: { name: 'British Columbia', rate: 0.07, type: 'GST+PST' },
  MB: { name: 'Manitoba', rate: 0.07, type: 'GST+PST' },
  NB: { name: 'New Brunswick', rate: 0.10, type: 'HST' },
  NL: { name: 'Newfoundland and Labrador', rate: 0.10, type: 'HST' },
  NS: { name: 'Nova Scotia', rate: 0.10, type: 'HST' },
  NT: { name: 'Northwest Territories', rate: 0, type: 'GST' },
  NU: { name: 'Nunavut', rate: 0, type: 'GST' },
  ON: { name: 'Ontario', rate: 0.08, type: 'HST' },
  PE: { name: 'Prince Edward Island', rate: 0.10, type: 'HST' },
  QC: { name: 'Quebec', rate: 0.09975, type: 'GST+QST' },
  SK: { name: 'Saskatchewan', rate: 0.06, type: 'GST+PST' },
  YT: { name: 'Yukon', rate: 0, type: 'GST' },
};

const TARIFF_TREATMENT_PRIORITY: Record<string, number> = {
  UST: 1, MXT: 2, CPTPT: 3, CEUT: 4, UKT: 5, AUT: 6, NZT: 7, CT: 8, CRT: 9, KRT: 10,
  CIAT: 11, COLT: 12, PAT: 13, HNT: 14, JT: 15, PT: 16, IT: 17, NT: 18, SLT: 19, UAT: 20,
  CCCT: 21, GPT: 22, LDCT: 23, MFN: 24, 'General Tariff': 25,
};

const TREATMENT_NAMES: Record<string, string> = {
  MFN: 'Most Favoured Nation', UST: 'United States (CUSMA)', MXT: 'Mexico (CUSMA)',
  CPTPT: 'CPTPP', CEUT: 'CETA (EU)', UKT: 'CUKTCA (UK)', AUT: 'Australia', NZT: 'New Zealand',
  CT: 'Chile', CRT: 'Costa Rica', KRT: 'Korea', CIAT: 'Israel', COLT: 'Colombia', PAT: 'Panama',
  HNT: 'Honduras', JT: 'Jordan', PT: 'Peru', IT: 'Iceland', NT: 'Norway', SLT: 'Switzerland-Liechtenstein',
  UAT: 'Ukraine', CCCT: 'Commonwealth Caribbean', GPT: 'General Preferential', LDCT: 'Least Developed Country',
  'General Tariff': 'General Tariff',
};

export const COUNTRY_TREATMENTS: Record<string, string[]> = {
  'United States': ['MFN', 'UST'], Mexico: ['MFN', 'MXT'], China: ['MFN', 'GPT'], India: ['MFN', 'GPT'],
  Japan: ['MFN', 'CPTPT'], Germany: ['MFN', 'CEUT'], France: ['MFN', 'CEUT'], Italy: ['MFN', 'CEUT'],
  Spain: ['MFN', 'CEUT'], Netherlands: ['MFN', 'CEUT'], Belgium: ['MFN', 'CEUT'], Austria: ['MFN', 'CEUT'],
  Portugal: ['MFN', 'CEUT'], Ireland: ['MFN', 'CEUT'], Poland: ['MFN', 'CEUT'], 'Czech Republic': ['MFN', 'CEUT'],
  Romania: ['MFN', 'CEUT'], Sweden: ['MFN', 'CEUT'], Denmark: ['MFN', 'CEUT'], Finland: ['MFN', 'CEUT'],
  Greece: ['MFN', 'CEUT'], Hungary: ['MFN', 'CEUT'], Bulgaria: ['MFN', 'CEUT'], Croatia: ['MFN', 'CEUT'],
  Slovakia: ['MFN', 'CEUT'], Slovenia: ['MFN', 'CEUT'], Lithuania: ['MFN', 'CEUT'], Latvia: ['MFN', 'CEUT'],
  Estonia: ['MFN', 'CEUT'], Cyprus: ['MFN', 'CEUT'], Luxembourg: ['MFN', 'CEUT'], Malta: ['MFN', 'CEUT'],
  'United Kingdom': ['MFN', 'UKT'], Australia: ['MFN', 'AUT'], 'New Zealand': ['MFN', 'NZT'],
  'South Korea': ['MFN', 'KRT'], Vietnam: ['MFN', 'CPTPT'], Malaysia: ['MFN', 'CPTPT'], Singapore: ['MFN', 'CPTPT'],
  Brunei: ['MFN', 'CPTPT'], Peru: ['MFN', 'PT', 'CPTPT'], Chile: ['MFN', 'CT', 'CPTPT'], Israel: ['MFN', 'CIAT'],
  Colombia: ['MFN', 'COLT'], 'Costa Rica': ['MFN', 'CRT'], Panama: ['MFN', 'PAT'], Honduras: ['MFN', 'HNT'],
  Jordan: ['MFN', 'JT'], Iceland: ['MFN', 'IT'], Norway: ['MFN', 'NT'], Switzerland: ['MFN', 'SLT'],
  Liechtenstein: ['MFN', 'SLT'], Ukraine: ['MFN', 'UAT'], Taiwan: ['MFN'], Brazil: ['MFN'],
  Indonesia: ['MFN', 'GPT'], Thailand: ['MFN', 'GPT'], Philippines: ['MFN', 'GPT'], Turkey: ['MFN'],
  'South Africa': ['MFN', 'GPT'], Nigeria: ['MFN', 'GPT'], Egypt: ['MFN', 'GPT'], Pakistan: ['MFN', 'GPT', 'LDCT'],
  Bangladesh: ['MFN', 'GPT', 'LDCT'], Cambodia: ['MFN', 'GPT', 'LDCT'], Ethiopia: ['MFN', 'GPT', 'LDCT'],
  Myanmar: ['MFN', 'GPT', 'LDCT'], Tanzania: ['MFN', 'GPT', 'LDCT'], Haiti: ['MFN', 'GPT', 'LDCT', 'CCCT'],
  Jamaica: ['MFN', 'CCCT'], 'Trinidad and Tobago': ['MFN', 'CCCT'], Barbados: ['MFN', 'CCCT'],
  Guyana: ['MFN', 'CCCT'], Belize: ['MFN', 'CCCT'], Bahamas: ['MFN', 'CCCT'], 'Antigua and Barbuda': ['MFN', 'CCCT'],
  Dominica: ['MFN', 'CCCT'], Grenada: ['MFN', 'CCCT'], 'Saint Lucia': ['MFN', 'CCCT'],
  'Saint Vincent and the Grenadines': ['MFN', 'CCCT'], 'Saint Kitts and Nevis': ['MFN', 'CCCT'],
  Argentina: ['MFN'], Russia: ['MFN'], 'Saudi Arabia': ['MFN'], 'United Arab Emirates': ['MFN'],
  Morocco: ['MFN', 'GPT'], 'Sri Lanka': ['MFN', 'GPT'], Kenya: ['MFN', 'GPT'], Ghana: ['MFN', 'GPT'],
  'Other / Unknown': ['MFN'],
};

export function listCountries(): string[] {
  return Object.keys(COUNTRY_TREATMENTS);
}

// ── Rate-string parsing (verbatim behaviour) ─────────────────────────────────
type ParsedRate = { percent: number; perUnit: string | null; compound: boolean; isNA: boolean; description: string };
export function parseRateToPercent(rateStr: string): ParsedRate {
  if (!rateStr || rateStr === 'N/A') return { percent: 0, perUnit: null, compound: false, isNA: true, description: 'N/A' };
  const cleaned = rateStr.trim();
  if (cleaned === 'Free' || cleaned === 'free') return { percent: 0, perUnit: null, compound: false, isNA: false, description: 'Free' };
  const pctMatch = cleaned.match(/^([\d.]+)\s*%/);
  if (pctMatch && !cleaned.includes('but not less than') && !cleaned.includes('but not more than') && !cleaned.includes('/')) {
    return { percent: parseFloat(pctMatch[1] as string), perUnit: null, compound: false, isNA: false, description: `${pctMatch[1]}%` };
  }
  if (cleaned.includes('but not less than') || cleaned.includes('but not more than')) {
    const pct = pctMatch ? parseFloat(pctMatch[1] as string) : 0;
    return { percent: pct, perUnit: null, compound: true, isNA: false, description: cleaned };
  }
  if (cleaned.match(/\$([\d.]+)\/(kg|litre|tonne)/)) return { percent: 0, perUnit: cleaned, compound: false, isNA: false, description: cleaned };
  if (cleaned.match(/([\d.]+)\s*¢\/(kg|dozen|litre)/)) return { percent: 0, perUnit: cleaned, compound: false, isNA: false, description: cleaned };
  if (cleaned.match(/([\d.]+)\s*¢\s*(?:each)?$/)) return { percent: 0, perUnit: cleaned, compound: false, isNA: false, description: cleaned };
  return { percent: 0, perUnit: null, compound: false, isNA: false, description: cleaned || 'Unknown' };
}

type DutyResult = { duty: number; warnings: string[]; requiresManualReview: boolean };
export function calculateDuty(rateStr: string, valueCAD: number, quantity: number): DutyResult {
  const parsed = parseRateToPercent(rateStr);
  const warnings: string[] = [];
  if (parsed.isNA) {
    return { duty: 0, warnings: ['Duty rate is N/A for this tariff item under the applied treatment. This item may require special authorization or quota allocation. Contact CBSA or a licensed customs broker.'], requiresManualReview: true };
  }
  if (parsed.description === 'Free') return { duty: 0, warnings: [], requiresManualReview: false };
  if (parsed.perUnit && quantity <= 0) {
    warnings.push(`This item has a per-unit duty rate (${parsed.description}). Quantity is required for accurate calculation. The duty shown may be understated.`);
    return { duty: 0, warnings, requiresManualReview: true };
  }
  if (parsed.percent > 0 && !parsed.perUnit) {
    let duty = valueCAD * (parsed.percent / 100);
    if (parsed.compound) {
      const minMatch = rateStr.match(/not less than \$([\d.]+)\/(kg|litre|tonne)/);
      if (minMatch && quantity > 0) {
        const perUnitMin = parseFloat(minMatch[1] as string);
        const multiplier = minMatch[2] === 'tonne' ? quantity / 1000 : quantity;
        duty = Math.max(duty, perUnitMin * multiplier);
      }
      const minCentMatch = rateStr.match(/not less than ([\d.]+)\s*¢\/(kg|each|dozen|litre)/);
      if (minCentMatch && quantity > 0) duty = Math.max(duty, (parseFloat(minCentMatch[1] as string) / 100) * quantity);
      const maxMatch = rateStr.match(/(?:or )?(?:not )?more than \$([\d.]+)\/(kg|litre|tonne)/);
      if (maxMatch && quantity > 0) {
        const perUnitMax = parseFloat(maxMatch[1] as string);
        const multiplier = maxMatch[2] === 'tonne' ? quantity / 1000 : quantity;
        duty = Math.min(duty, perUnitMax * multiplier);
      }
      const maxCentMatch = rateStr.match(/(?:or )?(?:not )?more than ([\d.]+)\s*¢\/(kg|each|dozen|litre)/);
      if (maxCentMatch && quantity > 0) duty = Math.min(duty, (parseFloat(maxCentMatch[1] as string) / 100) * quantity);
      if (quantity <= 0) warnings.push(`This item has a compound duty rate (${parsed.description}). Quantity is needed to verify the minimum/maximum floor. The estimate may differ from actual duty.`);
    }
    return { duty, warnings, requiresManualReview: false };
  }
  if (parsed.perUnit && quantity > 0) {
    const dollarMatch = rateStr.match(/\$([\d.]+)\/(kg|litre|tonne)/);
    if (dollarMatch) {
      const rate = parseFloat(dollarMatch[1] as string);
      const multiplier = dollarMatch[2] === 'tonne' ? quantity / 1000 : quantity;
      return { duty: rate * multiplier, warnings, requiresManualReview: false };
    }
    const centMatch = rateStr.match(/([\d.]+)\s*¢\/(kg|dozen|each|litre)/);
    if (centMatch) return { duty: (parseFloat(centMatch[1] as string) / 100) * quantity, warnings, requiresManualReview: false };
    const centEachMatch = rateStr.match(/([\d.]+)\s*¢\s*each/);
    if (centEachMatch) return { duty: (parseFloat(centEachMatch[1] as string) / 100) * quantity, warnings, requiresManualReview: false };
  }
  return { duty: valueCAD * (parsed.percent / 100), warnings, requiresManualReview: false };
}

type BestTreatment = { treatment: string; rate: string; treatmentName: string };
export function getBestTreatment(countryTreatments: string[], dutyRates: Record<string, string>): BestTreatment {
  let bestTreatment = 'MFN';
  let bestRate = dutyRates['MFN'] || 'N/A';
  let bestParsed = parseRateToPercent(bestRate);
  let bestPriority = TARIFF_TREATMENT_PRIORITY['MFN'] ?? 24;
  for (const treatment of countryTreatments) {
    const rate = dutyRates[treatment];
    if (!rate || rate === 'N/A') continue;
    const parsed = parseRateToPercent(rate);
    const priority = TARIFF_TREATMENT_PRIORITY[treatment] || 99;
    if (parsed.description === 'Free') return { treatment, rate, treatmentName: TREATMENT_NAMES[treatment] || treatment };
    if (priority < bestPriority && !parsed.compound) {
      bestTreatment = treatment; bestRate = rate; bestParsed = parsed; bestPriority = priority;
    } else if (!parsed.compound && parsed.percent < bestParsed.percent && !bestParsed.compound) {
      bestTreatment = treatment; bestRate = rate; bestParsed = parsed; bestPriority = priority;
    }
  }
  return { treatment: bestTreatment, rate: bestRate, treatmentName: TREATMENT_NAMES[bestTreatment] || bestTreatment };
}

// ── Lookups ──────────────────────────────────────────────────────────────────
export function getHsCode(code: string): (CaTariffRow & { code: string }) | null {
  const row = tariff()[code];
  return row ? { code, ...row } : null;
}
export function searchHs(query: string, limit = 15): Array<{ code: string; description: string; unitOfMeasure: string | null }> {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const t = tariff();
  const out: Array<{ code: string; description: string; unitOfMeasure: string | null }> = [];
  const isCode = /^[\d.]+$/.test(q);
  const lower = q.toLowerCase();
  for (const code of Object.keys(t)) {
    const row = t[code];
    if (!row) continue;
    const match = isCode ? code.startsWith(q) : row.d.toLowerCase().includes(lower);
    if (match) { out.push({ code, description: row.d, unitOfMeasure: row.u }); if (out.length >= limit) break; }
  }
  return out;
}

// ── Full calculate ───────────────────────────────────────────────────────────
export type CaCalcInput = {
  hsCode: string;
  countryOfOrigin: string;
  valueCAD: number;
  quantity?: number;
  province?: string;
  confirmedOrigin?: boolean;
};
export function calculateCanadaCustoms(input: CaCalcInput) {
  const hs = getHsCode(input.hsCode);
  if (!hs) return { ok: false as const, error: 'HS code not found' };
  const dutyRates = hs.r;
  const quantity = input.quantity ?? 0;

  const warnings: string[] = [];
  let treatments = COUNTRY_TREATMENTS[input.countryOfOrigin] || ['MFN'];
  const originalTreatments = treatments;
  const isPreferential = treatments.some((t) => t !== 'MFN' && t !== 'General Tariff');
  if (isPreferential && !input.confirmedOrigin) {
    treatments = ['MFN'];
    warnings.push('Preferential tariff rates require goods to qualify under rules of origin. MFN rate applied. Confirm origin eligibility to use the preferential rate.');
  }

  const best = getBestTreatment(treatments, dutyRates);
  const dutyCalc = calculateDuty(best.rate, input.valueCAD, quantity);
  warnings.push(...dutyCalc.warnings);
  const dutyAmount = round2(dutyCalc.duty);

  const provTax: ProvTax = PROVINCIAL_TAXES[input.province || 'ON'] ?? PROVINCIAL_TAXES.ON ?? { name: 'Ontario', rate: 0.08, type: 'HST' };
  const base = input.valueCAD + dutyAmount;
  let gstAmount = base * GST_RATE;
  let provincialTaxAmount = 0;
  let provincialTaxName = '';
  let gstLabel = 'GST';
  if (provTax.type === 'HST') { gstAmount = base * (GST_RATE + provTax.rate); provincialTaxName = 'HST'; gstLabel = 'HST'; }
  else if (provTax.type === 'GST+PST') { provincialTaxAmount = base * provTax.rate; provincialTaxName = 'PST'; }
  else if (provTax.type === 'GST+QST') { provincialTaxAmount = (base + base * GST_RATE) * provTax.rate; provincialTaxName = 'QST'; }

  gstAmount = round2(gstAmount);
  provincialTaxAmount = round2(provincialTaxAmount);
  const totalDutiesAndTaxes = round2(dutyAmount + gstAmount + provincialTaxAmount);

  const parsed = parseRateToPercent(best.rate);
  return {
    ok: true as const,
    hsCode: hs.code,
    description: hs.d,
    appliedTreatment: best.treatment,
    appliedTreatmentName: best.treatmentName,
    dutyRate: best.rate,
    // A clean ad-valorem rate the workspace can drop straight into its % field:
    dutyRatePercent: parsed.percent > 0 && !parsed.perUnit && !parsed.compound ? parsed.percent : parsed.description === 'Free' ? 0 : null,
    isSimplePercent: (parsed.percent > 0 || parsed.description === 'Free') && !parsed.perUnit && !parsed.compound,
    dutyAmount,
    gstRate: provTax.type === 'HST' ? GST_RATE + provTax.rate : GST_RATE,
    gstLabel,
    gstAmount,
    provincialTaxName,
    provincialTaxRate: provTax.type === 'HST' ? 0 : provTax.rate,
    provincialTaxAmount,
    totalDutiesAndTaxes,
    totalLandedCost: round2(input.valueCAD + totalDutiesAndTaxes),
    preferentialAvailable: isPreferential,
    originConfirmed: !!input.confirmedOrigin,
    requiresManualReview: dutyCalc.requiresManualReview,
    availableTreatments: Object.fromEntries(
      originalTreatments
        .filter((t) => dutyRates[t] && dutyRates[t] !== 'N/A')
        .map((t) => {
          const rate = dutyRates[t] as string;
          return [t, { rate, treatmentName: TREATMENT_NAMES[t] || t, duty: round2(calculateDuty(rate, input.valueCAD, quantity).duty) }];
        }),
    ),
    warnings,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ═══════════════════════════════════════════════════════════════════════════
// US import (USITC HTS) — Column-1-General (MFN) + FTA preference (USMCA etc.)
// Data: src/data/usTariff.json — 13,675 rate-bearing HTS lines. Rate strings use
// the same formats as CBSA, so parseRateToPercent / calculateDuty are reused.
// MPF / HMF are NOT added here — the customs workspace computes those for US
// import; this only resolves the genuine HS-driven duty rate.
// ═══════════════════════════════════════════════════════════════════════════
export type UsTariffRow = { d: string; u: string | null; g: string; s: string | null; o: string | null };
let US_TARIFF: Record<string, UsTariffRow> | null = null;
function usTariff(): Record<string, UsTariffRow> {
  if (!US_TARIFF) {
    try { US_TARIFF = JSON.parse(readFileSync(new URL('../data/usTariff.json', import.meta.url), 'utf-8')) as Record<string, UsTariffRow>; }
    catch { US_TARIFF = {}; }
  }
  return US_TARIFF;
}

// Origin country → HTS Special Program Indicator (major FTAs).
const US_SPI: Record<string, string> = {
  Canada: 'S', Mexico: 'S', Australia: 'AU', 'South Korea': 'KR', Chile: 'CL', Colombia: 'CO',
  Peru: 'PE', Panama: 'PA', Singapore: 'SG', Bahrain: 'BH', Jordan: 'JO', Morocco: 'MA', Oman: 'OM', Israel: 'IL',
};
const US_SPI_NAME: Record<string, string> = {
  S: 'USMCA', AU: 'US–Australia FTA', KR: 'US–Korea FTA', CL: 'US–Chile FTA', CO: 'US–Colombia TPA',
  PE: 'US–Peru TPA', PA: 'US–Panama TPA', SG: 'US–Singapore FTA', BH: 'US–Bahrain FTA', JO: 'US–Jordan FTA',
  MA: 'US–Morocco FTA', OM: 'US–Oman FTA', IL: 'US–Israel FTA',
};

function usPreferentialFree(special: string | null, spi: string): boolean {
  if (!special || !spi) return false;
  // "Free (A+,AU,…,S,SG)" — check SPI membership of a Free program group.
  const m = special.match(/Free\s*\(([^)]*)\)/i);
  if (!m || !m[1]) return false;
  return m[1].split(/[,\s]+/).map((s) => s.trim()).includes(spi);
}

export function getUsHsCode(code: string): (UsTariffRow & { code: string }) | null {
  const t = usTariff();
  if (t[code]) return { code, ...t[code] as UsTariffRow };
  // Fall back to the 8-digit subheading (statistical suffix inherits the rate).
  const digits = code.replace(/\D/g, '');
  if (digits.length >= 8) {
    const sub8 = digits.slice(0, 8);
    let best: string | null = null;
    for (const k of Object.keys(t)) {
      if (k.replace(/\D/g, '').startsWith(sub8)) { best = k; break; }
    }
    if (best) return { code: best, ...t[best] as UsTariffRow };
  }
  return null;
}

export function searchUsHs(query: string, limit = 15): Array<{ code: string; description: string; unitOfMeasure: string | null }> {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const t = usTariff();
  const out: Array<{ code: string; description: string; unitOfMeasure: string | null }> = [];
  const isCode = /^[\d.]+$/.test(q);
  const lower = q.toLowerCase();
  for (const code of Object.keys(t)) {
    const row = t[code];
    if (!row) continue;
    const match = isCode ? code.startsWith(q) : row.d.toLowerCase().includes(lower);
    if (match) { out.push({ code, description: row.d, unitOfMeasure: row.u }); if (out.length >= limit) break; }
  }
  return out;
}

export type UsCalcInput = { hsCode: string; countryOfOrigin: string; valueUSD: number; quantity?: number; confirmedOrigin?: boolean };
export function calculateUsCustoms(input: UsCalcInput) {
  const hs = getUsHsCode(input.hsCode);
  if (!hs) return { ok: false as const, error: 'HS code not found' };
  const spi = US_SPI[input.countryOfOrigin];
  const warnings: string[] = [];
  let rate = hs.g;
  let program = 'MFN (Column 1 General)';
  if (spi && usPreferentialFree(hs.s, spi)) {
    if (input.confirmedOrigin) { rate = 'Free'; program = `${US_SPI_NAME[spi] || spi} (preferential)`; }
    else warnings.push(`A ${US_SPI_NAME[spi] || spi} preferential rate (Free) may apply if the goods qualify under rules of origin — confirm eligibility to apply it.`);
  }
  const parsed = parseRateToPercent(rate);
  const dutyCalc = calculateDuty(rate, input.valueUSD, input.quantity ?? 0);
  warnings.push(...dutyCalc.warnings);
  return {
    ok: true as const,
    hsCode: hs.code,
    description: hs.d,
    appliedTreatmentName: program,
    dutyRate: rate,
    dutyRatePercent: parsed.percent > 0 && !parsed.perUnit && !parsed.compound ? parsed.percent : parsed.description === 'Free' ? 0 : null,
    isSimplePercent: (parsed.percent > 0 || parsed.description === 'Free') && !parsed.perUnit && !parsed.compound,
    dutyAmount: round2(dutyCalc.duty),
    requiresManualReview: dutyCalc.requiresManualReview,
    warnings,
  };
}
