(function installUsabilityShell() {
  'use strict';

  function activateTab(requestedName) {
    let name = requestedName;
    if (name === 'trucking') {
      name = 'drayage';
      document.getElementById('drayage-trucking-section')?.setAttribute('open', '');
    }
    const pane = document.getElementById(`tab-${name}`);
    if (!pane) return false;
    document.querySelectorAll('.tab-pane').forEach((item) => item.classList.remove('active'));
    pane.classList.add('active');
    document.querySelectorAll('[data-simple-tab]').forEach((button) => {
      const active = button.dataset.simpleTab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    document.dispatchEvent(new CustomEvent('workflow-selected', { detail: { tab: requestedName } }));
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
    return true;
  }

  // ── Customs clearance workspace ───────────────────────────────────────────
  // A self-contained inline calculator: movement type drives the template AND
  // which statutory fees apply, duty + government fees are computed from the
  // commercial value and rates, service charges are structured rows, and the
  // whole quote is previewed / exported from the page (no modal). Government
  // pass-throughs (duty, MPF/HMF, GST/HST) are never marked up; only the firm /
  // conditional service charges carry the hidden markup.
  const CLR_STAT = {
    mpfPct: 0.3464, mpfMin: 32.71, mpfMax: 634.62, // US CBP Merchandise Processing Fee (formal entry)
    hmfPct: 0.125, // US Harbor Maintenance Fee (ocean imports)
    gstPct: 5, // Canada federal GST (HST varies by province — override the rate field)
  };
  const CLR_ROUND = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const CLR_USD = (n) => 'USD ' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const CLR_NUM = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  function clearanceDefaultLines(template) {
    if (template === 'export_clearance') {
      return [
        { label: 'Export customs declaration / filing', amount: '', basis: 'per shipment', category: 'firm' },
        { label: 'Document handling', amount: '', basis: 'per shipment', category: 'firm' },
        { label: 'Permit / inspection / examination', amount: '', basis: 'if applicable', category: 'conditional' },
      ];
    }
    if (template === 'import_usa') {
      // Typical US-import broker/filing fees (editable). Duty + MPF + HMF are
      // computed separately in the government-charges table.
      return [
        { label: 'Customs brokerage / entry fee', amount: '115', basis: 'per entry', category: 'firm' },
        { label: 'ISF filing (10+2)', amount: '50', basis: 'per shipment (ocean)', category: 'firm' },
        { label: 'ISF bond (single-entry)', amount: '60', basis: 'if no continuous bond', category: 'conditional' },
        { label: 'Single-entry customs bond', amount: '75', basis: 'if no continuous bond', category: 'conditional' },
        { label: 'Exam / PGA / other', amount: '', basis: 'if applicable', category: 'conditional' },
      ];
    }
    return [
      { label: 'Customs clearance / entry', amount: '', basis: 'per entry', category: 'firm' },
      { label: 'Brokerage & document handling', amount: '', basis: 'per shipment', category: 'firm' },
      { label: 'Bond / permit / examination', amount: '', basis: 'if applicable', category: 'conditional' },
    ];
  }

  // Formulaic government charges. Duty from the entered rate; US adds MPF + HMF,
  // Canada adds GST/HST on (value + duty); export carries none.
  function clearanceStatutory(template, value, dutyPct, gstPct) {
    const items = [];
    const v = CLR_NUM(value);
    if (template === 'export_clearance' || v <= 0) return items;
    const duty = CLR_ROUND(v * CLR_NUM(dutyPct) / 100);
    items.push({ label: 'Import duty', amount: duty, basis: `${CLR_NUM(dutyPct)}% of ${CLR_USD(v)}`, category: 'statutory' });
    if (template === 'import_usa') {
      const mpf = Math.min(Math.max(CLR_ROUND(v * CLR_STAT.mpfPct / 100), CLR_STAT.mpfMin), CLR_STAT.mpfMax);
      items.push({ label: 'Merchandise Processing Fee (MPF)', amount: mpf, basis: `${CLR_STAT.mpfPct}% · ${CLR_USD(CLR_STAT.mpfMin)}–${CLR_USD(CLR_STAT.mpfMax)}`, category: 'statutory' });
      items.push({ label: 'Harbor Maintenance Fee (HMF)', amount: CLR_ROUND(v * CLR_STAT.hmfPct / 100), basis: `${CLR_STAT.hmfPct}% (ocean)`, category: 'statutory' });
    } else if (template === 'import_canada') {
      const g = gstPct === '' || gstPct == null ? CLR_STAT.gstPct : CLR_NUM(gstPct);
      items.push({ label: `GST/HST (${g}%)`, amount: CLR_ROUND((v + duty) * g / 100), basis: 'on value + duty', category: 'statutory' });
    }
    return items;
  }

  function installClearanceWorkspace(main) {
    if (document.getElementById('tab-clearance')) return;
    const pane = document.createElement('section');
    pane.id = 'tab-clearance';
    pane.className = 'tab-pane';
    pane.innerHTML = `
      <div class="card clearance-intro">
        <h2>Customs clearance quote</h2>
        <p class="muted">Build the whole quote here — pick the movement type, enter the shipment, and duty + government fees are calculated automatically. Preview or export the PDF without leaving the page.</p>
        <div class="clearance-move" role="tablist" aria-label="Movement type">
          <button type="button" class="clearance-move-btn active" data-template="import_usa" role="tab" aria-selected="true">USA import</button>
          <button type="button" class="clearance-move-btn" data-template="import_canada" role="tab" aria-selected="false">Canada import</button>
          <button type="button" class="clearance-move-btn" data-template="export_clearance" role="tab" aria-selected="false">Export</button>
        </div>
        <div class="clearance-import-row">
          <button type="button" class="btn-sm" id="clearance-import-btn">📄 Import from screenshot / email</button>
          <input type="file" id="clearance-import-file" accept="image/*,application/pdf,.eml,.txt,.html" hidden>
          <span id="clearance-import-status" class="muted small" role="status" aria-live="polite"></span>
        </div>
      </div>
      <div class="card">
        <h2>Shipment &amp; classification</h2>
        <div class="grid clearance-grid">
          <label>Quote title<input id="clearance-title" placeholder="USA import customs clearance"></label>
          <label>Port / border crossing<input id="clearance-port" placeholder="Newark, Detroit, Toronto Pearson…"></label>
          <label>Commodity<input id="clearance-commodity" placeholder="Machinery, household goods…"></label>
          <label>HS code<input id="clearance-hs" placeholder="Search code or description…" autocomplete="off" list="clearance-hs-list"><datalist id="clearance-hs-list"></datalist></label>
          <label id="clearance-country-wrap">Country of origin<input id="clearance-country" placeholder="e.g. China, United States…" autocomplete="off" list="clearance-country-list"><datalist id="clearance-country-list"></datalist></label>
          <label>Commercial value<input id="clearance-value" placeholder="25000" inputmode="decimal"></label>
          <label>Duty rate %<input id="clearance-duty" placeholder="0" inputmode="decimal"></label>
          <label id="clearance-gst-wrap" hidden>Sales tax %<input id="clearance-gst" placeholder="5" inputmode="decimal"></label>
          <label id="clearance-province-wrap" hidden>Province (delivery)<select id="clearance-province">
            <option value="ON">Ontario — HST 13%</option><option value="QC">Quebec — GST+QST</option>
            <option value="BC">British Columbia — GST+PST</option><option value="AB">Alberta — GST 5%</option>
            <option value="MB">Manitoba — GST+PST</option><option value="SK">Saskatchewan — GST+PST</option>
            <option value="NB">New Brunswick — HST 15%</option><option value="NS">Nova Scotia — HST 15%</option>
            <option value="NL">Newfoundland &amp; Labrador — HST 15%</option><option value="PE">Prince Edward Island — HST 15%</option>
            <option value="NT">Northwest Territories — GST 5%</option><option value="NU">Nunavut — GST 5%</option><option value="YT">Yukon — GST 5%</option>
          </select></label>
          <label id="clearance-confirm-wrap" class="clearance-confirm full" hidden><input type="checkbox" id="clearance-origin-confirmed"> <span>Goods qualify for the trade-agreement (preferential) rate — apply it</span></label>
          <div class="full clearance-hs-status" id="clearance-hs-status" hidden></div>
          <div class="full clearance-adcvd" id="clearance-adcvd" hidden></div>
          <label>Importer / exporter<input id="clearance-party" placeholder="Company name"></label>
          <label>POL / origin<input id="clearance-pol" placeholder="Optional"></label>
          <label>POD / destination<input id="clearance-pod" placeholder="Optional"></label>
          <label>Place of delivery<input id="clearance-delivery" placeholder="Optional"></label>
          <label>Rate validity<input id="clearance-validity" placeholder="e.g. 14 days"></label>
          <label class="full">Customs examination note<input id="clearance-exam" placeholder="Exam risk / hold conditions (optional)"></label>
          <label class="full">Operational notes<textarea id="clearance-notes" rows="3" placeholder="Entry type, bond, PGA/permit, delivery terms, special documents…"></textarea></label>
        </div>
      </div>
      <div class="card clearance-calc">
        <h2>Duty &amp; government charges <span class="muted small">computed from value &amp; rates · pass-through, never marked up</span></h2>
        <table class="clearance-table clearance-stat">
          <thead><tr><th>Charge</th><th class="clearance-amt">Amount</th><th>Basis</th></tr></thead>
          <tbody id="clearance-stat-body"></tbody>
        </table>
        <p class="muted small" id="clearance-stat-empty" hidden>No government charges for this movement type (export declaration only).</p>
      </div>
      <div class="card clearance-services-card">
        <div class="clearance-svc-head">
          <h2>Service charges <span class="muted small">your brokerage / handling — markup applies</span></h2>
          <button type="button" class="btn-sm" id="clearance-add-line">+ Add line</button>
        </div>
        <table class="clearance-table clearance-svc">
          <thead><tr><th>Service</th><th class="clearance-amt">Amount (cost)</th><th>Basis</th><th>Category</th><th aria-label="Remove"></th></tr></thead>
          <tbody id="clearance-svc-body"></tbody>
        </table>
        <div class="clearance-markup">
          <label>Hidden profit / rate (USD)<input id="clearance-markup-flat" type="number" value="0" step="1"></label>
          <label>Hidden markup %<input id="clearance-markup-pct" type="number" value="0" step="0.5"></label>
          <span class="muted small">Internal only — never shown on the client PDF.</span>
        </div>
      </div>
      <div class="card clearance-summary">
        <div class="clearance-sum-grid">
          <div><span class="muted small">Government charges</span><strong id="clearance-sum-stat">USD 0.00</strong></div>
          <div><span class="muted small">Services (sell)</span><strong id="clearance-sum-svc">USD 0.00</strong></div>
          <div class="clearance-sum-profit"><span class="muted small">Your profit (internal)</span><strong id="clearance-sum-profit">USD 0.00</strong></div>
          <div class="clearance-sum-total"><span class="muted small">Client total</span><strong id="clearance-sum-total">USD 0.00</strong></div>
        </div>
        <div class="clearance-actions">
          <button type="button" class="btn-sm" id="clearance-copy">📋 Copy quote (email)</button>
          <button type="button" class="btn-sm" id="clearance-preview">Preview</button>
          <button type="button" class="primary" id="clearance-pdf">Create PDF</button>
          <span id="clearance-status" class="status-inline" role="status" aria-live="polite"></span>
        </div>
      </div>
      <div class="card clearance-disclaimer">
        <strong>Estimate only — not a formal customs quotation.</strong>
        Duties and taxes are calculated from published tariff schedules and may <strong>not</strong> include every applicable charge —
        e.g. Section 301 / Section 232 tariffs, antidumping / countervailing duties, excise, or other government-agency (PGA) fees.
        The final duty, tax and import-clearance cost is determined only at <strong>formal cargo entry and customs evaluation</strong>.
        We are <strong>not a licensed customs broker</strong> and do not guarantee this estimate. A formal, reviewed quotation can be
        provided for an additional fee after a thorough evaluation of your shipping and commercial documentation.
        <a href="https://www.cbp.gov/trade/programs-administration/entry-summary/adcvd" target="_blank" rel="noopener">Read more about import duties &amp; AD/CVD ↗</a>
      </div>`;
    main.appendChild(pane);
    wireClearanceWorkspace(pane);
  }

  function wireClearanceWorkspace(pane) {
    const $ = (sel) => pane.querySelector(sel);
    const statBody = $('#clearance-stat-body');
    const svcBody = $('#clearance-svc-body');
    let template = 'import_usa';

    function currentValue(id) { return ($('#' + id)?.value ?? '').trim(); }

    function sellOf(amount) {
      const pct = CLR_NUM(currentValue('clearance-markup-pct'));
      const flat = CLR_NUM(currentValue('clearance-markup-flat'));
      return CLR_ROUND(Number(amount) * (1 + pct / 100) + flat);
    }

    function readServiceRows() {
      return Array.from(svcBody.querySelectorAll('tr')).map((tr) => ({
        label: tr.querySelector('.clr-svc-label')?.value.trim() || '',
        amount: tr.querySelector('.clr-svc-amount')?.value.trim() || '',
        basis: tr.querySelector('.clr-svc-basis')?.value.trim() || '',
        category: tr.querySelector('.clr-svc-cat')?.value || 'firm',
      })).filter((r) => r.label || r.amount);
    }

    function addServiceRow(line = { label: '', amount: '', basis: '', category: 'firm' }) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input class="clr-svc-label" value="${(line.label || '').replace(/"/g, '&quot;')}" placeholder="Service"></td>
        <td><input class="clr-svc-amount clearance-amt-input" value="${line.amount ?? ''}" placeholder="0.00" inputmode="decimal"></td>
        <td><input class="clr-svc-basis" value="${(line.basis || '').replace(/"/g, '&quot;')}" placeholder="per entry"></td>
        <td><select class="clr-svc-cat">
          <option value="firm"${line.category === 'firm' ? ' selected' : ''}>Firm</option>
          <option value="conditional"${line.category === 'conditional' ? ' selected' : ''}>Conditional</option>
        </select></td>
        <td><button type="button" class="clr-svc-remove" aria-label="Remove line" title="Remove">✕</button></td>`;
      tr.querySelector('.clr-svc-remove').addEventListener('click', () => { tr.remove(); recompute(); });
      tr.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', recompute));
      svcBody.appendChild(tr);
    }

    function seedServiceRows() {
      svcBody.innerHTML = '';
      clearanceDefaultLines(template).forEach(addServiceRow);
    }

    function statItems() {
      return clearanceStatutory(template, currentValue('clearance-value'), currentValue('clearance-duty'), currentValue('clearance-gst'));
    }

    function recompute() {
      const items = statItems();
      statBody.innerHTML = items.map((it) => `<tr><td>${it.label}</td><td class="clearance-amt">${CLR_USD(it.amount)}</td><td class="muted small">${it.basis}</td></tr>`).join('');
      $('#clearance-stat-empty').hidden = items.length > 0;
      const statTotal = items.reduce((s, it) => s + Number(it.amount), 0);

      const svc = readServiceRows();
      const svcCost = svc.reduce((s, r) => s + CLR_NUM(r.amount), 0);
      const svcSell = svc.reduce((s, r) => s + sellOf(CLR_NUM(r.amount)), 0);

      $('#clearance-sum-stat').textContent = CLR_USD(statTotal);
      $('#clearance-sum-svc').textContent = CLR_USD(svcSell);
      $('#clearance-sum-profit').textContent = CLR_USD(svcSell - svcCost);
      $('#clearance-sum-total').textContent = CLR_USD(statTotal + svcSell);
    }

    function setTemplate(next) {
      template = next;
      pane.querySelectorAll('.clearance-move-btn').forEach((b) => {
        const on = b.dataset.template === next;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      });
      // Genuine HS-code duty lookup runs for both imports: Canada via the CBSA
      // engine (+ province sales tax), USA via the USITC HTS engine (Column-1
      // General / USMCA; MPF + HMF are added by the workspace). Export declares
      // only, so no duty lookup.
      const isCa = next === 'import_canada';
      const isImport = next === 'import_usa' || next === 'import_canada';
      $('#clearance-gst-wrap').hidden = !isCa;            // sales tax is Canada-only
      $('#clearance-province-wrap').hidden = !isCa;
      $('#clearance-country-wrap').hidden = !isImport;    // origin drives both engines
      $('#clearance-confirm-wrap').hidden = !isImport;    // rules-of-origin gate for both
      if (!isImport) { const st = $('#clearance-hs-status'); if (st) st.hidden = true; }
      if (next !== 'import_usa') renderAdcvd(null); // AD/CVD flag is US-only for now
      // Duty / value are irrelevant to an export declaration.
      $('#clearance-duty').closest('label').hidden = next === 'export_clearance';
      $('#clearance-value').closest('label').hidden = next === 'export_clearance';
      seedServiceRows();
      recompute();
      if (isImport) lookupDuty();
    }

    function assemblePayload() {
      const notes = [
        currentValue('clearance-commodity') ? `Commodity: ${currentValue('clearance-commodity')}` : '',
        currentValue('clearance-value') && template !== 'export_clearance' ? `Commercial value: ${CLR_USD(CLR_NUM(currentValue('clearance-value')))}` : '',
        currentValue('clearance-party') ? `Importer / exporter: ${currentValue('clearance-party')}` : '',
        currentValue('clearance-notes'),
      ].filter(Boolean);
      const services = [...statItems(), ...readServiceRows()].map((it) => ({
        label: it.label,
        amount: it.amount === '' || it.amount == null ? null : Number(it.amount),
        currency: 'USD',
        basis: it.basis || null,
        note: null,
        category: it.category || 'firm',
      }));
      const dutyPct = CLR_NUM(currentValue('clearance-duty'));
      return {
        template,
        title: currentValue('clearance-title') || null,
        pol: currentValue('clearance-pol') || null,
        pod: currentValue('clearance-pod') || null,
        placeOfDelivery: currentValue('clearance-delivery') || null,
        terminal: currentValue('clearance-port') || null,
        hsCode: currentValue('clearance-hs') || null,
        dutyRate: template !== 'export_clearance' && dutyPct ? `${dutyPct}%` : null,
        customsExamNote: currentValue('clearance-exam') || null,
        validity: currentValue('clearance-validity') || null,
        includeCommercialNotes: true,
        hiddenMarkupFlat: CLR_NUM(currentValue('clearance-markup-flat')),
        hiddenMarkupPct: CLR_NUM(currentValue('clearance-markup-pct')),
        services,
        options: [],
        notes,
      };
    }

    // Build an email-ready plain-text version of the quote (paste into an email).
    function buildQuoteText() {
      const moveLabel = { import_usa: 'USA import', import_canada: 'Canada import', export_clearance: 'Export' }[template] || '';
      const lines = [];
      lines.push(`${currentValue('clearance-title') || 'Customs clearance quote'}${moveLabel ? ' — ' + moveLabel : ''}`);
      const bits = [];
      if (currentValue('clearance-hs')) bits.push('HS ' + currentValue('clearance-hs'));
      if (currentValue('clearance-country')) bits.push('Origin: ' + currentValue('clearance-country'));
      if (currentValue('clearance-value') && template !== 'export_clearance') bits.push('Value: ' + CLR_USD(CLR_NUM(currentValue('clearance-value'))));
      if (bits.length) lines.push(bits.join(' · '));
      lines.push('');
      const stat = statItems();
      if (stat.length) {
        lines.push('Duty & government charges:');
        stat.forEach((it) => lines.push(`  • ${it.label} — ${CLR_USD(it.amount)}`));
      }
      const svc = readServiceRows().filter((r) => r.label);
      if (svc.length) {
        lines.push('Service charges:');
        svc.forEach((r) => {
          if (r.amount === '' || r.amount == null) { lines.push(`  • ${r.label} — (if applicable)`); return; }
          const sell = r.category === 'statutory' ? CLR_NUM(r.amount) : sellOf(CLR_NUM(r.amount));
          lines.push(`  • ${r.label} — ${CLR_USD(sell)}`);
        });
      }
      lines.push('');
      lines.push(`Estimated total: ${$('#clearance-sum-total').textContent}`);
      if (currentValue('clearance-validity')) lines.push(`Validity: ${currentValue('clearance-validity')}`);
      lines.push('');
      lines.push('Estimate only — not a formal customs quotation. Duties/taxes are calculated from published tariff schedules and may not include Section 301/232 tariffs, antidumping/countervailing duties, excise, or other government-agency fees. The final duty, tax and import-clearance cost is determined at formal cargo entry and customs evaluation. We are not a licensed customs broker and do not guarantee this estimate; a formal, reviewed quotation can be provided for an additional fee after a thorough evaluation of your documentation.');
      return lines.join('\n');
    }
    async function copyQuote() {
      const status = $('#clearance-status');
      try {
        await navigator.clipboard.writeText(buildQuoteText());
        if (status) status.textContent = 'Quote copied — paste it into your email.';
      } catch {
        if (status) status.textContent = 'Copy blocked by the browser — use Preview and copy from there.';
      }
    }

    async function errText(res, fallback) {
      try { return (await res.json()).error || fallback; } catch { return fallback; }
    }
    async function preview() {
      const status = $('#clearance-status');
      const w = window.open('', 'clearance-preview');
      if (!w) { status.textContent = 'Pop-up blocked — allow pop-ups and retry.'; return; }
      w.document.write('<p style="font-family:Arial;padding:20px">Creating preview…</p>');
      status.textContent = 'Creating preview…';
      try {
        const r = await fetch('/api/client-quotes/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(assemblePayload()) });
        if (!r.ok) { status.textContent = await errText(r, 'Preview failed'); w.close(); return; }
        const html = await r.text();
        w.document.open(); w.document.write(html); w.document.close();
        status.textContent = 'Preview opened.';
      } catch (e) { status.textContent = 'Preview failed: ' + (e && e.message ? e.message : e); w.close(); }
    }
    async function createPdf() {
      const status = $('#clearance-status');
      status.textContent = 'Creating PDF…';
      try {
        const r = await fetch('/api/client-quotes/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(assemblePayload()) });
        if (!r.ok) { status.textContent = await errText(r, 'PDF failed'); return; }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'customs-clearance-quote.pdf';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = 'PDF created.';
      } catch (e) { status.textContent = 'PDF failed: ' + (e && e.message ? e.message : e); }
    }

    // ── Genuine CBSA HS-code duty lookup (Canada import) ────────────────────
    let hsTimer = null;
    let lookupTimer = null;
    async function loadCountryList() {
      try {
        const r = await fetch('/api/customs/countries');
        if (!r.ok) return;
        const { countries } = await r.json();
        const dl = $('#clearance-country-list');
        if (dl && Array.isArray(countries)) dl.innerHTML = countries.map((c) => `<option value="${String(c).replace(/"/g, '&quot;')}"></option>`).join('');
      } catch { /* offline — datalist just stays empty */ }
    }
    async function hsSuggest() {
      const q = currentValue('clearance-hs');
      if (q.length < 2) return;
      const ep = template === 'import_usa' ? 'us-hs-search' : 'hs-search';
      try {
        const r = await fetch(`/api/customs/${ep}?q=${encodeURIComponent(q)}&limit=12`);
        if (!r.ok) return;
        const { results } = await r.json();
        const dl = $('#clearance-hs-list');
        if (dl && Array.isArray(results)) dl.innerHTML = results.map((it) => `<option value="${it.code}">${String(it.description || '').slice(0, 80).replace(/"/g, '&quot;')}</option>`).join('');
      } catch { /* ignore */ }
    }
    function setHsStatus(html, kind) {
      const el = $('#clearance-hs-status');
      if (!el) return;
      el.className = 'full clearance-hs-status' + (kind ? ' is-' + kind : '');
      el.innerHTML = html;
      el.hidden = !html;
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    function renderAdcvd(adcvd) {
      const el = $('#clearance-adcvd');
      if (!el) return;
      if (!adcvd || !adcvd.matches || !adcvd.matches.length) { el.hidden = true; el.innerHTML = ''; return; }
      // Order-of-origin match first — that's the case most likely to actually apply.
      const products = adcvd.matches.map((m) => esc(m.product)).join('; ');
      const originHit = adcvd.matches.find((m) => m.originMatch);
      const originLine = originHit
        ? `<div>Active orders exist on this product from <strong>${esc(currentValue('clearance-country'))}</strong>.</div>`
        : `<div>Orders exist on this product area (check whether your origin country is covered).</div>`;
      el.innerHTML = `
        <div class="clearance-adcvd-head">⚠ Possible antidumping / countervailing (AD/CVD) exposure</div>
        <div class="clearance-adcvd-body">
          <div>HS falls in an AD/CVD-active area: <strong>${products}</strong>.</div>
          ${originLine}
          <div class="muted small">AD/CVD rates are <strong>per-exporter and case-specific</strong> — this is not a computed rate. Verify the exact case &amp; rate before quoting.</div>
          <a class="clearance-adcvd-link" href="${esc(adcvd.verifyUrl || 'https://access.trade.gov/')}" target="_blank" rel="noopener">Verify at Commerce ACCESS ↗</a>
          ${adcvd.asOf ? `<div class="muted small">Coverage snapshot: ${esc(adcvd.asOf)} — orders change; always confirm current status.</div>` : ''}
        </div>`;
      el.hidden = false;
    }
    async function lookupDuty() {
      if (template === 'import_usa') return lookupDutyUsa();
      if (template !== 'import_canada') return;
      const hs = currentValue('clearance-hs');
      const country = currentValue('clearance-country');
      const value = CLR_NUM(currentValue('clearance-value'));
      if (!hs || !country || value <= 0) return;
      try {
        const r = await fetch('/api/customs/calculate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hsCode: hs, countryOfOrigin: country, valueCAD: value,
            province: currentValue('clearance-province') || 'ON',
            confirmedOrigin: $('#clearance-origin-confirmed')?.checked === true,
          }),
        });
        if (r.status === 404) { setHsStatus('HS code not found in the CBSA tariff — check the number, or enter the duty rate manually.', 'warn'); return; }
        if (!r.ok) { setHsStatus('', ''); return; }
        const d = await r.json();
        const base = value + (d.dutyAmount || 0);
        const taxPct = base > 0 ? Math.round(((d.gstAmount + d.provincialTaxAmount) / base) * 1000) / 10 : 5;
        const warn = (d.warnings || []).length ? ` · <span class="clearance-warn">${d.warnings[0]}</span>` : '';
        if (d.isSimplePercent && d.dutyRatePercent != null) {
          $('#clearance-duty').value = String(d.dutyRatePercent);
          $('#clearance-gst').value = String(taxPct);
          recompute();
          setHsStatus(`Applied <strong>${d.appliedTreatmentName}</strong> — duty <strong>${d.dutyRate}</strong> · ${d.gstLabel}/tax ≈ ${taxPct}%${warn}`, 'ok');
        } else {
          setHsStatus(`CBSA rate for <strong>${d.appliedTreatmentName}</strong> is <strong>${d.dutyRate}</strong> (specific / compound) — enter the duty amount manually.${warn}`, 'warn');
        }
      } catch { setHsStatus('', ''); }
    }
    async function lookupDutyUsa() {
      const hs = currentValue('clearance-hs');
      const country = currentValue('clearance-country');
      const value = CLR_NUM(currentValue('clearance-value'));
      if (!hs || !country || value <= 0) return;
      try {
        const r = await fetch('/api/customs/us-calculate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hsCode: hs, countryOfOrigin: country, valueUSD: value, confirmedOrigin: $('#clearance-origin-confirmed')?.checked === true }),
        });
        if (r.status === 404) { setHsStatus('HS code not found in the US HTS — check the number, or enter the duty rate manually.', 'warn'); renderAdcvd(null); return; }
        if (!r.ok) { setHsStatus('', ''); return; }
        const d = await r.json();
        renderAdcvd(d.adcvd);
        const warn = (d.warnings || []).length ? ` · <span class="clearance-warn">${d.warnings[0]}</span>` : '';
        if (d.isSimplePercent && d.dutyRatePercent != null) {
          $('#clearance-duty').value = String(d.dutyRatePercent);
          recompute();
          setHsStatus(`Applied <strong>${d.appliedTreatmentName}</strong> — duty <strong>${d.dutyRate}</strong> · MPF + HMF added below${warn}`, 'ok');
        } else {
          setHsStatus(`US HTS rate for <strong>${d.appliedTreatmentName}</strong> is <strong>${d.dutyRate}</strong> (specific / compound) — enter the duty amount manually.${warn}`, 'warn');
        }
      } catch { setHsStatus('', ''); }
    }
    function scheduleLookup() { clearTimeout(lookupTimer); lookupTimer = setTimeout(lookupDuty, 350); }

    // ── Import from a screenshot / email (AI extraction) ────────────────────
    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
    }
    function applyExtract(x) {
      if (!x) return;
      if (x.movement_type && x.movement_type !== template) setTemplate(x.movement_type);
      const set = (id, v) => { if (v != null && v !== '') { const el = $('#' + id); if (el) el.value = String(v); } };
      set('clearance-hs', x.hs_code);
      set('clearance-commodity', x.commodity);
      set('clearance-value', x.commercial_value);
      set('clearance-country', x.country_of_origin);
      set('clearance-port', x.port_or_crossing);
      if (x.notes) { const n = $('#clearance-notes'); if (n) n.value = (n.value ? n.value + '\n' : '') + x.notes; }
      recompute();
      lookupDuty();
    }
    async function importFromDocument(file) {
      const status = $('#clearance-import-status');
      if (status) status.textContent = 'Reading the document…';
      try {
        const fileBase64 = await fileToBase64(file);
        const r = await fetch('/api/customs/extract', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileBase64, mediaType: file.type || 'image/png', filename: file.name }),
        });
        const data = await r.json();
        if (!r.ok) { if (status) status.textContent = data.error || 'Could not read the document.'; return; }
        applyExtract(data.extract || {});
        if (status) status.textContent = 'Filled from the document — review & adjust before quoting.';
      } catch (e) { if (status) status.textContent = 'Import failed: ' + (e && e.message ? e.message : e); }
    }

    pane.querySelectorAll('.clearance-move-btn').forEach((b) => b.addEventListener('click', () => setTemplate(b.dataset.template)));
    ['clearance-value', 'clearance-duty', 'clearance-gst', 'clearance-markup-flat', 'clearance-markup-pct'].forEach((id) => $('#' + id).addEventListener('input', recompute));
    $('#clearance-hs').addEventListener('input', () => { clearTimeout(hsTimer); hsTimer = setTimeout(hsSuggest, 200); scheduleLookup(); });
    ['clearance-country', 'clearance-value', 'clearance-province'].forEach((id) => $('#' + id).addEventListener('input', scheduleLookup));
    $('#clearance-origin-confirmed').addEventListener('change', lookupDuty);
    $('#clearance-add-line').addEventListener('click', () => { addServiceRow(); recompute(); });
    $('#clearance-preview').addEventListener('click', preview);
    $('#clearance-pdf').addEventListener('click', createPdf);
    $('#clearance-copy')?.addEventListener('click', copyQuote);
    $('#clearance-import-btn')?.addEventListener('click', () => $('#clearance-import-file')?.click());
    $('#clearance-import-file')?.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importFromDocument(f);
      e.target.value = '';
    });

    loadCountryList();
    setTemplate('import_usa');
  }

  function moveTruckingIntoDrayage() {
    const drayage = document.getElementById('tab-drayage');
    const trucking = document.getElementById('tab-trucking');
    if (!drayage || !trucking || document.getElementById('drayage-trucking-section')) return;

    const details = document.createElement('details');
    details.id = 'drayage-trucking-section';
    details.className = 'advanced-section drayage-trucking-section';
    details.innerHTML = '<summary><strong>Regular trucking rates</strong> <span class="muted small">FTL / LTL — open when needed</span></summary><div class="nested-trucking-workspace"></div>';
    const holder = details.querySelector('.nested-trucking-workspace');
    trucking.classList.remove('tab-pane', 'active');
    trucking.classList.add('nested-trucking-pane');
    holder.appendChild(trucking);
    drayage.appendChild(details);
  }

  function installWorkspaceGuides() {
    const guides = {
      shipments: {
        title: 'Shipments',
        description: 'Your main operational board for active and completed shipments, documents, notes, milestones and follow-ups.',
        tip: 'Start by dropping shipment documents above the spreadsheet, or add a blank row and edit cells directly.',
      },
      new: {
        title: 'Ocean freight',
        description: 'Parse carrier rate sheets, compare ocean options, and prepare client-facing quote replies.',
        tip: 'Uploaded and AI-extracted rates require a quick review of lane, equipment, validity and charge totals.',
      },
      drayage: {
        title: 'Drayage',
        description: 'Store drayage quotations, estimate matching lanes from history, and access occasional FTL/LTL rates.',
        tip: 'Historical estimates are guidance only. Confirm the final rate, equipment and accessorials with the provider.',
      },
      clearance: {
        title: 'Customs clearance',
        description: 'Prepare USA import, Canada import and export-clearance quotations using dedicated templates.',
        tip: 'Customs classification, statutory charges and duties or taxes must be verified before sending a quote.',
      },
    };
    for (const [id, guide] of Object.entries(guides)) {
      const pane = document.getElementById(`tab-${id}`);
      if (!pane || pane.querySelector(':scope > .workspace-guide')) continue;
      const intro = document.createElement('div');
      intro.className = 'workspace-guide';
      intro.innerHTML = `<div><h1>${guide.title}</h1><p>${guide.description}</p></div><div class="workspace-guide-tip"><strong>How to use this page</strong><br>${guide.tip}</div>`;
      pane.prepend(intro);
    }
  }

  function installShell() {
    const header = document.querySelector('header');
    const oldNav = header?.querySelector('nav');
    const main = document.querySelector('main') || document.body;
    if (!header || !oldNav || document.getElementById('simple-nav')) return;

    installClearanceWorkspace(main);
    moveTruckingIntoDrayage();
    installWorkspaceGuides();

    oldNav.classList.add('legacy-nav-hidden');
    header.classList.add('shell-active');

    // Brand-line controls: a colored status indicator + a hamburger menu,
    // pinned to the top-right so the workflow tabs get a clean, scroll-free row.
    const controls = document.createElement('div');
    controls.className = 'header-controls';
    controls.innerHTML = `
      <button type="button" class="status-indicator" data-action="system-check-primary" data-state="checking" aria-label="System status" title="Checking system status…"><span class="readiness-dot" aria-hidden="true"></span></button>
      <div class="simple-more-wrap">
        <button type="button" class="hamburger-btn" data-action="more" aria-expanded="false" aria-haspopup="menu" aria-controls="simple-more-menu" aria-label="Open menu"><span></span><span></span><span></span></button>
        <div id="simple-more-menu" class="simple-more-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-action="import">Import rate files</button>
          <button type="button" role="menuitem" data-action="client-quote">Create client quote</button>
          <button type="button" role="menuitem" data-simple-tab="history">Quote history</button>
          <button type="button" role="menuitem" data-simple-tab="delaypredict">DelayPredict</button>
          <button type="button" role="menuitem" data-simple-tab="intellcluster">IntellCluster</button>
          <button type="button" role="menuitem" data-simple-tab="secrets">⚙ Settings</button>
          <button type="button" role="menuitem" data-action="show-all">Show all tools</button>
          <button type="button" role="menuitem" data-action="system-check">Feature readiness</button>
          <button type="button" role="menuitem" data-action="help">Help</button>
        </div>
      </div>`;
    header.appendChild(controls);

    const nav = document.createElement('nav');
    nav.id = 'simple-nav';
    nav.className = 'simple-nav';
    nav.setAttribute('aria-label', 'Primary');
    nav.innerHTML = `
      <button type="button" class="simple-primary" data-simple-tab="shipments">Shipments</button>
      <button type="button" data-simple-tab="new">Ocean</button>
      <button type="button" data-simple-tab="drayage">Drayage</button>
      <button type="button" data-simple-tab="clearance">Customs</button>`;
    header.appendChild(nav);

    const moreButton = controls.querySelector('[data-action="more"]');
    const moreMenu = controls.querySelector('.simple-more-menu');
    const readinessButton = controls.querySelector('[data-action="system-check-primary"]');
    const menuItems = () => Array.from(moreMenu.querySelectorAll('[role="menuitem"]'));
    const closeMore = (restoreFocus = false) => {
      moreMenu.hidden = true;
      moreButton.setAttribute('aria-expanded', 'false');
      if (restoreFocus) moreButton.focus();
    };
    const openMore = () => {
      moreMenu.hidden = false;
      moreButton.setAttribute('aria-expanded', 'true');
    };

    header.querySelectorAll('[data-simple-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        activateTab(button.dataset.simpleTab);
        closeMore();
      });
    });
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      moreMenu.hidden ? openMore() : closeMore();
    });
    moreButton.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openMore();
        menuItems()[0]?.focus();
      } else if (event.key === 'Escape') {
        closeMore(true);
      }
    });
    moreMenu.addEventListener('keydown', (event) => {
      const items = menuItems();
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMore(true);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(index + 1 + items.length) % items.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items.at(-1)?.focus();
      }
    });
    controls.querySelector('[data-action="import"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('universal-rate-import-open'));
      closeMore();
    });
    controls.querySelector('[data-action="client-quote"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('client-quote-open'));
      closeMore();
    });
    controls.querySelector('[data-action="show-all"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('workflow-show-all'));
      closeMore();
    });
    const openReadiness = () => {
      document.dispatchEvent(new CustomEvent('system-check-open'));
      closeMore();
    };
    controls.querySelector('[data-action="system-check"]').addEventListener('click', openReadiness);
    readinessButton.addEventListener('click', openReadiness);
    controls.querySelector('[data-action="help"]').addEventListener('click', () => {
      document.getElementById('help-btn')?.click();
      closeMore();
    });
    document.addEventListener('click', (event) => {
      if (!controls.querySelector('.simple-more-wrap').contains(event.target)) closeMore();
    });
    document.addEventListener('system-readiness-updated', (event) => {
      const detail = event.detail || {};
      const features = Array.isArray(detail.features) ? detail.features : [];
      const needsSetup = features.some((item) => item.state === 'setup_required' || item.state === 'unavailable');
      const state = detail.status === 'unavailable' ? 'unavailable' : detail.status === 'ready' && !needsSetup ? 'ready' : 'degraded';
      readinessButton.dataset.state = state;
      const statusTitles = {
        ready: 'System ready — core services and configured AI providers are working. Click for details.',
        degraded: 'Attention needed — some features need setup or are degraded. Click for details.',
        unavailable: 'Status unavailable — the readiness check could not be reached. Click for details.',
      };
      readinessButton.title = statusTitles[state] || 'Checking system status…';
    });

    const brand = header.querySelector('.brand');
    brand?.addEventListener('click', (event) => {
      event.preventDefault();
      activateTab('shipments');
      closeMore();
    });

    document.querySelectorAll('details.advanced-section').forEach((details) => { details.open = false; });
    activateTab('shipments');
    fetch('/api/health/ready', { cache: 'no-store' })
      .then((response) => response.json())
      .then((detail) => document.dispatchEvent(new CustomEvent('system-readiness-updated', { detail })))
      .catch(() => document.dispatchEvent(new CustomEvent('system-readiness-updated', { detail: { status: 'unavailable' } })));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installShell);
  else installShell();
})();
