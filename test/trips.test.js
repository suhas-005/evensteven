import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/trips.js';
import { onRequestGet, onRequestPut } from '../functions/api/trips/[code].js';
import { json } from '../lib/store.js';

function fakeEnv() {
  const kv = new Map();
  return {
    kv,
    TRIPS: {
      get: async (k, type) => (type === 'json' ? JSON.parse(kv.get(k) ?? 'null') : kv.get(k) ?? null),
      put: async (k, v) => { kv.set(k, v); },
    },
  };
}

const jsonReq = (method, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('http://test/api/trips', {
    method,
    headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(text).length) },
    body: text,
  });
};

async function createTrip(env, extra = {}) {
  const res = await onRequestPost({
    request: jsonReq('POST', { name: 'Goa', currency: 'INR', members: ['Rohan', 'Priya'], ...extra }),
    env,
  });
  assert.equal(res.status, 201);
  return (await res.json()).code;
}

async function readTrip(env, code) {
  const res = await onRequestGet({ params: { code }, env });
  assert.equal(res.status, 200);
  return res.json();
}

test('POST creates a trip with two members and returns 201 with its code', async () => {
  const env = fakeEnv();
  const res = await onRequestPost({ request: jsonReq('POST', { name: 'Goa', currency: 'inr', members: ['Rohan', ' Priya '] }), env });
  assert.equal(res.status, 201);
  const { code } = await res.json();
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  const trip = JSON.parse(env.kv.get(code));
  assert.equal(trip.name, 'Goa');
  assert.equal(trip.currency, 'INR');
  assert.deepEqual(trip.members.map((m) => m.name), ['Rohan', 'Priya']);
  assert.deepEqual(trip.bills, []);
});

test('POST rejects a bad currency with 400 and an error body', async () => {
  const env = fakeEnv();
  const res = await onRequestPost({ request: jsonReq('POST', { name: 'Goa', currency: 'RUPEE', members: ['a', 'b'] }), env });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Currency must be a 3-letter code' });
});

test('POST rejects fewer than two members with 400', async () => {
  const env = fakeEnv();
  const res = await onRequestPost({ request: jsonReq('POST', { name: 'Goa', members: ['a'] }), env });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Add at least two members' });
});

for (const [label, raw] of [['null', 'null'], ['a number', '1'], ['a string', '"x"'], ['an array', '[1,2]']]) {
  test(`POST rejects ${label} body with 400 and an error body`, async () => {
    const env = fakeEnv();
    const res = await onRequestPost({ request: jsonReq('POST', raw), env });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Body must be a JSON object' });
  });
}

test('GET returns 404 for an unknown code', async () => {
  const env = fakeEnv();
  const res = await onRequestGet({ params: { code: 'ZZZZZZZZ' }, env });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'No such trip' });
});

test('PUT with a stale updatedAt returns 409 with error and the current trip', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const res = await onRequestPut({
    request: jsonReq('PUT', { ...current, updatedAt: 'stale', name: 'Changed' }),
    params: { code },
    env,
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'Someone else saved this trip.');
  assert.deepEqual(body.trip, current);
  assert.equal((await readTrip(env, code)).name, 'Goa');
});

test('PUT that removes a member returns 400', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const res = await onRequestPut({
    request: jsonReq('PUT', { updatedAt: current.updatedAt, members: current.members.slice(1), bills: [] }),
    params: { code },
    env,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Members cannot be removed' });
});

const badMembers = [
  ['a null member', [null, { id: 'abcdef01', name: 'A' }]],
  ['a member with no id', [{ name: 'A' }]],
  ['a member with a blank name', [{ id: 'abcdef01', name: '   ' }]],
  ['duplicate member ids', [{ id: 'abcdef01', name: 'A' }, { id: 'abcdef01', name: 'B' }]],
  ['a non-hex member id', [{ id: 'a1', name: 'A' }]],
  ['a toString member id', [{ id: 'toString', name: 'A' }]],
  ['members that is not an array', { id: 'abcdef01', name: 'A' }],
];

for (const [label, members] of badMembers) {
  test(`PUT rejects ${label} with 400`, async () => {
    const env = fakeEnv();
    const code = await createTrip(env);
    const current = await readTrip(env, code);
    const res = await onRequestPut({
      request: jsonReq('PUT', { updatedAt: current.updatedAt, members, bills: [] }),
      params: { code },
      env,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /^Members must be a list of people/);
  });
}

test('PUT rejects bills that are not an array with 400', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const res = await onRequestPut({
    request: jsonReq('PUT', { updatedAt: current.updatedAt, members: current.members, bills: 'nope' }),
    params: { code },
    env,
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Bills must be a list' });
});

test('PUT rejects a non-object body with 400', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const res = await onRequestPut({ request: jsonReq('PUT', 'null'), params: { code }, env });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Body must be a JSON object' });
});

test('PUT renames a member and adds a new one, and saves the result', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const renamed = current.members.map((m, i) => (i === 0 ? { ...m, name: 'Rohan K' } : m));
  const res = await onRequestPut({
    request: jsonReq('PUT', {
      updatedAt: current.updatedAt,
      name: 'Goa 2026',
      members: [...renamed, { id: 'abcdef01', name: 'Sam' }],
      bills: [],
    }),
    params: { code },
    env,
  });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.name, 'Goa 2026');
  assert.deepEqual(saved.members.map((m) => m.name), ['Rohan K', 'Priya', 'Sam']);
  assert.deepEqual(await readTrip(env, code), saved);
});

// ---------- bill validation ----------
async function putBills(mutate, extra = {}) {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const [a, b] = current.members.map((m) => m.id);
  const bills = mutate({ a, b, code });
  const res = await onRequestPut({
    request: jsonReq('PUT', { updatedAt: current.updatedAt, members: current.members, bills, ...extra }),
    params: { code },
    env,
  });
  return res;
}

const receipt = ({ a, b, code }) => ({
  id: 'deadbeef', title: 'Cafe', payerId: a, createdAt: '2026-10-24T00:00:00.000Z', kind: 'receipt',
  items: [{ id: 'i1', name: 'Dal', price: 120.5, qty: 2, shares: { [a]: 1, [b]: 2 } }, { id: 'i2', name: 'Rice', price: 0, shares: {} }],
  tax: 5, tip: 0, instruction: 'split equally', imageKey: `${code}/deadbeef.jpg`, needsReview: true,
});
const expense = ({ a, b }) => ({
  id: 'cafe0001', title: 'Cab', payerId: b, createdAt: '2026-10-24T00:00:00.000Z', kind: 'expense',
  items: [{ id: 'i1', name: 'Cab', price: 300, shares: { [a]: 1, [b]: 1 } }], tax: 0, tip: 0, instruction: '',
});

test('PUT accepts a valid receipt bill and a valid expense bill', async () => {
  const res = await putBills((c) => [receipt(c), expense(c)]);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).bills.length, 2);
});

test('PUT keeps a valid imageKey unchanged', async () => {
  const { res, code } = await putOne((c) => receipt(c));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).bills[0].imageKey, `${code}/deadbeef.jpg`);
});

const badBills = [
  ['a bill that is not an object', () => 'x'],
  ['a bad bill id', (c) => ({ ...expense(c), id: 'XYZ' })],
  ['a title over 200 characters', (c) => ({ ...expense(c), title: 't'.repeat(201) })],
  ['a numeric title', (c) => ({ ...expense(c), title: 5 })],
  ['an unknown kind', (c) => ({ ...expense(c), kind: 'gift' })],
  ['an unknown payer', (c) => ({ ...expense(c), payerId: 'nobody' })],
  ['a payerId of toString', (c) => ({ ...expense(c), payerId: 'toString' })],
  ['items that are not an array', (c) => ({ ...expense(c), items: {} })],
  ['more than 100 items', (c) => ({ ...expense(c), items: Array.from({ length: 101 }, (_, i) => ({ id: `i${i}`, name: 'x', price: 1, shares: {} })) })],
  ['an imageKey for another bill', (c) => ({ ...expense(c), imageKey: `${c.code}/other000.jpg` })],
  ['an item without an id', (c) => ({ ...expense(c), items: [{ name: 'x', price: 1, shares: {} }] })],
  ['an item name over 100 characters', (c) => ({ ...expense(c), items: [{ id: 'i1', name: 'n'.repeat(101), price: 1, shares: {} }] })],
  ['shares that are an array', (c) => ({ ...expense(c), items: [{ id: 'i1', name: 'x', price: 1, shares: [] }] })],
];

for (const [label, make] of badBills) {
  test(`PUT rejects ${label} with 400`, async () => {
    const res = await putBills((c) => [make(c)]);
    assert.equal(res.status, 400);
    assert.equal(typeof (await res.json()).error, 'string');
  });
}

const putOne = async (bill) => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const [a, b] = current.members.map((m) => m.id);
  const res = await onRequestPut({
    request: jsonReq('PUT', { updatedAt: current.updatedAt, members: current.members, bills: [bill({ a, b, code })] }),
    params: { code },
    env,
  });
  return { res, a, b, env, code };
};

test('PUT drops unknown fields and clamps values', async () => {
  const { res, a } = await putOne((c) => ({
    ...expense(c), extra: 'x', warning: 'w', discount: -5, roundOff: 5000,
    items: [{ id: 'i1', name: 'Cab', price: 1e308, extra: 1, shares: { [c.a]: 99 } }],
  }));
  assert.equal(res.status, 200);
  const bill = (await res.json()).bills[0];
  assert.equal('extra' in bill, false);
  assert.equal('warning' in bill, false);
  assert.equal('extra' in bill.items[0], false);
  assert.equal(bill.items[0].price, 1e9);
  assert.equal(bill.items[0].shares[a], 10);
  assert.equal(bill.roundOff, 100);
  assert.equal(bill.discount, 0);
});

test('PUT fills v2 defaults on old bills', async () => {
  const { res } = await putOne(expense);
  const bill = (await res.json()).bills[0];
  assert.deepEqual(bill.split, { mode: 'items', byMember: {} });
  assert.equal(bill.taxMode, 'prorate');
  assert.equal(bill.discount, 0);
  assert.equal(bill.roundOff, 0);
});

test('PUT rejects bad split mode, clamps percent over 100', async () => {
  const bad = await putOne((c) => ({ ...expense(c), split: { mode: 'weird', byMember: {} } }));
  assert.equal(bad.res.status, 400);
  const { res, a } = await putOne((c) => ({ ...expense(c), split: { mode: 'percent', byMember: { [c.a]: 150 } } }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).bills[0].split.byMember[a], 100);
});

test('PUT rejects a bad taxMode with 400', async () => {
  const { res } = await putOne((c) => ({ ...expense(c), taxMode: 'weird' }));
  assert.equal(res.status, 400);
});

test('PUT rejects a title over 200 characters naming the title', async () => {
  const { res } = await putOne((c) => ({ ...expense(c), title: 't'.repeat(201) }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /title/);
});

test('PUT clamps negative tax, negative price, and negative or unknown shares', async () => {
  const { res, a } = await putOne((c) => ({
    ...expense(c), tax: -1, tip: '5',
    items: [{ id: 'i1', name: 'x', price: -1, shares: { [c.a]: 2, [c.b]: -1, ghost: 1, toString: 1 } }],
  }));
  assert.equal(res.status, 200);
  const bill = (await res.json()).bills[0];
  assert.equal(bill.tax, 0);
  assert.equal(bill.tip, 5);
  assert.equal(bill.items[0].price, 0);
  assert.deepEqual(bill.items[0].shares, { [a]: 2 });
});

test('PUT rejects a non-finite price with 400 and defaults a missing createdAt', async () => {
  const bad = await putOne((c) => ({ ...expense(c), items: [{ id: 'i1', name: 'x', price: 'abc', shares: {} }] }));
  assert.equal(bad.res.status, 400);
  const { res } = await putOne((c) => { const b = expense(c); delete b.createdAt; return b; });
  assert.equal(res.status, 200);
  assert.equal(typeof (await res.json()).bills[0].createdAt, 'string');
});

test('PUT accepts UI grid rows: blank name, price 0, qty, check, needsReview', async () => {
  const { res } = await putOne((c) => ({
    ...receipt(c),
    items: [{ id: 'n1', name: '', price: 0, qty: 3, check: true, shares: {} }],
  }));
  assert.equal(res.status, 200);
  const bill = (await res.json()).bills[0];
  assert.equal(bill.items[0].qty, 3);
  assert.equal(bill.items[0].check, true);
  assert.equal(bill.needsReview, true);
});

test('PUT rejects a member name over 40 characters and caps the trip name at 60', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const put = (extra, members = current.members) => onRequestPut({
    request: jsonReq('PUT', { updatedAt: current.updatedAt, members, bills: [], ...extra }),
    params: { code }, env,
  });
  const bad = await put({}, [{ ...current.members[0], name: 'm'.repeat(41) }, current.members[1]]);
  assert.equal(bad.status, 400);
  const ok = await put({ name: 'n'.repeat(100) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).name.length, 60);
});

test('PUT rejects more than 500 bills with 400', async () => {
  const res = await putBills((c) => Array.from({ length: 501 }, () => expense(c)));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /500 bills/);
});

test('PUT rejects more than 50 members with 400', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const extra = Array.from({ length: 49 }, (_, i) => ({ id: (i + 0x10000000).toString(16), name: `N${i}` }));
  const res = await onRequestPut({
    request: jsonReq('PUT', { updatedAt: current.updatedAt, members: [...current.members, ...extra], bills: [] }),
    params: { code },
    env,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /50 members/);
});

test('POST /api/trips rejects oversized body by Content-Length before reading', async () => {
  const res = await onRequestPost({
    request: new Request('http://x/api/trips', { method: 'POST', headers: { 'content-length': '70000', 'content-type': 'application/json' }, body: '{}' }),
    env: fakeEnv(),
  });
  assert.equal(res.status, 413);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('POST /api/trips 411 without Content-Length', async () => {
  const res = await onRequestPost({ request: { headers: new Headers() }, env: fakeEnv() });
  assert.equal(res.status, 411);
  assert.match((await res.json()).error, /Content-Length/);
});

test('PUT /api/trips/:code rejects oversized body by Content-Length', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const res = await onRequestPut({
    request: new Request('http://x/api/trips/x', { method: 'PUT', headers: { 'content-length': '524289', 'content-type': 'application/json' }, body: '{}' }),
    params: { code },
    env,
  });
  assert.equal(res.status, 413);
});

test('POST /api/trips caps trip name at 60 and member names at 40', async () => {
  const env = fakeEnv();
  const res = await onRequestPost({
    request: jsonReq('POST', { name: 'n'.repeat(100), members: ['m'.repeat(100), 'Priya'] }),
    env,
  });
  assert.equal(res.status, 201);
  const trip = JSON.parse(env.kv.get((await res.json()).code));
  assert.equal(trip.name.length, 60);
  assert.equal(trip.members[0].name.length, 40);
});

test('POST /api/trips rejects more than 50 members with 400', async () => {
  const members = Array.from({ length: 51 }, (_, i) => `M${i}`);
  const res = await onRequestPost({ request: jsonReq('POST', { name: 'Goa', members }), env: fakeEnv() });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'A trip can have at most 50 members' });
});

test('json() responses are nosniff and no-store', async () => {
  const res = json({ a: 1 });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('PUT stores members as {id, name} only, trimmed', async () => {
  const env = fakeEnv();
  const code = await createTrip(env);
  const current = await readTrip(env, code);
  const members = [{ ...current.members[0], name: '  Rohan  ', junk: 'x'.repeat(1000) }, current.members[1]];
  const res = await onRequestPut({
    request: jsonReq('PUT', { updatedAt: current.updatedAt, members, bills: [] }),
    params: { code }, env,
  });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.deepEqual(saved.members[0], { id: current.members[0].id, name: 'Rohan' });
  assert.deepEqual(Object.keys(saved.members[1]).sort(), ['id', 'name']);
});
