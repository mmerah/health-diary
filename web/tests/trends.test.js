import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../js/core/dates.js';
import { CELL, changeWords, inRange, sortByTime, symptomGrid, trendSummary, weeklyMedians, weeklySymptomSummary, weightChange } from '../js/screens/trends-data.js';

const TODAY = '2026-10-14';

test('range filter and weight change', () => {
  const list = sortByTime([
    { date: addDays(TODAY, -3), value: 77.2 }, { date: addDays(TODAY, -200), value: 79 }, { date: addDays(TODAY, -60), value: 78.5 },
  ]);
  assert.equal(list[0].value, 79);
  assert.equal(inRange(list, '3m', TODAY).length, 2);
  assert.equal(inRange(list, 'all', TODAY).length, 3);
  const c = weightChange(inRange(list, '3m', TODAY));
  assert.equal(c.delta, -1.3);
  assert.equal(changeWords(c, d => d), `Down 1.3 kg since ${addDays(TODAY, -60)}`);
  assert.equal(weightChange([list[0]]), null);
});

test('weeklyMedians: 8 weeks, oldest first, gaps are null', () => {
  const days = [
    { date: TODAY, health: { steps: 1000, restingHr: 60, sleep: { total: 400 } } },
    { date: addDays(TODAY, -1), health: { steps: 3000, restingHr: 62, sleep: { total: 420 } } },
    { date: addDays(TODAY, -2), health: { steps: 2000, sleep: { total: 100, inBedOnly: true } } },
    { date: addDays(TODAY, -30), log: {}, health: null },
  ];
  const w = weeklyMedians(days, TODAY, 8);
  assert.equal(w.length, 8);
  assert.equal(w[7].end, TODAY);
  assert.equal(w[7].steps, 2000);
  assert.equal(w[7].restingHr, 61);
  assert.equal(w[7].sleep, 410); // the in-bed-only night is left out
  assert.equal(w[0].steps, null);
});

test('symptomGrid: rows by frequency, worst severity, no-entry days', () => {
  const log = symptoms => ({ v: 2, notes: 'x', symptoms });
  const days = [
    { date: TODAY, log: log([{ name: 'Headache', severity: 1 }, { name: 'headache ', severity: 3 }]) },
    { date: addDays(TODAY, -1), log: log([{ name: 'Fatigue', severity: null }, { name: 'Headache', severity: 2 }]) },
    { date: addDays(TODAY, -2), log: log([]) },
  ];
  const g = symptomGrid(days, TODAY, { weeks: 8, maxRows: 6 });
  assert.equal(g.dates.length, 56);
  assert.equal(g.dates[55], TODAY);
  assert.deepEqual(g.rows.map(r => r.name), ['Headache', 'Fatigue']);
  const h = g.rows[0];
  assert.equal(h.cells[55], 3);
  assert.equal(h.cells[54], 2);
  assert.equal(h.cells[53], CELL.NONE);
  assert.equal(h.cells[0], CELL.NO_ENTRY);
  assert.equal(g.rows[1].cells[54], CELL.NOT_SET);
  const weeks = weeklySymptomSummary(h, g.dates);
  assert.equal(weeks.length, 8);
  assert.deepEqual(weeks[7], { start: addDays(TODAY, -6), days: 2, worst: 3 });
});

test('symptomGrid keeps at most maxRows rows', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const days = [{ date: TODAY, log: { symptoms: names.map(name => ({ name, severity: 1 })) } }];
  const g = symptomGrid(days, TODAY, { maxRows: 6 });
  assert.equal(g.rows.length, 6);
  assert.equal(g.more, 1);
});

test('trendSummary: latest values, 30-day blood pressure average, recent temperature only', () => {
  const ms = [
    { type: 'weight', date: addDays(TODAY, -40), value: 79 }, { type: 'weight', date: addDays(TODAY, -2), value: 78 },
    { type: 'bp', date: addDays(TODAY, -60), value: { sys: 150, dia: 95 } },
    { type: 'bp', date: addDays(TODAY, -10), value: { sys: 120, dia: 80 } }, { type: 'bp', date: addDays(TODAY, -1), value: { sys: 131, dia: 85 } },
    { type: 'temp', date: addDays(TODAY, -20), value: 38.2 },
  ];
  const days = [
    { date: TODAY, health: { sleep: { total: 400 } }, log: { symptoms: [{ name: 'Headache' }] } },
    { date: addDays(TODAY, -1), health: { sleep: { total: 440 } }, log: { symptoms: [] } },
    { date: addDays(TODAY, -40), log: { symptoms: [{ name: 'Fatigue' }] } },
  ];
  const s = trendSummary(ms, days, TODAY, '3m');
  assert.equal(s.weight.last.value, 78);
  assert.equal(s.weight.change.delta, -1);
  assert.deepEqual(s.bp.avg, { sys: 126, dia: 83 }); // 125.5 and 82.5, rounded
  assert.equal(s.bp.n, 2);
  assert.equal(s.temp, null); // 20 days old: not recent
  assert.equal(s.sleep.median, 420);
  assert.equal(s.symptomDays, 1);
});
