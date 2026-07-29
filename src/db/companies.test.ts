// loadEnv() hard-exits on missing env, so give it valid-shaped values pointing
// at a dead port. A real CI DB (if present) still wins via ??=. This makes DB
// calls fail as a genuine CONNECTION error (throw, not exit) — exactly the path
// the self-heal + directory helpers must survive non-fatally.
process.env.DATABASE_URL ??= 'postgres://u:p@127.0.0.1:1/nodb?sslmode=disable';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-dummy';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCompanyName,
  ensureCompaniesTable,
  upsertCompany,
  searchCompanies,
  listCompanies,
  recordShipmentCompanies,
  COMPANY_ROLE_BY_FIELD,
} from './companies.js';

// ---- Pure normalization / dedupe key (no DB) ----

test('normalizeCompanyName lowercases + strips punctuation and whitespace', () => {
  assert.equal(normalizeCompanyName('A.P. Moller — Maersk'), 'apmollermaersk');
  assert.equal(normalizeCompanyName('AP Moller Maersk'), 'apmollermaersk');
  assert.equal(normalizeCompanyName('apmoller  maersk'), 'apmollermaersk');
});

test('normalizeCompanyName collapses accents + case so variants dedupe equal', () => {
  // Three spellings of the same company must produce ONE dedupe key.
  const a = normalizeCompanyName('Nestlé S.A.');
  const b = normalizeCompanyName('NESTLE SA');
  const c = normalizeCompanyName('  nestle,  s a  ');
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a, 'nestlesa');
});

test('normalizeCompanyName returns empty for blank / punctuation-only names', () => {
  assert.equal(normalizeCompanyName(''), '');
  assert.equal(normalizeCompanyName('   '), '');
  assert.equal(normalizeCompanyName('—.,&'), '');
});

test('COMPANY_ROLE_BY_FIELD maps the three shipment fields to roles', () => {
  assert.deepEqual(COMPANY_ROLE_BY_FIELD, {
    customerName: 'customer',
    shipperName: 'shipper',
    receiverName: 'receiver',
  });
});

// ---- Non-fatal contract (runs WITHOUT a reachable DB) ----
// These prove a fresh deploy / DB blip can never 500 boot or a shipment save:
// the self-heal + every helper degrade gracefully instead of throwing.

test('ensureCompaniesTable never throws, even with no DB (non-fatal)', async () => {
  await assert.doesNotReject(() => ensureCompaniesTable());
  // idempotent — safe to call twice
  await assert.doesNotReject(() => ensureCompaniesTable());
});

test('upsertCompany never throws (fire-and-forget safe)', async () => {
  await assert.doesNotReject(() => upsertCompany('Test Co', 'customer'));
  // blank / punctuation-only names are ignored without touching the DB
  await assert.doesNotReject(() => upsertCompany('   '));
});

test('searchCompanies / listCompanies always return an array (no DB → [])', async () => {
  assert.ok(Array.isArray(await searchCompanies('maersk')));
  assert.ok(Array.isArray(await searchCompanies('')));
  assert.ok(Array.isArray(await listCompanies(5)));
});

test('recordShipmentCompanies never throws for any field shape', () => {
  assert.doesNotThrow(() =>
    recordShipmentCompanies({
      customerName: 'Acme',
      shipperName: '',
      receiverName: null,
      unrelated: 42,
    })
  );
  assert.doesNotThrow(() => recordShipmentCompanies(null));
});
