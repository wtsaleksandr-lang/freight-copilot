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
  // HARD IDENTITY is the ONLY signal allowed to AUTO-MERGE. A shipment is "the
  // same" one already on the board only when a hard reference matches: our
  // internal S0xxxx ref, or the carrier booking / BL number. These come straight
  // off the email subject line / booking number and uniquely identify a
  // shipment. Soft signals (same client, shipper, receiver, lane, container)
  // NEVER auto-merge — they recur constantly across genuinely different
  // shipments (repeat business on the same lane), which is exactly what caused
  // wrong silent merges.
  const hardMatch = ranked.find(
    (r) =>
      same(signals.internalRef, r.shipment.refId) ||
      same(signals.bookingRef, r.shipment.bookingRef)
  );
  if (hardMatch) return { status: 'matched' as const, match: hardMatch, ranked };

  // A hard reference WAS provided but matched nothing on the board → this is
  // definitively a NEW shipment. Do not merge, and do not even prompt on soft
  // overlaps: an unmatched booking ref / internal ref is proof it isn't already
  // here. (This is the rule Alex asked for: strictly follow subject line +
  // booking reference — if present and unmatched, it can't be an existing row.)
  const hasHardId = Boolean(norm(signals.internalRef) || norm(signals.bookingRef));
  if (hasHardId) return { status: 'none' as const, ranked: [] };

  // No hard reference at all → fall back to SOFT matching, but only ever ASK
  // (ambiguous → the clarify prompt); never auto-merge. Below the consensus
  // floor, just create a new shipment silently.
  const first = ranked[0];
  const AMBIGUOUS_FLOOR = 45;
  if (!first || first.score < AMBIGUOUS_FLOOR) {
    return { status: 'none' as const, ranked: [] };
  }
  return { status: 'ambiguous' as const, ranked: ranked.slice(0, 5) };
}
