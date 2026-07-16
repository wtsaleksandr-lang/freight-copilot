export interface ShipmentReportRow {
  refId: string;
  customerName?: string | null;
  shipperName?: string | null;
  receiverName?: string | null;
  fpol?: string | null;
  pol?: string | null;
  pod?: string | null;
  containerType?: string | null;
  containerQuantity?: number | null;
  cargoName?: string | null;
  carrierPreference?: string | null;
  bookingRef?: string | null;
  shipmentType?: string | null;
  operationalStatus?: string | null;
  notes?: string | null;
  updatedAt: Date | string;
}

export interface ShipmentReportItem extends ShipmentReportRow {
  statusLabel: string;
  lane: string;
  equipment: string;
  lastUpdated: string;
  ageDays: number;
  attention: string[];
}

export interface ShipmentStatusReport {
  generatedAt: string;
  shipmentCount: number;
  attentionCount: number;
  items: ShipmentReportItem[];
  text: string;
}

const DAY_MS = 86_400_000;
const CLOSED_STATUSES = new Set(['shipped', 'completed', 'closed', 'delivered']);

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function titleStatus(value: string | null | undefined): string {
  const normalized = clean(value) || 'status not set';
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function endpoint(...values: Array<string | null | undefined>): string {
  return values.map(clean).find(Boolean) ?? '—';
}

export function buildShipmentStatusReport(
  rows: ShipmentReportRow[],
  now = new Date()
): ShipmentStatusReport {
  const items = rows.map((row) => {
    const updated = new Date(row.updatedAt);
    const ageDays = Number.isNaN(updated.getTime())
      ? 0
      : Math.max(0, Math.floor((now.getTime() - updated.getTime()) / DAY_MS));
    const status = clean(row.operationalStatus).toLowerCase();
    const attention: string[] = [];

    if (!status) attention.push('Operational status is not set');
    if (!clean(row.bookingRef) && !CLOSED_STATUSES.has(status)) {
      attention.push('Booking reference is missing');
    }
    if (!clean(row.pol) || !clean(row.pod)) attention.push('Ocean routing is incomplete');
    if (ageDays >= 7 && !CLOSED_STATUSES.has(status)) {
      attention.push(`No update for ${ageDays} days`);
    }
    if (status === 'pending_invoice') attention.push('Invoice is pending');
    if (status === 'pending_payment') attention.push('Payment is pending');

    const quantity = row.containerQuantity && row.containerQuantity > 1
      ? `${row.containerQuantity} × `
      : '';

    return {
      ...row,
      statusLabel: titleStatus(row.operationalStatus),
      lane: `${endpoint(row.fpol, row.pol)} → ${endpoint(row.pod)}`,
      equipment: `${quantity}${clean(row.containerType) || clean(row.shipmentType) || '—'}`,
      lastUpdated: Number.isNaN(updated.getTime())
        ? '—'
        : updated.toISOString().slice(0, 10),
      ageDays,
      attention,
    };
  });

  const lines = [
    `Shipment Status Report — ${now.toISOString().slice(0, 10)}`,
    `${items.length} shipment${items.length === 1 ? '' : 's'} · ${items.filter((item) => item.attention.length > 0).length} requiring attention`,
    '',
  ];

  for (const item of items) {
    const customer = clean(item.customerName) || clean(item.shipperName) || clean(item.receiverName) || 'Customer not set';
    const carrier = [clean(item.carrierPreference), clean(item.bookingRef)].filter(Boolean).join(' / ') || 'Carrier/booking not set';
    lines.push(`${item.refId} — ${customer}`);
    lines.push(`Route: ${item.lane}`);
    lines.push(`Equipment: ${item.equipment}`);
    lines.push(`Status: ${item.statusLabel}`);
    lines.push(`Carrier / booking: ${carrier}`);
    lines.push(`Last updated: ${item.lastUpdated}`);
    if (clean(item.notes)) lines.push(`Notes: ${clean(item.notes)}`);
    if (item.attention.length > 0) lines.push(`Attention: ${item.attention.join('; ')}`);
    lines.push('');
  }

  return {
    generatedAt: now.toISOString(),
    shipmentCount: items.length,
    attentionCount: items.filter((item) => item.attention.length > 0).length,
    items,
    text: lines.join('\n').trim(),
  };
}
