import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules } from '../lib/rules.js';

const members = [{ id: 'a', name: 'Rohan' }, { id: 'b', name: 'Priya' }, { id: 'c', name: 'Sam' }];
const items = () => [
  { id: 'i1', name: 'Chicken Biryani', price: 450, shares: {} },
  { id: 'i2', name: 'Paneer Tikka', price: 320, shares: {} },
  { id: 'i3', name: 'Tiramisu', price: 280, shares: {} },
];

test('empty instruction splits everything equally', () => {
  const { items: out, leftover } = applyRules(items(), members, '');
  assert.deepEqual(leftover, []);
  for (const it of out) assert.deepEqual(it.shares, { a: 1, b: 1, c: 1 });
});

test('split equally is consumed', () => {
  const { items: out, leftover } = applyRules(items(), members, 'split equally');
  assert.deepEqual(leftover, []);
  assert.deepEqual(out[0].shares, { a: 1, b: 1, c: 1 });
});

test('skipped removes member from matching item only', () => {
  const { items: out, leftover } = applyRules(items(), members, 'Priya skipped the biryani');
  assert.deepEqual(leftover, []);
  assert.deepEqual(out[0].shares, { a: 1, c: 1 });
  assert.deepEqual(out[1].shares, { a: 1, b: 1, c: 1 });
});

test('only had restricts member to matching items', () => {
  const { items: out, leftover } = applyRules(items(), members, 'Sam only had tiramisu, rest equally');
  assert.deepEqual(leftover, []);
  assert.deepEqual(out[0].shares, { a: 1, b: 1 });
  assert.deepEqual(out[1].shares, { a: 1, b: 1 });
  assert.deepEqual(out[2].shares, { a: 1, b: 1, c: 1 });
});

test('unknown clauses go to leftover, known ones still apply', () => {
  const { items: out, leftover } = applyRules(items(), members, 'Rohan is veg, Priya skipped the tiramisu');
  assert.deepEqual(leftover, ['rohan is veg']);
  assert.deepEqual(out[2].shares, { a: 1, c: 1 });
});

test('member name matches by prefix, case-insensitive', () => {
  const { items: out } = applyRules(items(), members, 'pri didn\'t have paneer');
  assert.deepEqual(out[1].shares, { a: 1, c: 1 });
});

test('existing shares are kept when no equal keyword and items not mentioned', () => {
  const start = items();
  start[0].shares = { a: 2, b: 1 };
  const { items: out } = applyRules(start, members, 'Sam skipped tiramisu');
  assert.deepEqual(out[0].shares, { a: 2, b: 1 });
  assert.deepEqual(out[2].shares, { a: 1, b: 1 });
});

for (const phrase of ['rest equally', 'everything else equally', 'others equally', 'rest split equally', 'rest is equally']) {
  test(`"${phrase}" fills unassigned items and leaves no leftover`, () => {
    const start = items();
    start[0].shares = { a: 2 };
    const { items: out, leftover } = applyRules(start, members, phrase);
    assert.deepEqual(leftover, []);
    assert.deepEqual(out[0].shares, { a: 2 });
    assert.deepEqual(out[1].shares, { a: 1, b: 1, c: 1 });
    assert.deepEqual(out[2].shares, { a: 1, b: 1, c: 1 });
  });
}

test("the spec's example sentence leaves only the veg clause and excludes Priya from the biryani", () => {
  const r = applyRules(items(), members, 'split this, Rohan is veg, Priya skipped the biryani, rest equally');
  assert.deepEqual(r.leftover, ['rohan is veg']);
  const biryani = r.items.find((i) => i.id === 'i1');
  assert.equal(biryani.shares.b, undefined);
  assert.deepEqual(Object.keys(biryani.shares).sort(), ['a', 'c']);
});
