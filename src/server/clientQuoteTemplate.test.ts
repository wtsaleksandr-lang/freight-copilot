import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClientQuoteHtml } from './clientQuoteTemplate.js';

test('groups import charges and uses concise forwarder language', () => {
  const html = buildClientQuoteHtml({
    template: 'import_usa',
    hsCode: '9406',
    dutyRate: '2.9%',
    terminal: 'NEW YORK PORT',
    placeOfDelivery: 'Cape Elizabeth, Maine 04107',
    waitingTime: '1 hour free; USD 100/hour thereafter',
    services: [
      { label: 'Import handling', amount: 70, basis: 'per B/L', category: 'firm' },
      { label: 'HMF', amount: 0, basis: '0.125% of value', category: 'statutory' },
      { label: 'Single-entry bond', amount: 250, basis: 'per B/L', note: 'if required', category: 'conditional' },
    ],
  });
  assert.match(html, /Firm service charges/);
  assert.match(html, /Statutory charges/);
  assert.match(html, /Conditional charges/);
  assert.match(html, /Duty indication: 2.9% under HS 9406/);
  assert.match(html, /WAITING TIME/);
  assert.match(html, /Complete sell rates for the stated scope/);
  assert.match(html, /firm target or competing indication/);
});

test('shows indicative sailing separately from carrier-confirmed space', () => {
  const html = buildClientQuoteHtml({
    template: 'ocean_comparison',
    pol: 'Plattsville, ON',
    pod: 'Santos',
    hiddenMarkupFlat: 500,
    destinationChargesNote: 'COLLECT / excluded from origin total',
    options: [{
      carrier: 'MSC', containerType: '20DRY', amount: 3560, destinationCharges: 100,
      transitDays: 22, indicativeEtd: '28 Jul 2026', scheduleStatus: 'Subject to booking confirmation',
      remarks: 'Best overall level', recommended: true,
    }],
  });
  assert.match(html, /USD 4,060\.00/);
  assert.match(html, /USD 100\.00/);
  assert.match(html, /Nearest published ETD/);
  assert.match(html, /28 Jul 2026/);
  assert.match(html, /Subject to booking confirmation/);
  assert.match(html, /final vessel allocation are confirmed only after booking submission and carrier acceptance/);
  assert.match(html, /Recommended/);
  assert.doesNotMatch(html, /500|markup|profit/i);
});

test('commercial notes can be omitted without changing rates', () => {
  const html = buildClientQuoteHtml({
    template: 'import_canada',
    includeCommercialNotes: false,
    services: [{ label: 'Delivery', amount: 920, basis: 'per container' }],
  });
  assert.match(html, /USD 920\.00/);
  assert.doesNotMatch(html, /Commercial review|Rate basis:/);
});
