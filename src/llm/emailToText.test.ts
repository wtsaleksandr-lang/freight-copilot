import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRawEmail, parsedEmailToPromptText } from './emailToText.js';

const CRLF = '\r\n';

test('parses headers + plain body from a simple email', () => {
  const raw = [
    'From: Alex <alex@loadmode.com>',
    'To: customer@acme.com',
    'Subject: Your ocean quote SHA→LAX',
    'Message-ID: <abc123@loadmode.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Shanghai to Los Angeles, 40HC, USD 2450 all-in.',
  ].join(CRLF);
  const email = parseRawEmail(raw);
  assert.equal(email.from, 'Alex <alex@loadmode.com>');
  assert.equal(email.subject, 'Your ocean quote SHA→LAX');
  assert.equal(email.messageId, 'abc123@loadmode.com'); // brackets stripped
  assert.match(email.text, /Shanghai to Los Angeles, 40HC, USD 2450 all-in\./);
});

test('unfolds a folded (continued) header', () => {
  const raw = [
    'Subject: Ocean quote for a very long',
    '\tlane description that wraps',
    'From: alex@loadmode.com',
    '',
    'body',
  ].join(CRLF);
  const email = parseRawEmail(raw);
  assert.equal(email.subject, 'Ocean quote for a very long lane description that wraps');
});

test('decodes quoted-printable bodies', () => {
  const raw = [
    'Subject: QP test',
    'Content-Type: text/plain',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Freight =E2=82=AC1.200 per 40HC with a soft=',
    ' wrapped line.',
  ].join(CRLF);
  const email = parseRawEmail(raw);
  assert.match(email.text, /Freight €1\.200 per 40HC/);
  assert.match(email.text, /soft wrapped line\./); // soft break joined
});

test('decodes base64 bodies', () => {
  const body = Buffer.from('Ningbo to Rotterdam 20GP EUR 1800', 'utf8').toString('base64');
  const raw = [
    'Subject: b64',
    'Content-Type: text/plain',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join(CRLF);
  const email = parseRawEmail(raw);
  assert.match(email.text, /Ningbo to Rotterdam 20GP EUR 1800/);
});

test('multipart/alternative prefers the text/plain part', () => {
  const boundary = 'BND-1';
  const raw = [
    'Subject: multipart',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'PLAIN: Qingdao to Long Beach 40HC USD 2600',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>HTML: should be ignored when plain exists</p>',
    `--${boundary}--`,
  ].join(CRLF);
  const email = parseRawEmail(raw);
  assert.match(email.text, /PLAIN: Qingdao to Long Beach 40HC USD 2600/);
  assert.doesNotMatch(email.text, /should be ignored/);
});

test('html-only email is stripped to readable text', () => {
  const raw = [
    'Subject: html only',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><p>Xiamen&nbsp;to&nbsp;Oakland</p><p>40HC &amp; 20GP</p></body></html>',
  ].join(CRLF);
  const email = parseRawEmail(raw);
  assert.match(email.text, /Xiamen to Oakland/);
  assert.match(email.text, /40HC & 20GP/);
  assert.doesNotMatch(email.text, /<p>/);
});

test('nested multipart/mixed → alternative resolves to the plain leaf', () => {
  const outer = 'OUT';
  const inner = 'IN';
  const raw = [
    'Subject: nested',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
    `--${inner}`,
    'Content-Type: text/plain',
    '',
    'NESTED PLAIN rate body',
    `--${inner}`,
    'Content-Type: text/html',
    '',
    '<p>nested html</p>',
    `--${inner}--`,
    `--${outer}--`,
  ].join(CRLF);
  const email = parseRawEmail(raw);
  assert.match(email.text, /NESTED PLAIN rate body/);
});

test('missing Message-ID yields an empty string (dedupe becomes a no-op)', () => {
  const email = parseRawEmail('Subject: no id\r\n\r\nbody');
  assert.equal(email.messageId, '');
});

test('parsedEmailToPromptText renders a From/Subject header block Claude can read', () => {
  const text = parsedEmailToPromptText({
    text: 'body text',
    subject: 'Quote',
    from: 'alex@loadmode.com',
    messageId: 'x',
  });
  assert.match(text, /^From: alex@loadmode\.com/);
  assert.match(text, /Subject: Quote/);
  assert.match(text, /body text/);
});
