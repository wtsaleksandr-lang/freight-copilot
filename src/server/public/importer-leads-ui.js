/**
 * Importer-Leads workspace (tab-leads).
 *
 * Builds a self-contained admin page — filter form, live credit-cost notice,
 * results table, and per-row expandable AI draft with Copy + mailto — wired to
 * POST /api/importer-leads. The whole app sits behind HTTP Basic auth, so this
 * page is only reachable by the authenticated operator; it spends paid credits.
 *
 * The nav entry (data-simple-tab="leads") is added in usability-shell.js; this
 * script only builds/wires the pane it activates.
 */
(function importerLeadsWorkspace() {
  'use strict';

  const PANE_ID = 'tab-leads';
  const MAX_CAP = 25;

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
  }

  function clampMax(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_CAP);
  }

  // Live spend estimate. ImportYeti bills ~10 records/credit and we pull
  // page_size = max(50, maxLeads*4); Hunter + Anthropic bill ~1 call per lead
  // when the matching toggle is on.
  function creditNotice(max, enrich, draft) {
    const importYeti = Math.ceil(Math.max(50, max * 4) / 10);
    const parts = [`~${importYeti} ImportYeti credit${importYeti === 1 ? '' : 's'}`];
    if (enrich) parts.push(`up to ${max} Hunter lookup${max === 1 ? '' : 's'}`);
    if (draft) parts.push(`up to ${max} AI draft${max === 1 ? '' : 's'}`);
    return `Pulls up to <strong>${max}</strong> importer lead${max === 1 ? '' : 's'} — costs ${parts.join(' + ')}. Credits are spent only when you click Find leads.`;
  }

  function confidencePill(confidence) {
    if (confidence == null || confidence === '') return '';
    const n = Number(confidence);
    const tone = n >= 90 ? 'high' : n >= 70 ? 'mid' : 'low';
    return `<span class="il-conf il-conf-${tone}">${esc(n)}%</span>`;
  }

  function websiteCell(site) {
    if (!site) return '<span class="muted">—</span>';
    const href = /^https?:\/\//i.test(site) ? site : `https://${site}`;
    return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(site)}</a>`;
  }

  function cell(value) {
    return value == null || value === '' ? '<span class="muted">—</span>' : esc(value);
  }

  // Build the CSV client-side from the already-fetched leads so exporting never
  // re-hits the paid APIs.
  const CSV_COLS = [
    'company', 'state', 'supplier', 'supplier_country', 'product', 'hs_code', 'entry_port',
    'ships_12m', 'total_shipments', 'last_shipment', 'phone', 'website', 'incumbent_forwarder',
    'contact_name', 'title', 'email', 'email_confidence',
  ];
  function toCSV(leads) {
    const escCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return [CSV_COLS.join(','), ...leads.map((l) => CSV_COLS.map((c) => escCell(l[c])).join(','))].join('\n');
  }

  const PANE_HTML = `
    <div class="card">
      <h2>Find importer leads</h2>
      <p class="muted small">Real US importers pulled from bill-of-lading data, forwarders and NVOCCs filtered out. Optionally enrich a decision-maker contact and AI-draft a cold email for the exact lane they already ship.</p>
      <div class="grid il-grid">
        <label>Entry port<input id="il-entry-port" placeholder="Los Angeles, Newark, Savannah…" autocomplete="off"></label>
        <label>Product / keywords<input id="il-product" placeholder="LED lighting, granite, auto parts…" autocomplete="off"></label>
        <label>HS code<input id="il-hs" placeholder="e.g. 9405" autocomplete="off"></label>
        <label>Supplier country<input id="il-country" placeholder="China, India, Vietnam…" autocomplete="off"></label>
        <label>Max leads<input id="il-max" type="number" min="1" max="${MAX_CAP}" step="1" value="10" inputmode="numeric"></label>
        <div class="il-toggles full">
          <label class="il-toggle"><input type="checkbox" id="il-enrich"> <span>Enrich contacts <span class="muted small">(Hunter — decision-maker name + email)</span></span></label>
          <label class="il-toggle"><input type="checkbox" id="il-draft"> <span>Draft emails <span class="muted small">(AI cold-email per lead — needs enrichment)</span></span></label>
        </div>
      </div>
      <div id="il-cost-notice" class="il-notice" role="status" aria-live="polite"></div>
      <div class="il-actions">
        <button type="button" class="primary" id="il-run">Find leads</button>
        <button type="button" class="btn-sm" id="il-download" hidden>⬇ Download CSV</button>
        <span id="il-status" class="status-inline" role="status" aria-live="polite"></span>
      </div>
    </div>
    <div id="il-results"></div>`;

  function buildPane() {
    if (document.getElementById(PANE_ID)) return document.getElementById(PANE_ID);
    const main = document.querySelector('main') || document.body;
    const pane = document.createElement('section');
    pane.id = PANE_ID;
    pane.className = 'tab-pane';
    pane.innerHTML = PANE_HTML;
    main.appendChild(pane);
    injectStyles();
    wire(pane);
    return pane;
  }

  function injectStyles() {
    if (document.getElementById('il-styles')) return;
    const style = document.createElement('style');
    style.id = 'il-styles';
    style.textContent = `
      #tab-leads .il-toggles { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
      #tab-leads .il-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      #tab-leads .il-notice { margin: 12px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: #f8fafc; font-size: 13px; color: var(--muted); }
      #tab-leads .il-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
      #tab-leads .il-conf { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; }
      #tab-leads .il-conf-high { background: #dcfce7; color: #166534; }
      #tab-leads .il-conf-mid { background: #fef9c3; color: #854d0e; }
      #tab-leads .il-conf-low { background: #fee2e2; color: #991b1b; }
      #tab-leads .il-draft-row td { background: #f8fafc; }
      #tab-leads .il-draft-wrap { padding: 12px 6px; }
      #tab-leads .il-draft-text { white-space: pre-wrap; font-size: 13px; line-height: 1.5; border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: #fff; max-width: 720px; }
      #tab-leads .il-draft-actions { display: flex; gap: 10px; margin-top: 10px; }
      #tab-leads .il-expand { cursor: pointer; }
      #tab-leads .il-empty { padding: 18px; color: var(--muted); }
      #tab-leads td.il-nowrap { white-space: nowrap; }
    `;
    document.head.appendChild(style);
  }

  function wire(pane) {
    const $ = (sel) => pane.querySelector(sel);
    const notice = $('#il-cost-notice');
    const status = $('#il-status');
    const results = $('#il-results');
    const runBtn = $('#il-run');
    const downloadBtn = $('#il-download');
    const enrichBox = $('#il-enrich');
    const draftBox = $('#il-draft');
    const maxInput = $('#il-max');

    let lastLeads = [];

    function readForm() {
      return {
        entryPort: $('#il-entry-port').value.trim(),
        product: $('#il-product').value.trim(),
        hsCode: $('#il-hs').value.trim(),
        supplierCountry: $('#il-country').value.trim(),
        maxLeads: clampMax(maxInput.value),
        withEnrichment: enrichBox.checked,
        withEmails: draftBox.checked,
      };
    }

    function refreshNotice() {
      const max = clampMax(maxInput.value);
      notice.innerHTML = creditNotice(max, enrichBox.checked, draftBox.checked);
    }

    // Drafting requires an enriched contact — keep the toggles coherent.
    draftBox.addEventListener('change', () => {
      if (draftBox.checked && !enrichBox.checked) enrichBox.checked = true;
      refreshNotice();
    });
    enrichBox.addEventListener('change', () => {
      if (!enrichBox.checked && draftBox.checked) draftBox.checked = false;
      refreshNotice();
    });
    maxInput.addEventListener('input', () => {
      refreshNotice();
    });
    maxInput.addEventListener('change', () => {
      maxInput.value = String(clampMax(maxInput.value));
      refreshNotice();
    });

    function setStatus(message, tone) {
      status.textContent = message || '';
      status.className = 'status-inline' + (tone ? ' ' + tone : '');
    }

    function hasFilter(form) {
      return Boolean(form.entryPort || form.product || form.hsCode || form.supplierCountry);
    }

    async function run() {
      const form = readForm();
      if (!hasFilter(form)) {
        setStatus('Add at least one filter before pulling leads.', 'error');
        return;
      }
      runBtn.disabled = true;
      downloadBtn.hidden = true;
      setStatus('Pulling importer leads… this can take a moment with enrichment/drafting on.', 'info');
      results.innerHTML = '<div class="card"><div class="il-empty">Working…</div></div>';
      try {
        const response = await fetch('/api/importer-leads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(form),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = payload && payload.error ? payload.error : `Request failed (${response.status}).`;
          throw new Error(message);
        }
        lastLeads = Array.isArray(payload.leads) ? payload.leads : [];
        renderResults(lastLeads);
        const credits = payload.creditsRemaining == null ? null : payload.creditsRemaining;
        const creditNote = credits == null ? '' : ` · ${credits} ImportYeti credits remaining`;
        if (!lastLeads.length) {
          setStatus(`No matching importers found.${creditNote}`, 'info');
        } else {
          setStatus(`${lastLeads.length} lead${lastLeads.length === 1 ? '' : 's'} found.${creditNote}`, 'success');
          downloadBtn.hidden = false;
        }
      } catch (err) {
        // Surface, never swallow — the operator needs to know a paid pull failed.
        const message = err instanceof Error ? err.message : String(err);
        results.innerHTML = `<div class="card"><div class="il-empty"><strong>Could not pull leads.</strong><br>${esc(message)}</div></div>`;
        setStatus(message, 'error');
      } finally {
        runBtn.disabled = false;
      }
    }

    function renderResults(leads) {
      if (!leads.length) {
        results.innerHTML = '<div class="card"><div class="il-empty">No importers matched those filters. Try a broader product term or a different entry port.</div></div>';
        return;
      }
      const rows = leads.map((lead, index) => {
        const supplier = [lead.supplier, lead.supplier_country].filter(Boolean).join(' · ');
        const contact = [lead.contact_name, lead.title].filter(Boolean).join(' — ');
        const emailCell = lead.email
          ? `${esc(lead.email)} ${confidencePill(lead.email_confidence)}`
          : '<span class="muted">—</span>';
        const canExpand = Boolean(lead.draft_email);
        const expandBtn = canExpand
          ? `<button type="button" class="btn-sm il-expand" data-index="${index}" aria-expanded="false">✉ Draft</button>`
          : '<span class="muted">—</span>';
        return `
          <tr>
            <td>${cell(lead.company)}</td>
            <td>${cell(lead.state)}</td>
            <td>${supplier ? esc(supplier) : '<span class="muted">—</span>'}</td>
            <td>${cell(lead.product)}</td>
            <td>${cell(lead.entry_port)}</td>
            <td class="il-nowrap">${cell(lead.ships_12m)}</td>
            <td>${cell(lead.incumbent_forwarder)}</td>
            <td class="il-nowrap">${cell(lead.phone)}</td>
            <td>${websiteCell(lead.website)}</td>
            <td>${contact ? esc(contact) : '<span class="muted">—</span>'}</td>
            <td>${emailCell}</td>
            <td>${expandBtn}</td>
          </tr>
          <tr class="il-draft-row" data-draft="${index}" hidden><td colspan="12"></td></tr>`;
      }).join('');

      results.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>${leads.length} lead${leads.length === 1 ? '' : 's'}</h2></div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Company</th><th>State</th><th>Supplier</th><th>Product</th><th>Lane (entry)</th>
                  <th>12-mo shipments</th><th>Incumbent forwarder</th><th>Phone</th><th>Website</th>
                  <th>Contact</th><th>Email</th><th>Outreach</th>
                </tr>
              </thead>
              <tbody id="il-tbody">${rows}</tbody>
            </table>
          </div>
        </div>`;

      results.querySelectorAll('.il-expand').forEach((btn) => {
        btn.addEventListener('click', () => toggleDraft(leads, Number(btn.dataset.index), btn));
      });
    }

    function toggleDraft(leads, index, btn) {
      const draftRow = results.querySelector(`tr.il-draft-row[data-draft="${index}"]`);
      if (!draftRow) return;
      const lead = leads[index];
      const open = !draftRow.hidden;
      if (open) {
        draftRow.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      const cellEl = draftRow.querySelector('td');
      const subject = `Sharper rates on your ${lead.product || 'import'} lane`;
      const mailtoParts = [];
      mailtoParts.push(`subject=${encodeURIComponent(subject)}`);
      mailtoParts.push(`body=${encodeURIComponent(lead.draft_email || '')}`);
      const mailto = `mailto:${encodeURIComponent(lead.email || '')}?${mailtoParts.join('&')}`;
      cellEl.innerHTML = `
        <div class="il-draft-wrap">
          <div class="il-draft-text">${esc(lead.draft_email)}</div>
          <div class="il-draft-actions">
            <button type="button" class="btn-sm il-copy" data-index="${index}">📋 Copy</button>
            <a class="btn-sm" href="${esc(mailto)}">✉ Open in email</a>
          </div>
        </div>`;
      draftRow.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const copyBtn = cellEl.querySelector('.il-copy');
      copyBtn.addEventListener('click', () => copyDraft(lead.draft_email || '', copyBtn));
    }

    async function copyDraft(text, btn) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        const original = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = original; }, 1500);
      } catch (err) {
        // Surface rather than swallow — the operator should know copy failed.
        setStatus('Could not copy to clipboard: ' + (err instanceof Error ? err.message : String(err)), 'error');
      }
    }

    function download() {
      if (!lastLeads.length) return;
      try {
        const blob = new Blob([toCSV(lastLeads)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `importer-leads-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        setStatus('Could not build CSV: ' + (err instanceof Error ? err.message : String(err)), 'error');
      }
    }

    runBtn.addEventListener('click', run);
    downloadBtn.addEventListener('click', download);
    refreshNotice();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPane);
  else buildPane();
})();
