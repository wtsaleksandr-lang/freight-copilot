// loadEnv() hard-exits the process on missing env, so give it valid-shaped
// values pointing at a dead port. A real CI DB (if present) still wins via ??=.
// This makes the DB calls fail as a genuine CONNECTION error (throw, not exit),
// which is exactly the path the self-heal must survive non-fatally.
process.env.DATABASE_URL ??= 'postgres://u:p@127.0.0.1:1/nodb?sslmode=disable';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-dummy';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureEmailTemplateTable,
  getEmailTemplates,
  DEFAULT_EMAIL_TEMPLATES,
  DEFAULT_OCEAN_DISCLAIMER,
} from './emailTemplates.js';

// These run WITHOUT a reachable database on purpose: they prove the self-heal
// is non-fatal (never throws → a fresh deploy can't 500 on a missing table)
// and that reads fall back to the in-code defaults. If a real DATABASE_URL is
// present the calls simply succeed instead — either way they must not throw.

test('ensureEmailTemplateTable never throws, even with no DB (non-fatal)', async () => {
  await assert.doesNotReject(() => ensureEmailTemplateTable());
});

test('ensureEmailTemplateTable is safe to call twice (idempotent)', async () => {
  await assert.doesNotReject(() => ensureEmailTemplateTable());
  await assert.doesNotReject(() => ensureEmailTemplateTable());
});

test('getEmailTemplates returns a complete payload (defaults on DB error)', async () => {
  const payload = await getEmailTemplates();
  assert.ok(payload.templates.concise?.includes('<EACH_LANE>'));
  assert.ok(payload.templates.structured);
  assert.ok(payload.templates.conversational);
  // No <ETD>/<ETA>/<VESSEL> anywhere in the defaults.
  assert.equal(/<(ETD|ETA|VESSEL)>/.test(JSON.stringify(payload.templates)), false);
  assert.ok(payload.disclaimer.length > 0);
});

test('in-code defaults carry the owner-approved disclaimer + 3 templates', () => {
  assert.equal(Object.keys(DEFAULT_EMAIL_TEMPLATES).length, 3);
  assert.ok(DEFAULT_OCEAN_DISCLAIMER.startsWith('Please note:'));
});
