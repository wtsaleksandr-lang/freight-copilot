(function installShipmentEmailUi() {
  'use strict';

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function installStyles() {
    if (document.getElementById('shipment-email-styles')) return;
    const style = document.createElement('style');
    style.id = 'shipment-email-styles';
    style.textContent = `
      .ship-email-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .ship-email-grid .full{grid-column:1/-1}
      .ship-email-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
      #ship-email-subject,#ship-email-body{width:100%}
      #ship-email-body{min-height:260px}
      .ship-email-warning{margin-top:8px;color:#f59e0b;font-size:12px}
      @media(max-width:700px){.ship-email-grid{grid-template-columns:1fr}.ship-email-grid .full{grid-column:auto}}
    `;
    document.head.appendChild(style);
  }

  async function generateDraft() {
    const btn = document.getElementById('ship-email-generate');
    const status = document.getElementById('ship-email-status');
    const refId = document.getElementById('ship-email-ref').value.trim();
    const type = document.getElementById('ship-email-type').value;
    const recipientName = document.getElementById('ship-email-recipient').value.trim();
    const extraContext = document.getElementById('ship-email-context').value.trim();

    if (!refId) {
      status.textContent = 'Enter a shipment reference.';
      return;
    }

    btn.disabled = true;
    status.textContent = 'Generating…';
    try {
      const response = await fetch('/api/shipments/email-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refId, type, recipientName, extraContext }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Draft generation failed');
      document.getElementById('ship-email-subject').value = data.subject;
      document.getElementById('ship-email-body').value = data.body;
      const warning = document.getElementById('ship-email-warning');
      if (data.missingFields?.length) {
        warning.textContent = `Review before sending — missing from shipment record: ${data.missingFields.join(', ')}.`;
        warning.hidden = false;
      } else {
        warning.hidden = true;
        warning.textContent = '';
      }
      document.getElementById('ship-email-output').hidden = false;
      status.textContent = 'Draft ready.';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function copyField(id, label) {
    const value = document.getElementById(id).value;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    document.getElementById('ship-email-status').textContent = `${label} copied.`;
  }

  function install() {
    const pane = document.getElementById('tab-shipments');
    if (!pane || document.getElementById('shipment-email-card')) return;
    installStyles();
    const card = document.createElement('div');
    card.id = 'shipment-email-card';
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <h2>Shipment email assistant <span class="muted-inline">— draft routine operational messages</span></h2>
      </div>
      <p class="muted small">Uses the shipment record to prepare an editable email. Internal cost, sell rate, and profit are never included.</p>
      <div class="ship-email-grid">
        <label>Shipment reference
          <input id="ship-email-ref" placeholder="S00001" autocomplete="off" />
        </label>
        <label>Message type
          <select id="ship-email-type">
            <option value="status_update">Customer status update</option>
            <option value="booking_followup">Carrier booking follow-up</option>
            <option value="missing_information">Request missing information</option>
            <option value="delay_notice">Delay / exception notice</option>
          </select>
        </label>
        <label>Recipient name
          <input id="ship-email-recipient" placeholder="Optional — defaults to customer/team" />
        </label>
        <label class="full">Additional facts or instructions
          <textarea id="ship-email-context" rows="3" placeholder="Example: Vessel departure moved from July 18 to July 21. Ask for revised cut-off confirmation."></textarea>
        </label>
      </div>
      <div class="ship-email-actions">
        <button id="ship-email-generate" class="primary" type="button">Generate email draft</button>
        <span id="ship-email-status" class="status-inline"></span>
      </div>
      <div id="ship-email-output" hidden>
        <div id="ship-email-warning" class="ship-email-warning" hidden></div>
        <label class="full">Subject
          <input id="ship-email-subject" />
        </label>
        <label class="full">Email body
          <textarea id="ship-email-body" rows="14"></textarea>
        </label>
        <div class="ship-email-actions">
          <button id="ship-email-copy-subject" class="btn-sm" type="button">Copy subject</button>
          <button id="ship-email-copy-body" class="btn-sm" type="button">Copy body</button>
        </div>
      </div>`;

    const reportCard = document.getElementById('shipment-report-card');
    if (reportCard?.nextSibling) pane.insertBefore(card, reportCard.nextSibling);
    else pane.prepend(card);

    document.getElementById('ship-email-generate').addEventListener('click', generateDraft);
    document.getElementById('ship-email-copy-subject').addEventListener('click', () => copyField('ship-email-subject', 'Subject'));
    document.getElementById('ship-email-copy-body').addEventListener('click', () => copyField('ship-email-body', 'Body'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
