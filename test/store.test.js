import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCode, newId, putTrip, getTrip } from '../lib/store.js';

test('newCode is 8 chars from the safe alphabet', () => {
  for (let i = 0; i < 50; i++) assert.match(newCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
});

test('newId is 8 hex chars', () => {
  assert.match(newId(), /^[0-9a-f]{8}$/);
});

test('putTrip stamps updatedAt and getTrip reads it back', async () => {
  const kv = new Map();
  const env = { TRIPS: { get: async (k, type) => (type === 'json' ? JSON.parse(kv.get(k) ?? 'null') : kv.get(k) ?? null), put: async (k, v) => { kv.set(k, v); } } };
  const saved = await putTrip(env, { code: 'ABCDEFGH', name: 'Goa', updatedAt: 'old' });
  assert.notEqual(saved.updatedAt, 'old');
  const back = await getTrip(env, 'ABCDEFGH');
  assert.equal(back.name, 'Goa');
  assert.equal(await getTrip(env, 'NOPE'), null);
});
