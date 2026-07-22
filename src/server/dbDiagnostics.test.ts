import test from 'node:test';
import assert from 'node:assert/strict';
import { categorizeDbHost } from './dbDiagnostics.js';

test('categorizeDbHost classifies hosts without exposing secrets', () => {
  const neon = categorizeDbHost('postgresql://u:p@ep-cool-1.us-east-2.aws.neon.tech/mydb?sslmode=require');
  assert.equal(neon.hostCategory, 'neon-hosted');
  assert.equal(neon.databaseName, 'mydb');
  assert.equal(neon.sslMode, 'require');

  const local = categorizeDbHost('postgresql://postgres:secret@localhost:5432/dev?sslmode=disable');
  assert.equal(local.hostCategory, 'localhost');
  assert.equal(local.sslMode, 'disable');

  const replit = categorizeDbHost('postgresql://u:p@helium.internal/appdb');
  assert.equal(replit.hostCategory, 'replit-managed');

  const missing = categorizeDbHost(undefined);
  assert.equal(missing.hostCategory, 'missing');
  assert.equal(missing.fingerprint, null);
});

test('fingerprint is stable, non-reversible, and excludes host/user/password', () => {
  const a = categorizeDbHost('postgresql://alice:pw1@ep-1.neon.tech/shared?sslmode=require');
  const b = categorizeDbHost('postgresql://bob:pw2@ep-1.neon.tech/shared?sslmode=require');
  // Same category + db name => same fingerprint (two apps sharing one DB).
  assert.equal(a.fingerprint, b.fingerprint);
  // Fingerprint must not contain the password, user, or raw host.
  assert.ok(!(a.fingerprint ?? '').includes('alice'));
  assert.ok(!(a.fingerprint ?? '').includes('pw1'));
  const different = categorizeDbHost('postgresql://alice:pw1@ep-1.neon.tech/other?sslmode=require');
  assert.notEqual(a.fingerprint, different.fingerprint);
});
