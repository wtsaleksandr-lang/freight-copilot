import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractSheetCorrectionProposals,
  clarifyingQuestions,
  applyClarifyAnswers,
  parseLooseDate,
  type SheetCorrectionSource,
} from './sheetCorrectionIntake.js';

const base: SheetCorrectionSource = {
  carriers: ['MSC'],
  pols: ['Shanghai'],
  pods: ['Antwerp'],
  containerTypes: ['40HC'],
  validityFrom: null,
  validityTo: null,
};

test('extracts validity + POD correction from a plain-English note', () => {
  const proposals = extractSheetCorrectionProposals(
    'The MSC validity is actually through Sept 30, and POD should be Rotterdam not Antwerp',
    base
  );
  const byField = Object.fromEntries(proposals.map((p) => [p.field, p]));
  assert.equal(byField.validityTo?.proposedValue, `${new Date().getFullYear()}-09-30`);
  assert.equal(byField.pod?.proposedValue, 'Rotterdam');
  assert.equal(byField.pod?.from, 'Antwerp');
  assert.equal(byField.pod?.confidence, 'high');
});

test('single current value resolves the target without a clarify question', () => {
  const proposals = extractSheetCorrectionProposals('POL should be Ningbo', base);
  const pol = proposals.find((p) => p.field === 'pol');
  assert.ok(pol);
  assert.equal(pol?.from, 'Shanghai'); // only one POL in the upload → unambiguous
  assert.equal(clarifyingQuestions(proposals).length, 0);
});

test('multiple current values + no "not X" → ambiguous, asks a clarify question', () => {
  const src: SheetCorrectionSource = { ...base, pods: ['Antwerp', 'Hamburg'] };
  const proposals = extractSheetCorrectionProposals('POD should be Rotterdam', src);
  const pod = proposals.find((p) => p.field === 'pod');
  assert.ok(pod?.ambiguous);
  const questions = clarifyingQuestions(proposals);
  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0]?.options, ['Antwerp', 'Hamburg', 'All of them']);

  const resolved = applyClarifyAnswers(proposals, [{ answer: 'Hamburg' }]);
  const rp = resolved.find((p) => p.field === 'pod');
  assert.equal(rp?.ambiguous, false);
  assert.equal(rp?.from, 'Hamburg');
});

test('parseLooseDate understands common freight date forms', () => {
  const y = new Date().getFullYear();
  assert.equal(parseLooseDate('2026-9-3'), '2026-09-03');
  assert.equal(parseLooseDate('September 30 2026'), '2026-09-30');
  assert.equal(parseLooseDate('30 Sep'), `${y}-09-30`);
  assert.equal(parseLooseDate('15/11/2026'), '2026-11-15');
  assert.equal(parseLooseDate('not a date'), null);
});
