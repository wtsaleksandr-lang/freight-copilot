// ---------- LoadMode USD → CAD hover conversion ----------
// Single source of truth for the USD→CAD coefficient used by the
// profit-amount hover tooltips (shipments grid profit cell + the
// clearance summary "Your profit" figure). The profit figures the app
// shows are in USD; hovering reveals the CAD equivalent.
//
// To change the rate later, edit USD_TO_CAD below — nothing else.
//
//   LoadModeCad.USD_TO_CAD        // the coefficient (number)
//   LoadModeCad.format(usd)       // -> "CA$1,731.30" / "-CA$1,731.30" / ""
//   LoadModeCad.hint(usd)         // -> "≈ CA$1,731.30 (× 1.403)" / ""
//
(function installCadConvert() {
  if (window.LoadModeCad) return;

  // Conversion coefficient. CAD = USD × USD_TO_CAD. Change here only.
  const USD_TO_CAD = 1.403;

  // Format a USD amount as its CAD equivalent, e.g. "CA$1,731.30".
  // Mirrors app.js formatMoney: leading minus, CA$ prefix, thousands
  // separators, exactly 2 decimals. Returns '' for non-finite input.
  function format(usdAmount) {
    const usd = Number(usdAmount);
    if (!Number.isFinite(usd)) return '';
    const cad = usd * USD_TO_CAD;
    const withSep = Math.abs(cad).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (cad < 0 ? '-CA$' : 'CA$') + withSep;
  }

  // Full hover label, e.g. "≈ CA$1,731.30 (× 1.403)".
  function hint(usdAmount) {
    const f = format(usdAmount);
    return f ? `≈ ${f} (× ${USD_TO_CAD})` : '';
  }

  window.LoadModeCad = { USD_TO_CAD, format, hint };
})();

// ---------- CAD hover tooltip ----------
// A single, shared floating tooltip for any element carrying data-cad
// (the shipments-grid profit cell + the clearance "Your profit" figure).
// It is appended to <body> and positioned with position:fixed, so it is
// immune to the grid's overflow clipping — the profit <td> lives inside
// `#ship-table td { overflow:hidden }` and a `.table-wrap` that becomes a
// scroll container, which would clip a CSS ::after tooltip. Delegated
// listeners on document mean grid re-renders need no re-wiring, and the
// tooltip never affects layout (position:fixed, pointer-events:none).
(function installCadTooltip() {
  if (window.__cadTipInstalled) return;
  window.__cadTipInstalled = true;

  let tip = null;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'cad-tip-pop';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    return tip;
  }

  function show(el) {
    const text = el.getAttribute('data-cad');
    if (!text) return;
    const t = ensureTip();
    t.textContent = text;
    t.style.display = 'block';
    const r = el.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    // Prefer above the value, right-aligned to it; flip below if no room.
    let top = r.top - tr.height - 8;
    if (top < 4) top = r.bottom + 8;
    let left = r.right - tr.width;
    if (left < 4) left = 4;
    const maxLeft = window.innerWidth - tr.width - 4;
    if (left > maxLeft) left = maxLeft;
    t.style.top = `${Math.round(top)}px`;
    t.style.left = `${Math.round(left)}px`;
  }

  function hide() {
    if (tip) tip.style.display = 'none';
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-cad]') : null;
    if (el) show(el);
  });
  document.addEventListener('mouseout', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-cad]') : null;
    if (el) hide();
  });
  // Any scroll (grid, page) invalidates the fixed position — just hide.
  window.addEventListener('scroll', hide, true);
})();
