import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREATE_NEW_LABEL,
  candidateLabel,
  decideShipmentIntake,
} from './shipmentDedupDecision.js';
import { fillOnlyPatch } from '../db/shipmentBoard.js';

const updatedAt = new Date('2026-07-20T00:00:00.000Z');
const rows = [
  {
    refId: 'S00043252',
    updatedAt,
    bookingRef: 'MAEU-9032111',
    customerName: 'Access Air',
    shipperName: 'ABC Machinery',
    receiverName: 'Port Client',
    carrierPreference: 'Maersk',
    pol: 'Montreal',
    pod: 'Antwerp',
    containerType: '40HC',
  },
  {
    refId: 'S00043253',
    updatedAt,
    bookingRef: 'MSC-218754',
    customerName: 'Other Customer',
    shipperName: 'ABC Machinery',
    receiverName: 'Port Client',
    carrierPreference: 'MSC',
    pol: 'Montreal',
    pod: 'Hamburg',
    containerType: '40HC',
  },
];

test('matched: exact internal ref -> merge into that shipment', () => {
  const decision = decideShipmentIntake({ internalRef: 'S00043252' }, rows);
  assert.equal(decision.action, 'merge');
  if (decision.action === 'merge') assert.equal(decision.refId, 'S00043252');
});

test('matched: exact booking ref (despite punctuation) -> merge', () => {
  const decision = decideShipmentIntake({ bookingRef: 'MAEU 9032111' }, rows);
  assert.equal(decision.action, 'merge');
  if (decision.action === 'merge') assert.equal(decision.refId, 'S00043252');
});

test('none: no overlapping signals -> create new', () => {
  const decision = decideShipmentIntake(
    { customerName: 'Totally Unrelated Co', pol: 'Shanghai', pod: 'Rotterdam' },
    rows
  );
  assert.equal(decision.action, 'create');
});

test('none: empty signals against empty board -> create new', () => {
  const decision = decideShipmentIntake({}, []);
  assert.equal(decision.action, 'create');
});

test('weak single-signal overlap -> create, no prompt', () => {
  // shipper + container = 28, below the ambiguity floor: recurs across genuinely
  // different freight shipments, so it must NOT raise the merge prompt anymore.
  const decision = decideShipmentIntake(
    { shipperName: 'ABC Machinery', containerType: '40HC' },
    rows
  );
  assert.equal(decision.action, 'create');
});

test('ambiguous: strong multi-field tie -> clarify with candidate options', () => {
  // shipper + receiver + POL match BOTH rows equally (58 each) — a real "which?"
  const decision = decideShipmentIntake(
    { shipperName: 'ABC Machinery', receiverName: 'Port Client', pol: 'Montreal' },
    rows
  );
  assert.equal(decision.action, 'clarify');
  if (decision.action !== 'clarify') return;
  // One question, options rendered as clickable buttons.
  assert.equal(decision.questions.length, 1);
  const opts = decision.questions[0]!.options;
  // First option is always "create new", then ranked merge candidates.
  assert.equal(opts[0], CREATE_NEW_LABEL);
  assert.ok(opts.some((o) => o.includes('S00043252')));
  assert.ok(opts.some((o) => o.includes('S00043253')));
  // commitOptions maps each label back to a concrete action/refId.
  const createOpt = decision.commitOptions.find((o) => o.action === 'create');
  assert.ok(createOpt);
  const mergeOpt = decision.commitOptions.find(
    (o) => o.action === 'merge' && o.refId === 'S00043252'
  );
  assert.ok(mergeOpt);
  // Labels line up 1:1 with the question options (frontend maps by label).
  assert.deepEqual(
    decision.commitOptions.map((o) => o.label),
    opts
  );
});

test('candidateLabel: shows ref + shipper→receiver', () => {
  const label = candidateLabel(rows[0]!);
  assert.ok(label.includes('S00043252'));
  assert.ok(label.includes('ABC Machinery→Port Client'));
});

test('fillOnlyPatch: fills empty cells only, never overwrites populated', () => {
  const existing: Record<string, unknown> = {
    shipperName: 'ABC Machinery', // populated -> must NOT be overwritten
    receiverName: null, // empty -> should fill
    pod: '', // empty string -> should fill
    pol: 'Montreal', // populated -> must NOT be overwritten
  };
  const incoming = {
    shipperName: 'Different Shipper Co',
    receiverName: 'New Receiver',
    pod: 'Hamburg',
    pol: 'Shanghai',
  };
  const patch = fillOnlyPatch(existing, incoming);
  assert.deepEqual(patch, { receiverName: 'New Receiver', pod: 'Hamburg' });
});

test('fillOnlyPatch: skips absent incoming values and honours editable gate', () => {
  const existing = { a: null, b: null, secret: null } as Record<string, unknown>;
  const incoming = { a: 'x', b: null, secret: 'nope' } as Record<string, unknown>;
  const patch = fillOnlyPatch(existing, incoming, (k) => k !== 'secret');
  assert.deepEqual(patch, { a: 'x' });
});
