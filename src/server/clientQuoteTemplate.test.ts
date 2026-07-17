import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClientQuoteHtml } from './clientQuoteTemplate.js';

test('renders import services, customs notes and waiting clause', () => {
  const html = buildClientQuoteHtml({
    template: 'import_usa',
    hsCode: '9406',
    dutyRate: '2.9%',
    terminal: 'NEW YORK PORT',
    placeOfDelivery: 'Cape Elizabeth, Maine 04107',
    waitingTime: '1 hour free, $100/hr thereafter',
    services: [{ label: 'Import handling', amount: 70, basis: 'per B/L' }],
  });
  assert.match(html, /Ocean import FCL, to USA/);
  assert.match(html, /USD 70\.00/);
  assert.match(html, /HS CODE 9406/);
  assert.match(html, /NEW YORK PORT/);
  assert.match(html, /WAITING TIME/);
});

test('keeps destination charges separate and hides markup calculation', () => {
  const html = buildClientQuoteHtml({
    template: 'ocean_comparison',
    pol: 'Plattsville, ON',
    pod: 'Santos',
    hiddenMarkupFlat: 500,
    destinationChargesNote: 'COLLECT / not included',
    options: [{ carrier: 'MSC', containerType: '20DRY', amount: 3560, destinationCharges: 100, transitDays: 22 }],
  });
  assert.match(html, /USD 4,060\.00/);
  assert.match(html, /USD 100\.00/);
  assert.match(html, /COLLECT \/ not included/);
  assert.doesNotMatch(html, /500|markup|profit/i);
});
