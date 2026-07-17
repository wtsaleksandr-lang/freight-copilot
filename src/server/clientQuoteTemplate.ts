import { chromium } from 'playwright';

export type ClientQuoteLine = {
  label: string;
  amount?: number | null;
  currency?: string | null;
  basis?: string | null;
  note?: string | null;
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
};

export type ClientQuoteInput = {
  template: 'import_usa' | 'import_canada' | 'ocean_comparison';
  title?: string | null;
  pol?: string | null;
  pod?: string | null;
  placeOfDelivery?: string | null;
  terminal?: string | null;
  hsCode?: string | null;
  dutyRate?: string | null;
  customsExamNote?: string | null;
  currency?: string | null;
  services?: ClientQuoteLine[];
  options?: ClientQuoteOption[];
  notes?: string[];
  waitingTime?: string | null;
  destinationChargesNote?: string | null;
  hiddenMarkupFlat?: number | null;
  hiddenMarkupPct?: number | null;
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

export function buildClientQuoteHtml(input: ClientQuoteInput): string {
  const currency = input.currency || 'USD';
  const title = input.title || ({ import_usa: 'Ocean import FCL, to USA', import_canada: 'Ocean import FCL, to Canada', ocean_comparison: 'Ocean freight quotation' } as const)[input.template];
  const serviceRows = (input.services ?? []).map((line) => `<tr class="${line.emphasis ? 'emphasis' : ''}"><td>${esc(line.label)}</td><td class="amount">${line.amount == null ? '' : money(sell(line.amount, input), line.currency || currency)}</td><td>${esc(line.basis || '')}</td><td>${esc(line.note || '')}</td></tr>`).join('');
  const detailRows = [
    input.hsCode || input.dutyRate ? `<tr class="emphasis"><td>Import Duties and Taxes</td><td colspan="3">ACCORDING TO HS CODE ${esc(input.hsCode || '')}${input.dutyRate ? ` · duty rate ${esc(input.dutyRate)}` : ''}</td></tr>` : '',
    input.customsExamNote ? `<tr class="emphasis"><td>Customs examination</td><td colspan="3">${esc(input.customsExamNote)}</td></tr>` : '',
    input.terminal ? `<tr class="emphasis"><td>Container terminal</td><td colspan="3">${esc(input.terminal)}</td></tr>` : '',
    input.placeOfDelivery ? `<tr class="emphasis"><td>Place of delivery</td><td colspan="3">${esc(input.placeOfDelivery)}</td></tr>` : '',
  ].join('');
  const optionHeaders = (input.options ?? []).map((o) => `<th>${esc(o.carrier)}<small>${esc(o.containerType)}</small></th>`).join('');
  const optionRates = (input.options ?? []).map((o) => `<td class="option-price">${money(sell(o.amount, input), o.currency || currency)}</td>`).join('');
  const optionDest = (input.options ?? []).map((o) => `<td>${o.destinationCharges == null ? '—' : money(o.destinationCharges, o.destinationCurrency || o.currency || currency)}</td>`).join('');
  const optionTransit = (input.options ?? []).map((o) => `<td>${o.transitDays == null ? '—' : `${o.transitDays} days`}</td>`).join('');
  const comparison = input.template === 'ocean_comparison' ? `<table class="comparison"><tr><th class="rowhead">POL</th><td colspan="${Math.max(1, input.options?.length ?? 1)}">${esc(input.pol || '')}</td></tr><tr><th class="rowhead">POD</th><td colspan="${Math.max(1, input.options?.length ?? 1)}">${esc(input.pod || '')}</td></tr><tr><th class="rowhead">Carrier / equipment</th>${optionHeaders}</tr><tr><th class="rowhead">Rate</th>${optionRates}</tr><tr><th class="rowhead">Destination charges · collect</th>${optionDest}</tr><tr><th class="rowhead">Transit time approximately</th>${optionTransit}</tr></table>` : '';
  const notes = (input.notes ?? []).map((note) => `<div class="notice">${esc(note)}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page{size:A4 landscape;margin:10mm}body{font-family:Arial,sans-serif;color:#111;font-size:10.5pt;margin:0}h1{font-size:15pt;margin:0;padding:6px 8px;border:1.4px solid #111;border-bottom:0;background:#f2f2f2}table{width:100%;border-collapse:collapse;table-layout:fixed}td,th{border:1px solid #111;padding:5px 7px;vertical-align:middle}th{background:#f2f2f2;font-weight:700}.services td:first-child{width:28%;text-align:center}.services td:nth-child(2){width:18%;font-weight:700}.services td:nth-child(3){width:14%}.services td:nth-child(4){width:40%}.amount{font-weight:700}.emphasis td{font-weight:700}.comparison{margin-top:10px}.comparison .rowhead{width:20%;text-align:left}.comparison th small{display:block;font-size:8.5pt;margin-top:2px}.option-price{font-weight:700;font-size:11pt}.notice{border:1px solid #111;border-top:0;padding:6px 8px}.waiting{font-weight:700;color:#0b4a8b;text-align:center;border:1.4px solid #111;padding:7px;margin-top:8px}.collect{font-weight:700;text-align:center;border:1px solid #111;padding:6px;margin-top:8px}.footer{margin-top:8px;font-size:8.5pt;color:#555;text-align:right}
  </style></head><body><h1>${esc(title)}</h1>${comparison || `<table class="services"><tr><th>Services</th><th>Rate</th><th>Basis</th><th>Notes</th></tr>${serviceRows}${detailRows}</table>`}${input.destinationChargesNote ? `<div class="collect">Destination charges: ${esc(input.destinationChargesNote)}</div>` : ''}${input.waitingTime ? `<div class="waiting">WAITING TIME: ${esc(input.waitingTime)}</div>` : ''}${notes}<div class="footer">Client quotation · rates in ${esc(currency)} unless stated otherwise</div></body></html>`;
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
