/**
 * Drayage rate-matrix + accessorial engine — ported from QuoteFleet's
 * (wtsaleksandr-lang/quotefleet) drayage calc so LoadMode can produce a
 * structured, itemized drayage RATE (port-anchored zone tariff + accessorials +
 * fuel + margin) instead of only a historical estimate.
 *
 * Pure + self-contained: distance is computed from bundled port coordinates and
 * a door lat/lng passed IN by the caller (geocoded upstream). No external deps,
 * unit-testable. Tariffs/accessorials are editable defaults reconciled from real
 * port-drayage quotes — treat as a starting matrix, not a locked price list.
 */

export type DrayageCurrency = 'USD' | 'CAD';

// ── Bundled port coordinates (anchors for the tariff zones) ─────────────────
const PORT_COORDS: Record<string, { lat: number; lng: number; city: string }> = {
  USLAX: { lat: 33.7361, lng: -118.2922, city: 'Los Angeles' },
  USLGB: { lat: 33.7544, lng: -118.2169, city: 'Long Beach' },
  USNYC: { lat: 40.6815, lng: -74.1483, city: 'Newark' },
  USSAV: { lat: 32.1308, lng: -81.1517, city: 'Savannah' },
  USHOU: { lat: 29.7252, lng: -95.0699, city: 'Houston' },
  USNOR: { lat: 36.8847, lng: -76.3289, city: 'Norfolk' },
  USCHS: { lat: 32.7917, lng: -79.9237, city: 'Charleston' },
  USSEA: { lat: 47.6043, lng: -122.3493, city: 'Seattle' },
  USTIW: { lat: 47.2657, lng: -122.4257, city: 'Tacoma' },
  CAVAN: { lat: 49.2872, lng: -123.1109, city: 'Vancouver' },
  CAMTR: { lat: 45.5017, lng: -73.5673, city: 'Montreal' },
  CAHAL: { lat: 44.6488, lng: -63.5752, city: 'Halifax' },
  CAPRR: { lat: 54.3150, lng: -130.3208, city: 'Prince Rupert' },
};

// ── Zone tariffs (flat price by radius ring from the anchor port) ────────────
type Ring = { radius: number; price: number; label: string };
const TARIFFS: Record<string, Ring[]> = {
  USLAX: [{ radius: 30, price: 425, label: 'LAX/LGB → Local LA Basin (0-30 mi)' }, { radius: 60, price: 575, label: 'LAX/LGB → IE / Orange Co. (30-60 mi)' }, { radius: 150, price: 875, label: 'LAX/LGB → SoCal Extended (60-150 mi)' }],
  USLGB: [{ radius: 30, price: 425, label: 'LGB/LAX → Local LA Basin (0-30 mi)' }, { radius: 60, price: 575, label: 'LGB/LAX → IE / Orange Co. (30-60 mi)' }, { radius: 150, price: 875, label: 'LGB/LAX → SoCal Extended (60-150 mi)' }],
  USNYC: [{ radius: 30, price: 525, label: 'NY/NJ → NY Metro (0-30 mi)' }, { radius: 60, price: 695, label: 'NY/NJ → CT/PA Border (30-60 mi)' }, { radius: 150, price: 1050, label: 'NY/NJ → Extended NE (60-150 mi)' }],
  USSAV: [{ radius: 30, price: 350, label: 'Savannah → Local (0-30 mi)' }, { radius: 60, price: 475, label: 'Savannah → Regional GA/SC (30-60 mi)' }, { radius: 150, price: 750, label: 'Savannah → Extended SE (60-150 mi)' }],
  USHOU: [{ radius: 30, price: 375, label: 'Houston → Local (0-30 mi)' }, { radius: 60, price: 525, label: 'Houston → Regional TX (30-60 mi)' }, { radius: 150, price: 800, label: 'Houston → Extended TX (60-150 mi)' }],
  USNOR: [{ radius: 30, price: 380, label: 'Norfolk → Local (0-30 mi)' }, { radius: 60, price: 510, label: 'Norfolk → Regional VA/NC (30-60 mi)' }, { radius: 150, price: 800, label: 'Norfolk → Extended Mid-Atlantic (60-150 mi)' }],
  USCHS: [{ radius: 30, price: 360, label: 'Charleston → Local (0-30 mi)' }, { radius: 60, price: 485, label: 'Charleston → Regional SC (30-60 mi)' }, { radius: 150, price: 765, label: 'Charleston → Extended SE (60-150 mi)' }],
  USSEA: [{ radius: 30, price: 425, label: 'Seattle → Local Puget (0-30 mi)' }, { radius: 60, price: 575, label: 'Seattle → Regional WA (30-60 mi)' }, { radius: 150, price: 875, label: 'Seattle → Extended PNW (60-150 mi)' }],
  USTIW: [{ radius: 30, price: 425, label: 'Tacoma → Local Puget (0-30 mi)' }, { radius: 60, price: 575, label: 'Tacoma → Regional WA (30-60 mi)' }, { radius: 150, price: 875, label: 'Tacoma → Extended PNW (60-150 mi)' }],
  CAVAN: [{ radius: 30, price: 525, label: 'Vancouver → Lower Mainland (0-30 mi)' }, { radius: 60, price: 720, label: 'Vancouver → Fraser Valley (30-60 mi)' }, { radius: 150, price: 1075, label: 'Vancouver → Extended BC (60-150 mi)' }],
  CAMTR: [{ radius: 30, price: 460, label: 'Montreal → Greater Montreal (0-30 mi)' }, { radius: 60, price: 625, label: 'Montreal → Regional QC (30-60 mi)' }, { radius: 150, price: 950, label: 'Montreal → Extended QC/ON (60-150 mi)' }],
  CAHAL: [{ radius: 30, price: 425, label: 'Halifax → HRM (0-30 mi)' }, { radius: 60, price: 575, label: 'Halifax → Regional NS (30-60 mi)' }, { radius: 150, price: 875, label: 'Halifax → Extended Maritimes (60-150 mi)' }],
  CAPRR: [{ radius: 30, price: 575, label: 'Prince Rupert → Local (0-30 mi)' }, { radius: 60, price: 850, label: 'Prince Rupert → Regional BC (30-60 mi)' }, { radius: 150, price: 1250, label: 'Prince Rupert → Extended BC (60-150 mi)' }],
};

// ── Accessorial schedule (drayage-relevant; editable defaults) ───────────────
type AccKind = 'flat' | 'per_mile' | 'pct_of_base' | 'per_day' | 'per_hour';
type AccTrigger = 'optional' | 'auto' | 'auto_if_hazmat' | 'auto_if_temp_controlled' | 'auto_if_residential' | 'auto_if_weight_over';
export type Accessorial = {
  code: string;
  label: string;
  kind: AccKind;
  amount: number;
  trigger: AccTrigger;
  freeHours?: number;
  daysFlag?: 'storageDays' | 'layoverDays';
  weightLbsOver?: number;
};
export const DRAYAGE_ACCESSORIALS: Accessorial[] = [
  { code: 'detention', label: 'Detention (over 2 free hrs)', kind: 'per_hour', amount: 99, trigger: 'optional', freeHours: 2 },
  { code: 'detention_terminal', label: 'Terminal detention (over 1 free hr)', kind: 'per_hour', amount: 100, trigger: 'optional', freeHours: 1 },
  { code: 'layover', label: 'Layover', kind: 'per_day', amount: 350, trigger: 'optional', daysFlag: 'layoverDays' },
  { code: 'prepull', label: 'Pre-pull', kind: 'flat', amount: 145, trigger: 'optional' },
  { code: 'chassis_rental', label: 'Chassis rental', kind: 'per_day', amount: 40, trigger: 'optional', daysFlag: 'storageDays' },
  { code: 'chassis_split', label: 'Chassis split', kind: 'flat', amount: 100, trigger: 'optional' },
  { code: 'flip_fee', label: 'Flip fee', kind: 'flat', amount: 200, trigger: 'optional' },
  { code: 'triaxle', label: 'Tri-axle chassis', kind: 'per_day', amount: 85, trigger: 'optional', daysFlag: 'storageDays' },
  { code: 'drop_hook', label: 'Drop & hook', kind: 'flat', amount: 150, trigger: 'optional' },
  { code: 'stop_off', label: 'Stop-off', kind: 'flat', amount: 150, trigger: 'optional' },
  { code: 'wait_time', label: 'Wait time', kind: 'flat', amount: 150, trigger: 'optional' },
  { code: 'storage', label: 'Yard storage', kind: 'per_day', amount: 45, trigger: 'optional', daysFlag: 'storageDays' },
  { code: 'reefer_storage', label: 'Reefer storage', kind: 'per_day', amount: 95, trigger: 'optional', daysFlag: 'storageDays' },
  { code: 'rail_terminal_surcharge', label: 'Rail-terminal surcharge', kind: 'flat', amount: 195, trigger: 'optional' },
  { code: 'weekend_fee', label: 'Weekend / after-hours', kind: 'flat', amount: 250, trigger: 'optional' },
  { code: 'pier_pass', label: 'PierPass / TMF', kind: 'flat', amount: 35.5, trigger: 'optional' },
  { code: 'port_congestion', label: 'Port congestion', kind: 'flat', amount: 75, trigger: 'optional' },
  { code: 'scale_ticket', label: 'Scale ticket', kind: 'flat', amount: 35, trigger: 'optional' },
  { code: 'in_bond', label: 'In-bond move', kind: 'flat', amount: 250, trigger: 'optional' },
  { code: 'appointment', label: 'Appointment fee', kind: 'flat', amount: 50, trigger: 'optional' },
  { code: 'tonu', label: 'TONU (truck ordered, not used)', kind: 'flat', amount: 300, trigger: 'optional' },
  { code: 'driver_assist', label: 'Driver assist', kind: 'flat', amount: 100, trigger: 'optional' },
  { code: 'reefer_monitoring', label: 'Reefer monitoring', kind: 'per_day', amount: 35, trigger: 'optional', daysFlag: 'storageDays' },
  // Auto-triggered:
  { code: 'hazmat_flat', label: 'Hazmat handling', kind: 'flat', amount: 250, trigger: 'auto_if_hazmat' },
  { code: 'reefer_flat', label: 'Reefer / temp-controlled', kind: 'flat', amount: 250, trigger: 'auto_if_temp_controlled' },
  { code: 'reefer_genset', label: 'Reefer genset', kind: 'per_day', amount: 75, trigger: 'auto_if_temp_controlled', daysFlag: 'storageDays' },
  { code: 'residential', label: 'Residential delivery', kind: 'flat', amount: 150, trigger: 'auto_if_residential' },
  { code: 'overweight', label: 'Overweight', kind: 'flat', amount: 200, trigger: 'auto_if_weight_over', weightLbsOver: 44000 },
];

// ── Engine ──────────────────────────────────────────────────────────────────
export type DrayageFlags = {
  hazmat?: boolean;
  tempControlled?: boolean;
  residential?: boolean;
  storageDays?: number;
  layoverDays?: number;
  detentionHours?: number;
  terminalDetentionHours?: number;
  weightLbs?: number;
};
export type DrayageMatrixInput = {
  portCode: string;
  doorLat: number;
  doorLng: number;
  flags?: DrayageFlags;
  selectedAccessorialCodes?: string[];
  fuelPerMile?: number; // DOE-index $/mi (0 = off)
  marginPct?: number; // hidden markup, folded into total
  currency?: DrayageCurrency;
};
export type MatrixLine = { name: string; amount: number; kind: 'linehaul' | 'accessorial' | 'fuel' | 'margin'; code?: string };
export type MatrixResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      portCode: string;
      miles: number;
      currency: DrayageCurrency;
      lines: MatrixLine[];
      subtotalLinehaul: number;
      subtotalAccessorials: number;
      fuel: number;
      margin: number;
      total: number;
    };

function round2(n: number): number { return Math.round(n * 100) / 100; }

export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function applyAccessorial(a: Accessorial, base: number, flags: DrayageFlags): number {
  switch (a.kind) {
    case 'flat': return a.amount;
    case 'per_mile': return 0; // no per-mile accessorials in the drayage set
    case 'pct_of_base': return base * (a.amount / 100);
    case 'per_day': {
      const days = Number(flags[a.daysFlag === 'layoverDays' ? 'layoverDays' : 'storageDays'] ?? 0);
      return a.amount * Math.max(0, days);
    }
    case 'per_hour': {
      const raw = a.code === 'detention_terminal' ? Number(flags.terminalDetentionHours ?? 0) : Number(flags.detentionHours ?? 0);
      return a.amount * Math.max(0, raw - Number(a.freeHours ?? 0));
    }
    default: return a.amount;
  }
}

function autoTriggered(flags: DrayageFlags): Accessorial[] {
  return DRAYAGE_ACCESSORIALS.filter((a) => {
    if (a.trigger === 'auto') return true;
    if (a.trigger === 'auto_if_hazmat') return !!flags.hazmat;
    if (a.trigger === 'auto_if_temp_controlled') return !!flags.tempControlled;
    if (a.trigger === 'auto_if_residential') return !!flags.residential;
    if (a.trigger === 'auto_if_weight_over') return typeof flags.weightLbs === 'number' && typeof a.weightLbsOver === 'number' && flags.weightLbs > a.weightLbsOver;
    return false;
  });
}

/** Is this port anchored in the tariff matrix? */
export function isTariffPort(code: string): boolean {
  return Boolean(TARIFFS[(code || '').toUpperCase()]);
}
export function tariffPortCodes(): string[] { return Object.keys(TARIFFS); }

export function computeDrayageMatrix(input: DrayageMatrixInput): MatrixResult {
  const portCode = (input.portCode || '').toUpperCase();
  const rings = TARIFFS[portCode];
  const port = PORT_COORDS[portCode];
  if (!rings || !port) {
    return { ok: false, reason: `No drayage tariff for port "${input.portCode}". Tariff ports: ${tariffPortCodes().join(', ')}.` };
  }
  // Straight-line × 1.18 road-distance factor (matches QuoteFleet).
  const miles = round2(haversineMiles(port, { lat: input.doorLat, lng: input.doorLng }) * 1.18);
  const zone = rings.filter((r) => miles <= r.radius).sort((a, b) => a.radius - b.radius)[0];
  if (!zone) {
    return { ok: false, reason: `About ${Math.round(miles)} mi from ${port.city} — beyond the ${rings[rings.length - 1]!.radius}-mile drayage range. Contact us for a custom / FTL quote.` };
  }

  const currency = input.currency ?? (portCode.startsWith('CA') ? 'CAD' : 'USD');
  const flags = input.flags ?? {};
  const lines: MatrixLine[] = [];

  const linehaul = round2(zone.price);
  lines.push({ name: `${zone.label} (zone tariff)`, amount: linehaul, kind: 'linehaul' });

  let acc = 0;
  const auto = autoTriggered(flags);
  const autoCodes = new Set(auto.map((a) => a.code));
  for (const a of auto) {
    const amt = round2(applyAccessorial(a, linehaul, flags));
    if (amt === 0) continue;
    lines.push({ name: `${a.label} (auto)`, amount: amt, kind: 'accessorial', code: a.code });
    acc += amt;
  }
  const selected = new Set(input.selectedAccessorialCodes ?? []);
  for (const a of DRAYAGE_ACCESSORIALS) {
    if (a.trigger !== 'optional' || !selected.has(a.code) || autoCodes.has(a.code)) continue;
    const amt = round2(applyAccessorial(a, linehaul, flags));
    if (amt === 0) continue;
    lines.push({ name: a.label, amount: amt, kind: 'accessorial', code: a.code });
    acc += amt;
  }
  const subtotalAccessorials = round2(acc);

  let fuel = 0;
  const perMile = Math.max(0, input.fuelPerMile ?? 0);
  if (perMile > 0) {
    fuel = round2(perMile * miles);
    if (fuel > 0) lines.push({ name: `Fuel surcharge ($${perMile.toFixed(2)}/mi × ${Math.round(miles)} mi)`, amount: fuel, kind: 'fuel' });
  }

  const subtotal = round2(linehaul + subtotalAccessorials + fuel);
  let margin = 0;
  const marginPct = Math.max(0, input.marginPct ?? 0);
  if (marginPct > 0) {
    margin = round2(subtotal * (marginPct / 100));
    lines.push({ name: `Margin (${marginPct.toFixed(1)}%)`, amount: margin, kind: 'margin' });
  }

  return {
    ok: true,
    portCode,
    miles,
    currency,
    lines,
    subtotalLinehaul: linehaul,
    subtotalAccessorials,
    fuel,
    margin,
    total: round2(subtotal + margin),
  };
}
