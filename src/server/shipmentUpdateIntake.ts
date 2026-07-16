export type ShipmentUpdateField =
  | 'bookingRef'
  | 'carrierPreference'
  | 'operationalStatus'
  | 'pol'
  | 'pod'
  | 'containerType'
  | 'containerQuantity'
  | 'notes';

export type ProposalConfidence = 'high' | 'medium' | 'low';

export interface ShipmentUpdateSource {
  bookingRef?: string | null;
  carrierPreference?: string | null;
  operationalStatus?: string | null;
  pol?: string | null;
  pod?: string | null;
  containerType?: string | null;
  containerQuantity?: number | null;
  notes?: string | null;
}

export interface ShipmentUpdateProposal {
  field: ShipmentUpdateField;
  currentValue: string | number | null;
  proposedValue: string | number;
  confidence: ProposalConfidence;
  evidence: string;
}

const CARRIERS = [
  ['Maersk', /\b(?:maersk|maeu)\b/i],
  ['MSC', /\b(?:msc|mediterranean shipping)\b/i],
  ['CMA CGM', /\b(?:cma\s*cgm|cmdu)\b/i],
  ['Hapag-Lloyd', /\b(?:hapag[- ]?lloyd|hlcu)\b/i],
  ['OOCL', /\boocl\b/i],
  ['ONE', /\b(?:ocean network express|one line)\b/i],
  ['ZIM', /\bzim\b/i],
] as const;

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

function sameValue(a: unknown, b: unknown): boolean {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

function evidenceLine(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', index) + 1);
  const next = text.indexOf('\n', index);
  return text.slice(start, next === -1 ? text.length : next).trim().slice(0, 220);
}

function addProposal(
  output: ShipmentUpdateProposal[],
  current: ShipmentUpdateSource,
  field: ShipmentUpdateField,
  value: string | number | null | undefined,
  confidence: ProposalConfidence,
  evidence: string
): void {
  if (value === null || value === undefined || clean(value) === '') return;
  if (sameValue(current[field], value)) return;
  if (output.some((item) => item.field === field)) return;
  output.push({
    field,
    currentValue: current[field] ?? null,
    proposedValue: value,
    confidence,
    evidence,
  });
}

export function extractShipmentUpdateProposals(
  text: string,
  current: ShipmentUpdateSource
): ShipmentUpdateProposal[] {
  const source = text.replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const proposals: ShipmentUpdateProposal[] = [];

  const booking = /(?:(?:booking\s+(?:reference|ref|number|no\.?|#)|bkg\s*(?:reference|ref|number|no\.?|#))\s*[:#-]?|booking\s*[:#-])\s*([A-Z0-9][A-Z0-9-]{5,24})/i.exec(source);
  if (booking?.[1]) {
    addProposal(proposals, current, 'bookingRef', booking[1].toUpperCase(), 'high', evidenceLine(source, booking.index));
  }

  for (const [name, pattern] of CARRIERS) {
    const match = pattern.exec(source);
    if (match) {
      addProposal(proposals, current, 'carrierPreference', name, 'medium', evidenceLine(source, match.index));
      break;
    }
  }

  const statusRules: Array<[string, RegExp, ProposalConfidence]> = [
    ['delivered', /\b(?:delivered|delivery completed|proof of delivery)\b/i, 'high'],
    ['shipped', /\b(?:vessel departed|has sailed|shipped on board|on board)\b/i, 'high'],
    ['pending_payment', /\b(?:payment pending|awaiting payment|pending payment)\b/i, 'high'],
    ['pending_invoice', /\b(?:invoice pending|awaiting invoice|pending invoice)\b/i, 'high'],
    ['processing', /\b(?:booking confirmed|booking confirmation|in process|processing)\b/i, 'medium'],
  ];
  for (const [status, pattern, confidence] of statusRules) {
    const match = pattern.exec(source);
    if (match) {
      addProposal(proposals, current, 'operationalStatus', status, confidence, evidenceLine(source, match.index));
      break;
    }
  }

  const pol = /(?:POL|port of loading)\s*[:#-]\s*([^\n,;]{2,60})/i.exec(source);
  if (pol?.[1]) addProposal(proposals, current, 'pol', pol[1].trim(), 'high', evidenceLine(source, pol.index));

  const pod = /(?:POD|port of discharge|destination port)\s*[:#-]\s*([^\n,;]{2,60})/i.exec(source);
  if (pod?.[1]) addProposal(proposals, current, 'pod', pod[1].trim(), 'high', evidenceLine(source, pod.index));

  const container = /\b(?:(\d+)\s*[x×]\s*)?(20|40|45)\s*['’]?(?:\s*)(HC|HQ|DV|GP|RF|RH|OT|FR|NOR|REEFER|DRY)?\b/i.exec(source);
  if (container) {
    const quantity = container[1] ? Number(container[1]) : null;
    const size = container[2];
    const rawCode = (container[3] ?? '').toUpperCase();
    const codeMap: Record<string, string> = {
      HC: 'HC', HQ: 'HC', DV: 'DV', GP: 'DV', RF: 'RF', RH: 'RH',
      OT: 'OT', FR: 'FR', NOR: 'NOR', REEFER: 'RF', DRY: 'DV',
    };
    const type = `${size}${codeMap[rawCode] ?? (size === '40' ? 'HC' : 'DV')}`;
    addProposal(proposals, current, 'containerType', type, rawCode ? 'high' : 'medium', evidenceLine(source, container.index));
    if (quantity && quantity > 0) {
      addProposal(proposals, current, 'containerQuantity', quantity, 'high', evidenceLine(source, container.index));
    }
  }

  const exception = /(?:delay|exception|rolled|rollover|short shipped|customs hold|port congestion|vessel change)[^\n]*/i.exec(source);
  if (exception) {
    const note = exception[0].trim().slice(0, 500);
    const existing = clean(current.notes);
    if (!existing.toLowerCase().includes(note.toLowerCase())) {
      addProposal(proposals, current, 'notes', existing ? `${existing}\n${note}` : note, 'medium', evidenceLine(source, exception.index));
    }
  }

  return proposals;
}
