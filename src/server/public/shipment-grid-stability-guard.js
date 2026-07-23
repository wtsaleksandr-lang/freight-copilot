(function installShipmentGridStabilityGuard() {
  'use strict';

  if (window.__shipmentGridStabilityGuardInstalled) return;
  window.__shipmentGridStabilityGuardInstalled = true;

  const NativeMutationObserver = window.MutationObserver;
  if (typeof NativeMutationObserver !== 'function') return;

  function isGridInternalMutation(record) {
    const target = record.target;
    if (!(target instanceof Element)) return false;
    const table = target.closest('#ship-table');
    if (!table) return false;

    // Column reordering moves existing TH/TD nodes between positions. The grid
    // enhancement observer used to react to those moves and immediately run the
    // ordering pass again, creating a visible left/right feedback loop.
    if (target instanceof HTMLTableRowElement) {
      const moved = [...record.addedNodes, ...record.removedNodes];
      if (moved.length && moved.every((node) => node instanceof HTMLTableCellElement)) return true;
    }

    // Installing a resize handle is enhancement-owned DOM, not new shipment data.
    if (target instanceof HTMLTableCellElement) {
      const changed = [...record.addedNodes, ...record.removedNodes];
      if (changed.length && changed.every((node) => node instanceof Element && node.classList.contains('shipment-column-resizer'))) return true;
    }

    // Column reordering ALSO moves <col> nodes inside the <colgroup>
    // (moveColumn, shipment-grid-enhancements-ui.js). The original guard only
    // caught the TH/TD row moves above and missed this, so the enhancement
    // observer reacted to its OWN colgroup reorder and re-ran the ordering pass
    // forever — the header-drag "twitch" (hundreds of colgroup/th mutations, no
    // scroll). Treat a colgroup that only moved <col> children as internal.
    if (target instanceof Element && target.tagName === 'COLGROUP') {
      const moved = [...record.addedNodes, ...record.removedNodes];
      if (moved.length && moved.every((node) => node instanceof Element && node.tagName === 'COL')) return true;
    }

    return false;
  }

  window.MutationObserver = class ShipmentAwareMutationObserver extends NativeMutationObserver {
    constructor(callback) {
      let shipmentTableObserved = false;
      super((records, observer) => {
        const meaningful = shipmentTableObserved ? records.filter((record) => !isGridInternalMutation(record)) : records;
        if (meaningful.length) callback(meaningful, observer);
      });
      const nativeObserve = this.observe.bind(this);
      this.observe = (target, options) => {
        shipmentTableObserved = target instanceof Element && target.id === 'ship-table';
        nativeObserve(target, options);
      };
    }
  };
})();
