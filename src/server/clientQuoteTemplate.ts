import { chromium } from 'playwright';

export type ClientQuoteLine = {
  label: string;
  amount?: number | null;
  currency?: string | null;
  basis?: string | null;
  note?: string | null;
  category?: 'firm' | 'statutory' | 'conditional';
  emphasis?: boolean;
};

export type ClientQuoteOption = {
  carrier: string;
  containerType: string;
  amount: number;
  currency?: string | null;
  transitDays?: number | null;
  destinationCharges?: number | null;
  destinationCurrency?: string | null;
  indicativeEtd?: string | null;
  scheduleStatus?: string | null;
  remarks?: string | null;
  recommended?: boolean | null;
};

export type ClientQuoteInput = {
  template: 'import_usa' | 'import_canada' | 'export_clearance' | 'ocean_comparison';
  title?: string | null;
  pol?: string | null;
  pod?: string | null;
  placeOfDelivery?: string | null;
  terminal?: string | null;
  hsCode?: string | null;
  dutyRate?: string | null;
  customsExamNote?: string | null;
  currency?: string | null;
  validity?: string | null;
  services?: ClientQuoteLine[];
  options?: ClientQuoteOption[];
  notes?: string[];
  waitingTime?: string | null;
  destinationChargesNote?: string | null;
  hiddenMarkupFlat?: number | null;
  hiddenMarkupPct?: number | null;
  includeCommercialNotes?: boolean | null;
};

function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(amount: number | null | undefined, currency = 'USD'): string {
  if (amount == null || !Number.isFinite(amount)) return '';
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sell(amount: number, input: ClientQuoteInput): number {
  const pct = Number(input.hiddenMarkupPct ?? 0);
  const flat = Number(input.hiddenMarkupFlat ?? 0);
  return Math.round((amount * (1 + pct / 100) + flat) * 100) / 100;
}

function serviceSection(label: string, rows: ClientQuoteLine[], input: ClientQuoteInput, currency: string): string {
  if (!rows.length) return '';
  const body = rows.map((line) => `<tr class="${line.emphasis ? 'emphasis' : ''}"><td>${esc(line.label)}</td><td class="amount">${line.amount == null ? '' : money(sell(line.amount, input), line.currency || currency)}</td><td>${esc(line.basis || '')}</td><td>${esc(line.note || '')}</td></tr>`).join('');
  return `<tr class="section-row"><th colspan="4">${esc(label)}</th></tr>${body}`;
}

function commercialNotes(input: ClientQuoteInput): string {
  if (input.includeCommercialNotes === false) return '';
  return `<div class="terms"><div><strong>Rate basis:</strong> Complete sell rates for the stated scope, including agency handling and all specifically listed charges.</div><div><strong>Exclusions:</strong> Duties/taxes, customs examination, storage, demurrage, detention and exceptional third-party costs unless stated otherwise.</div><div><strong>Commercial review:</strong> Please advise if you have a firm target or competing indication; available service and routing options will be rechecked where possible.</div><div><strong>Validity:</strong> ${esc(input.validity || 'Subject to rate validity and final service confirmation.')}</div></div>`;
}

function customsClassificationRows(input: ClientQuoteInput): string {
  const isExport = input.template === 'export_clearance';
  if (!input.hsCode && !input.dutyRate) return '';
  if (isExport) {
    return `<tr class="emphasis"><td>Export classification</td><td colspan="3">HS ${esc(input.hsCode || 'TBC')}${input.dutyRate ? ` · duty/tax indication: ${esc(input.dutyRate)}` : ''}, subject to final customs review.</td></tr>`;
  }
  return `<tr class="emphasis"><td>Import Duties and Taxes</td><td colspan="3">Duty indication: ${esc(input.dutyRate || 'TBC')} under HS ${esc(input.hsCode || 'TBC')}, subject to final customs classification.</td></tr>`;
}

export function buildClientQuoteHtml(input: ClientQuoteInput): string {
  const currency = input.currency || 'USD';
  const title = input.title || ({
    import_usa: 'Ocean import FCL, to USA',
    import_canada: 'Ocean import FCL, to Canada',
    export_clearance: 'Export customs clearance quotation',
    ocean_comparison: 'Ocean freight quotation',
  } as const)[input.template];
  const services = input.services ?? [];
  const serviceRows = [
    serviceSection('Firm service charges', services.filter((line) => (line.category ?? 'firm') === 'firm'), input, currency),
    serviceSection('Statutory charges', services.filter((line) => line.category === 'statutory'), input, currency),
    serviceSection('Conditional charges', services.filter((line) => line.category === 'conditional'), input, currency),
  ].join('');
  const detailRows = [
    customsClassificationRows(input),
    input.customsExamNote ? `<tr class="emphasis"><td>Customs examination</td><td colspan="3">${esc(input.customsExamNote)}</td></tr>` : '',
    input.terminal ? `<tr class="emphasis"><td>Container terminal</td><td colspan="3">${esc(input.terminal)}</td></tr>` : '',
    input.placeOfDelivery ? `<tr class="emphasis"><td>Place of delivery</td><td colspan="3">${esc(input.placeOfDelivery)}</td></tr>` : '',
  ].join('');
  const options = input.options ?? [];
  const optionHeaders = options.map((o) => `<th class="${o.recommended ? 'recommended' : ''}">${o.recommended ? '<span class="tag">Recommended</span>' : ''}${esc(o.carrier)}<small>${esc(o.containerType)}</small></th>`).join('');
  const optionRates = options.map((o) => `<td class="option-price ${o.recommended ? 'recommended' : ''}">${money(sell(o.amount, input), o.currency || currency)}</td>`).join('');
  const optionDest = options.map((o) => `<td>${o.destinationCharges == null ? '—' : money(o.destinationCharges, o.destinationCurrency || o.currency || currency)}</td>`).join('');
  const optionEtd = options.map((o) => `<td>${esc(o.indicativeEtd || '—')}</td>`).join('');
  const optionStatus = options.map((o) => `<td>${esc(o.scheduleStatus || 'Subject to booking confirmation')}</td>`).join('');
  const optionTransit = options.map((o) => `<td>${o.transitDays == null ? '—' : `${o.transitDays} days`}</td>`).join('');
  const optionRemarks = options.map((o) => `<td>${esc(o.remarks || '—')}</td>`).join('');
  const comparison = input.template === 'ocean_comparison' ? `<table class="comparison"><tr><th class="rowhead">POL</th><td colspan="${Math.max(1, options.length)}">${esc(input.pol || '')}</td></tr><tr><th class="rowhead">POD</th><td colspan="${Math.max(1, options.length)}">${esc(input.pod || '')}</td></tr><tr><th class="rowhead">Carrier / equipment</th>${optionHeaders}</tr><tr><th class="rowhead">Complete sell rate</th>${optionRates}</tr><tr><th class="rowhead">Destination charges · collect</th>${optionDest}</tr><tr><th class="rowhead">Nearest published ETD</th>${optionEtd}</tr><tr><th class="rowhead">Space / vessel status</th>${optionStatus}</tr><tr><th class="rowhead">Transit time approximately</th>${optionTransit}</tr><tr><th class="rowhead">Remarks</th>${optionRemarks}</tr></table><div class="schedule-note"><strong>Schedule note:</strong> Published sailing dates are indicative. Space, equipment and final vessel allocation are confirmed only after booking submission and carrier acceptance.</div>` : '';
  const notes = (input.notes ?? []).map((note) => `<div class="notice">${esc(note)}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page{size:A4 landscape;margin:10mm}body{font-family:Arial,sans-serif;color:#111;font-size:10pt;margin:0}h1{font-size:15pt;margin:0;padding:6px 8px;border:1.4px solid #111;border-bottom:0;background:#f2f2f2}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{border:1px solid #111;padding:5px 7px;vertical-align:middle}th{background:#f2f2f2;font-weight:700}.services td:first-child{width:28%;text-align:center}.services td:nth-child(2){width:18%;font-weight:700}.services td:nth-child(3){width:14%}.services td:nth-child(4){width:40%}.section-row th{text-align:left;background:#e8edf3}.amount{font-weight:700}.emphasis td{font-weight:700}.comparison{margin-top:10px}.comparison .rowhead{width:20%;text-align:left}.comparison th small{display:block;font-size:8.5pt;margin-top:2px}.option-price{font-weight:700;font-size:11pt}.recommended{background:#eef6ef}.tag{display:block;font-size:7.5pt;text-transform:uppercase;letter-spacing:.04em;color:#276738;margin-bottom:3px}.notice{border:1px solid #111;border-top:0;padding:6px 8px}.waiting{font-weight:700;color:#0b4a8b;text-align:center;border:1.4px solid #111;padding:7px;margin-top:8px}.collect{font-weight:700;text-align:center;border:1px solid #111;padding:6px;margin-top:8px}.schedule-note,.terms{border:1px solid #111;padding:7px 8px;margin-top:8px}.schedule-note{background:#f6f8fa}.terms{font-size:8.8pt;line-height:1.35}.terms div+div{margin-top:3px}.footer{margin-top:7px;font-size:8pt;color:#555;text-align:right}
  </style></head><body><h1>${esc(title)}</h1>${comparison || `<table class="services"><tr><th>Services</th><th>Rate</th><th>Basis</th><th>Notes</th></tr>${serviceRows}${detailRows}</table>`}${input.destinationChargesNote ? `<div class="collect">Destination charges: ${esc(input.destinationChargesNote)}</div>` : ''}${input.waitingTime ? `<div class="waiting">WAITING TIME: ${esc(input.waitingTime)}</div>` : ''}${notes}${commercialNotes(input)}<div class="footer">Client quotation · rates in ${esc(currency)} unless stated otherwise</div></body></html>`;
}

export async function renderClientQuotePdf(input: ClientQuoteInput): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(buildClientQuoteHtml(input), { waitUntil: 'domcontentloaded' });
    return await page.pdf({ format: 'A4', landscape: true, printBackground: true });
  } finally {
    await browser.close();
  }
}
