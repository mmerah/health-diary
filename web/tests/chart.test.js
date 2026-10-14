import test from 'node:test';
import assert from 'node:assert/strict';
import { linePath, nearestIndex, niceStep, scale, stepIndex, timeTicks, yDomain, DAY_MS } from '../js/screens/chart.js';

test('niceStep picks 1, 2, 2.5, 5 × 10^n', () => {
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.3), 2);
  assert.equal(niceStep(2.2), 2.5);
  assert.equal(niceStep(34), 50);
  assert.equal(niceStep(0), 1);
});

test('yDomain keeps a minimum span and nice ticks around the data', () => {
  const d = yDomain([77.1, 78.6], { minSpan: 4 });
  assert.ok(d.hi - d.lo >= 4);
  assert.ok(d.lo <= 77.1 && d.hi >= 78.6);
  assert.equal(d.ticks[0], d.lo);
  assert.equal(d.ticks[d.ticks.length - 1], d.hi);
  assert.ok(d.ticks.length >= 3 && d.ticks.length <= 6);
});

test('yDomain chooses a tight range for blood pressure', () => {
  const d = yDomain([78, 150, 70, 142], { minSpan: 40 });
  assert.ok(d.hi - d.lo <= 110, `range ${d.lo}–${d.hi} is too wide`);
  assert.ok(d.lo <= 70 && d.hi >= 150);
});

test('yDomain with no values does not throw', () => {
  const d = yDomain([null, NaN], { minSpan: 4 });
  assert.ok(d.ticks.length >= 2);
});

test('scale maps the domain to the range', () => {
  const s = scale(0, 10, 100, 200);
  assert.equal(s(0), 100);
  assert.equal(s(5), 150);
  assert.equal(s(10), 200);
});

test('timeTicks gives 2 to 4 ticks with both ends', () => {
  const t0 = new Date(2026, 0, 1).getTime(), t1 = new Date(2026, 5, 1).getTime();
  const t = timeTicks(t0, t1, 4);
  assert.equal(t.length, 4);
  assert.equal(t[0], t0);
  assert.equal(t[3], t1);
  assert.equal(timeTicks(t0, t0 + DAY_MS, 4).length, 2);
  assert.equal(timeTicks(t0, t0, 4).length, 1);
});

test('nearestIndex and stepIndex for pointer and keys', () => {
  assert.equal(nearestIndex([0, 10, 20], 14), 1);
  assert.equal(nearestIndex([0, 10, 20], 16), 2);
  assert.equal(stepIndex('ArrowRight', 0, 3), 1);
  assert.equal(stepIndex('ArrowRight', 2, 3), 2);
  assert.equal(stepIndex('ArrowLeft', 0, 3), 0);
  assert.equal(stepIndex('ArrowLeft', -1, 3), 2);
  assert.equal(stepIndex('Home', 2, 3), 0);
  assert.equal(stepIndex('End', 0, 3), 2);
  assert.equal(stepIndex('a', 0, 3), null);
});

test('linePath breaks at missing values', () => {
  assert.equal(linePath([[0, 0], [1, 1], null, [3, 3], [4, 4]]), 'M0.0,0.0L1.0,1.0M3.0,3.0L4.0,4.0');
  assert.equal(linePath([[0, NaN]]), '');
});
