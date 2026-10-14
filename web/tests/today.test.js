// Tests for the Today screen helpers (js/screens/today-model.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLog } from '../js/core/schema.js';
import * as M from '../js/screens/today-model.js';

test('clip: short text unchanged, long text cut at a word with an ellipsis', () => {
  assert.equal(M.clip('Oatmeal'), 'Oatmeal');
  assert.equal(M.clip('  two\n lines  '), 'two lines');
  const c = M.clip('Oatmeal with banana, coffee and a croissant with butter', 24);
  assert.ok(c.endsWith('…'));
  assert.ok(c.length <= 25);
  assert.equal(c, 'Oatmeal with banana…');
});

test('drinks: null → +1 gives 1, null → −1 gives 0 (none), never below 0', () => {
  assert.equal(M.stepDrink(null, 1), 1);
  assert.equal(M.stepDrink(null, -1), 0);
  assert.equal(M.stepDrink(0, -1), 0);
  assert.equal(M.stepDrink(0, 1), 1);
  assert.equal(M.stepDrink(5, -1), 4);
  const water = { one: 'glass', many: 'glasses' };
  assert.equal(M.drinkText(water, null), 'Not recorded');
  assert.equal(M.drinkText(water, 0), 'None');
  assert.equal(M.drinkText(water, 1), '1 glass');
  assert.equal(M.drinkText(water, 6), '6 glasses');
});

test('week: Monday to Sunday around the day, across month ends; never after today', () => {
  assert.deepEqual(M.weekDays('2026-10-14'),
    ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
  assert.equal(M.weekDays('2026-11-01')[0], '2026-10-26'); // a Sunday
  assert.equal(M.weekDays('2026-10-12')[0], '2026-10-12'); // a Monday
  assert.equal(M.shiftWeek('2026-10-14', -1, '2026-10-14'), '2026-10-07');
  assert.equal(M.shiftWeek('2026-10-07', 1, '2026-10-10'), '2026-10-10');
  assert.equal(M.clampDate('2027-01-01', '2026-10-14'), '2026-10-14');
  assert.equal(M.clampDate('nonsense', '2026-10-14'), '2026-10-14');
  assert.equal(M.clampDate(null, '2026-10-14'), '2026-10-14');
  assert.equal(M.clampDate('2026-10-01', '2026-10-14'), '2026-10-01');
});

test('summaries for collapsed rows', () => {
  const log = normalizeLog({
    meals: { breakfast: { time: '07:40', text: 'Oatmeal with banana, coffee and a croissant with butter and jam' } },
    snacks: [{ time: '10:30', text: 'Apple' }, { time: '', text: 'Banana' }],
    drinks: { water: 6, coffee: 2, alcohol: null },
    meds: { taken: { a: { done: true, time: '07:45' }, b: { done: true, time: '' } }, extra: [{ name: 'Paracetamol 1 g', time: '15:00' }] },
    symptoms: [{ name: 'Headache', severity: 2, when: 'day' }, { name: 'Fatigue' }],
  });
  assert.match(M.mealSummary(log.meals.breakfast), /^07:40 · Oatmeal with banana.*…$/);
  assert.equal(M.mealSummary(log.meals.lunch), '');
  assert.equal(M.snacksSummary(log.snacks), 'Apple, Banana');
  assert.equal(M.snacksSummary([]), '');
  assert.equal(M.drinksSummary(log.drinks), 'Water 6 · Coffee 2');
  assert.equal(M.drinksSummary({ water: null, coffee: null, alcohol: 0 }), 'Alcohol 0');
  assert.equal(M.medsSummary(log, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]), '2 of 3 taken · 1 extra');
  assert.equal(M.medsSummary(normalizeLog({}), []), '');
  assert.equal(M.symptomsSummary(log.symptoms), 'Headache (moderate), Fatigue');
  assert.equal(M.symptomDetail(log.symptoms[0]), 'Moderate · all day');
  assert.equal(M.measurementsSummary([
    { type: 'weight', time: '07:30', value: 77.4 }, { type: 'weight', time: '19:00', value: 76.9 },
    { type: 'bp', time: '08:00', value: { sys: 120, dia: 80, pulse: null } },
  ]), 'Weight 76.9 kg · Blood pressure 120/80 mmHg');
});

test('health items and source', () => {
  assert.deepEqual(M.healthItems(null), []);
  const h = { sleep: { total: 412, deep: 64, rem: 95, core: 253, awake: 0 }, steps: 8420, restingHr: 58, hrv: null, source: 'apple', syncedAt: '2026-10-14T08:12' };
  const items = M.healthItems(h);
  assert.deepEqual(items.map(i => i.value), ['6h52', '8,420', '58']);
  assert.equal(M.healthSource(h, '2026-10-14'), 'Synced 08:12');
  assert.equal(M.healthSource(h, '2026-10-15'), 'Synced 14 Oct 08:12');
  assert.equal(M.healthSource({ source: 'manual' }, '2026-10-14'), 'Entered by hand');
  const st = M.sleepStages(h.sleep);
  assert.deepEqual(st.map(s => s.key), ['deep', 'core', 'rem']);
  assert.ok(Math.abs(st.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
  assert.deepEqual(M.sleepStages({ total: 400 }), []);
});

test('open section at first: the meal of the hour on today, if empty', () => {
  const log = normalizeLog({ meals: { breakfast: { time: '07:40', text: 'Oatmeal' } } });
  assert.deepEqual([...M.defaultOpen(log, { isToday: true, now: '08:30' })], []);
  assert.deepEqual([...M.defaultOpen(log, { isToday: true, now: '12:10' })], ['lunch']);
  assert.deepEqual([...M.defaultOpen(log, { isToday: false, now: '12:10' })], []);
});

test('symptom chips: own symptoms by frequency, then the defaults, no duplicates', () => {
  const days = [
    { log: { symptoms: [{ name: 'Fatigue' }, { name: 'Brain fog' }] } },
    { log: { symptoms: [{ name: 'Brain fog' }, { name: 'headache' }] } },
    { log: { symptoms: ['Brain fog'] } },
    { log: null },
  ];
  const order = M.symptomOrder(days, ['Fatigue', 'Headache', 'Nausea']);
  assert.deepEqual(order, ['Brain fog', 'Fatigue', 'headache', 'Nausea']);
  assert.deepEqual(M.symptomOrder([], ['A', 'B']), ['A', 'B']);
});

test('new symptom: no severity; when = part of the day if given', () => {
  assert.deepEqual(M.newSymptom('Headache', 'afternoon'),
    { name: 'Headache', severity: null, when: 'periods', periods: ['afternoon'], from: '', to: '' });
  assert.equal(M.newSymptom('Headache', null).when, null);
});

test('notes and meals: quick add appends, never replaces', () => {
  assert.equal(M.appendNote('', 'Felt dizzy', '15:20'), '15:20 — Felt dizzy');
  assert.equal(M.appendNote('First line\n\n', 'Second', '16:00'), 'First line\n16:00 — Second');
  assert.equal(M.appendNote('A', 'B', ''), 'A\nB');
  assert.equal(M.appendMeal('', 'Toast'), 'Toast');
  assert.equal(M.appendMeal('Oatmeal.', 'coffee'), 'Oatmeal, coffee');
});

test('health correction records edited fields and keeps the rest', () => {
  const old = { sleep: { total: 400, deep: 60, rem: 90, core: 230, awake: 20, bed: '23:00', wake: '06:20', naps: [], inBedOnly: false },
    steps: 5000, restingHr: 60, hrv: 40, workouts: [], source: 'apple', syncedAt: '2026-10-14T08:00', edited: [] };
  const same = M.correctHealth(old, { sleepH: '6', sleepM: '40', bed: '23:00', wake: '06:20', steps: '5000', restingHr: '60', hrv: '40' });
  assert.deepEqual(same.next.edited, []);
  assert.equal(same.next.sleep.deep, 60);
  const r = M.correctHealth(old, { sleepH: '7', sleepM: '0', bed: '23:00', wake: '06:20', steps: '6200', restingHr: '60', hrv: '40' });
  assert.deepEqual(r.next.edited.sort(), ['sleep', 'steps']);
  assert.equal(r.next.sleep.total, 420);
  assert.equal(r.next.sleep.deep, undefined); // old stages no longer match the total
  assert.equal(r.next.source, 'apple');
  assert.equal(r.next.syncedAt, old.syncedAt);
  const fresh = M.correctHealth(null, { sleepH: '', sleepM: '', bed: '', wake: '', steps: '3000', restingHr: '', hrv: '' });
  assert.equal(fresh.next.source, 'manual');
  assert.equal(fresh.next.sleep, null);
  assert.deepEqual(fresh.next.edited, ['steps']);
  assert.ok(M.correctHealth(null, { steps: '-3' }).error);
  assert.ok(M.correctHealth(null, { restingHr: '300' }).error);
  assert.ok(M.correctHealth(null, { sleepH: '7', sleepM: '75' }).error);
});

test('measurement check names the wrong field', () => {
  assert.deepEqual(M.checkMeasurement('weight', { kg: '76,9' }), { value: 76.9 });
  assert.equal(M.checkMeasurement('weight', { kg: '' }).field, 'kg');
  assert.equal(M.checkMeasurement('bp', { sys: '120', dia: '300', pulse: '' }).field, 'dia');
  const both = M.checkMeasurement('bp', { sys: '80', dia: '90', pulse: '' });
  assert.ok(both.error);
  assert.equal(both.field, null);
  assert.deepEqual(M.checkMeasurement('bp', { sys: '120', dia: '80', pulse: '' }).value, { sys: 120, dia: 80, pulse: null });
});
