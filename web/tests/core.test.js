// Tests for the shared base: dates, text helpers and the data model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as D from '../js/core/dates.js';
import { duration, esc, listJoin, plural } from '../js/core/format.js';
import {
  activeMeds, describeWhen, hasContent, mealAt, mergeHealth, normalizeLog, normalizeProfile, parseMeasurement, periodOf,
} from '../js/core/schema.js';

test('dates: add, diff and validity across month and year ends', () => {
  assert.equal(D.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(D.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(D.diffDays('2026-10-14', '2026-10-01'), 13);
  assert.equal(D.diffDays('2026-03-30', '2026-03-28'), 2); // across the spring clock change in Europe
  assert.ok(D.isValidDate('2024-02-29'));
  assert.ok(!D.isValidDate('2026-02-29'));
  assert.ok(!D.isValidDate('2026-13-01'));
  assert.equal(D.ageOn('1991-03-14', '2026-03-13'), 34);
  assert.equal(D.ageOn('1991-03-14', '2026-03-14'), 35);
  assert.equal(D.minToHm(1500), '01:00');
  assert.ok(D.isValidTime('23:59') && D.isValidTime('') && !D.isValidTime('24:00'));
});

test('format: escaping, durations, plurals', () => {
  assert.equal(esc('<img src=x onerror="a">'), '&lt;img src=x onerror=&quot;a&quot;&gt;');
  assert.equal(esc(0), '0');
  assert.equal(esc(null), '');
  assert.equal(duration(425), '7h05');
  assert.equal(plural(1, 'cup'), '1 cup');
  assert.equal(plural(2, 'glass', 'glasses'), '2 glasses');
  assert.equal(listJoin(['a', 'b', 'c']), 'a, b and c');
});

test('schema: meal and part of the day for a time', () => {
  assert.equal(mealAt('07:30').key, 'breakfast');
  assert.equal(mealAt('12:10').key, 'lunch');
  assert.equal(mealAt('19:00').key, 'dinner');
  assert.equal(mealAt('02:00').key, 'dinner');
  assert.equal(periodOf('05:59'), 'night');
  assert.equal(periodOf('06:00'), 'morning');
  assert.equal(periodOf('23:00'), 'night');
});

test('schema: version 1 logs become version 2', () => {
  const old = {
    meals: { breakfast: { time: '07:30', text: 'Eggs' } },
    drinks: { water: 3, coffee: 0 },
    meds: { taken: { 'Magnesium 300 mg, evening': true } },
    symptoms: ['Headache', { name: 'Fatigue', severity: 2, time: '15:00' }],
    feeling: 6,
  };
  const log = normalizeLog(old);
  assert.equal(log.v, 2);
  assert.deepEqual(log.meals.lunch, { time: '', text: '' });
  assert.equal(log.drinks.water, 3);
  assert.equal(log.drinks.coffee, 0);
  assert.equal(log.drinks.alcohol, null); // not recorded, not zero
  assert.equal(log.symptoms[0].severity, null);
  assert.deepEqual([log.symptoms[1].when, log.symptoms[1].from], ['time', '15:00']);
  assert.equal(log.feeling, undefined);
  // The old medication line and the migrated profile medication share one id.
  const profile = normalizeProfile({ medications: 'Magnesium 300 mg, evening\n\nVitamin D' });
  assert.equal(profile.medications.length, 2);
  assert.deepEqual(log.meds.taken[profile.medications[0].id], { done: true, time: '' });
});

test('schema: bad values are dropped, not trusted', () => {
  const log = normalizeLog({ meals: { breakfast: { time: '<b>', text: 5 } }, symptoms: [{ name: '', severity: 9 }] });
  assert.deepEqual(log.meals.breakfast, { time: '', text: '' });
  assert.equal(log.symptoms.length, 0);
});

test('schema: content detection', () => {
  assert.ok(!hasContent(null));
  assert.ok(!hasContent(normalizeLog({})));
  assert.ok(hasContent({ drinks: { water: 0 } })); // "none" is an answer
  assert.ok(hasContent({ symptoms: [{ name: 'Headache' }] }));
});

test('schema: active medications on a date', () => {
  const p = normalizeProfile({ medications: [
    { id: 'a', name: 'A', since: '2026-01-01' },
    { id: 'b', name: 'B', since: '2026-01-01', until: '2026-02-01' },
    { id: 'c', name: 'C', asNeeded: true },
  ] });
  assert.deepEqual(activeMeds(p, '2026-01-15').map(m => m.id), ['a', 'b']);
  assert.deepEqual(activeMeds(p, '2026-03-01').map(m => m.id), ['a']);
  assert.deepEqual(activeMeds(p, '2025-12-31').map(m => m.id), []);
});

test('schema: measurements are checked against their limits', () => {
  assert.deepEqual(parseMeasurement('weight', { kg: '76,45' }), { value: 76.5 });
  assert.match(parseMeasurement('weight', { kg: '7' }).error, /20 to 300/);
  assert.match(parseMeasurement('bp', { sys: '80', dia: '120', pulse: '' }).error, /higher/);
  assert.deepEqual(parseMeasurement('bp', { sys: '128', dia: '82', pulse: '' }), { value: { sys: 128, dia: 82, pulse: null } });
  assert.match(parseMeasurement('temp', { c: '' }).error, /temperature/);
});

test('schema: when a symptom happened', () => {
  const s = { when: 'periods', periods: ['evening', 'morning'] };
  assert.equal(describeWhen(s), 'morning and evening');
  assert.equal(describeWhen({ when: 'time', periods: [], from: '15:10', to: '15:20' }), '15:10–15:20');
  assert.equal(describeWhen({ when: 'day', periods: [] }), 'all day');
});

test('schema: a sync keeps values corrected by hand', () => {
  const h = mergeHealth({ steps: 5000, edited: ['steps'] }, { steps: 3000, restingHr: 58 }, '2026-10-14T08:00');
  assert.equal(h.steps, 5000);
  assert.equal(h.restingHr, 58);
  assert.equal(h.syncedAt, '2026-10-14T08:00');
});
