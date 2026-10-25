import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTurnstile } from '../lib/turnstile.js';
test('unconfigured secret passes with reason', async () => {
  const r = await verifyTurnstile({}, 'tok', '1.2.3.4');
  assert.deepEqual(r, { ok: true, reason: 'unconfigured' });
});
test('calls siteverify and maps success', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { assert.match(String(url), /siteverify/); return new Response(JSON.stringify({ success: true })); };
  try { assert.equal((await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 'tok', '1.1.1.1')).ok, true); } finally { globalThis.fetch = orig; }
});
test('missing token fails fast when configured', async () => {
  assert.equal((await verifyTurnstile({ TURNSTILE_SECRET: 's' }, '', '1.1.1.1')).ok, false);
});
