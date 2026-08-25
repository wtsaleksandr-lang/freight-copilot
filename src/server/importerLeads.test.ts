import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isForwarder,
  dedupImporters,
  domainMatchesCompany,
  toLead,
  toCSV,
  MAX_LEADS_CAP,
  type BolRecord,
  type Lead,
} from './importerLeads.js';

test('isForwarder flags forwarders/NVOCCs but keeps real importers', () => {
  assert.equal(isForwarder('Expeditors International'), true);
  assert.equal(isForwarder('DB Schenker'), true);
  assert.equal(isForwarder('Acme Global Logistics'), true); // "logistics"
  assert.equal(isForwarder('Sunrise Freight Forwarding'), true);
  assert.equal(isForwarder('Bright Home Furnishings'), false);
  assert.equal(isForwarder('Global Stone Impex'), false);
});

test('dedupImporters drops forwarders + confidential, keeps highest 12-mo volume per company', () => {
  const rows: BolRecord[] = [
    { company_name: 'Bright Home', company_basename: 'bright home', company_shipments_12m: 5 },
    { company_name: 'Bright Home', company_basename: 'bright home', company_shipments_12m: 12 },
    { company_name: 'DHL Supply Chain', company_shipments_12m: 99 }, // forwarder → dropped
    { company_name: 'Secret Co', company_shipments_12m: 40, company_manifest_confidentiality: true }, // dropped
    { company_name: 'Nova Imports', company_basename: 'nova imports', company_shipments_12m: 30 },
  ];
  const out = dedupImporters(rows);
  assert.equal(out.length, 2);
  // sorted by 12-mo volume desc: Nova (30) then Bright Home (12, the higher of its two rows)
  assert.equal(out[0]?.company_name, 'Nova Imports');
  assert.equal(out[1]?.company_name, 'Bright Home');
  assert.equal(out[1]?.company_shipments_12m, 12);
});

test('domainMatchesCompany accepts genuine hosts and rejects fuzzy drift', () => {
  assert.equal(domainMatchesCompany('Global Stone Impex', 'globalstoneimpex.com'), true);
  assert.equal(domainMatchesCompany('Bright Home Furnishings', 'brighthome.com'), true);
  // Fuzzy drift: Hunter resolves "Bosch Tool" to an unrelated host → must reject.
  assert.equal(domainMatchesCompany('Bosch Tool', 'motopaja.fi'), false);
  // Nothing distinctive to check (only stop tokens) → don't block.
  assert.equal(domainMatchesCompany('International Group', 'anything.com'), true);
});

test('toLead merges BOL record + enrichment and derives state from address', () => {
  const record: BolRecord = {
    company_name: 'Nova Imports',
    company_address: '100 Main St, Los Angeles, CA 90001',
    supplier_name: 'Shenzhen Widgets',
    supplier_country_code: 'CN',
    product_description: 'LED lighting',
    hs_code: '9405',
    entry_port: 'Los Angeles',
    company_shipments_12m: 30,
    company_total_shipments: 120,
    arrival_date: '2026-07-01',
    company_main_phone_number: '555-1000',
    notify_party_name: 'Expeditors',
  };
  const contact = {
    domain: 'novaimports.com',
    contact_name: 'Jane Doe',
    title: 'Head of Logistics',
    email: 'jane@novaimports.com',
    email_confidence: 95,
    linkedin: null,
  };
  const lead = toLead(record, contact);
  assert.equal(lead.company, 'Nova Imports');
  assert.equal(lead.state, 'CA');
  assert.equal(lead.supplier, 'Shenzhen Widgets');
  assert.equal(lead.supplier_country, 'CN');
  assert.equal(lead.entry_port, 'Los Angeles');
  assert.equal(lead.incumbent_forwarder, 'Expeditors');
  assert.equal(lead.website, 'novaimports.com'); // from enrichment
  assert.equal(lead.email, 'jane@novaimports.com');
  assert.equal(lead.email_confidence, 95);
});

test('toLead without enrichment leaves contact fields null', () => {
  const lead = toLead({ company_name: 'Nova Imports', company_state: 'TX' }, null);
  assert.equal(lead.contact_name, null);
  assert.equal(lead.email, null);
  assert.equal(lead.state, 'TX');
  assert.equal(lead.website, null);
});

test('toCSV emits a header row plus one quoted row per lead', () => {
  const leads: Lead[] = [
    toLead({ company_name: 'Nova Imports', company_state: 'TX', product_description: 'A, B "special"' }, null),
  ];
  const csv = toCSV(leads);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^company,state,supplier/);
  assert.match(lines[1]!, /"Nova Imports"/);
  assert.match(lines[1]!, /"A, B ""special"""/); // commas + escaped quotes
});

test('MAX_LEADS_CAP is the documented hard cap', () => {
  assert.equal(MAX_LEADS_CAP, 25);
});
