import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeQuota, takeBoth, dayKey } from '../lib/caps.js';
function fakeKV() { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, _m: m }; }
test('dayKey is UTC date', () => { assert.equal(dayKey(new Date('2026-10-24T23:59:00Z')), '2026-10-24'); });
test('takeQuota allows up to limit then denies', async () => {
  const env = { TRIPS: fakeKV() };
  for (let i = 0; i < 3; i++) assert.equal(await takeQuota(env, 'ABC', 'parse', 3), true);
  assert.equal(await takeQuota(env, 'ABC', 'parse', 3), false);
  assert.equal(await takeQuota(env, 'XYZ', 'parse', 3), true);
});
test('takeBoth leaves the global counter unchanged when the per-trip quota is spent', async () => {
  const env = { TRIPS: fakeKV() };
  const day = dayKey();
  await env.TRIPS.put(`q:ABC:${day}:parse`, '30');
  assert.equal(await takeBoth(env, 'ABC', 'parse'), false);
  assert.equal(env.TRIPS._m.has(`q:global:${day}:parse`), false);
});
test('takeBoth denies a fresh trip once the global quota is spent', async () => {
  const env = { TRIPS: fakeKV() };
  const day = dayKey();
  await env.TRIPS.put(`q:global:${day}:parse`, '300');
  assert.equal(await takeBoth(env, 'XYZ', 'parse'), false);
  assert.equal(env.TRIPS._m.get(`q:global:${day}:parse`), '300');
});
test('takeBoth counts both the trip and the global quota when both have room', async () => {
  const env = { TRIPS: fakeKV() };
  const day = dayKey();
  assert.equal(await takeBoth(env, 'ABC', 'parse'), true);
  assert.equal(env.TRIPS._m.get(`q:ABC:${day}:parse`), '1');
  assert.equal(env.TRIPS._m.get(`q:global:${day}:parse`), '1');
});
