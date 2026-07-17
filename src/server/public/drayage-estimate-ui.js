(function installDrayageEstimateUi() {
  'use strict';
  const HIST_CODE = 'HIST_ESTIMATE';

  function esc(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function money(value, currency) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '—';
    return `${esc(currency || 'USD')} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function installStyles() {
    if (document.getElementById('dr-estimate-styles')) return;
    const style = document.createElement('style');
    style.id = 'dr-estimate-styles';
    style.textContent = `
      .dr-estimate-panel{margin:14px 0;padding:14px;border:1px solid rgba(245,158,11,.45);border-radius:12px;background:rgba(245,158,11,.07)}
      .dr-estimate-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .dr-estimate-badge{display:inline-flex;padding:4px 9px;border-radius:999px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
      .dr-estimate-badge.high{background:rgba(34,197,94,.16);color:#22c55e}.dr-estimate-badge.medium{background:rgba(245,158,11,.18);color:#f59e0b}.dr-estimate-badge.low{background:rgba(239,68,68,.16);color:#ef4444}
      .dr-estimate-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
      .dr-estimate-metric{padding:10px;border-radius:9px;background:rgba(255,255,255,.035)}.dr-estimate-metric span{display:block;font-size:11px;color:var(--muted,#94a3b8);margin-bottom:3px}.dr-estimate-metric strong{font-size:16px}
      .dr-estimate-warning{margin-top:12px;padding:9px 11px;border-radius:8px;background:rgba(239,68,68,.08);color:#fca5a5;font-size:12px}.dr-estimate-notes{margin-top:9px;font-size:12px;line-height:1.5;color:var(--muted,#94a3b8)}
    `;
    document.head.appendChild(style);
  }

  function parseStoredEstimate(rate) {
    const notes = String(rate.notes || '');
    const confidence = (notes.match(/\b(HIGH|MEDIUM|LOW) confidence/i)?.[1] || 'low').toLowerCase();
    const range = notes.match(/Interquartile range:\s*([A-Z]{3})\s*([\d,.]+)[–-]([\d,.]+)/i);
    const sourceMatch = rate.charges?.[0]?.basis?.match(/Median of\s+(\d+)/i);
    const countMatch = notes.match(/Normalized to\s+(\d+) container/i);
    const exactMatch = notes.match(/(\d+) exact lane match/i);
    const weightMatch = notes.match(/(\d+) weight-compatible match/i);
    const newest = notes.match(/Newest supporting rate:\s*(\d{4}-\d{2}-\d{2})/i);
    return {
      providerCode: rate.providerCode,
      providerName: rate.providerName,
      currency: rate.currency,
      baseRate: Number(rate.baseRate ?? rate.baseRateCents / 100),
      totalCost: Number(rate.totalCost ?? rate.totalCostCents / 100),
      transitDays: rate.transitDays,
      freeTimeDays: rate.freeTimeDays,
      confidence,
      sourceCount: Number(sourceMatch?.[1] || 0),
      requestedContainerCount: Number(countMatch?.[1] || 1),
      exactLaneCount: Number(exactMatch?.[1] || 0),
      weightMatchedCount: Number(weightMatch?.[1] || 0),
      newestSourceDate: newest?.[1] || null,
      estimateLow: range ? Number(range[2].replaceAll(',', '')) : null,
      estimateHigh: range ? Number(range[3].replaceAll(',', '')) : null,
      notes,
    };
  }

  function host() {
    const pane = document.getElementById('tab-drayage');
    if (!pane) return null;
    return pane.querySelector('[id*="result"][class*="card"]') || pane;
  }

  function renderEstimate(rate) {
    const card = host();
    if (!card) return;
    installStyles();
    let panel = document.getElementById('dr-estimate-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'dr-estimate-panel';
      panel.className = 'dr-estimate-panel';
      card.appendChild(panel);
    }
    const confidence = ['high','medium','low'].includes(rate.confidence) ? rate.confidence : 'low';
    const range = Number.isFinite(Number(rate.estimateLow)) && Number.isFinite(Number(rate.estimateHigh)) ? `${money(rate.estimateLow, rate.currency)} – ${money(rate.estimateHigh, rate.currency)}` : '—';
    panel.innerHTML = `
      <div class="dr-estimate-head"><strong>Historical drayage estimate</strong><span class="dr-estimate-badge ${esc(confidence)}">${esc(confidence)} confidence</span></div>
      <div class="dr-estimate-grid">
        <div class="dr-estimate-metric"><span>Estimated all-in</span><strong>${money(rate.totalCost, rate.currency)}</strong></div>
        <div class="dr-estimate-metric"><span>Historical range</span><strong>${range}</strong></div>
        <div class="dr-estimate-metric"><span>Containers priced</span><strong>${Number(rate.requestedContainerCount) || 1}</strong></div>
        <div class="dr-estimate-metric"><span>Supporting rates</span><strong>${Number(rate.sourceCount) || 0}</strong></div>
        <div class="dr-estimate-metric"><span>Exact lane matches</span><strong>${Number(rate.exactLaneCount) || 0}</strong></div>
        <div class="dr-estimate-metric"><span>Weight-compatible</span><strong>${Number(rate.weightMatchedCount) || 0}</strong></div>
        <div class="dr-estimate-metric"><span>Newest evidence</span><strong>${esc(rate.newestSourceDate || '—')}</strong></div>
        <div class="dr-estimate-metric"><span>Free time</span><strong>${Number.isFinite(Number(rate.freeTimeDays)) ? `${Number(rate.freeTimeDays)} days` : '—'}</strong></div>
      </div>
      <div class="dr-estimate-warning"><strong>Directional estimate only.</strong> Verify chassis, fuel, tolls, overweight, pre-pull, storage, waiting time, permits and availability with a drayage provider before quoting it as firm.</div>
      ${rate.notes ? `<div class="dr-estimate-notes">${esc(rate.notes)}</div>` : ''}`;
  }

  function clearEstimate() { document.getElementById('dr-estimate-panel')?.remove(); }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function drayageAwareFetch(input, init) {
    const response = await originalFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url || '';
      const isQuotePost = url.includes('/api/drayage/quote');
      const isQuoteDetail = /\/api\/drayage\/quotes\/[^/?]+/.test(url);
      if (response.ok && (isQuotePost || isQuoteDetail)) {
        const payload = await response.clone().json();
        setTimeout(() => {
          const raw = isQuotePost
            ? payload.ranked?.find((rate) => rate.providerCode === HIST_CODE || rate.providerName === 'Historical lane estimate')
            : payload.rates?.find((rate) => rate.providerCode === HIST_CODE || rate.providerName === 'Historical lane estimate');
          if (raw) renderEstimate(isQuotePost ? raw : parseStoredEstimate(raw));
          else clearEstimate();
        }, 0);
      }
    } catch (err) { console.warn('[drayage-estimate-ui] render failed:', err); }
    return response;
  };
})();
