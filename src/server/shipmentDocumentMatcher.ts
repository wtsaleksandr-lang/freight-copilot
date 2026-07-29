export type MatchableShipment = {
  refId: string;
  updatedAt: Date;
  bookingRef?: string | null;
  customerName?: string | null;
  shipperName?: string | null;
  receiverName?: string | null;
  carrierPreference?: string | null;
  pol?: string | null;
  pod?: string | null;
  containerType?: string | null;
};

export type ShipmentSignals = {
  internalRef?: string | null;
  bookingRef?: string | null;
  customerName?: string | null;
  shipperName?: string | null;
  receiverName?: string | null;
  carrierPreference?: string | null;
  pol?: string | null;
  pod?: string | null;
  containerType?: string | null;
};

function norm(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function same(a: unknown, b: unknown): boolean {
  const x = norm(a); const y = norm(b);
  return Boolean(x && y && x === y);
}

function containsEither(a: unknown, b: unknown): boolean {
  const x = norm(a); const y = norm(b);
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
}

export function rankShipmentMatches(signals: ShipmentSignals, rows: MatchableShipment[]) {
  return rows.map((shipment) => {
    let score = 0;
    const evidence: string[] = [];
    if (same(signals.internalRef, shipment.refId)) { score += 200; evidence.push('internal shipment reference'); }
    if (same(signals.bookingRef, shipment.bookingRef)) { score += 100; evidence.push('booking reference'); }
    if (containsEither(signals.customerName, shipment.customerName)) { score += 35; evidence.push('customer'); }
    if (containsEither(signals.shipperName, shipment.shipperName)) { score += 20; evidence.push('shipper'); }
    if (containsEither(signals.receiverName, shipment.receiverName)) { score += 20; evidence.push('receiver'); }
    if (same(signals.pol, shipment.pol)) { score += 18; evidence.push('POL'); }
    if (same(signals.pod, shipment.pod)) { score += 18; evidence.push('POD'); }
    if (same(signals.carrierPreference, shipment.carrierPreference)) { score += 12; evidence.push('carrier'); }
    if (same(signals.containerType, shipment.containerType)) { score += 8; evidence.push('container type'); }
    return { shipment, score, evidence };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.shipment.refId.localeCompare(b.shipment.refId));
}

export function chooseShipmentMatch(signals: ShipmentSignals, rows: MatchableShipment[]) {
  const ranked = rankShipmentMatches(signals, rows);
  const first = ranked[0];
  const second = ranked[1];
  if (!first) return { status: 'none' as const, ranked };
  // Don't raise the "might already exist" prompt on weak, single-signal overlaps
  // (same customer alone = 35, same POL+POD = 36, same shipper+container = 28…).
  // In freight those repeat constantly across genuinely different shipments, so
  // asking every time is noise. Only a real multi-field consensus (>= FLOOR) is
  // worth interrupting for; strong IDs (booking 100 / internalRef 200) still go
  // decisive below and real duplicates still auto-merge.
  const AMBIGUOUS_FLOOR = 45;
  if (first.score < AMBIGUOUS_FLOOR) return { status: 'none' as const, ranked: [] };
  const decisive = first.score >= 100 || (first.score >= 45 && (!second || first.score - second.score >= 20));
  return decisive
    ? { status: 'matched' as const, match: first, ranked }
    : { status: 'ambiguous' as const, ranked: ranked.slice(0, 5) };
}
