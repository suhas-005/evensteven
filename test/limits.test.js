import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, clamp, str, contentLengthProblem } from '../lib/limits.js';

const req = (len) => new Request('http://x/', { method: 'POST', headers: len === undefined ? {} : { 'content-length': String(len) } });

test('clamp bounds and rejects non-finite', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(1e308, 0, 10), 10);
  assert.equal(clamp('x', 0, 10), null);
  assert.equal(clamp(NaN, 0, 10), null);
});

test('str trims and truncates', () => {
  assert.equal(str('  hi  ', 10), 'hi');
  assert.equal(str('a'.repeat(50), 10).length, 10);
  assert.equal(str(undefined, 10), '');
});

test('contentLengthProblem', () => {
  assert.match(contentLengthProblem(req(undefined), 100), /Content-Length/);
  assert.match(contentLengthProblem(req(101), 100), /too large/i);
  assert.equal(contentLengthProblem(req(100), 100), null);
  assert.equal(LIMITS.bodyParse, 1_572_864);
});
