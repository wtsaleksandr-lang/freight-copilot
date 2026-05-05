import { chromium } from 'playwright';

export interface PdfRateCharge {
  name: string;
  total: number;
  currency: string;
}

export interface PdfQuote {
  id: number;
  carrierCode: string;
  carrierName: string;
  origin: string;
  destination: string;
  containerType: string;
  requestedDate: string;
  createdAt: Date;
  notes?: string | null;
  rates: Array<{
    rank: number | null;
    serviceName: string;
    sailingDate: string | null;
    vesselVoyage?: string | null;
    transitDays: number | null;
    detentionFreetimeDays?: number | null;
    demurrageFreetimeDays?: number | null;
    rollable?: boolean | null;
    currency: string;
    totalCostCents: number;
    freightCharges?: PdfRateCharge[];
    destinationCharges?: PdfRateCharge[];
    destinationTotal?: number | null;
    destinationCurrency?: string | null;
  }>;
}

export interface Markup {
  pct: number;
  flat: number;
}

function esc(s: string | number | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function applyMarkup(costCents: number, markup: Markup): number {
  const dollars = costCents / 100;
  return Math.round(dollars * (1 + markup.pct / 100) + markup.flat);
}

function buildHtml(q: PdfQuote, markup: Markup): string {
  const showMarkup = markup.pct !== 0 || markup.flat !== 0;
  const createdStr = q.createdAt.toISOString().slice(0, 10);

  const rows = q.rates
    .map((r) => {
      const costDollars = (r.totalCostCents / 100).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const yourPrice = showMarkup ? applyMarkup(r.totalCostCents, markup) : null;
      const dnd =
        r.detentionFreetimeDays != null || r.demurrageFreetimeDays != null
          ? `${r.detentionFreetimeDays ?? '?'}d / ${r.demurrageFreetimeDays ?? '?'}d`
          : '—';
      const flags: string[] = [];
      if (r.rollable) flags.push('Rollable');
      return `<tr>
        <td class="rank">#${r.rank ?? '—'}</td>
        <td>${esc(r.sailingDate) || '—'}</td>
        <td>${esc(r.vesselVoyage || '')}</td>
        <td>${r.transitDays != null ? r.transitDays + 'd' : '—'}</td>
        <td>${esc(dnd)}</td>
        <td class="num">${esc(r.currency)} ${costDollars}</td>
        ${showMarkup ? `<td class="num your-price">${esc(r.currency)} ${yourPrice!.toLocaleString()}</td>` : ''}
        <td>${esc(flags.join(', ') || '—')}</td>
      </tr>`;
    })
    .join('');

  const breakdownSections = q.rates
    .filter((r) => (r.freightCharges?.length ?? 0) > 0 || (r.destinationCharges?.length ?? 0) > 0)
    .map((r) => {
      const freight = (r.freightCharges ?? [])
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}</td><td class="num">${esc(c.currency)} ${c.total.toFixed(2)}</td></tr>`
        )
        .join('');
      const dest = (r.destinationCharges ?? [])
        .map(
          (c) =>
            `<tr><td>${esc(c.name)}</td><td class="num">${esc(c.currency)} ${c.total.toFixed(2)}</td></tr>`
        )
        .join('');
      const destTotal =
        r.destinationTotal && r.destinationCurrency
          ? `<tr class="row-total"><td>Destination total (on-collect)</td><td class="num">${esc(r.destinationCurrency)} ${r.destinationTotal.toLocaleString()}</td></tr>`
          : '';
      return `
      <h3>#${r.rank ?? '—'} — ${esc(r.serviceName)} (${esc(r.sailingDate || '')})</h3>
      <table class="bd">
        ${freight ? `<tbody class="bd-section"><tr><th colspan="2">Freight charges (your cost)</th></tr>${freight}<tr class="row-total"><td>Freight total</td><td class="num">${esc(r.currency)} ${(r.totalCostCents / 100).toFixed(2)}</td></tr></tbody>` : ''}
        ${dest ? `<tbody class="bd-section"><tr><th colspan="2">Destination charges (paid by receiver)</th></tr>${dest}${destTotal}</tbody>` : ''}
      </table>`;
    })
    .join('');

  const markupLabel = showMarkup
    ? `Markup applied: +${markup.pct}% / +${markup.flat} ${q.rates[0]?.currency ?? 'USD'}`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Quote #${q.id} — ${esc(q.origin)} → ${esc(q.destination)}</title>
<style>
  @page { margin: 16mm; }
  body {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    color: #0f172a;
    font-size: 11.5pt;
    line-height: 1.5;
  }
  h1 { font-size: 22pt; margin: 0 0 4pt 0; font-weight: 600; letter-spacing: -0.01em; }
  h2 { font-size: 14pt; margin: 18pt 0 6pt 0; font-weight: 600; }
  .brand {
    color: #64748b;
    font-size: 10pt;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 8pt;
  }
  .meta {
    color: #475569;
    font-size: 10.5pt;
    margin-bottom: 14pt;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: 120pt 1fr;
    row-gap: 4pt;
    column-gap: 10pt;
    margin: 10pt 0;
  }
  .meta-grid .k { color: #64748b; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10pt;
  }
  th {
    text-align: left;
    border-bottom: 1pt solid #0f172a;
    padding: 6pt 8pt;
    font-size: 10pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #475569;
    font-weight: 600;
  }
  td {
    padding: 7pt 8pt;
    border-bottom: 0.5pt solid #e5e7eb;
    vertical-align: top;
  }
  td.rank { font-weight: 700; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .your-price { color: #15803d; font-weight: 600; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt 0; }
  table.bd { margin-bottom: 8pt; }
  table.bd th { background: #f1f5f9; padding: 5pt 8pt; }
  table.bd .row-total td { font-weight: 600; border-top: 0.75pt solid #0f172a; }
  .bd-section td { padding: 5pt 8pt; }
  .notes { margin-top: 20pt; font-size: 10pt; color: #475569; }
  footer {
    margin-top: 24pt;
    padding-top: 8pt;
    border-top: 0.5pt solid #e5e7eb;
    color: #94a3b8;
    font-size: 9pt;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="brand">LoadMode</div>
  <h1>${esc(q.origin)} &rarr; ${esc(q.destination)}</h1>
  <div class="meta">${esc(q.carrierName)} · ${esc(q.containerType)} · quote #${q.id}</div>

  <div class="meta-grid">
    <div class="k">Carrier</div><div>${esc(q.carrierName)} (${esc(q.carrierCode)})</div>
    <div class="k">Lane</div><div>${esc(q.origin)} &rarr; ${esc(q.destination)}</div>
    <div class="k">Container</div><div>${esc(q.containerType)}</div>
    <div class="k">Requested for</div><div>${esc(q.requestedDate)}</div>
    <div class="k">Created</div><div>${esc(createdStr)}</div>
    ${markupLabel ? `<div class="k">Pricing</div><div>${esc(markupLabel)}</div>` : ''}
  </div>

  <h2>Sailing options</h2>
  <table>
    <thead>
      <tr>
        <th>Rank</th>
        <th>Sailing</th>
        <th>Vessel/voyage</th>
        <th>Transit</th>
        <th>Det/Dem free</th>
        <th class="num">Our cost</th>
        ${showMarkup ? '<th class="num">Your price</th>' : ''}
        <th>Flags</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  ${breakdownSections ? '<h2>Charge breakdown</h2>' + breakdownSections : ''}

  ${q.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(q.notes)}</div>` : ''}

  <footer>Generated by LoadMode on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</footer>
</body>
</html>`;
}

export async function renderQuotePdf(q: PdfQuote, markup: Markup): Promise<Buffer> {
  const html = buildHtml(q, markup);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pdfBuf = await page.pdf({ format: 'A4', printBackground: true });
    return pdfBuf;
  } finally {
    await browser.close();
  }
}
