// Tab switching
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'history') loadHistory();
  });
});

// Populate carrier dropdown from /api/carriers
async function loadCarriers() {
  const sel = document.getElementById('carrier');
  try {
    const r = await fetch('/api/carriers');
    const data = await r.json();
    sel.innerHTML = data.carriers
      .map(
        (c) =>
          `<option value="${c.code}"${c.isActive ? '' : ' disabled'}>` +
          esc(c.name) +
          ` (${c.code})${c.isActive ? '' : ' — onboarding pending'}</option>`
      )
      .join('');
    // Default to the first active carrier
    const firstActive = data.carriers.find((c) => c.isActive);
    if (firstActive) sel.value = firstActive.code;
  } catch (err) {
    sel.innerHTML = '<option>Error loading carriers</option>';
  }
}
loadCarriers();

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

// Track last successful quote for reply generation
let lastQuote = null;

// Generate client reply from last quote's ranked rates
document.getElementById('reply-btn').addEventListener('click', async () => {
  if (!lastQuote) {
    setStatus('reply-status', 'Run a quote first.', 'error');
    return;
  }
  const btn = document.getElementById('reply-btn');
  const ta = document.getElementById('reply-text');
  const copyBtn = document.getElementById('reply-copy-btn');
  btn.disabled = true;
  setStatus('reply-status', 'Composing…', 'info');
  try {
    const r = await fetch('/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: lastQuote.input.from,
        destination: lastQuote.input.to,
        containerType: lastQuote.input.container,
        ranked: lastQuote.ranked,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Reply generation failed');
    ta.value = data.text;
    ta.hidden = false;
    copyBtn.hidden = false;
    setStatus('reply-status', 'Reply ready. Edit as needed and copy.', 'success');
  } catch (err) {
    setStatus('reply-status', err.message, 'error');
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

// Run quote
document.getElementById('run-btn').addEventListener('click', async () => {
  const body = {
    carrier: document.getElementById('carrier').value,
    from: document.getElementById('from').value.trim(),
    fromRegion: document.getElementById('from-region').value.trim() || undefined,
    to: document.getElementById('to').value.trim(),
    toRegion: document.getElementById('to-region').value.trim() || undefined,
    container: document.getElementById('container').value.trim(),
    weight: parseInt(document.getElementById('weight').value, 10),
    commodity: document.getElementById('commodity').value.trim() || undefined,
  };
  if (!body.from || !body.to || !body.container || !body.weight) {
    setStatus('run-status', 'Fill at least From, To, Container, Weight.', 'error');
    return;
  }

  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  setStatus(
    'run-status',
    'Opening Chrome & driving Maersk — this takes 30–90s…',
    'info'
  );

  try {
    const r = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Quote failed');
    setStatus(
      'run-status',
      `Done. ${data.ranked.length} option(s) parsed. Saved as quote #${data.quoteId}.`,
      'success'
    );
    lastQuote = { input: body, ranked: data.ranked, quoteId: data.quoteId };
    renderResults(body, data);
  } catch (err) {
    setStatus('run-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function renderResults(input, data) {
  const card = document.getElementById('results-card');
  const title = document.getElementById('results-title');
  const meta = document.getElementById('results-meta');
  const table = document.getElementById('results-table');
  card.hidden = false;

  title.textContent = `Quote #${data.quoteId}: ${input.from} → ${input.to} (${input.container})`;
  meta.innerHTML = `${data.ranked.length} rates · <a href="file:///${data.artifacts.screenshot.replace(/\\/g, '/')}" target="_blank" rel="noopener">screenshot</a>`;

  const thead = `<thead>
    <tr>
      <th>Rank</th>
      <th>Sailing</th>
      <th>Transit</th>
      <th>Vessel / voyage</th>
      <th>Service</th>
      <th>Price</th>
      <th>Δ vs #1</th>
      <th>Flags</th>
    </tr>
  </thead>`;

  if (data.ranked.length === 0) {
    table.innerHTML = thead + '<tbody><tr><td colspan="8" class="empty">No rates with prices were parsed.</td></tr></tbody>';
    return;
  }

  const rows = data.ranked
    .map((r) => {
      const flags = [];
      if (r.rollable) flags.push('<span class="flag rollable">Rollable</span>');
      if (r.close_to_lowest) flags.push('<span class="flag close">≈ lowest</span>');
      const delta =
        r.rank === 1
          ? '—'
          : `+${Math.round(r.delta_from_lowest)} (+${r.delta_pct.toFixed(1)}%)`;
      const transit = r.transit_days != null ? `${r.transit_days}d` : '—';
      const price = `${r.headline_price_currency ?? ''} ${(r.headline_price_amount ?? 0).toLocaleString()}`;
      return `<tr>
        <td class="rank">#${r.rank}</td>
        <td>${esc(r.sailing_date ?? '—')}</td>
        <td>${transit}</td>
        <td>${esc(r.vessel_voyage ?? '—')}</td>
        <td>${esc(r.service_name)}</td>
        <td class="price">${esc(price)}</td>
        <td>${delta}</td>
        <td>${flags.join('') || '—'}</td>
      </tr>`;
    })
    .join('');
  table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
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
