import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFees, normalizeFeePolicy } from './fee-policy.js';
test('default 50 percent and inclusive boundary', () => {
  assert.equal(evaluateFees(0.5, 0.25).allowed, true);
  assert.equal(evaluateFees(0.5, 0.250001).allowed, false);
});
test('adjustable percentage', () => {
  assert.equal(evaluateFees(0.5, 0.051, { maxFeePercent: 10 }).allowed, false);
});
test('optional USD ceiling uses stricter limit', () => {
  const p = { strictUsdEnabled: true, maxFeeUsd: 0.02 };
  assert.equal(evaluateFees(0.5, 0.021, p).allowed, false);
  assert.equal(evaluateFees(0.5, 0.02, p).allowed, true);
  assert.equal(evaluateFees(0.5, 0.1, { ...p, strictUsdEnabled: false }).allowed, true);
});
test('invalid settings and unknown costs fail closed', () => {
  for (const maxFeePercent of [51, -1, NaN, '50']) assert.throws(() => normalizeFeePolicy({ maxFeePercent }));
  assert.throws(() => evaluateFees(0.5, NaN));
  assert.throws(() => evaluateFees(0.5, -1));
  assert.throws(() => normalizeFeePolicy({ strictUsdEnabled: 'false' }));
  assert.throws(() => normalizeFeePolicy({ maxFeeUsd: 0 }));
});
