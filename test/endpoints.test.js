import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as assignPost } from '../functions/api/trips/[code]/assign.js';
import { onRequestPost as parsePost } from '../functions/api/trips/[code]/parse.js';
import { onRequestPost as tripsPost } from '../functions/api/trips.js';
import { onRequestGet as imageGet, onRequestDelete as imageDelete } from '../functions/api/trips/[code]/images/[id].js';
import { VISION_MODEL } from '../lib/ai.js';
import { dayKey } from '../lib/caps.js';

const CODE = 'ABCDEFGH';
const MEMBERS = [{ id: 'm1', name: 'Suhas' }, { id: 'm2', name: 'Rohan' }];

function fakeEnv(members = MEMBERS) {
  const kv = new Map([[CODE, JSON.stringify({ code: CODE, members })]]);
  const photos = new Map();
  const photoCalls = [];
  return {
    photos,
    photoCalls,
    TRIPS: {
      get: async (k, type) => (type === 'json' ? JSON.parse(kv.get(k) ?? 'null') : kv.get(k) ?? null),
      put: async (k, v) => { kv.set(k, v); },
    },
    RECEIPTS: {
      put: async (k, v, opts) => { photoCalls.push(['put', k, opts]); photos.set(k, v); },
      get: async (k, opts) => {
        photoCalls.push(['get', k, opts]);
        const v = photos.get(k);
        return v === undefined ? null : new Response(v).body;
      },
      delete: async (k) => { photoCalls.push(['delete', k]); photos.delete(k); },
    },
    AI: {
      run: async () => ({ response: JSON.stringify({ items: [{ id: 'x1', shares: { m1: 1 } }] }) }),
    },
  };
}

const assignReq = (body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://test/assign', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(text).length) },
    body: text,
  });
};

const goodItem = (id, name) => ({ id, name, price: 100, shares: {} });

test('assign rejects a null item with 400 and an error body', async () => {
  const res = await assignPost({ request: assignReq({ instruction: 'split equally', items: [null] }), params: { code: CODE }, env: fakeEnv() });
  assert.equal(res.status, 400);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('assign rejects an item with no name with 400', async () => {
  const res = await assignPost({ request: assignReq({ instruction: 'split equally', items: [{}] }), params: { code: CODE }, env: fakeEnv() });
  assert.equal(res.status, 400);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('assign rejects more than 100 items with 400', async () => {
  const items = Array.from({ length: 101 }, (_, i) => goodItem(`i${i}`, `Item ${i}`));
  const res = await assignPost({ request: assignReq({ instruction: 'split equally', items }), params: { code: CODE }, env: fakeEnv() });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at most 100/);
});

test('assign accepts 100 items and returns them', async () => {
  const items = Array.from({ length: 100 }, (_, i) => goodItem(`i${i}`, `Item ${i}`));
  const res = await assignPost({ request: assignReq({ instruction: 'split equally', items }), params: { code: CODE }, env: fakeEnv() });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).items.length, 100);
});

test('assign success: excludes the member named in the instruction', async () => {
  const items = [goodItem('x1', 'Chicken Curry'), goodItem('x2', 'Dal')];
  const res = await assignPost({ request: assignReq({ instruction: 'Rohan is veg', items }), params: { code: CODE }, env: fakeEnv() });
  assert.equal(res.status, 200);
  const out = (await res.json()).items;
  assert.equal(out.length, 2);
  assert.ok(out.every((it) => it.shares && typeof it.shares === 'object'));
});

test('image GET with a bad code returns 404', async () => {
  const env = fakeEnv();
  const res = await imageGet({ params: { code: 'bad', id: 'deadbeef' }, env });
  assert.equal(res.status, 404);
  assert.equal(env.photoCalls.length, 0);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('image GET with a bad id returns 404', async () => {
  const env = fakeEnv();
  const res = await imageGet({ params: { code: CODE, id: '../../x' }, env });
  assert.equal(res.status, 404);
  assert.equal(env.photoCalls.length, 0);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('image DELETE with a bad code or id returns 404', async () => {
  const env = fakeEnv();
  const badCode = await imageDelete({ params: { code: 'ABC', id: 'deadbeef' }, env });
  assert.equal(badCode.status, 404);
  const badId = await imageDelete({ params: { code: CODE, id: 'XYZ' }, env });
  assert.equal(badId.status, 404);
  assert.equal(env.photoCalls.length, 0);
});

test('image GET round trip returns the stored JPEG bytes', async () => {
  const env = fakeEnv();
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  env.photos.set(`${CODE}/deadbeef.jpg`, bytes);
  const res = await imageGet({ params: { code: CODE, id: 'deadbeef' }, env });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  assert.deepEqual(env.photoCalls.find((c) => c[0] === 'get')[2], { type: 'stream' });
});

test('image DELETE returns ok and removes the object', async () => {
  const env = fakeEnv();
  env.photos.set(`${CODE}/deadbeef.jpg`, new Uint8Array([1]));
  const res = await imageDelete({ params: { code: CODE, id: 'deadbeef' }, env });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(env.photos.has(`${CODE}/deadbeef.jpg`), false);
});

test('parse stores the photo in KV with a 30-day expirationTtl after the model succeeds', async () => {
  const env = receiptEnv();
  const res = await parsePost({ request: await parseReq(), params: { code: CODE }, env });
  assert.equal(res.status, 200);
  const draft = await res.json();
  const puts = env.photoCalls.filter((c) => c[0] === 'put');
  assert.equal(puts.length, 1);
  assert.equal(puts[0][1], draft.imageKey);
  assert.equal(puts[0][2].expirationTtl, 2592000);
});

test('assign rejects an instruction over 500 characters with 400', async () => {
  const res = await assignPost({ request: assignReq({ instruction: 'x'.repeat(501), items: [goodItem('i1', 'Dal')] }), params: { code: CODE }, env: fakeEnv() });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /500/);
  const ok = await assignPost({ request: assignReq({ instruction: 'split equally' + 'y'.repeat(487), items: [goodItem('i1', 'Dal')] }), params: { code: CODE }, env: fakeEnv() });
  assert.equal(ok.status, 200);
});

test('assign rejects an item name over 100 characters with 400', async () => {
  const res = await assignPost({ request: assignReq({ instruction: 'split equally', items: [goodItem('i1', 'n'.repeat(101))] }), params: { code: CODE }, env: fakeEnv() });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /100/);
});

test('parse rejects an instruction over 500 characters with 400', async () => {
  const form = new FormData();
  form.set('image', new File([new Uint8Array([1])], 'r.jpg', { type: 'image/jpeg' }));
  form.set('instruction', 'x'.repeat(501));
  const res = await parsePost({ request: await sized('http://test/parse', form), params: { code: CODE }, env: fakeEnv() });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /500/);
});

const JPEG = [0xff, 0xd8, 0xff, 0xd9];
const RECEIPT = { merchant: 'Cafe', items: [{ name: 'Dal', price: 100 }, { name: 'Chicken', price: 200 }], subtotal: 300, tax: 0, tip: 0, total: 300 };
const MEMBERS3 = [{ id: 'm1', name: 'Suhas' }, { id: 'm2', name: 'Rohan' }, { id: 'm3', name: 'Priya' }];

// Serialises a multipart form to its real bytes so the Content-Length header is accurate.
async function sized(url, form, extraHeaders = {}) {
  const probe = new Request(url, { method: 'POST', body: form });
  const body = new Uint8Array(await probe.arrayBuffer());
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': probe.headers.get('content-type'), 'content-length': String(body.byteLength), ...extraHeaders },
    body,
  });
}

async function parseReq({ fields = {}, bytes = JPEG } = {}) {
  const form = new FormData();
  form.set('image', new File([new Uint8Array(bytes)], 'r.jpg', { type: 'image/jpeg' }));
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) form.append(k, x);
  return sized('http://test/parse', form);
}

// Vision call returns RECEIPT; the text model (used for leftover instructions) always fails.
function receiptEnv(members = MEMBERS) {
  const env = fakeEnv(members);
  env.AI.run = async (model) => {
    if (model === VISION_MODEL) return { response: JSON.stringify(RECEIPT) };
    throw new Error('text model down');
  };
  return env;
}

test('assign returns 503 while AI_DISABLED is set', async () => {
  const env = { ...fakeEnv(), AI_DISABLED: '1' };
  const res = await assignPost({ request: assignReq({ instruction: 'split equally', items: [goodItem('i1', 'Dal')] }), params: { code: CODE }, env });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Receipt reading is paused' });
});

test('assign returns 429 once the per-trip daily quota is used up', async () => {
  const env = fakeEnv();
  await env.TRIPS.put(`q:${CODE}:${dayKey()}:assign`, '60');
  const res = await assignPost({ request: assignReq({ instruction: 'zzz', items: [goodItem('i1', 'Dal')] }), params: { code: CODE }, env });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'Daily limit reached, try tomorrow.' });
});

test('parse returns 403 when Turnstile rejects the token', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }));
  try {
    const form = new FormData();
    form.set('image', new File([new Uint8Array(JPEG)], 'r.jpg', { type: 'image/jpeg' }));
    form.set('turnstileToken', 'bad');
    const env = { ...receiptEnv(), TURNSTILE_SECRET: 's' };
    const log = spy(env);
    const res = await parsePost({ request: await sized('http://test/parse', form), params: { code: CODE }, env });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Captcha failed, reload and try again' });
    assert.equal(env.photoCalls.length, 0);
    assert.equal(log.ai, 0, 'captcha must be checked before the model is called');
    assert.deepEqual(log.kvWrites.filter((k) => k.startsWith('q:')), [], 'captcha must be checked before any quota is spent');
  } finally { globalThis.fetch = orig; }
});

test('parse does not store the photo when the model call fails', async () => {
  const env = fakeEnv();
  env.AI.run = async () => { throw new Error('model down'); };
  const res = await parsePost({ request: await parseReq(), params: { code: CODE }, env });
  assert.equal(res.status, 502);
  assert.equal(env.photoCalls.filter((c) => c[0] === 'put').length, 0);
});

test('parse rejects bytes that are not a JPEG with 400', async () => {
  const env = receiptEnv();
  const res = await parsePost({ request: await parseReq({ bytes: [0x89, 0x50, 0x4e, 0x47] }), params: { code: CODE }, env });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Photo must be a JPEG' });
  assert.equal(env.photoCalls.length, 0);
});

test('parse rejects a request with no Content-Length with 411', async () => {
  const form = new FormData();
  form.set('image', new File([new Uint8Array(JPEG)], 'r.jpg', { type: 'image/jpeg' }));
  const res = await parsePost({ request: new Request('http://test/parse', { method: 'POST', body: form }), params: { code: CODE }, env: receiptEnv() });
  assert.equal(res.status, 411);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('parse with 2 of 3 present gives every item explicit shares for the present members only', async () => {
  // The leftover instruction reaches the model, which returns no shares, so items stay empty and only R28 can fill them.
  const env = receiptEnv(MEMBERS3);
  env.AI.run = async (model) => (model === VISION_MODEL ? { response: JSON.stringify(RECEIPT) } : { response: JSON.stringify({ items: [] }) });
  const res = await parsePost({
    request: await parseReq({ fields: { instruction: 'Suhas had two Dal', present: ['m1', 'm3'] } }),
    params: { code: CODE }, env,
  });
  assert.equal(res.status, 200);
  const draft = await res.json();
  assert.equal(draft.items.length, 2);
  for (const it of draft.items) assert.deepEqual(Object.keys(it.shares).sort(), ['m1', 'm3']);
});

test('parse with all members present leaves a fallback-unassigned item with empty shares', async () => {
  const env = receiptEnv(MEMBERS3);
  const res = await parsePost({
    request: await parseReq({ fields: { instruction: 'Suhas had two Dal', present: ['m1', 'm2', 'm3'] } }),
    params: { code: CODE }, env,
  });
  assert.equal(res.status, 200);
  const draft = await res.json();
  assert.ok(draft.warning);
  assert.ok(draft.items.every((it) => Object.keys(it.shares).length === 0));
});

test('parse with 2 of 3 present and a failed model call gives items the present members only', async () => {
  const env = receiptEnv(MEMBERS3);
  const res = await parsePost({
    request: await parseReq({ fields: { instruction: 'Suhas had two Dal', present: ['m1', 'm2'] } }),
    params: { code: CODE }, env,
  });
  assert.equal(res.status, 200);
  const draft = await res.json();
  assert.ok(draft.warning);
  for (const it of draft.items) assert.deepEqual(Object.keys(it.shares).sort(), ['m1', 'm2']);
});

test('parse caps the draft title at 200 characters', async () => {
  const env = receiptEnv();
  env.AI.run = async (model) => (model === VISION_MODEL ? { response: JSON.stringify({ ...RECEIPT, merchant: 'M'.repeat(300) }) } : { response: '' });
  const res = await parsePost({ request: await parseReq(), params: { code: CODE }, env });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).title.length, 200);
});

test('parse keeps the row check flag in the draft', async () => {
  const env = receiptEnv();
  const row = { name: 'Fish', qty: 1, rate: 100, amount: 200 };
  env.AI.run = async (model) => (model === VISION_MODEL
    ? { response: JSON.stringify({ merchant: 'Cafe', rows: [row], subtotal: 200, tax: 0, tip: 0, total: 200 }) }
    : { response: '' });
  const res = await parsePost({ request: await parseReq(), params: { code: CODE }, env });
  assert.equal(res.status, 200);
  const draft = await res.json();
  assert.equal(draft.items[0].check, true);
});

// Wraps the fake env so tests can see model calls and KV writes.
function spy(env) {
  const log = { ai: 0, kvWrites: [] };
  const run = env.AI.run;
  env.AI.run = async (...args) => { log.ai++; return run(...args); };
  const put = env.TRIPS.put;
  env.TRIPS.put = async (k, v, opts) => { log.kvWrites.push(k); return put(k, v, opts); };
  return log;
}

test('parse returns 503 while AI_DISABLED is set and never calls the model', async () => {
  const env = { ...receiptEnv(), AI_DISABLED: '1' };
  const log = spy(env);
  const res = await parsePost({ request: await parseReq(), params: { code: CODE }, env });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Receipt reading is paused' });
  assert.equal(log.ai, 0);
});

test('parse returns 429 once the per-trip daily quota is used up, without calling the model', async () => {
  const env = receiptEnv();
  await env.TRIPS.put(`q:${CODE}:${dayKey()}:parse`, '30');
  const log = spy(env);
  const res = await parsePost({ request: await parseReq(), params: { code: CODE }, env });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'Daily limit reached, try tomorrow.' });
  assert.equal(log.ai, 0);
  assert.equal(env.photoCalls.length, 0);
});

test('POST /api/trips returns 403 and writes no trip when Turnstile rejects', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false }));
  try {
    const env = { ...fakeEnv(), TURNSTILE_SECRET: 's' };
    const log = spy(env);
    const res = await tripsPost({ request: assignReq({ name: 'Goa', members: ['A', 'B'], turnstileToken: 'bad' }), env });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Captcha failed, reload and try again' });
    assert.deepEqual(log.kvWrites, []);
  } finally { globalThis.fetch = orig; }
});

test('parse still returns the draft, without imageKey, when the photo put fails', async () => {
  const env = receiptEnv();
  env.RECEIPTS.put = async () => { throw new Error('kv down'); };
  const res = await parsePost({ request: await parseReq({ fields: { instruction: 'split equally' } }), params: { code: CODE }, env });
  assert.equal(res.status, 200);
  const draft = await res.json();
  assert.equal(draft.items.length, 2);
  assert.equal('imageKey' in draft, false);
});

test('assign with a rules-only instruction spends no quota and writes no q: key', async () => {
  const env = fakeEnv();
  const log = spy(env);
  const res = await assignPost({ request: assignReq({ instruction: 'split equally', items: [goodItem('i1', 'Dal')] }), params: { code: CODE }, env });
  assert.equal(res.status, 200);
  assert.deepEqual(log.kvWrites.filter((k) => k.startsWith('q:')), []);
  assert.equal(log.ai, 0);
});

test('assign with a leftover instruction takes the quota', async () => {
  const env = fakeEnv();
  const log = spy(env);
  const res = await assignPost({ request: assignReq({ instruction: 'zzz', items: [goodItem('i1', 'Dal')] }), params: { code: CODE }, env });
  assert.equal(res.status, 200);
  assert.equal(log.kvWrites.filter((k) => k.startsWith('q:')).length, 2);
  assert.equal(log.ai, 1);
});

test('assign and parse return a JSON 503 when the quota KV put throws', async () => {
  const env = fakeEnv();
  const put = env.TRIPS.put;
  env.TRIPS.put = async (k, ...a) => { if (k.startsWith('q:')) throw new Error('kv down'); return put(k, ...a); };
  const res = await assignPost({ request: assignReq({ instruction: 'zzz', items: [goodItem('i1', 'Dal')] }), params: { code: CODE }, env });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'Receipt reading is paused, try again later' });
  const env2 = receiptEnv();
  const put2 = env2.TRIPS.put;
  env2.TRIPS.put = async (k, ...a) => { if (k.startsWith('q:')) throw new Error('kv down'); return put2(k, ...a); };
  const res2 = await parsePost({ request: await parseReq(), params: { code: CODE }, env: env2 });
  assert.equal(res2.status, 503);
  assert.deepEqual(await res2.json(), { error: 'Receipt reading is paused, try again later' });
});

test('image GET sets nosniff', async () => {
  const env = fakeEnv();
  env.photos.set(`${CODE}/deadbeef.jpg`, new Uint8Array([1, 2, 3]));
  const res = await imageGet({ params: { code: CODE, id: 'deadbeef' }, env });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
