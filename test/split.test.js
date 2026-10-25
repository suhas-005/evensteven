import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimals, toMinor, fromMinor, format, billTotals, balances, settleUp, pairwiseDebts, tripStats } from '../public/split.js';

const members = [{ id: 'a', name: 'Asha' }, { id: 'b', name: 'Bala' }, { id: 'c', name: 'Chit' }];

test('decimals by currency', () => {
  assert.equal(decimals('INR'), 0);
  assert.equal(decimals('JPY'), 0);
  assert.equal(decimals('EUR'), 2);
});

test('toMinor / fromMinor round trip', () => {
  assert.equal(toMinor('12.34', 'EUR'), 1234);
  assert.equal(toMinor(1000, 'INR'), 1000);
  assert.equal(fromMinor(1234, 'EUR'), 12.34);
  assert.equal(toMinor('', 'INR'), 0);
});

test('format uses symbol and grouping', () => {
  assert.equal(format(124000, 'INR'), '₹1,24,000');
  assert.equal(format(123456, 'EUR'), '€1,234.56');
});

test('equal split sends rounding remainder to payer', () => {
  const bill = { payerId: 'a', items: [{ id: 'i1', name: 'Pizza', price: 1000, shares: {} }], tax: 0, tip: 0 };
  const t = billTotals(bill, members, 'INR');
  assert.deepEqual(t.perMember, { a: 334, b: 333, c: 333 });
  assert.equal(t.total, 1000);
});

test('weighted shares', () => {
  const bill = { payerId: 'c', items: [{ id: 'i1', name: 'Beer', price: 400, shares: { a: 2, b: 1 } }], tax: 0, tip: 0 };
  const t = billTotals(bill, members, 'INR');
  assert.deepEqual(t.perMember, { a: 267, b: 133, c: 0 });
});

test('tax and tip prorated by food share', () => {
  const bill = {
    payerId: 'a',
    items: [
      { id: 'i1', name: 'Steak', price: 1000, shares: { a: 1 } },
      { id: 'i2', name: 'Salad', price: 500, shares: { b: 1 } },
    ],
    tax: 150, tip: 0,
  };
  const t = billTotals(bill, members, 'INR');
  assert.deepEqual(t.perMember, { a: 1100, b: 550, c: 0 });
  assert.equal(t.total, 1650);
});

test('shares for unknown members are ignored', () => {
  const bill = { payerId: 'a', items: [{ id: 'i1', name: 'X', price: 300, shares: { zzz: 1 } }], tax: 0, tip: 0 };
  const t = billTotals(bill, members, 'INR');
  assert.deepEqual(t.perMember, { a: 100, b: 100, c: 100 });
});

test('balances net payer credit against shares', () => {
  const trip = {
    currency: 'INR', members,
    bills: [
      { payerId: 'a', items: [{ id: 'i1', name: 'Dinner', price: 900, shares: {} }], tax: 0, tip: 0 },
      { payerId: 'b', items: [{ id: 'i2', name: 'Cab', price: 300, shares: { a: 1, b: 1 } }], tax: 0, tip: 0 },
    ],
  };
  assert.deepEqual(balances(trip), { a: 450, b: -150, c: -300 });
});

test('settleUp produces minimal greedy transfers', () => {
  assert.deepEqual(settleUp({ a: 500, b: -200, c: -300 }), [
    { from: 'c', to: 'a', amount: 300 },
    { from: 'b', to: 'a', amount: 200 },
  ]);
  assert.deepEqual(settleUp({ a: 0, b: 0 }), []);
});

function checkSettle(net) {
  const t = settleUp(net);
  const owed = Object.fromEntries(Object.keys(net).map((k) => [k, 0]));
  for (const x of t) { assert.ok(x.amount > 0); owed[x.from] += x.amount; owed[x.to] -= x.amount; }
  for (const k of Object.keys(net)) assert.equal(owed[k], -net[k]);
  assert.ok(t.length <= Object.keys(net).length - 1);
  return t;
}

test('settleUp settles 2, 3 and 5 members including multiple creditors', () => {
  checkSettle({ a: 700, b: -700 });
  checkSettle({ a: 300, b: 200, c: -500 });
  checkSettle({ a: 900, b: -400, c: -500 });
  checkSettle({ a: 800, b: 300, c: -250, d: -450, e: -400 });
  checkSettle({ a: 600, b: 400, c: -100, d: -300, e: -600 });
});

test('format renders JPY with no decimals', () => {
  assert.equal(format(1500, 'JPY'), '¥1,500');
});

test('VND and IDR are zero-decimal currencies', () => {
  assert.equal(decimals('VND'), 0);
  assert.equal(decimals('IDR'), 0);
});

test('billTotals prorates tax with a rounding remainder that sums exactly', () => {
  const ms = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const bill = { payerId: 'b', items: [{ price: 100, shares: {} }], tax: 10, tip: 0 };
  const t = billTotals(bill, ms, 'INR');
  assert.equal(t.total, 110);
  assert.deepEqual(t.perMember, { a: 37, b: 36, c: 37 });
  assert.equal(Object.values(t.perMember).reduce((s, v) => s + v, 0), 110);
});

test('percent mode normalises percentages', () => {
  const bill = { payerId: 'a', items: [{ id: 'i', name: 'X', price: 1000, shares: {} }], tax: 0, tip: 0, split: { mode: 'percent', byMember: { a: 5, b: 3, c: 2 } } };
  assert.deepEqual(billTotals(bill, members, 'INR').perMember, { a: 500, b: 300, c: 200 });
});

test('amount mode charges the gap to the payer and reports it', () => {
  const bill = { payerId: 'a', items: [{ id: 'i', name: 'X', price: 1000, shares: {} }], tax: 0, tip: 0, split: { mode: 'amount', byMember: { b: 300, c: 300 } } };
  const t = billTotals(bill, members, 'INR');
  assert.deepEqual(t.perMember, { a: 400, b: 300, c: 300 });
  assert.equal(t.unassigned, 400);
});

test('equal tax mode splits extras evenly among participants', () => {
  const bill = { payerId: 'a', items: [{ id: 'i1', name: 'Steak', price: 1000, shares: { a: 1 } }, { id: 'i2', name: 'Salad', price: 500, shares: { b: 1 } }], tax: 150, tip: 0, taxMode: 'equal' };
  assert.deepEqual(billTotals(bill, members, 'INR').perMember, { a: 1075, b: 575, c: 0 });
});

test('discount reduces prorated extras; roundOff goes to payer', () => {
  const bill = { payerId: 'b', items: [{ id: 'i1', name: 'A', price: 1000, shares: { a: 1 } }, { id: 'i2', name: 'B', price: 1000, shares: { b: 1 } }], tax: 100, tip: 0, discount: 300, roundOff: 1 };
  const t = billTotals(bill, members, 'INR');
  assert.equal(t.total, 1801);
  assert.deepEqual(t.perMember, { a: 900, b: 901, c: 0 });
});

test('v1 bills without v2 fields are unchanged', () => {
  const bill = {
    payerId: 'b',
    items: [
      { id: 'i1', name: 'Dosa', price: 333, shares: { a: 1 } },
      { id: 'i2', name: 'Thali', price: 1000, shares: { b: 1, c: 1 } },
      { id: 'i3', name: 'Lassi', price: 250, shares: {} },
    ],
    tax: 71, tip: 13,
  };
  const t = billTotals(bill, members, 'INR');
  assert.deepEqual(t.perMember, { a: 438, b: 615, c: 614 });
  assert.equal(t.total, 1667);
  assert.equal(Object.values(t.perMember).reduce((s, v) => s + v, 0), 1667);
});

const sumOf = (o) => Object.values(o).reduce((s, v) => s + v, 0);

test('total is rounded once from major units: INR tax with paise plus roundOff', () => {
  const bill = { payerId: 'a', items: [{ id: 'i', name: 'X', price: 8854, shares: {} }], tax: 246.5, tip: 0, roundOff: 0.5 };
  const t = billTotals(bill, members, 'INR');
  assert.equal(t.total, 9101);
  assert.equal(sumOf(t.perMember), 9101);
});

test('total is rounded once from major units: INR items with paise sum to the printed 100', () => {
  const bill = { payerId: 'a', items: [{ id: '1', name: 'A', price: 33.5, shares: {} }, { id: '2', name: 'B', price: 33.5, shares: {} }, { id: '3', name: 'C', price: 33, shares: {} }], tax: 0, tip: 0 };
  const t = billTotals(bill, members, 'INR');
  assert.equal(t.total, 100);
  assert.equal(sumOf(t.perMember), 100);
});

test('JPY total and formatting', () => {
  const bill = { payerId: 'a', items: [{ id: 'i', name: 'X', price: 1000, shares: {} }], tax: 100, tip: 0 };
  const t = billTotals(bill, members, 'JPY');
  assert.equal(t.total, 1100);
  assert.equal(sumOf(t.perMember), 1100);
  assert.match(format(t.total, 'JPY'), /1,100/);
  assert.doesNotMatch(format(t.total, 'JPY'), /\./);
});

test('amount mode over-assignment makes the payer negative and members still sum to the total', () => {
  const bill = { payerId: 'a', items: [{ id: 'i', name: 'X', price: 1000, shares: {} }], tax: 0, tip: 0, split: { mode: 'amount', byMember: { b: 700, c: 700 } } };
  const t = billTotals(bill, members, 'INR');
  assert.equal(t.perMember.a, -400);
  assert.equal(sumOf(t.perMember), t.total);
});

test('all-zero percent falls back to an equal split', () => {
  const bill = { payerId: 'a', items: [{ id: 'i', name: 'X', price: 900, shares: {} }], tax: 0, tip: 0, split: { mode: 'percent', byMember: { a: 0, b: 0, c: 0 } } };
  assert.deepEqual(billTotals(bill, members, 'INR').perMember, { a: 300, b: 300, c: 300 });
});

test('roundOff combined with equal tax mode lands on the payer and sums to the total', () => {
  const bill = { payerId: 'a', items: [{ id: 'i1', name: 'Steak', price: 1000, shares: { a: 1 } }, { id: 'i2', name: 'Salad', price: 500, shares: { b: 1 } }], tax: 150, tip: 0, taxMode: 'equal', roundOff: -1 };
  const t = billTotals(bill, members, 'INR');
  assert.equal(t.total, 1649);
  assert.deepEqual(t.perMember, { a: 1074, b: 575, c: 0 });
});

test('pairwiseDebts nets each pair and drops zero pairs', () => {
  const trip = { currency: 'INR', members, bills: [
    { payerId: 'a', items: [{ id: 'i1', name: 'D', price: 900, shares: {} }], tax: 0, tip: 0 },           // b,c owe a 300 each
    { payerId: 'b', items: [{ id: 'i2', name: 'Cab', price: 200, shares: { a: 1, b: 1 } }], tax: 0, tip: 0 }, // a owes b 100
  ]};
  assert.deepEqual(pairwiseDebts(trip), [
    { from: 'c', to: 'a', amount: 300 },
    { from: 'b', to: 'a', amount: 200 },
  ]);
});
test('pairwiseDebts empty when settled', () => { assert.deepEqual(pairwiseDebts({ currency: 'INR', members, bills: [] }), []); });
test('tripStats totals, per head, biggest, paid most', () => {
  const trip = { currency: 'INR', members, bills: [
    { title: 'Dinner', payerId: 'a', items: [{ id: 'i1', name: 'D', price: 900, shares: {} }], tax: 0, tip: 0 },
    { title: 'Cab', payerId: 'b', items: [{ id: 'i2', name: 'C', price: 300, shares: {} }], tax: 0, tip: 0 },
    { title: 'Snacks', payerId: 'b', items: [{ id: 'i3', name: 'S', price: 700, shares: {} }], tax: 0, tip: 0 },
  ]};
  const s = tripStats(trip);
  assert.equal(s.total, 1900); assert.equal(s.perHead, 633); assert.equal(s.bills, 3);
  assert.deepEqual(s.biggest, { amount: 900, title: 'Dinner' });
  assert.deepEqual(s.paidMost, { amount: 1000, memberId: 'b' });
});
test('tripStats on empty trip', () => {
  assert.deepEqual(tripStats({ currency: 'INR', members, bills: [] }), { total: 0, perHead: 0, biggest: null, paidMost: null, bills: 0 });
});

test('pairwiseDebts keeps negative shares from a discount larger than the subtotal', () => {
  const trip = { currency: 'INR', members, bills: [
    { payerId: 'a', items: [{ id: 'i1', name: 'X', price: 100, shares: { a: 1, b: 1, c: 1 } }], tax: 0, tip: 0, discount: 150 },
    { payerId: 'b', items: [], tax: 0, tip: 0 },
  ]};
  assert.deepEqual(balances(trip), { a: -34, b: 17, c: 17 });
  assert.deepEqual(pairwiseDebts(trip), [
    { from: 'a', to: 'b', amount: 17 },
    { from: 'a', to: 'c', amount: 17 },
  ]);
});

test('pairwiseDebts reconciles with balances for mixed bills', () => {
  const trip = { currency: 'INR', members, bills: [
    { payerId: 'a', items: [{ id: 'i1', name: 'A', price: 900, shares: { a: 1, b: 2 } }, { id: 'i2', name: 'B', price: 300, shares: {} }], tax: 0, tip: 0 },
    { payerId: 'b', items: [{ id: 'i3', name: 'P', price: 1000, shares: {} }], tax: 0, tip: 0, split: { mode: 'percent', byMember: { a: 5, b: 3, c: 2 } } },
    { payerId: 'c', items: [{ id: 'i4', name: 'X', price: 1000, shares: {} }], tax: 0, tip: 0, split: { mode: 'amount', byMember: { a: 700, b: 700 } } },
    { payerId: 'a', items: [{ id: 'i5', name: 'Y', price: 100, shares: { a: 1, b: 1, c: 1 } }], tax: 0, tip: 0, discount: 150 },
    { payerId: 'b', items: [{ id: 'i6', name: 'Z', price: 100, shares: {} }], tax: 10, tip: 0, roundOff: -1 },
  ]};
  const debts = pairwiseDebts(trip);
  assert.ok(debts.length > 0);
  const net = balances(trip);
  const flow = Object.fromEntries(members.map((m) => [m.id, 0]));
  for (const d of debts) { flow[d.to] += d.amount; flow[d.from] -= d.amount; }
  for (const m of members) assert.equal(flow[m.id], net[m.id], `member ${m.id}`);
});
