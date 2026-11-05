import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../js/core/dates.js';
import { setCatalog } from '../js/core/schema.js';
import {
  availableItems, correlation, defaultKeys, foodKey, foodWords, itemOf, pairSummary, pairSummaries, prepare, rangeDates, seriesOf, valueWords,
} from '../js/screens/compare-data.js';

const TODAY = '2026-10-14';
const dates = rangeDates(TODAY, 30);
const log = (x = {}) => ({ v: 2, notes: 'x', ...x });
const meals = text => ({ breakfast: { time: '', text: '' }, lunch: { time: '', text }, dinner: { time: '', text: '' } });

setCatalog({ v: 1, counters: [{ id: 'c_tea', name: 'Tea', one: 'cup', many: 'cups' }], measurements: [{ id: 'c_pain', name: 'Pain', unit: '/10', min: 0, max: 10, step: 1 }] });

test('rangeDates: oldest first, ends today', () => {
  assert.equal(dates.length, 30);
  assert.equal(dates[29], TODAY);
  assert.equal(dates[0], addDays(TODAY, -29));
});

test('itemOf: valid keys only', () => {
  assert.equal(itemOf('m:weight').label, 'Weight');
  assert.equal(itemOf('h:sleep').kind, 'num');
  assert.equal(itemOf('c:c_tea').label, 'Tea');
  assert.equal(itemOf('s:headache').label, 'Headache');
  assert.equal(itemOf('s:*').label, 'Any symptom');
  assert.equal(itemOf('f:pizza').kind, 'event');
  assert.equal(itemOf('m:c_gone'), null);
  assert.equal(itemOf('x:1'), null);
  assert.equal(itemOf(''), null);
  assert.equal(foodKey('  Crème  BRÛLÉE! '), 'creme brulee');
});

test('series: measurements per day (mean), blood pressure has two numbers, unknown is null', () => {
  const meas = [
    { type: 'weight', date: TODAY, value: 78 }, { type: 'weight', date: TODAY, value: 79 },
    { type: 'bp', date: addDays(TODAY, -1), value: { sys: 130, dia: 80 } },
  ];
  const p = prepare([], meas, TODAY);
  assert.deepEqual(seriesOf(itemOf('m:weight'), p, [addDays(TODAY, -1), TODAY]).values, [null, 78.5]);
  const bp = seriesOf(itemOf('m:bp'), p, [addDays(TODAY, -1), TODAY]);
  assert.deepEqual(bp.values, [130, null]);
  assert.deepEqual(bp.values2, [80, null]);
  assert.equal(valueWords(itemOf('m:bp'), bp, 0), '130/80 mmHg');
});

test('series: symptoms, food and counters know "no diary" from "no"', () => {
  const days = [
    { date: addDays(TODAY, -2), log: log({ symptoms: [{ name: 'Headache', severity: 2 }, { name: 'headache ', severity: 3 }], meals: meals('Pizzas and salad'), drinks: { coffee: 3 } }) },
    { date: addDays(TODAY, -1), log: log({ symptoms: [{ name: 'Fatigue' }], meals: meals('Crème brûlée') , drinks: { coffee: 0 } }) },
    { date: TODAY, log: null, health: { steps: 100, sleep: { total: 400 } } },
  ];
  const p = prepare(days, [], TODAY);
  const d3 = dates.slice(-3);
  assert.deepEqual(seriesOf(itemOf('s:headache'), p, d3).values, [3, 0, null]);
  assert.deepEqual(seriesOf(itemOf('s:*'), p, d3).values, [3, -1, null]);
  assert.deepEqual(seriesOf(itemOf('f:pizza'), p, d3).values, [1, 0, null]);
  assert.deepEqual(seriesOf(itemOf('f:creme'), p, d3).values, [0, 1, null], 'accents do not matter');
  assert.deepEqual(seriesOf(itemOf('f:izza'), p, d3).values, [0, 0, null], 'start of a word only');
  assert.deepEqual(seriesOf(itemOf('c:coffee'), p, d3).values, [3, 0, null]);
  // Today: last night's sleep counts, today's steps are not complete.
  assert.deepEqual(seriesOf(itemOf('h:sleep'), p, d3).values, [null, null, 400]);
  assert.deepEqual(seriesOf(itemOf('h:steps'), p, d3).values, [null, null, null]);
  assert.equal(valueWords(itemOf('s:*'), seriesOf(itemOf('s:*'), p, d3), 1), 'Severity not set');
  assert.equal(valueWords(itemOf('f:pizza'), seriesOf(itemOf('f:pizza'), p, d3), 2), 'No meal written');
});

test('food words: on 3 days or more, no small words', () => {
  const days = [0, 1, 2, 3].map(i => ({ date: addDays(TODAY, -i), log: log({ meals: meals(i < 3 ? 'Pasta with tomato and a green salad, coffee, tea' : 'Rice') }) }));
  const words = foodWords(prepare(days, [], TODAY), dates).map(w => w.word);
  assert.deepEqual(words, ['pasta', 'salad', 'tomato'], 'no small words, adjectives or counter names');
});

test('correlation', () => {
  assert.equal(Math.round(correlation([1, 2, 3, 4], [2, 4, 6, 8]) * 100) / 100, 1);
  assert.equal(Math.round(correlation([1, 2, 3, 4], [8, 6, 4, 2]) * 100) / 100, -1);
  assert.equal(correlation([1, 2], [1, 2]), null);
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), null);
});

// 20 days: short sleep on even days, with a headache and more coffee.
const sample = () => dates.slice(-20).map((date, i) => ({
  date,
  log: log({ symptoms: i % 2 ? [] : [{ name: 'Headache', severity: 1 }], drinks: { coffee: i % 2 ? 1 : 4 }, meals: meals(i % 2 ? 'Soup' : 'Pizza') }),
  health: { sleep: { total: i % 2 ? 450 : 360 } },
}));

test('pairs: a number and an event compare medians; two numbers give r; two events give shares', () => {
  const p = prepare(sample(), [], TODAY);
  const items = ['h:sleep', 's:headache', 'c:coffee', 'f:pizza'].map(itemOf);
  const series = items.map(it => seriesOf(it, p, dates));
  const [sh, sc, sp, hc, hp, cp] = pairSummaries(items, series);
  assert.equal(sh.type, 'num-event');
  assert.equal(sh.yes.value, 360);
  assert.equal(sh.no.value, 450);
  assert.match(sh.text, /Sleep \(median\): 6h00 on the 10 days with headache, 7h30 on the 10 other days\./);
  assert.equal(sc.type, 'num-num');
  assert.equal(Math.round(sc.r), -1);
  assert.match(sc.text, /When sleep is higher, coffee is often lower \(clear link, 20 days, r = −1\.00\)/);
  assert.equal(sp.type, 'num-event');
  assert.match(sp.text, /with pizza in a meal/);
  assert.equal(hc.type, 'num-event', 'event first is turned around');
  assert.equal(hc.a.key, 'c:coffee');
  assert.match(hc.text, /^Coffee \(average\): 4\.0 cups on the 10 days with headache, 1\.0 cups on the 10 other days\.$/);
  assert.equal(hp.type, 'event-event');
  assert.equal(hp.a.key, 'f:pizza', 'food first, symptom second');
  assert.match(hp.text, /Headache: on 10 of 10 days with pizza in a meal \(100%\), on 0 of 10 other days \(0%\)\./);
  assert.equal(cp.b.key, 'f:pizza');
});

test('pairs: few days are said, not computed', () => {
  const p = prepare(sample().slice(0, 4), [], TODAY);
  const a = itemOf('h:sleep'), b = itemOf('c:coffee');
  const s = pairSummary(a, seriesOf(a, p, dates), b, seriesOf(b, p, dates));
  assert.equal(s.type, 'few');
  assert.match(s.text, /only 4 days with both/);
});

test('available items and the first choice', () => {
  const p = prepare(sample(), [{ type: 'c_pain', date: TODAY, value: 3 }], TODAY);
  const av = availableItems(p, dates);
  const names = av.groups.map(g => g.name);
  assert.deepEqual(names, ['Measurements', 'Apple Health', 'Counters', 'Symptoms', 'Food']);
  assert.deepEqual(av.groups[0].items.map(i => i.key), ['m:c_pain']);
  assert.ok(!av.groups[2].items.some(i => i.key === 'c:water'), 'no counter without values');
  assert.deepEqual(av.groups[3].items.map(i => [i.key, i.days]), [['s:headache', 10]], 'no "Any symptom" with one symptom');
  assert.deepEqual(defaultKeys(av), ['h:sleep', 's:headache']);
  assert.deepEqual(defaultKeys(availableItems(prepare([], [], TODAY), dates)), []);
});
