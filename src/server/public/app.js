// Tab switching
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'bundles') loadBundles();
  });
});

// ---- Bundles tab ----
async function loadBundles() {
  const table = document.getElementById('bundles-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/bundles');
    const data = await r.json();
    if (!data.bundles || data.bundles.length === 0) {
      table.innerHTML =
        '<tbody><tr><td class="empty">No bundles yet. Run a quote from the "New quote" tab.</td></tr></tbody>';
      return;
    }
    const thead = '<thead><tr><th>Ref ID</th><th>Created</th><th>Lane</th><th>Container</th><th>Carriers</th><th>Status</th><th>Client</th></tr></thead>';
    const rows = data.bundles
      .map((b) => {
        const created = new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        const statusCls =
          b.status === 'complete' ? 'success' : b.status === 'partial' ? 'info' : 'error';
        const carriers = Array.isArray(b.carrierCodes) ? b.carrierCodes.join(', ') : '';
        return `<tr class="clickable" data-refid="${b.refId}">
          <td><code>${esc(b.refId)}</code></td>
          <td>${created}</td>
          <td>${esc(b.origin)} → ${esc(b.destination)}</td>
          <td>${esc(b.containerType)}</td>
          <td>${esc(carriers)}</td>
          <td><span class="status-inline ${statusCls}">${esc(b.status)}</span></td>
          <td>${esc(b.clientName || '—')}</td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    table.querySelectorAll('tr.clickable').forEach((row) => {
      row.addEventListener('click', () => loadBundleDetail(row.dataset.refid));
    });
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}

async function loadBundleDetail(refId) {
  const card = document.getElementById('bundle-detail-card');
  const title = document.getElementById('bundle-detail-title');
  const status = document.getElementById('bundle-detail-status');
  const meta = document.getElementById('bundle-detail-meta');
  const table = document.getElementById('bundle-detail-table');
  const emailEl = document.getElementById('bundle-detail-email');
  card.hidden = false;
  meta.textContent = 'Loading…';
  try {
    const r = await fetch(`/api/bundles/${refId}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load');
    const b = data.bundle;
    title.textContent = `${b.refId} — ${b.origin} → ${b.destination}`;
    status.textContent = b.status;
    status.className = 'muted';
    const created = new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    meta.innerHTML =
      `${esc(b.containerType)} · ${b.cargoWeightKg}kg · ${esc(b.commodity || '—')} · ` +
      `markup +${b.markupPct}% +${b.markupFlat} · ${created}<br>` +
      `<code>${esc(b.outputFolder)}</code>`;
    emailEl.value = b.generatedEmail || '(no email generated)';

    const snaps = data.rateSnapshots || [];
    if (snaps.length === 0) {
      table.innerHTML = '<tbody><tr><td class="empty">No rates saved.</td></tr></tbody>';
    } else {
      const thead = '<thead><tr><th>Carrier</th><th>Rank</th><th>Sailing</th><th>Vessel</th><th>Transit</th><th>Det/Dem</th><th>Cost</th></tr></thead>';
      const rows = snaps
        .map((s) => {
          const price = (s.totalCostCents / 100).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          const dnd =
            s.detentionFreetimeDays != null || s.demurrageFreetimeDays != null
              ? `${s.detentionFreetimeDays ?? '?'}d / ${s.demurrageFreetimeDays ?? '?'}d`
              : '—';
          return `<tr>
            <td><strong>${esc(s.carrierName || '—')}</strong></td>
            <td class="rank">#${s.rank ?? '—'}</td>
            <td>${esc(s.sailingDate ?? '—')}</td>
            <td>${esc(s.vesselVoyage ?? '—')}</td>
            <td>${s.transitDays != null ? s.transitDays + 'd' : '—'}</td>
            <td>${esc(dnd)}</td>
            <td class="price">${esc(s.currency || '')} ${price}</td>
          </tr>`;
        })
        .join('');
      table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    }
    card.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    meta.textContent = 'Error: ' + err.message;
    table.innerHTML = '';
    emailEl.value = '';
  }
}

document.getElementById('bundles-refresh-btn').addEventListener('click', loadBundles);

// Populate carrier checkboxes with inline session status
async function loadCarriers() {
  const div = document.getElementById('carrier-checkboxes');
  try {
    const [carriersResp, sessionsResp] = await Promise.all([
      fetch('/api/carriers').then((r) => r.json()),
      fetch('/api/sessions').then((r) => r.json()),
    ]);
    const sessionByCode = Object.fromEntries(
      (sessionsResp.sessions || []).map((s) => [s.carrierCode, s])
    );

    div.innerHTML = carriersResp.carriers
      .map((c) => {
        const s = sessionByCode[c.code];
        let suffix = '';
        if (!c.isActive) {
          suffix = ' <span class="muted small">— onboarding</span>';
        } else if (s) {
          if (s.status === 'fresh')
            suffix = ` <span class="confidence-high">${s.daysLeft}d session</span>`;
          else if (s.status === 'expiring')
            suffix = ` <span class="confidence-medium">${s.daysLeft}d left</span>`;
          else
            suffix = ` <span class="confidence-low">no session</span>`;
        }
        const disabled = c.isActive ? '' : 'disabled';
        const cls = c.isActive ? 'carrier-check' : 'carrier-check disabled';
        return `<label class="${cls}">
          <input type="checkbox" value="${c.code}" ${disabled} ${c.isActive ? 'checked' : ''}>
          ${esc(c.name)} (${c.code})${suffix}
        </label>`;
      })
      .join('');
  } catch (err) {
    div.innerHTML = `<span class="muted">Error loading carriers: ${esc(err.message)}</span>`;
  }
}
loadCarriers();

function getSelectedCarriers() {
  const checkboxes = document.querySelectorAll(
    '#carrier-checkboxes input[type="checkbox"]:checked'
  );
  return Array.from(checkboxes).map((cb) => cb.value);
}

// ---- Markup sliders (synced with number inputs, persisted in localStorage) ----
const MARKUP_PCT_KEY = 'freight.markup.pct';
const MARKUP_FLAT_KEY = 'freight.markup.flat';
const EMAIL_TEMPLATE_KEY = 'freight.email.template';

const pctSlider = document.getElementById('markup-pct-slider');
const pctNum = document.getElementById('markup-pct');
const flatSlider = document.getElementById('markup-flat-slider');
const flatNum = document.getElementById('markup-flat');
const tplArea = document.getElementById('email-template');

(function restoreSettings() {
  const pct = localStorage.getItem(MARKUP_PCT_KEY);
  const flat = localStorage.getItem(MARKUP_FLAT_KEY);
  const tpl = localStorage.getItem(EMAIL_TEMPLATE_KEY);
  if (pct != null) {
    pctNum.value = pct;
    pctSlider.value = Math.min(parseFloat(pct), parseFloat(pctSlider.max));
  }
  if (flat != null) {
    flatNum.value = flat;
    flatSlider.value = Math.min(parseFloat(flat), parseFloat(flatSlider.max));
  }
  if (tpl) tplArea.value = tpl;
})();

function syncSliderToNum(slider, num, key) {
  slider.addEventListener('input', () => {
    num.value = slider.value;
    localStorage.setItem(key, slider.value);
  });
  num.addEventListener('change', () => {
    const v = parseFloat(num.value) || 0;
    slider.value = Math.min(v, parseFloat(slider.max));
    localStorage.setItem(key, num.value);
  });
}
syncSliderToNum(pctSlider, pctNum, MARKUP_PCT_KEY);
syncSliderToNum(flatSlider, flatNum, MARKUP_FLAT_KEY);

tplArea.addEventListener('change', () => {
  localStorage.setItem(EMAIL_TEMPLATE_KEY, tplArea.value);
});

function getMarkup() {
  return {
    pct: parseFloat(pctNum.value) || 0,
    flat: parseFloat(flatNum.value) || 0,
  };
}

function applyMarkup(cost, markup) {
  return Math.round(cost * (1 + markup.pct / 100) + markup.flat);
}

// Intake — paste a client request (text or image), extract, auto-fill the form
let pastedImageDataUrl = null;
let pastedImageMediaType = null;

const intakeTextarea = document.getElementById('intake-text');
const intakePreview = document.getElementById('intake-image-preview');
const intakePreviewImg = document.getElementById('intake-image');

intakeTextarea.addEventListener('paste', (e) => {
  const items = (e.clipboardData || {}).items || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        pastedImageDataUrl = String(reader.result);
        pastedImageMediaType = item.type;
        intakePreviewImg.src = pastedImageDataUrl;
        intakePreview.hidden = false;
        setStatus('intake-status', 'Screenshot ready. Hit "Extract" to parse.', 'info');
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});

document.getElementById('intake-clear-image').addEventListener('click', () => {
  pastedImageDataUrl = null;
  pastedImageMediaType = null;
  intakePreview.hidden = true;
  intakePreviewImg.src = '';
  setStatus('intake-status', '', '');
});

document.getElementById('intake-btn').addEventListener('click', async () => {
  const text = intakeTextarea.value.trim();
  if (!text && !pastedImageDataUrl) {
    setStatus('intake-status', 'Paste text or a screenshot first.', 'error');
    return;
  }
  const body = {};
  if (pastedImageDataUrl) {
    // Strip the "data:image/png;base64," prefix
    const base64 = pastedImageDataUrl.substring(pastedImageDataUrl.indexOf(',') + 1);
    body.imageBase64 = base64;
    body.imageMediaType = pastedImageMediaType || 'image/png';
  } else {
    body.text = text;
  }

  const btn = document.getElementById('intake-btn');
  btn.disabled = true;
  setStatus('intake-status', 'Extracting…', 'info');

  try {
    const r = await fetch('/api/intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Intake failed');

    if (data.from) document.getElementById('from').value = data.from;
    if (data.fromRegion) document.getElementById('from-region').value = data.fromRegion;
    if (data.to) document.getElementById('to').value = data.to;
    if (data.toRegion) document.getElementById('to-region').value = data.toRegion;
    if (data.container) document.getElementById('container').value = data.container;
    if (data.weight) document.getElementById('weight').value = data.weight;
    if (data.commodity) document.getElementById('commodity').value = data.commodity;

    const confClass = `confidence-${data.confidence}`;
    const notesHtml = data.notes
      ? ` <span class="muted">· Notes: ${esc(data.notes)}</span>`
      : '';
    const statusEl = document.getElementById('intake-status');
    statusEl.className = 'status-inline';
    statusEl.innerHTML =
      `Extracted — <span class="${confClass}">${data.confidence} confidence</span>. Review the form below.${notesHtml}`;
  } catch (err) {
    setStatus('intake-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('reply-copy-btn').addEventListener('click', async () => {
  const ta = document.getElementById('reply-text');
  try {
    await navigator.clipboard.writeText(ta.value);
    setStatus('reply-status', 'Copied to clipboard.', 'success');
  } catch (e) {
    ta.select();
    setStatus('reply-status', 'Copy failed — selected the text for manual copy.', 'info');
  }
});

// Run full quote bundle (one-click multi-carrier)
document.getElementById('run-btn').addEventListener('click', async () => {
  const carriers = getSelectedCarriers();
  if (carriers.length === 0) {
    setStatus('run-status', 'Pick at least one carrier (checkbox above).', 'error');
    return;
  }
  const markup = getMarkup();
  const body = {
    carriers,
    from: document.getElementById('from').value.trim(),
    fromRegion: document.getElementById('from-region').value.trim() || undefined,
    to: document.getElementById('to').value.trim(),
    toRegion: document.getElementById('to-region').value.trim() || undefined,
    container: document.getElementById('container').value.trim(),
    weight: parseInt(document.getElementById('weight').value, 10),
    commodity: document.getElementById('commodity').value.trim() || undefined,
    clientName: document.getElementById('client-name').value.trim() || undefined,
    markupPct: markup.pct,
    markupFlat: markup.flat,
    emailTemplate: tplArea.value.trim() || undefined,
    intakeText: document.getElementById('intake-text').value.trim() || undefined,
  };
  if (!body.from || !body.to || !body.container || !body.weight) {
    setStatus('run-status', 'Fill at least From, To, Container, Weight.', 'error');
    return;
  }

  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  setStatus(
    'run-status',
    `Running ${carriers.length} carrier(s) — Chrome will open per carrier. This takes ~${carriers.length * 60}s…`,
    'info'
  );

  try {
    const r = await fetch('/api/bundle/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Bundle failed');
    const okCount = data.carriers.filter((c) => c.status === 'ok').length;
    setStatus(
      'run-status',
      `${data.refId} — ${okCount}/${data.carriers.length} carriers returned rates. Saved to ${data.outputFolder}.`,
      data.status === 'failed' ? 'error' : 'success'
    );
    renderBundleResults(body, data);
  } catch (err) {
    setStatus('run-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function renderBundleResults(input, data) {
  const card = document.getElementById('results-card');
  const title = document.getElementById('results-title');
  const meta = document.getElementById('results-meta');
  const table = document.getElementById('results-table');
  card.hidden = false;
  const markup = getMarkup();

  title.textContent = `${data.refId}: ${input.from} → ${input.to} (${input.container})`;
  const carrierStatuses = data.carriers
    .map((c) => `${esc(c.carrierName)} (${c.status})`)
    .join(' · ');
  meta.innerHTML =
    `<code>${esc(data.outputFolder)}</code><br>${esc(carrierStatuses)}` +
    (markup.pct || markup.flat ? ` · Markup +${markup.pct}% +${markup.flat}` : '');

  // Combine all ranked rates across carriers, re-sort by freight_total
  const all = [];
  for (const c of data.carriers) {
    if (c.status !== 'ok') continue;
    for (const r of c.ranked) {
      all.push({ ...r, carrierName: c.carrierName, carrierCode: c.carrierCode });
    }
  }
  all.sort((a, b) => a.freight_total - b.freight_total);

  if (all.length === 0) {
    table.innerHTML =
      '<tbody><tr><td class="empty">No rates returned. Check carrier sessions or try again.</td></tr></tbody>';
  } else {
    const showMarkup = markup.pct !== 0 || markup.flat !== 0;
    const thead = `<thead><tr>
      <th>Rank</th>
      <th>Carrier</th>
      <th>Sailing</th>
      <th>Transit</th>
      <th>Det/Dem free</th>
      <th>Vessel/voyage</th>
      <th>Service</th>
      ${showMarkup ? '<th>Your price</th>' : '<th>Cost</th>'}
      <th>Flags</th>
    </tr></thead>`;
    const lowest = all[0].freight_total;
    const rows = all
      .map((r, idx) => {
        const flags = [];
        if (r.rollable) flags.push('<span class="flag rollable">Rollable</span>');
        if (idx > 0) {
          const pct = ((r.freight_total - lowest) / lowest) * 100;
          if (pct <= 3) flags.push('<span class="flag close">≈ lowest</span>');
        }
        const transit = r.transit_days != null ? `${r.transit_days}d` : '—';
        const dnd =
          r.detention_freetime_days != null || r.demurrage_freetime_days != null
            ? `${r.detention_freetime_days ?? '?'}d / ${r.demurrage_freetime_days ?? '?'}d`
            : '—';
        const cost = r.freight_total;
        const currency = r.freight_currency ?? '';
        const displayPrice = showMarkup ? applyMarkup(cost, markup) : cost;
        const priceStr = `${currency} ${displayPrice.toLocaleString()}`;
        return `<tr>
          <td class="rank">#${idx + 1}</td>
          <td><strong>${esc(r.carrierName)}</strong></td>
          <td>${esc(r.sailing_date ?? '—')}</td>
          <td>${transit}</td>
          <td>${esc(dnd)}</td>
          <td>${esc(r.vessel_voyage ?? '—')}</td>
          <td>${esc(r.service_name)}</td>
          <td class="price ${showMarkup ? 'your-price' : ''}">${esc(priceStr)}</td>
          <td>${flags.join('') || '—'}</td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
  }

  // Email
  const emailTextarea = document.getElementById('reply-text');
  if (data.generatedEmail) {
    emailTextarea.value = data.generatedEmail;
    emailTextarea.hidden = false;
    document.getElementById('reply-copy-btn').hidden = false;
  } else {
    emailTextarea.value = '';
    emailTextarea.hidden = true;
  }
}

function renderResults(input, data) {
  const card = document.getElementById('results-card');
  const title = document.getElementById('results-title');
  const meta = document.getElementById('results-meta');
  const table = document.getElementById('results-table');
  card.hidden = false;

  const markup = getMarkup();
  const markupLabel =
    markup.pct || markup.flat
      ? `Markup: +${markup.pct}% / +${markup.flat.toLocaleString()} USD`
      : 'Markup: none';

  title.textContent = `Quote #${data.quoteId}: ${input.from} → ${input.to} (${input.container})`;
  meta.innerHTML = `${data.ranked.length} rates · ${esc(markupLabel)} · <a href="file:///${data.artifacts.screenshot.replace(/\\/g, '/')}" target="_blank" rel="noopener">screenshot</a>`;

  const showMarkup = markup.pct !== 0 || markup.flat !== 0;

  const thead = `<thead>
    <tr>
      <th>Rank</th>
      <th>Sailing</th>
      <th>Transit</th>
      <th>Det/Dem free</th>
      <th>Vessel / voyage</th>
      <th>Service</th>
      <th>Freight (our cost)</th>
      ${showMarkup ? '<th>Your price</th>' : ''}
      <th>Δ vs #1</th>
      <th>Flags</th>
      <th></th>
    </tr>
  </thead>`;

  const colCount = 10 + (showMarkup ? 1 : 0);
  if (data.ranked.length === 0) {
    table.innerHTML =
      thead +
      `<tbody><tr><td colspan="${colCount}" class="empty">No rates with prices were parsed.</td></tr></tbody>`;
    return;
  }

  const rows = data.ranked
    .map((r, idx) => {
      const flags = [];
      if (r.rollable) flags.push('<span class="flag rollable">Rollable</span>');
      if (r.close_to_lowest) flags.push('<span class="flag close">≈ lowest</span>');
      if (r.headline_mismatch) flags.push('<span class="flag mismatch">! mismatch</span>');
      const delta =
        r.rank === 1
          ? '—'
          : `+${Math.round(r.delta_from_lowest)} (+${r.delta_pct.toFixed(1)}%)`;
      const transit = r.transit_days != null ? `${r.transit_days}d` : '—';
      const dnd =
        r.detention_freetime_days != null || r.demurrage_freetime_days != null
          ? `${r.detention_freetime_days ?? '?'}d / ${r.demurrage_freetime_days ?? '?'}d`
          : '—';
      const cost = r.freight_total ?? r.headline_price_amount ?? 0;
      const currency = r.freight_currency ?? r.headline_price_currency ?? '';
      const costStr = `${currency} ${cost.toLocaleString()}`;
      const yourPrice = showMarkup ? applyMarkup(cost, markup) : null;
      const yourPriceStr = yourPrice != null ? `${currency} ${yourPrice.toLocaleString()}` : '';
      const hasBreakdown =
        (r.freight_charges?.length ?? 0) > 0 ||
        (r.destination_charges?.length ?? 0) > 0;
      const expandBtn = hasBreakdown
        ? `<button class="link-btn" data-expand="${idx}">+ breakdown</button>`
        : '';

      const breakdownRow = hasBreakdown
        ? `<tr class="breakdown-row" id="bd-${idx}" hidden>
             <td colspan="${colCount}">${renderBreakdown(r)}</td>
           </tr>`
        : '';

      return `<tr>
        <td class="rank">#${r.rank}</td>
        <td>${esc(r.sailing_date ?? '—')}</td>
        <td>${transit}</td>
        <td>${esc(dnd)}</td>
        <td>${esc(r.vessel_voyage ?? '—')}</td>
        <td>${esc(r.service_name)}</td>
        <td class="price">${esc(costStr)}</td>
        ${showMarkup ? `<td class="price your-price">${esc(yourPriceStr)}</td>` : ''}
        <td>${delta}</td>
        <td>${flags.join('') || '—'}</td>
        <td>${expandBtn}</td>
      </tr>${breakdownRow}`;
    })
    .join('');
  table.innerHTML = thead + '<tbody>' + rows + '</tbody>';

  // Wire expand buttons
  table.querySelectorAll('button[data-expand]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = 'bd-' + btn.dataset.expand;
      const row = document.getElementById(id);
      row.hidden = !row.hidden;
      btn.textContent = row.hidden ? '+ breakdown' : '− breakdown';
    });
  });
}

function renderBreakdown(r) {
  const lines = [];
  if (r.freight_charges?.length) {
    lines.push('<div class="bd-title">Freight charges (your cost)</div>');
    lines.push('<table class="bd-mini">');
    for (const c of r.freight_charges) {
      lines.push(
        `<tr><td>${esc(c.name)}</td><td class="price">${esc(c.currency)} ${c.total.toFixed(2)}</td></tr>`
      );
    }
    lines.push(
      `<tr class="bd-total"><td>Total</td><td class="price">${esc(r.freight_currency ?? '')} ${r.freight_total.toLocaleString()}</td></tr>`
    );
    lines.push('</table>');
  }
  if (r.destination_charges?.length) {
    lines.push('<div class="bd-title">Destination charges (paid by receiver, on collect)</div>');
    lines.push('<table class="bd-mini">');
    for (const c of r.destination_charges) {
      lines.push(
        `<tr><td>${esc(c.name)}</td><td class="price">${esc(c.currency)} ${c.total.toFixed(2)}</td></tr>`
      );
    }
    if (r.destination_currency) {
      lines.push(
        `<tr class="bd-total"><td>Total</td><td class="price">${esc(r.destination_currency)} ${r.destination_total.toLocaleString()}</td></tr>`
      );
    }
    lines.push('</table>');
  }
  return lines.join('');
}

async function loadHistory() {
  const table = document.getElementById('history-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/quotes');
    const data = await r.json();
    const thead = '<thead><tr><th>ID</th><th>Created</th><th>Lane</th><th>Container</th></tr></thead>';
    if (data.quotes.length === 0) {
      table.innerHTML = thead + '<tbody><tr><td colspan="4" class="empty">No quotes yet. Run one from the "New quote" tab.</td></tr></tbody>';
      return;
    }
    const rows = data.quotes
      .map((q) => {
        const created = new Date(q.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        return `<tr class="clickable" data-id="${q.id}">
          <td class="rank">#${q.id}</td>
          <td>${created}</td>
          <td>${esc(q.origin)} → ${esc(q.destination)}</td>
          <td>${esc(q.containerType)}</td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    table.querySelectorAll('tr.clickable').forEach((row) => {
      row.addEventListener('click', () => loadQuote(row.dataset.id));
    });
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}

async function loadQuote(id) {
  const card = document.getElementById('quote-detail-card');
  const title = document.getElementById('quote-detail-title');
  const meta = document.getElementById('quote-detail-meta');
  const table = document.getElementById('quote-detail-table');
  card.hidden = false;
  meta.textContent = 'Loading…';
  try {
    const r = await fetch(`/api/quotes/${id}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load');

    const q = data.quote;
    title.textContent = `Quote #${q.id}: ${q.origin} → ${q.destination}`;
    const created = new Date(q.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    meta.textContent = `${q.containerType} · requested ${q.requestedDate} · created ${created}`;

    const markup = getMarkup();
    const detailPdfBtn = document.getElementById('quote-detail-pdf-btn');
    detailPdfBtn.href = `/api/quotes/${q.id}/pdf?pct=${markup.pct}&flat=${markup.flat}`;
    detailPdfBtn.setAttribute('download', `quote-${q.id}.pdf`);
    detailPdfBtn.hidden = false;

    const thead = '<thead><tr><th>Rank</th><th>Sailing</th><th>Service</th><th>Transit</th><th>Price</th></tr></thead>';
    const snaps = data.rateSnapshots;
    if (snaps.length === 0) {
      table.innerHTML = thead + '<tbody><tr><td colspan="5" class="empty">No rates saved.</td></tr></tbody>';
    } else {
      const rows = snaps
        .map((s) => {
          const price = `${s.currency} ${(s.totalCostCents / 100).toFixed(2)}`;
          const transit = s.transitDays != null ? `${s.transitDays}d` : '—';
          return `<tr>
            <td class="rank">#${s.rank ?? '—'}</td>
            <td>${esc(s.sailingDate ?? '—')}</td>
            <td>${esc(s.serviceName)}</td>
            <td>${transit}</td>
            <td class="price">${esc(price)}</td>
          </tr>`;
        })
        .join('');
      table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    }
    window.scrollTo({ top: card.offsetTop - 20, behavior: 'smooth' });
  } catch (err) {
    meta.textContent = 'Error: ' + err.message;
    table.innerHTML = '';
  }
}

// ---- Agent tab ----
document.getElementById('agent-run-btn').addEventListener('click', async () => {
  const url = document.getElementById('agent-url').value.trim();
  const goal = document.getElementById('agent-goal').value.trim();
  const maxIter = parseInt(document.getElementById('agent-max-iter').value, 10) || 25;
  if (!url || !goal) {
    setStatus('agent-status', 'Fill both URL and goal.', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('agent-status', 'URL must start with http:// or https://', 'error');
    return;
  }

  const btn = document.getElementById('agent-run-btn');
  btn.disabled = true;
  setStatus('agent-status', 'Running agent — a Chrome window will open. This can take a minute…', 'info');

  const card = document.getElementById('agent-transcript-card');
  const list = document.getElementById('agent-transcript');
  card.hidden = false;
  list.innerHTML = '<li class="muted">Running…</li>';

  try {
    const r = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, goal, maxIterations: maxIter }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Agent failed');

    renderAgentResult(data);
    setStatus(
      'agent-status',
      data.finished ? 'Task complete.' : `Stopped: ${data.finishReason}`,
      data.finished ? 'success' : 'info'
    );
  } catch (err) {
    setStatus('agent-status', err.message, 'error');
    list.innerHTML = `<li class="result err">Error: ${esc(err.message)}</li>`;
  } finally {
    btn.disabled = false;
  }
});

function renderAgentResult(data) {
  const list = document.getElementById('agent-transcript');
  const title = document.getElementById('agent-transcript-title');
  const meta = document.getElementById('agent-transcript-meta');
  title.textContent = data.finished ? 'Transcript — finished' : 'Transcript — stopped';
  meta.textContent = `${data.steps.length} step(s) · start ${data.startUrl} · final ${data.finalUrl}`;

  list.innerHTML = data.steps
    .map((s) => {
      let resultClass = 'result';
      if (s.result.startsWith('BLOCKED')) resultClass += ' blocked';
      else if (!s.ok) resultClass += ' err';
      const argsStr = Object.entries(s.args)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      return `<li>
        <span class="action">${esc(s.action)}</span>
        <span class="muted">${esc(argsStr)}</span>
        <br>
        <span class="${resultClass}">→ ${esc(s.result)}</span>
      </li>`;
    })
    .join('');
}

// ---- Record tab ----
let activeRecordingId = null;
let recordingPollHandle = null;

async function loadRecCarrierDropdown() {
  const sel = document.getElementById('rec-carrier');
  try {
    const r = await fetch('/api/carriers');
    const data = await r.json();
    sel.innerHTML =
      '<option value="">(none — save under _recordings)</option>' +
      data.carriers
        .map((c) => `<option value="${c.code}">${esc(c.name)} (${c.code})</option>`)
        .join('');
  } catch {
    sel.innerHTML = '<option value="">(error loading carriers)</option>';
  }
}
loadRecCarrierDropdown();

document.getElementById('rec-start-btn').addEventListener('click', async () => {
  const url = document.getElementById('rec-url').value.trim();
  const carrier = document.getElementById('rec-carrier').value || undefined;
  const description = document.getElementById('rec-description').value.trim() || undefined;

  if (!url) {
    setStatus('rec-status', 'Paste a URL first.', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('rec-status', 'URL must start with http:// or https://', 'error');
    return;
  }

  setStatus('rec-status', 'Launching recorder…', 'info');
  document.getElementById('rec-start-btn').disabled = true;
  document.getElementById('rec-analysis-card').hidden = true;

  try {
    const r = await fetch('/api/record/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, carrierCode: carrier, description }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not start recording');

    activeRecordingId = data.id;
    document.getElementById('rec-active-card').hidden = false;
    document.getElementById('rec-active-meta').innerHTML =
      `Recording <code>${esc(data.id.slice(0, 8))}</code> · started ${new Date(data.startedAt).toLocaleTimeString()} · saving to <code>${esc(data.outFile)}</code>`;
    document.getElementById('rec-stop-btn').hidden = false;
    setStatus('rec-status', 'Recording started — do your workflow in the browser window.', 'info');

    pollRecording();
  } catch (err) {
    setStatus('rec-status', err.message, 'error');
    document.getElementById('rec-start-btn').disabled = false;
  }
});

document.getElementById('rec-stop-btn').addEventListener('click', async () => {
  if (!activeRecordingId) return;
  if (!confirm('Cancel the recording? Any captured actions will be discarded.')) return;
  await fetch(`/api/record/stop/${activeRecordingId}`, { method: 'POST' });
  finishRecordingUi('Cancelled.');
});

document.getElementById('rec-refresh-btn').addEventListener('click', loadRecList);

async function pollRecording() {
  if (!activeRecordingId) return;
  if (recordingPollHandle) clearInterval(recordingPollHandle);
  recordingPollHandle = setInterval(async () => {
    if (!activeRecordingId) {
      clearInterval(recordingPollHandle);
      return;
    }
    try {
      const r = await fetch(`/api/record/status/${activeRecordingId}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'status check failed');
      if (data.status === 'running') return; // still recording

      // Recording finished — analyze.
      clearInterval(recordingPollHandle);
      const id = activeRecordingId;
      setStatus('rec-status', 'Browser closed. Sending to Claude for analysis…', 'info');
      try {
        const ar = await fetch(`/api/record/analyze/${id}`, { method: 'POST' });
        const adata = await ar.json();
        if (!ar.ok) throw new Error(adata.error || 'analysis failed');
        finishRecordingUi('Analysis complete.');
        renderAnalysis(adata.meta, adata.analysis);
        loadRecList();
      } catch (err) {
        finishRecordingUi('Analyze failed: ' + err.message);
        setStatus('rec-status', err.message, 'error');
      }
    } catch (err) {
      clearInterval(recordingPollHandle);
      setStatus('rec-status', err.message, 'error');
    }
  }, 2000);
}

function finishRecordingUi(msg) {
  activeRecordingId = null;
  if (recordingPollHandle) {
    clearInterval(recordingPollHandle);
    recordingPollHandle = null;
  }
  document.getElementById('rec-active-card').hidden = true;
  document.getElementById('rec-stop-btn').hidden = true;
  document.getElementById('rec-start-btn').disabled = false;
  if (msg) setStatus('rec-status', msg, 'success');
}

function renderAnalysis(meta, a) {
  const card = document.getElementById('rec-analysis-card');
  const title = document.getElementById('rec-analysis-title');
  const metaEl = document.getElementById('rec-analysis-meta');
  const body = document.getElementById('rec-analysis-body');
  card.hidden = false;
  title.textContent = a.summary;
  metaEl.innerHTML =
    `<code>${esc(a.starting_url)}</code> · ` +
    (meta.carrierCode ? `carrier <code>${esc(meta.carrierCode)}</code> · ` : '') +
    `<span class="confidence-${a.readiness.status === 'ready_to_replay' ? 'high' : 'medium'}">${esc(a.readiness.status)}</span> — ${esc(a.readiness.reason)}` +
    ` · saved to <code>${esc(a.saved_to)}</code>`;

  let html = '<h3 class="bd-title">Steps</h3><ol class="rec-steps">';
  for (const s of a.steps) {
    html += `<li><div class="rec-step-desc">${esc(s.description)}</div><pre class="rec-step-code">${esc(s.playwright_call)}</pre></li>`;
  }
  html += '</ol>';

  if (a.parameters && a.parameters.length > 0) {
    html += '<h3 class="bd-title">Parameters (inputs you change per run)</h3>';
    html += '<table class="bd-mini" style="min-width:520px">';
    html += '<tr><th align="left">Name</th><th align="left">Description</th><th align="left">Example</th><th>Step</th></tr>';
    for (const p of a.parameters) {
      html += `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.description)}</td><td>${esc(p.example_value)}</td><td>#${p.step_number}</td></tr>`;
    }
    html += '</table>';
  }
  body.innerHTML = html;
  card.scrollIntoView({ behavior: 'smooth' });
}

async function loadRecList() {
  const table = document.getElementById('rec-list-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/record/list');
    const data = await r.json();
    if (!data.recordings || data.recordings.length === 0) {
      table.innerHTML = '<tbody><tr><td class="empty">No recordings yet.</td></tr></tbody>';
      return;
    }
    const thead = '<thead><tr><th>Started</th><th>URL</th><th>Carrier</th><th>Status</th><th>File</th></tr></thead>';
    const rows = data.recordings
      .map((r) => {
        const started = new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' ');
        const statusCls = r.status === 'finished' ? 'success' : r.status === 'failed' ? 'error' : 'info';
        return `<tr>
          <td>${esc(started)}</td>
          <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url.slice(0, 50))}</a></td>
          <td>${esc(r.carrierCode || '—')}</td>
          <td><span class="status-inline ${statusCls}">${esc(r.status)}</span></td>
          <td><code class="muted small">${esc(r.outFile.split(/[\\/]/).slice(-2).join('/'))}</code></td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}
loadRecList();

function setStatus(elId, msg, type) {
  const el = document.getElementById(elId);
  el.className = 'status-inline ' + (type || '');
  el.textContent = msg;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
