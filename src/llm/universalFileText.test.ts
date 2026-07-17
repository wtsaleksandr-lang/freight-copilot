import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUniversalFile } from './universalFileText.js';

function input(filename: string, value: string, mediaType = '') {
  return { filename, mediaType, fileBase64: Buffer.from(value).toString('base64') };
}

test('normalizes CSV and email text without OCR', () => {
  const csv = normalizeUniversalFile(input('rates.csv', 'origin,destination,total\nToronto,Chicago,1800', 'text/csv'));
  assert.equal(csv.kind, 'text');
  assert.match(csv.text ?? '', /Toronto,Chicago,1800/);
  const eml = normalizeUniversalFile(input('quote.eml', 'Subject: Rate\n\nUSD 2200', 'message/rfc822'));
  assert.equal(eml.kind, 'text');
  assert.match(eml.text ?? '', /USD 2200/);
});

test('passes PDFs and images through for visual extraction', () => {
  assert.equal(normalizeUniversalFile(input('rate.pdf', 'fake', 'application/pdf')).kind, 'pdf');
  assert.equal(normalizeUniversalFile(input('rate.png', 'fake', 'image/png')).kind, 'image');
});

test('extracts readable RTF content', () => {
  const result = normalizeUniversalFile(input('quote.rtf', '{\\rtf1 Lane Toronto to Chicago\\par Total USD 2500}'));
  assert.match(result.text ?? '', /Toronto to Chicago/);
  assert.match(result.text ?? '', /USD 2500/);
});

test('rejects legacy binary office files with an actionable message', () => {
  assert.throws(() => normalizeUniversalFile(input('old-rate.xls', 'binary')), /save it as xlsx, PDF, CSV, or an image/i);
});

test('rejects unknown formats instead of pretending to parse them', () => {
  assert.throws(() => normalizeUniversalFile(input('archive.rar', 'binary')), /unsupported or unrecognized/i);
});
