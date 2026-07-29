import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUniversalFile, isOfficeDocFile } from './universalFileText.js';

function input(filename: string, value: string, mediaType = '') {
  return { filename, mediaType, fileBase64: Buffer.from(value).toString('base64') };
}

/**
 * Build a minimal ZIP archive (method 0 / stored) from name→content entries.
 * Enough for the extractor's `unzipEntries` to decode — used to fabricate a
 * real .docx without pulling in a zip dependency.
 */
function makeZip(entries: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.from(data, 'utf8');
    const local = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method 0 (stored)
    local.writeUInt32LE(0, 14); // crc (unchecked)
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    dataBuf.copy(local, 30 + nameBuf.length);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method 0
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const localDir = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localDir.length, 16);
  return Buffer.concat([localDir, centralDir, eocd]);
}

function docxInput(filename: string, bodyText: string) {
  const documentXml =
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`;
  const zip = makeZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: documentXml },
  ]);
  return { filename, mediaType: '', fileBase64: zip.toString('base64') };
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

test('recognizes modern office documents by extension', () => {
  for (const name of ['booking.docx', 'RATES.XLSX', 'deck.pptx', 'notes.odt', 'sheet.ods', 'slides.odp']) {
    assert.equal(isOfficeDocFile(name), true, name);
  }
  for (const name of ['scan.pdf', 'photo.png', 'thread.eml', 'legacy.doc', undefined]) {
    assert.equal(isOfficeDocFile(name), false, String(name));
  }
});

test('decodes a .docx to text (the intake/briefing office-doc branch)', () => {
  const norm = normalizeUniversalFile(docxInput('booking.docx', 'Shipment from Toronto to Chicago total USD 3200'));
  assert.equal(norm.kind, 'text');
  assert.match(norm.text ?? '', /Toronto to Chicago/);
  assert.match(norm.text ?? '', /USD 3200/);
});
