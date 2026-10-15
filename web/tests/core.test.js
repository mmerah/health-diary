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

test('schema: a stored log is completed and cleaned', () => {
  const log = normalizeLog({
    meals: { breakfast: { time: '07:30', text: 'Eggs' } },
    drinks: { water: 3, coffee: 0 },
    meds: { taken: { mag: { done: true, time: '21:05' }, vitd: { done: 'yes', time: '25:00' } } },
    symptoms: [{ name: 'Fatigue', severity: 2, when: 'time', from: '15:00' }, 'Headache', null],
    feeling: 6,
  });
  assert.deepEqual(log.meals.lunch, { time: '', text: '' });
  assert.deepEqual([log.drinks.water, log.drinks.coffee, log.drinks.alcohol], [3, 0, null]); // null = not recorded
  assert.deepEqual(log.meds.taken, { mag: { done: true, time: '21:05' }, vitd: { done: true, time: '' } });
  assert.deepEqual(log.symptoms.map(s => [s.name, s.when, s.from]), [['Fatigue', 'time', '15:00']]);
  assert.equal(log.feeling, undefined);
  assert.deepEqual(normalizeProfile({ medications: 'not a list' }).medications, []);
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

test('catalog: own items next to the built-in ones', async () => {
  const S = await import('../js/core/schema.js');
  S.setCatalog({
    symptoms: ['Aura', 'Aura', ' Light sensitivity ', ''],
    docTypes: { custom: ['Dentist', 'Blood test'], hidden: ['Vaccination', 'Other', 'Nope'] },
    measurements: [{ id: 'c_glu', name: 'Blood glucose', unit: 'mmol/L', low: 3.9, high: 7.8, min: 0.5, max: 40, step: 0.1 },
      { id: 'bad id', name: 'X' }],
    counters: [{ id: 'c_tea', name: 'Tea', one: 'cup', many: 'cups' }],
  });
  const c = S.getCatalog();
  assert.deepEqual(c.symptoms, ['Aura', 'Light sensitivity']);
  assert.deepEqual(c.docTypes, { custom: ['Dentist'], hidden: ['Vaccination'] }); // "Other" cannot be hidden
  assert.ok(S.docCategories().includes('Dentist') && !S.docCategories().includes('Vaccination'));
  assert.ok(!S.isBuiltInDocType('Dentist') && S.isBuiltInDocType('Blood test'));
  assert.equal(c.measurements.length, 1);
  assert.deepEqual(Object.keys(S.measurementTypes()), ['weight', 'bp', 'temp', 'c_glu']);
  assert.deepEqual(S.parseMeasurement('c_glu', { v: '8,24' }), { value: 8.2 });
  assert.match(S.parseMeasurement('c_glu', { v: '50' }).error, /0.5 to 40/);
  assert.equal(S.measurementDef('c_glu').flag(8.2), 'Above your range (over 7.8 mmol/L)');
  assert.equal(S.measurementDef('c_glu').flag(5), null);
  assert.equal(S.parseMeasurement('c_gone', { v: '1' }).error, 'This measurement type no longer exists.');
  assert.deepEqual(S.counterTypes().map(x => x.key), ['water', 'coffee', 'alcohol', 'c_tea']);
  const log = S.normalizeLog({ drinks: { water: 2, c_tea: 3, c_old: 1, evil: 5 } });
  assert.deepEqual(log.drinks, { water: 2, coffee: null, alcohol: null, c_tea: 3, c_old: 1 });
  assert.equal(S.drinkSummary(log.drinks), '2 water · 3 tea');
  S.setCatalog(null);
});

test('catalog: changes from two devices are merged', async () => {
  const S = await import('../js/core/schema.js');
  const m = (id, name, extra = {}) => ({ id, name, unit: '', min: 0, max: 10, step: 1, ...extra });
  const base = { symptoms: ['Fatigue', 'Headache'], measurements: [m('c_aa', 'Pain'), m('c_bb', 'Glucose')], counters: [] };
  const mine = { symptoms: ['Headache', 'Fatigue', 'Aura'], measurements: [m('c_aa', 'Back pain'), m('c_bb', 'Glucose')], counters: [] };
  const theirs = { symptoms: ['Fatigue', 'Nausea'], measurements: [m('c_aa', 'Pain'), m('c_cc', 'SpO2')],
    counters: [{ id: 'c_tea', name: 'Tea', one: 'cup', many: 'cups' }] };
  const r = S.mergeCatalog(base, mine, theirs);
  // They removed Headache and added Nausea; I moved Fatigue and added Aura.
  assert.deepEqual(r.symptoms, ['Fatigue', 'Aura', 'Nausea']);
  // c_aa: only I renamed it → mine. c_bb: they deleted it, I did not change it → deleted. c_cc: they added it.
  assert.deepEqual(r.measurements.map(x => [x.id, x.name]), [['c_aa', 'Back pain'], ['c_cc', 'SpO2']]);
  assert.deepEqual(r.counters.map(x => x.id), ['c_tea']);
  // Both changed the same item: I renamed it, they hid it → both changes stay.
  const b2 = { measurements: [m('c_aa', 'Pain')] };
  const r2 = S.mergeCatalog(b2, { measurements: [m('c_aa', 'Back pain')] }, { measurements: [m('c_aa', 'Pain', { hidden: true })] });
  assert.deepEqual([r2.measurements[0].name, r2.measurements[0].hidden], ['Back pain', true]);
  // They deleted it, I changed it → my change stays.
  assert.equal(S.mergeCatalog(b2, { measurements: [m('c_aa', 'Back pain')] }, { measurements: [] }).measurements.length, 1);
  // Nothing changed on my side → their version.
  assert.deepEqual(S.mergeCatalog(base, base, theirs).symptoms, ['Fatigue', 'Nausea']);
});
