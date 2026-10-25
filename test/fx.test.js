import { test } from 'node:test'; import assert from 'node:assert/strict';
import { planDigits } from '../public/fx.js';
test('planDigits aligns right, marks non-digits static', () => {
  const p = planDigits('₹90', '₹1,240');
  assert.deepEqual(p.map((d) => d.ch), ['₹', '1', ',', '2', '4', '0']);
  assert.equal(p[0].static, true); assert.equal(p[2].static, true);
  assert.deepEqual(p[5], { ch: '0', from: 0, to: 0, static: false });
  assert.deepEqual(p[4], { ch: '4', from: 9, to: 4, static: false });   // right-aligned: '9' of 90 maps under '4' of 1,240
  assert.deepEqual(p[1], { ch: '1', from: 0, to: 1, static: false });   // missing digits roll from 0
});
test('planDigits shrinking number rolls surplus digits away', () => {
  const p = planDigits('₹1,240', '₹90');
  assert.deepEqual(p.map((d) => d.ch), ['₹', '9', '0']);
  assert.deepEqual(p[2], { ch: '0', from: 0, to: 0, static: false });
  assert.deepEqual(p[1], { ch: '9', from: 4, to: 9, static: false });
});
test('planDigits handles negative values from format', () => {
  const p = planDigits('₹5,000', '-₹5,000');
  assert.deepEqual(p.map((d) => d.ch), ['-', '₹', '5', ',', '0', '0', '0']);
  assert.equal(p[0].static, true);
  assert.deepEqual(p[2], { ch: '5', from: 5, to: 5, static: false });
});
