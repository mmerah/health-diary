// Tests for the Today screen helpers (js/screens/today-model.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLog, setCatalog } from '../js/core/schema.js';
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
  assert.equal(M.drinksSummary(log.drinks), '6 water · 2 coffee');
  assert.equal(M.drinksSummary({ water: null, coffee: null, alcohol: 0 }), '0 alcohol');
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
  assert.equal(M.defaultOpen(log, { isToday: false, now: '12:10', wide: true }).size, M.SECTION_KEYS.length);
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

test('meal time: now, or the usual time when the meal is more than 3 hours away', () => {
  assert.deepEqual(M.mealTime('lunch', '13:10', true), { time: '13:10', usual: false });
  assert.deepEqual(M.mealTime('breakfast', '15:19', true), { time: '08:00', usual: true });
  assert.deepEqual(M.mealTime('dinner', '20:05', false), { time: '19:30', usual: true });
});

test('recent meals: same as yesterday first, then distinct older texts', () => {
  const day = (date, text) => ({ date, log: { meals: { lunch: { text } } } });
  const r = M.recentMeals([day('2026-10-13', 'Pasta'), day('2026-10-12', 'pasta'), day('2026-10-11', 'Salad'),
    day('2026-10-10', 'Soup'), day('2026-10-09', 'Rice'), day('2026-10-08', 'Fish'), day('2026-10-14', 'Today')], 'lunch', '2026-10-14');
  assert.deepEqual(r.map(x => x.label), ['Same as yesterday', 'Salad', 'Soup', 'Rice']);
  assert.equal(r[0].text, 'Pasta');
  assert.deepEqual(M.recentMeals([day('2026-10-11', 'Salad')], 'lunch', '2026-10-14').map(x => x.label), ['Salad']);
});

const L = raw => normalizeLog(raw);

test('merge: other device changes are kept, mine are put back, same section → mine wins', () => {
  const base = L({ meals: { breakfast: { time: '07:40', text: 'Oatmeal' } }, drinks: { water: 1 }, notes: 'a',
    meds: { taken: { mag: { done: false, time: '' } } } });
  const local = structuredClone(base);
  local.drinks.water = 3;                         // only here
  local.notes = 'mine';                           // both sides
  local.meds.taken.vitd = { done: true, time: '08:00' };
  const server = structuredClone(base);
  server.meals.lunch = { time: '12:30', text: 'Soup' }; // only there
  server.notes = 'theirs';
  server.meds.taken.mag = { done: true, time: '21:00' };
  const { log, conflicts } = M.mergeLog(base, local, server);
  assert.equal(log.drinks.water, 3);
  assert.equal(log.meals.lunch.text, 'Soup');
  assert.equal(log.meals.breakfast.text, 'Oatmeal');
  assert.equal(log.notes, 'mine');
  assert.deepEqual(log.meds.taken.mag, { done: true, time: '21:00' });
  assert.deepEqual(log.meds.taken.vitd, { done: true, time: '08:00' });
  assert.deepEqual(conflicts, ['Notes']);
  assert.deepEqual(M.mergeLog(base, base, server).log, server);
});

test('saveMerging: plain save, merge on 409, retry once, then give up', async () => {
  const base = { version: 4, log: L({ notes: 'a' }) };
  const local = L({ notes: 'a', activities: 'walk' });
  const conflict = (log, v) => Object.assign(new Error('Conflict'), { status: 409, data: { log, logVersion: v } });
  const calls = [];
  const ok = await M.saveMerging(async (d, l, v) => { calls.push(v); return { logVersion: 5 }; }, 'd', local, base);
  assert.deepEqual([ok.version, ok.merged, calls], [5, false, [4]]);

  let n = 0;
  const r = await M.saveMerging(async (d, l, v) => {
    n++;
    if (n === 1) throw conflict({ notes: 'b' }, 6);
    if (n === 2) throw conflict({ notes: 'c', symptoms: [{ name: 'Headache' }] }, 7);
    assert.equal(v, 7);
    return { logVersion: 8 };
  }, 'd', local, base);
  assert.equal(r.version, 8);
  assert.equal(r.merged, true);
  assert.equal(r.log.activities, 'walk');
  assert.equal(r.log.notes, 'c');
  assert.equal(r.log.symptoms[0].name, 'Headache');

  await assert.rejects(M.saveMerging(async () => { throw conflict({}, 9); }, 'd', local, base), /Conflict/);
  await assert.rejects(M.saveMerging(async () => { throw Object.assign(new Error('Down'), { status: 500 }); }, 'd', local, base), /Down/);
});

// The user's own items (catalog): a Tea counter, a Back pain measurement, an own symptom list.
const OWN = { symptoms: ['Back pain', 'Fatigue'], counters: [{ id: 'c_tea', name: 'Tea', one: 'cup', many: 'cups' }],
  measurements: [{ id: 'c_pain', name: 'Back pain', unit: '/10', low: null, high: 4, min: 0, max: 10, step: 1 }] };

test('own counters and measurements in the summaries', t => {
  setCatalog(OWN);
  t.after(() => setCatalog(null));
  const log = normalizeLog({ drinks: { water: 2, coffee: null, alcohol: 0, c_tea: 3 } });
  assert.equal(M.drinksSummary(log.drinks), '2 water · 0 alcohol · 3 tea');
  assert.equal(M.measurementsSummary([{ type: 'c_pain', time: '20:00', value: 6 }, { type: 'weight', time: '07:00', value: 76.9 }]),
    'Weight 76.9 kg · Back pain 6/10');
  assert.equal(M.checkMeasurement('c_pain', { v: '11' }).field, 'v');
  assert.deepEqual(M.checkMeasurement('c_pain', { v: '5' }), { value: 5 });
});

test('own counters merge like drinks', t => {
  setCatalog(OWN);
  t.after(() => setCatalog(null));
  const base = normalizeLog({ drinks: { c_tea: 1 } });
  const local = structuredClone(base); local.drinks.c_tea = 2;
  const server = structuredClone(base); server.drinks.water = 4;
  const { log, conflicts } = M.mergeLog(base, local, server);
  assert.equal(log.drinks.c_tea, 2);
  assert.equal(log.drinks.water, 4);
  assert.deepEqual(conflicts, []);
});

test('symptom chips: own list in its order, then up to 3 recent names not in it', () => {
  const days = [{ log: { symptoms: [{ name: 'Nausea' }, { name: 'fatigue' }, { name: 'Cough' }, { name: 'Itch' }, { name: 'Rash' }] } },
    { log: { symptoms: [{ name: 'Nausea' }] } }];
  assert.deepEqual(M.symptomChipList(['Back pain', 'Fatigue'], days), ['Back pain', 'Fatigue', 'Nausea', 'Cough', 'Itch']);
  assert.deepEqual(M.symptomChipList([], []), []);
});

test('Apple Health oxygen and respiratory rate: text and hand correction', () => {
  assert.deepEqual(M.healthExtras({ spo2: 97.1, spo2Min: 92, respiratoryRate: 14.2 }).map(x => x.text), ['97.1 % (lowest 92 %)', '14.2 /min']);
  assert.deepEqual(M.healthExtras({ steps: 10 }), []);
  const old = { spo2: 97.1, spo2Min: 92, respiratoryRate: 14.2, edited: [] };
  const r = M.correctHealth(old, { spo2: '96,5', spo2Min: '92', respiratoryRate: '14.2' });
  assert.equal(r.next.spo2, 96.5);
  assert.deepEqual(r.next.edited, ['spo2']);
  assert.ok(M.correctHealth(old, { spo2: '120' }).error);
  assert.equal(M.correctHealth(old, { steps: '10' }).next.spo2, 97.1); // not in the form: kept
});

test('a hand correction sends only the changed fields', async () => {
  const { healthPatch } = await import('../js/screens/today-model.js');
  const before = { sleep: { total: 400 }, steps: 3000, restingHr: 58, hrv: 40, edited: [] };
  const after = { sleep: { total: 420 }, steps: 3000, restingHr: 58, hrv: null, edited: ['sleep', 'hrv'] };
  assert.deepEqual(healthPatch(before, after), { sleep: { total: 420 }, hrv: null });
  assert.deepEqual(healthPatch(null, { steps: 10 }), { steps: 10 });
});
