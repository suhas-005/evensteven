import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, normalizeReceipt, normalizeShares, readReceipt } from '../lib/ai.js';

test('normalizeReceipt reads rows with qty/rate/amount and flags mismatches', () => {
  const r = normalizeReceipt({ merchant: 'Easy Tiger', rows: [
    { name: 'Open Farm House', qty: 1, rate: 419, amount: 419 },
    { name: 'Fish Finger', qty: 1, rate: 369, amount: 738 },   // mismatch -> check
    { name: 'No amount', qty: 2, rate: 70 },                    // falls back to qty*rate
  ], subtotal: 1297, tax: 247.7, discount: 0, roundOff: 0.3, total: 1545 });
  assert.equal(r.items[0].price, 419); assert.equal(r.items[0].check, undefined);
  assert.equal(r.items[1].price, 738); assert.equal(r.items[1].check, true);
  assert.equal(r.items[2].price, 140);
  assert.equal(r.roundOff, 0.3); assert.equal(r.discount, 0);
});

test('normalizeReceipt uses discount and roundOff in the sum check', () => {
  const r = normalizeReceipt({ rows: [{ name: 'A', amount: 100 }], tax: 10, discount: 20, roundOff: 0, total: 90 });
  assert.equal(r.needsReview, false);
});

test('normalizeReceipt derives roundOff from printed totals over the model value', () => {
  const r = normalizeReceipt({ merchant: 'Easy Tiger', rows: [{ name: 'Bill', amount: 1297 }],
    subtotal: 1297, tax: 247.7, discount: 0, roundOff: -0.3, total: 1545 });
  assert.equal(r.roundOff, 0.3);
  assert.equal(r.needsReview, false);
});

test('normalizeReceipt keeps the clamped model roundOff and flags review when the derived value is out of range', () => {
  const r = normalizeReceipt({ rows: [{ name: 'Bill', amount: 100 }], subtotal: 100, tax: 0, roundOff: 150, total: 300 });
  assert.equal(r.roundOff, 100);
  assert.equal(r.needsReview, true);
});

test('normalizeReceipt keeps the model roundOff when there is no total', () => {
  const r = normalizeReceipt({ rows: [{ name: 'Bill', amount: 100 }], subtotal: 100, roundOff: -0.3 });
  assert.equal(r.roundOff, -0.3);
});

test('normalizeReceipt truncates item names to 100 characters', () => {
  const r = normalizeReceipt({ rows: [{ name: 'N'.repeat(150), amount: 5 }], subtotal: 5 });
  assert.equal(r.items[0].name.length, 100);
  assert.equal(r.needsReview, false);
});

test('readReceipt sends messages with image_url and honours env.VISION_MODEL and gateway', async () => {
  let seen;
  const env = { VISION_MODEL: '@cf/x/y', AI_GATEWAY_ID: 'gw', AI: { run: async (model, input, opts) => { seen = { model, input, opts }; return { response: '{"rows":[{"name":"T","amount":5}],"subtotal":5,"total":5}' }; } } };
  const r = await readReceipt(env, new Uint8Array([0xff, 0xd8, 0xff, 1]).buffer);
  assert.equal(seen.model, '@cf/x/y');
  assert.match(seen.input.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.deepEqual(seen.opts, { gateway: { id: 'gw' } });
  assert.equal(r.items[0].price, 5);
});

test('extractJson tolerates prose and code fences', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":{"b":"}"}}\n\nNote: {x} done'), { a: { b: '}' } });
  assert.throws(() => extractJson('no json here'));
  const isAns = (o) => Array.isArray(o.items);
  assert.deepEqual(extractJson('Example: {"items":[]}\nAnswer: {"merchant":"X","items":[1]}', (o) => o.items?.length), { merchant: 'X', items: [1] });
  assert.deepEqual(extractJson('Use {name} format. {"merchant":"X"}'), { merchant: 'X' });
  assert.deepEqual(extractJson('I saw a { here. {"merchant":"X"}'), { merchant: 'X' });
  assert.deepEqual(extractJson('{"a":1} then {"items":[2]} then {"b":2}', isAns), { items: [2] });
  assert.throws(() => extractJson('{"a":1}', isAns));
});

test('normalizeReceipt coerces numbers and flags mismatch', () => {
  const ok = normalizeReceipt({ merchant: 'Cafe', items: [{ name: 'Tea', price: '40' }, { name: 'Cake', price: 160, qty: 2 }], subtotal: 200, tax: 10, tip: 0, total: 210 });
  assert.equal(ok.merchant, 'Cafe');
  assert.deepEqual(ok.items, [{ name: 'Tea', price: 40 }, { name: 'Cake', price: 160, qty: 2 }]);
  assert.equal(ok.tax, 10);
  assert.equal(ok.needsReview, false);

  const bad = normalizeReceipt({ items: [{ name: 'Tea', price: 40 }], subtotal: 500 });
  assert.equal(bad.needsReview, true);

  const noSub = normalizeReceipt({ items: [{ name: 'Tea', price: 40 }], total: 50, tax: 10 });
  assert.equal(noSub.needsReview, false);
});

test('normalizeReceipt drops items without a positive price', () => {
  const r = normalizeReceipt({ items: [{ name: 'Free water', price: 0 }, { name: 'Tea', price: 40 }], subtotal: 40 });
  assert.equal(r.items.length, 1);
});

test('normalizeShares keeps only known members and positive weights', () => {
  const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const items = [{ id: 'i1', name: 'X', price: 10, shares: { a: 1 } }, { id: 'i2', name: 'Y', price: 20, shares: {} }];
  const out = normalizeShares(items, members, { items: [{ id: 'i1', shares: { a: 2, b: 'x', zzz: 1 } }] });
  assert.deepEqual(out[0].shares, { a: 2 });
  assert.deepEqual(out[1].shares, {});
});

test('normalizeShares keeps existing shares when model shares are unusable', () => {
  const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const prior = { a: 2, b: 1 };
  const mk = () => [{ id: 'i1', name: 'X', price: 10, shares: { ...prior } }];
  const cases = {
    'unknown ids only': { items: [{ id: 'i1', shares: { zzz: 1 } }] },
    'all-zero weights': { items: [{ id: 'i1', shares: { a: 0, b: 0 } }] },
    'empty shares object': { items: [{ id: 'i1', shares: {} }] },
    'shares as a string': { items: [{ id: 'i1', shares: 'a' }] },
  };
  for (const [label, raw] of Object.entries(cases)) {
    const out = normalizeShares(mk(), members, raw);
    assert.deepEqual(out[0].shares, prior, label);
  }
});

test('normalizeReceipt keeps the model roundOff and flags review when the derived gap exceeds 1', () => {
  const r = normalizeReceipt({ rows: [{ name: 'Bill', amount: 1000 }], subtotal: 1000, tax: 50, roundOff: 0, total: 1130 });
  assert.equal(r.roundOff, 0);
  assert.equal(r.needsReview, true);
});

test('normalizeReceipt clamps negative or huge tax, tip and discount to 0..money', () => {
  const r = normalizeReceipt({ rows: [{ name: 'A', amount: 100 }], tax: -5, tip: 5000000000, discount: 7000000000 });
  assert.equal(r.tax, 0); assert.equal(r.tip, 1e9); assert.equal(r.discount, 1e9);
});

test('normalizeShares clamps model weights to LIMITS.weight', () => {
  const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const items = [{ id: 'i1', name: 'X', price: 10, shares: {} }];
  const out = normalizeShares(items, members, { items: [{ id: 'i1', shares: { a: 12, b: 1e308 } }] });
  assert.deepEqual(out[0].shares, { a: 10, b: 10 });
});
