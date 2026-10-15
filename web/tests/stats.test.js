// Report statistics and the lab parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLog, hasContent } from '../js/core/schema.js';
import { median } from '../js/core/math.js';
import {
  adherence, asNeededUse, associations, bedMinutes, drinkStats, measurementStats, medTimeline, symptomStats, weekBlocks, wearableStats,
} from '../js/report/stats.js';
import { labFlag, labTable, parseLabs, parseRange } from '../js/report/labs.js';

const day = (date, edit, health = null) => {
  const log = emptyLog();
  if (edit) edit(log);
  return { date, log, health, logged: hasContent(log) };
};
const sym = (name, severity = null, extra = {}) => ({ name, severity, when: null, periods: [], from: '', to: '', ...extra });

test('median, not mean; bedtimes after midnight sort after the evening', () => {
  assert.equal(median([1, 1, 3]), 1);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), null);
  assert.ok(bedMinutes('00:30') > bedMinutes('23:30'));
});

test('weekBlocks end on the last day of the period', () => {
  const w = weekBlocks('2026-10-01', '2026-10-14');
  assert.deepEqual(w.map(x => [x.start, x.end]), [['2026-10-01', '2026-10-07'], ['2026-10-08', '2026-10-14']]);
  assert.equal(weekBlocks('2026-10-03', '2026-10-14')[0].days, 5);
});

test('adherence: only days where the medication part was filled in, while the medication is active', () => {
  const profile = { medications: [
    { id: 'a', name: 'Med A', since: '2026-10-03', until: '', asNeeded: false },
    { id: 'b', name: 'Med B', since: '', until: '2026-10-02', asNeeded: false },
    { id: 'p', name: 'Paracetamol', asNeeded: true },
  ] };
  const days = [
    day('2026-10-01', l => { l.meds.taken.b = { done: true, time: '08:00' }; }),
    day('2026-10-02', l => { l.meds.extra.push({ name: 'Ibuprofen', time: '' }); }), // medication part filled in, B not ticked → not taken
    day('2026-10-03', l => { l.meds.taken.a = { done: true, time: '21:00' }; }),
    day('2026-10-04', l => { l.notes = 'x'; l.meds.taken.b = { done: false, time: '' }; }), // touched, A not ticked → not taken
    day('2026-10-05', l => { l.drinks.water = 1; }), // only a glass of water: does not count
    day('2026-10-06', null), // no diary entry: does not count
    day('2026-10-07', l => { l.meds.taken.a = { done: true, time: '22:00' }; }), // partial day: skipped
  ];
  const [a, b] = adherence(profile, days, { skip: '2026-10-07' });
  assert.deepEqual([a.taken, a.eligible, a.missed], [1, 2, ['2026-10-04']]);
  assert.deepEqual([b.taken, b.eligible, b.missed], [1, 2, ['2026-10-02']]);
  assert.equal(a.usualTime, '21:00');
  assert.equal(adherence(profile, days).length, 2, 'as-needed medication is not scheduled');
});

test('as-needed medication: count, days and usual time; diary names match the profile', () => {
  const profile = { medications: [{ id: 'p', name: 'Paracetamol', dose: '1 g', asNeeded: true }] };
  const days = [
    day('2026-10-01', l => { l.meds.extra.push({ name: 'Paracetamol 1 g', time: '15:00' }, { name: 'paracetamol', time: '21:00' }); }),
    day('2026-10-02', l => { l.meds.taken.p = { done: true, time: '16:00' }; }),
    day('2026-10-03', l => { l.meds.extra.push({ name: 'Ibuprofen', time: '' }); }),
  ];
  const [p, ibu] = asNeededUse(profile, days);
  assert.deepEqual([p.name, p.uses, p.days, p.usualTime], ['Paracetamol 1 g', 3, 2, '16:00']);
  assert.deepEqual([ibu.name, ibu.uses, ibu.profile], ['Ibuprofen', 1, false]);
});

test('medication timeline: started and stopped dates up to the end of the period', () => {
  const ev = medTimeline({ medications: [{ name: 'A', dose: '5 mg', since: '2026-01-01', until: '2026-05-01' }, { name: 'B', since: '2027-01-01' }] }, '2026-10-14');
  assert.deepEqual(ev.map(e => [e.date, e.type, e.name]), [['2026-01-01', 'started', 'A 5 mg'], ['2026-05-01', 'stopped', 'A 5 mg']]);
});

test('symptoms: grouped without case, severity counts, unset apart, median, time of day, trend', () => {
  const days = [];
  for (let i = 1; i <= 28; i++) {
    const date = `2026-10-${String(i).padStart(2, '0')}`;
    days.push(day(date, l => {
      l.notes = 'x';
      if (i === 2) l.symptoms.push(sym('headache', 1, { when: 'day' }));
      if (i >= 15 && i % 2) l.symptoms.push(sym('Headache', i > 24 ? 3 : 2, { when: 'periods', periods: ['morning'] }));
      if (i === 20) l.symptoms.push(sym('HEADACHE', null, { when: 'time', from: '15:00' }), sym('Nausea'));
      if (i > 20) l.symptoms.push(sym('Dizziness', 1));
    }));
  }
  const [h, dz, n] = symptomStats(days, { from: '2026-10-01', to: '2026-10-28' });
  assert.equal(h.name, 'Headache');
  assert.equal(h.days, 9);
  assert.deepEqual(h.severity, { 1: 1, 2: 5, 3: 2, unset: 1 });
  assert.equal(h.median, 2);
  assert.deepEqual(h.when, { day: 1, morning: 7, afternoon: 1 });
  assert.equal(h.trend, 'more');
  assert.deepEqual(h.weekly, [1, 0, 5, 3]);
  assert.deepEqual(h.severeDates, ['2026-10-25', '2026-10-27']);
  assert.equal(dz.trend, 'new');
  assert.equal(n.median, null, 'severity not set');
  assert.equal(n.severity.unset, 1);
});

test('symptoms: days without a diary entry are not counted', () => {
  const days = [day('2026-10-01', l => { l.symptoms.push(sym('Fatigue', 1)); }), day('2026-10-02', null)];
  const [f] = symptomStats(days, { from: '2026-10-01', to: '2026-10-02' });
  assert.equal(f.halves.loggedSecond, 0);
});

test('drinks: null = not recorded and left out; heavy days; partial day out', () => {
  const days = [
    day('2026-10-01', l => { l.drinks = { water: 4, coffee: 1, alcohol: 0 }; }),
    day('2026-10-02', l => { l.drinks = { water: null, coffee: 3, alcohol: 6 }; }),
    day('2026-10-03', l => { l.drinks = { water: 2, coffee: null, alcohol: null }; }),
    day('2026-10-04', l => { l.drinks = { water: 9, coffee: 9, alcohol: 9 }; }),
  ];
  const [w, c, a] = drinkStats(days, { skip: '2026-10-04' });
  assert.deepEqual([w.recorded, w.average, w.max], [2, 3, 4]);
  assert.deepEqual([c.recorded, c.average, c.daysThreePlus], [2, 2, 1]);
  assert.deepEqual([a.recorded, a.daysAny, a.max, a.daysHeavy], [2, 1, 6, 1]);
  assert.equal(drinkStats([day('2026-10-01', l => { l.notes = 'x'; })]).length, 0);
});

test('wearable: weekly medians, partial-day steps left out, first and last 4 weeks', () => {
  const days = [];
  for (let i = 0; i < 63; i++) {
    const d = new Date(2026, 7, 13 + i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ date, log: null, logged: false, health: { sleep: { total: i < 28 ? 480 : 360, bed: i < 28 ? '23:00' : '00:30' }, steps: i === 62 ? 50 : 8000, restingHr: i < 28 ? 55 : 62, hrv: 40 } });
  }
  const from = days[0].date, to = days[62].date;
  const w = wearableStats(days, { from, to, skip: to });
  assert.equal(w.weeks.length, 9);
  assert.equal(w.overall.steps.min, 8000, 'today’s partial steps are left out');
  assert.equal(w.compare.first.sleep.median, 480);
  assert.equal(w.compare.last.restingHr.median, 62);
  assert.equal(w.compare.last.bed.median, bedMinutes('00:30'));
  assert.equal(w.shortNights, 0);
  assert.equal(wearableStats([{ date: from, log: null, health: null }], { from, to }), null);
});

test('associations: descriptive counts in two groups, small groups marked', () => {
  const days = [];
  for (let i = 1; i <= 20; i++) {
    days.push(day(`2026-10-${String(i).padStart(2, '0')}`, l => {
      l.drinks = { water: 1, coffee: i <= 10 ? 4 : 1, alcohol: 0 };
      if (i <= 6 || i === 15) l.symptoms.push(sym('Palpitations', 2));
    }, { sleep: { total: i % 2 ? 300 : 420 } }));
  }
  const syms = symptomStats(days, { from: '2026-10-01', to: '2026-10-20' });
  const a = associations(days, syms);
  const coffee = a.find(x => x.factor === 'coffee');
  assert.deepEqual([coffee.a.with, coffee.a.days, coffee.b.with, coffee.b.days], [6, 10, 1, 10]);
  assert.equal(coffee.small, false);
  assert.ok(!a.some(x => x.factor === 'alcohol'), 'no group without alcohol days');
  assert.ok(a.find(x => x.factor === 'sleep'));
});

test('measurements: values in the period, a baseline before it, BP and fever episodes, weight change', () => {
  const ms = [
    { type: 'weight', date: '2026-09-01', value: 80 }, { type: 'weight', date: '2026-10-02', value: 79 }, { type: 'weight', date: '2026-10-12', value: 76.5 },
    { type: 'bp', date: '2026-10-03', value: { sys: 142, dia: 85 } }, { type: 'bp', date: '2026-10-04', value: { sys: 120, dia: 92 } }, { type: 'bp', date: '2026-10-05', value: { sys: 118, dia: 76 } },
    { type: 'temp', date: '2026-10-03', time: '20:00', value: 38.4 }, { type: 'temp', date: '2026-10-04', value: 38.9 }, { type: 'temp', date: '2026-10-10', value: 38.1 },
  ];
  const opt = { from: '2026-10-01', to: '2026-10-14' };
  const w = measurementStats('weight', ms, opt);
  assert.equal(w.before.date, '2026-09-01');
  assert.equal(w.rows.length, 2);
  assert.equal(w.change.kg, -2.5);
  assert.ok(Math.abs(w.change.pct + 3.16) < 0.01);
  assert.equal(measurementStats('bp', ms, opt).high.length, 2);
  const t = measurementStats('temp', ms, opt);
  assert.deepEqual(t.episodes.map(e => [e.from, e.to, e.max]), [['2026-10-03', '2026-10-04', 38.9], ['2026-10-10', '2026-10-10', 38.1]]);
});

// ---------- Labs

test('lab lines: value, unit, range and flag', () => {
  const [a] = parseLabs('Total cholesterol   2.15 g/L    (< 2.00)    HIGH');
  assert.deepEqual([a.test, a.value, a.unit, a.rangeText, a.flag], ['Total cholesterol', 2.15, 'g/L', '< 2.00', 'high']);
  const [b] = parseLabs('Vitamin D (25-OH) 18 ng/mL (30 – 100) LOW');
  assert.deepEqual([b.test, b.value, b.flag], ['Vitamin D (25-OH)', 18, 'low']);
  const [c] = parseLabs('PSA 0.84 0.00 - 4.00');
  assert.deepEqual([c.value, c.range.lo, c.range.hi, c.flag], [0.84, 0, 4, null]);
  const [d] = parseLabs('Hémoglobine : 12,1 g/dL (13,0 - 17,0)');
  assert.deepEqual([d.value, d.flag], [12.1, 'low'], 'outside the printed range without a printed flag');
  const [e] = parseLabs('Glucose 1.32 g/L H');
  assert.equal(e.flag, 'high');
  const [f] = parseLabs('CRP < 5 mg/L (< 5)');
  assert.equal(f.flag, null, 'below a detection limit');
  assert.equal(parseLabs('Creatinine          9.8 mg/L    (7 – 12), eGFR > 90')[0].value, 9.8);
});

test('lab parser is conservative', () => {
  for (const s of ['Mean HR 72 bpm, min 48 bpm (sleep), max 141 bpm (exercise).', 'LVEF 62% (Simpson biplane).', 'Collected: 12/09/2026 08:10, fasting',
    'Follow-up echo in 2 years, or earlier if symptoms change.', 'Sample no. 2026-88412-07', 'Page 1 (1 - 2)']) {
    assert.deepEqual(parseLabs(s), [], s);
  }
});

test('ranges and flags', () => {
  assert.deepEqual(parseRange('< 2.00'), { hi: 2, op: '<', text: '< 2.00' });
  assert.deepEqual(parseRange('30 – 100'), { lo: 30, hi: 100, text: '30 – 100' });
  assert.equal(labFlag(2, parseRange('< 2.00')), 'high');
  assert.equal(labFlag(0.4, parseRange('> 0.40')), 'low');
  assert.equal(labFlag(100, parseRange('30 – 100')), null);
  assert.equal(labFlag(50, parseRange('30 – 100'), 'LOW'), 'low', 'the printed flag wins');
});

test('lab table: the same test across documents, side by side, oldest first', () => {
  const t = labTable([
    { date: '2026-09-01', content: 'TOTAL CHOLESTEROL 1.98 g/L (< 2.00)\nPotassium 4.2 mmol/L (3.5 – 5.0)' },
    { date: '2026-03-01', content: 'Total cholesterol 2.15 g/L (< 2.00) HIGH' },
    { date: '2026-05-01', content: 'No lab values here.' },
  ]);
  assert.deepEqual(t.dates, ['2026-03-01', '2026-09-01']);
  const chol = t.rows[0];
  assert.deepEqual(Object.keys(chol.cells), ['2026-03-01', '2026-09-01']);
  assert.equal(chol.latest.value, 1.98);
  assert.equal(t.rows.length, 2);
});

test('two-unit lab lines: the first value is the result, the range is compared in the same unit', () => {
  const [ldl] = parseLabs('LDL cholesterol 1.90 g/L 4.91 mmol/L (< 1.16)');
  assert.deepEqual([ldl.test, ldl.valueText, ldl.unit, ldl.alt.valueText, ldl.alt.unit], ['LDL cholesterol', '1.90', 'g/L', '4.91', 'mmol/L']);
  const [glu] = parseLabs('Glucose 0.95 g/L 5.27 mmol/L (0.70-1.10)');
  assert.deepEqual([glu.test, glu.flag], ['Glucose', null], 'in range in the first unit: no false HIGH');
  const [g2] = parseLabs('Glucose 0.95 g/L soit 5.27 mmol/L (3.9-6.1 mmol/L)');
  assert.deepEqual([g2.flag, g2.rangeText], [null, '3.9-6.1 mmol/L'], 'range in the second unit');
  const [g3] = parseLabs('Glucose 1.32 g/L 7.33 mmol/L (3.9-6.1 mmol/L)');
  assert.equal(g3.flag, 'high');
  const [x] = parseLabs('Albumine 40 g/L (35-50 mmol/L)');
  assert.equal(x.flag, null, 'a range in another unit: no flag');
  assert.equal(parseLabs('LDL cholesterol     1.30 g/L    (< 1.60)')[0].valueText, '1.30', 'the printed value is kept');
  assert.equal(parseLabs('Leucocytes 6.2 10^9/L (4.0-10.0)')[0].unit, '10^9/L');
});

test('non-lab lines of a lab report are kept', async () => {
  const { nonLabText } = await import('../js/report/labs.js');
  const t = nonLabText('Glucose 0.95 g/L (0.70-1.10)\nAntigène HBs : POSITIF\nProtéinurie : 2+\nCommentaire : hémolyse légère');
  assert.equal(t, 'Antigène HBs : POSITIF\nProtéinurie : 2+\nCommentaire : hémolyse légère');
});

test('weekly symptom counts: unknown (null) for weeks without a diary entry', () => {
  const days = [day('2026-10-01', l => { l.symptoms.push(sym('Fatigue', 1)); }), day('2026-10-14', l => { l.notes = 'x'; })];
  const [f] = symptomStats(days, { from: '2026-10-01', to: '2026-10-14' });
  assert.deepEqual(f.weekly, [1, 0]);
  const [g] = symptomStats([day('2026-10-01', l => { l.symptoms.push(sym('Fatigue', 1)); })], { from: '2026-09-24', to: '2026-10-14' });
  assert.deepEqual(g.weekly, [null, 1, null], 'oldest week first');
});

test('home blood pressure: mean and number of readings', () => {
  const ms = [{ type: 'bp', date: '2026-10-03', value: { sys: 130, dia: 80 } }, { type: 'bp', date: '2026-10-04', value: { sys: 141, dia: 91 } }];
  assert.deepEqual(measurementStats('bp', ms, { from: '2026-10-01', to: '2026-10-14' }).mean, { sys: 136, dia: 86, n: 2 });
});

test('measurement and counter definitions: own items, and a fallback for deleted ones', async () => {
  const { setCatalog } = await import('../js/core/schema.js');
  const { measurementDefOf, counterList } = await import('../js/report/stats.js');
  setCatalog({ measurements: [{ id: 'c_pain', name: 'Back pain', unit: '/10', high: 4, min: 0, max: 10, step: 1 }], counters: [{ id: 'c_tea', name: 'Tea', one: 'cup', many: 'cups' }] });
  try {
    assert.equal(measurementDefOf('c_pain').format(5), '5/10');
    assert.match(measurementDefOf('c_pain').flag(6), /Above your range/);
    assert.equal(measurementDefOf('c_gone').label, 'Other measurement');
    const keys = counterList([day('2026-10-01', l => { l.drinks.c_old = 2; })]).map(c => [c.key, c.label]);
    assert.deepEqual(keys.slice(3), [['c_tea', 'Tea'], ['c_old', 'Other counter']]);
    const tea = drinkStats([day('2026-10-01', l => { l.drinks.c_tea = 1; }), day('2026-10-02', l => { l.drinks.c_tea = 3; })]).find(x => x.key === 'c_tea');
    assert.deepEqual([tea.key, tea.recorded, tea.average, tea.max], ['c_tea', 2, 2, 3]);
    const pain = measurementStats('c_pain', [{ type: 'c_pain', date: '2026-10-02', value: 6 }, { type: 'c_pain', date: '2026-10-03', value: 2 }], { from: '2026-10-01', to: '2026-10-14' });
    assert.deepEqual([pain.label, pain.above.length, pain.below.length], ['Back pain', 1, 0]);
  } finally { setCatalog(null); }
});

test('symptom trend: only with 7 or more diary days in each half', () => {
  const few = [];
  for (let i = 20; i <= 28; i++) few.push(day(`2026-10-${i}`, l => { l.symptoms.push(sym('Headache', 1)); }));
  const [h] = symptomStats(few, { from: '2026-10-01', to: '2026-10-28' });
  assert.equal(h.trend, 'unknown', 'no diary days in the first half: no "new" trend');
  const many = [];
  for (let i = 1; i <= 28; i++) many.push(day(`2026-10-${String(i).padStart(2, '0')}`, l => { l.notes = 'x'; if (i > 20) l.symptoms.push(sym('Headache', 1)); }));
  assert.equal(symptomStats(many, { from: '2026-10-01', to: '2026-10-28' })[0].trend, 'new');
});
