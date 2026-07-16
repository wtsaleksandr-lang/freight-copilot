export type ShipmentEmailType =
  | 'status_update'
  | 'booking_followup'
  | 'missing_information'
  | 'delay_notice';

export interface ShipmentEmailInput {
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
  operationalStatus?: string | null;
  notes?: string | null;
  updatedAt?: Date | string | null;
}

export interface ShipmentEmailDraftOptions {
  type: ShipmentEmailType;
  recipientName?: string | null;
  extraContext?: string | null;
}

export interface ShipmentEmailDraft {
  subject: string;
  body: string;
  missingFields: string[];
}

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function titleCaseStatus(value: string | null | undefined): string {
  const status = clean(value) || 'processing';
  return status
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function routeLabel(shipment: ShipmentEmailInput): string {
  const origin = clean(shipment.fpol) || clean(shipment.pol) || 'origin not confirmed';
  const destination = clean(shipment.pod) || 'destination not confirmed';
  return `${origin} to ${destination}`;
}

function equipmentLabel(shipment: ShipmentEmailInput): string {
  const type = clean(shipment.containerType);
  if (!type) return 'equipment not confirmed';
  const quantity = shipment.containerQuantity && shipment.containerQuantity > 1
    ? `${shipment.containerQuantity} x `
    : '';
  return `${quantity}${type}`;
}

function greeting(name: string | null | undefined): string {
  return `Dear ${clean(name) || 'Team'},`;
}

function closing(): string {
  return 'Best regards,\nAlex';
}

export function buildShipmentEmailDraft(
  shipment: ShipmentEmailInput,
  options: ShipmentEmailDraftOptions
): ShipmentEmailDraft {
  const customer = clean(shipment.customerName) || clean(shipment.shipperName) || clean(shipment.receiverName);
  const route = routeLabel(shipment);
  const equipment = equipmentLabel(shipment);
  const status = titleCaseStatus(shipment.operationalStatus);
  const carrier = clean(shipment.carrierPreference);
  const booking = clean(shipment.bookingRef);
  const cargo = clean(shipment.cargoName);
  const notes = clean(shipment.notes);
  const extra = clean(options.extraContext);
  const missingFields: string[] = [];

  if (!clean(shipment.pol) && !clean(shipment.fpol)) missingFields.push('origin');
  if (!clean(shipment.pod)) missingFields.push('destination');
  if (!clean(shipment.containerType)) missingFields.push('equipment');
  if (!booking && options.type !== 'missing_information') missingFields.push('booking reference');

  const commonDetails = [
    `Reference: ${shipment.refId}`,
    `Route: ${route}`,
    `Equipment: ${equipment}`,
    cargo ? `Cargo: ${cargo}` : '',
    carrier ? `Carrier: ${carrier}` : '',
    booking ? `Booking: ${booking}` : '',
  ].filter(Boolean);

  let subject = '';
  let paragraphs: string[] = [];

  switch (options.type) {
    case 'booking_followup':
      subject = `Booking follow-up — ${shipment.refId} — ${route}`;
      paragraphs = [
        greeting(options.recipientName || customer),
        'I am following up regarding the booking confirmation for the shipment below.',
        commonDetails.join('\n'),
        booking
          ? `Please confirm the current booking status and advise whether any action is required from our side for booking ${booking}.`
          : 'Please provide the booking confirmation, carrier booking reference, routing, and applicable cut-off details.',
        extra || 'Please also advise the expected timing for the confirmation.',
        closing(),
      ];
      break;

    case 'missing_information': {
      const requested = extra || [
        !cargo ? 'cargo description' : '',
        !clean(shipment.containerType) ? 'container or equipment type' : '',
        !clean(shipment.pol) && !clean(shipment.fpol) ? 'origin location' : '',
        !clean(shipment.pod) ? 'destination location' : '',
        !booking ? 'booking reference, if already available' : '',
      ].filter(Boolean).join(', ');
      subject = `Information required — ${shipment.refId}`;
      paragraphs = [
        greeting(options.recipientName || customer),
        'To proceed with this shipment, please provide or confirm the following information:',
        requested || 'Please confirm the missing shipment details and any special handling requirements.',
        commonDetails.join('\n'),
        'Once received, we will update the file and proceed with the next step.',
        closing(),
      ];
      break;
    }

    case 'delay_notice':
      subject = `Shipment update / delay notice — ${shipment.refId} — ${route}`;
      paragraphs = [
        greeting(options.recipientName || customer),
        `Please note that the shipment below is experiencing a delay or operational exception. The current status is ${status}.`,
        commonDetails.join('\n'),
        extra || notes || 'We are checking with the carrier and will provide the next confirmed update as soon as available.',
        'We are monitoring the shipment and will keep you informed of any material change.',
        closing(),
      ];
      break;

    case 'status_update':
    default:
      subject = `Shipment status update — ${shipment.refId} — ${route}`;
      paragraphs = [
        greeting(options.recipientName || customer),
        `Please see the latest status update for the shipment below. The current status is ${status}.`,
        commonDetails.join('\n'),
        notes ? `Latest notes: ${notes}` : '',
        extra,
        'We will continue monitoring the shipment and share the next update when available.',
        closing(),
      ];
      break;
  }

  return {
    subject,
    body: paragraphs.filter(Boolean).join('\n\n'),
    missingFields,
  };
}
