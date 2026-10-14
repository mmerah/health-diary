// Invented sample data for the demo. "Alex Example" is not a real person.
// Seeded random numbers: the same data on every load of the same day.
import { addDays, minToHm, pad, today as todayIso, parse } from '../core/dates.js';
import { emptyLog, LOG_VERSION } from '../core/schema.js';

function rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const BREAKFASTS = ['Oatmeal with banana, coffee', 'Two eggs, wholemeal toast, coffee', 'Greek yogurt, granola, orange juice',
  'Croissant and coffee', 'Skipped, coffee only', 'Porridge with berries, green tea'];
const LUNCHES = ['Chicken salad, bread', 'Pasta bolognese', 'Sandwich (tuna), apple', 'Rice, salmon, broccoli',
  'Couscous with vegetables', 'Burger and fries (work lunch)', 'Lentil soup, bread, cheese'];
const SNACKS = ['Apple', 'Handful of almonds', 'Coffee and a biscuit', 'Banana', 'Dark chocolate, 2 squares', 'Yogurt'];
const DINNERS = ['Grilled fish, potatoes, salad', 'Pizza', 'Chicken curry with rice', 'Omelette, salad',
  'Steak, green beans', 'Vegetable stir-fry with noodles', 'Soup and bread', 'Leftover pasta'];
const ACTIVITIES = ['Office day. Walked 20 min at lunch.', 'Remote work. Gym in the evening: 45 min weights.',
  'Football with friends, 1 h.', 'Long walk, about 9 km.', 'Mostly sitting, busy with deadlines.',
  'Cycled to work and back, 2 × 25 min.', 'Errands in town, a lot of walking.', 'Rest day at home.'];
const NOTES = ['Late screen time, went to bed later than planned.', 'Busy, stressful day.', 'Glass of wine with dinner.'];
const WORKOUTS = [{ type: 'Strength training', minutes: 45, start: '18:30' }, { type: 'Walking', minutes: 52, start: '12:40' },
  { type: 'Cycling', minutes: 28, start: '08:10' }, { type: 'Soccer', minutes: 64, start: '19:15' }, { type: 'Running', minutes: 31, start: '07:05' }];

export const DEMO_USER = { id: 1, username: 'demo', isAdmin: true, hasIngestToken: false, ingestLastUsed: null, createdAt: '', notice: null };

export function seed() {
  const r = rng(7);
  const pick = a => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + r() * (b - a);
  const t5 = (a, b) => minToHm(Math.round(between(a, b) / 5) * 5);
  const today = todayIso();
  const dmy = n => { const d = parse(addDays(today, n)); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };

  const profile = {
    v: 2,
    name: 'Alex Example',
    dob: '1991-03-14',
    sex: 'Male',
    ethnicity: 'Southern European',
    heightCm: 178,
    conditions: 'Mild mitral valve prolapse (diagnosed 2024)\nIsolated PVCs (benign, Holter 2026)',
    medications: [
      { id: 'mag', name: 'Magnesium', dose: '300 mg, evening', since: addDays(today, -400), until: '', asNeeded: false },
      { id: 'vitd', name: 'Vitamin D3', dose: '1000 IU, morning', since: addDays(today, -198), until: '', asNeeded: false },
      { id: 'para', name: 'Paracetamol', dose: '1 g', since: '', until: '', asNeeded: true },
    ],
    allergies: 'Penicillin (rash)',
    surgeries: 'Appendectomy (2009)',
    familyHistory: 'Father: high blood pressure, type 2 diabetes\nMother: hypothyroidism',
    lifestyle: 'Non-smoker. Office job.',
  };

  const days = {}, health = {};
  for (let i = 75; i >= 0; i--) {
    const date = addDays(today, -i);
    let sleepTotal = null;
    if (i > 0) { // Today has no health data yet: the shortcut has not run.
      sleepTotal = Math.round(between(330, 490));
      const deep = Math.round(sleepTotal * between(0.12, 0.2));
      const rem = Math.round(sleepTotal * between(0.18, 0.26));
      const awake = Math.round(between(8, 45));
      const bed = Math.round(between(22 * 60 + 30, 24 * 60 + 50) / 5) * 5;
      health[date] = {
        sleep: { total: sleepTotal, deep, rem, core: sleepTotal - deep - rem, awake, bed: minToHm(bed), wake: minToHm(bed + sleepTotal + awake), naps: [], inBedOnly: false },
        steps: Math.round(between(2800, 14500)),
        restingHr: Math.round(between(54, 66)),
        hrv: Math.round(between(30, 62)),
        workouts: r() < 0.35 ? [pick(WORKOUTS)] : [],
        source: 'apple',
        syncedAt: `${addDays(date, 1)}T08:${pad(Math.floor(between(0, 59)))}`,
        edited: [],
      };
    }
    if (i === 0) {
      const log = emptyLog();
      log.meals.breakfast = { time: '07:40', text: 'Oatmeal with banana, coffee' };
      log.drinks = { water: 1, coffee: 1, alcohol: null };
      log.meds.taken.vitd = { done: true, time: '07:45' };
      days[date] = log;
      continue;
    }
    if (r() > 0.86) continue; // Some days are not logged.

    const weekend = [0, 6].includes(parse(date).getDay());
    const coffee = Math.round(between(1, 4.4));
    const symptoms = [];
    const sev = () => (r() < 0.55 ? 1 : r() < 0.8 ? 2 : 3);
    const sym = (name, severity, when) => symptoms.push({ name, severity, periods: [], from: '', to: '', ...when });
    if (sleepTotal < 380 && r() < 0.6) sym('Fatigue', sev(), { when: 'periods', periods: r() < 0.5 ? ['afternoon'] : ['afternoon', 'evening'] });
    const headache = r() < 0.1;
    if (headache) sym('Headache', sev(), r() < 0.4 ? { when: 'day' } : { when: 'periods', periods: ['afternoon'] });
    const palp = coffee >= 3 && r() < 0.3;
    if (palp) { const from = t5(14 * 60 + 30, 16 * 60); sym('Palpitations', 2, { when: 'time', from, to: minToHm(Number(from.slice(0, 2)) * 60 + Number(from.slice(3)) + 10) }); }
    if (r() < 0.06) sym('Bloating', 1, { when: 'periods', periods: ['evening'] });
    const snacks = [];
    if (r() < 0.4) snacks.push({ time: t5(10 * 60 + 15, 11 * 60), text: pick(SNACKS) });
    if (r() < 0.55) snacks.push({ time: t5(16 * 60, 17 * 60 + 30), text: pick(SNACKS) });
    let notes = '';
    if (palp) notes = `Palpitations for about 10 min, after coffee number ${coffee}.`;
    else if (symptoms.some(s => s.name === 'Fatigue')) notes = 'Tired all afternoon.';
    else if (r() < 0.15) notes = pick(NOTES);

    const taken = { mag: { done: r() < 0.85, time: t5(21 * 60, 22 * 60 + 30) } };
    if (i < 198) taken.vitd = { done: r() < 0.9, time: t5(7 * 60, 8 * 60 + 30) };
    for (const k of Object.keys(taken)) if (!taken[k].done) taken[k].time = '';

    days[date] = {
      v: LOG_VERSION,
      meals: {
        breakfast: { time: t5(7 * 60, 8 * 60 + 30), text: pick(BREAKFASTS) },
        lunch: { time: t5(12 * 60 + 15, 13 * 60 + 30), text: pick(LUNCHES) },
        dinner: { time: t5(19 * 60 + 15, 21 * 60), text: pick(DINNERS) },
      },
      snacks,
      drinks: { water: Math.round(between(3, 9)), coffee, alcohol: weekend && r() < 0.6 ? Math.round(between(1, 3)) : 0 },
      meds: { taken, extra: headache && r() < 0.6 ? [{ name: 'Paracetamol 1 g', time: t5(15 * 60, 18 * 60) }] : [] },
      activities: pick(ACTIVITIES), symptoms, notes,
    };
  }

  const measurements = [];
  let id = 1;
  [-118, -96, -81, -60, -47, -33, -19, -9, -3].forEach((d, k, all) => {
    const value = Math.round((78.6 - (1.7 * k) / (all.length - 1) + between(-0.3, 0.3)) * 10) / 10;
    measurements.push({ id: id++, type: 'weight', date: addDays(today, d), time: '07:30', value, source: k % 3 === 1 ? 'manual' : 'apple' });
  });
  [[-110, 128, 82, 64], [-60, 124, 79, 61], [-20, 121, 78, 60], [-5, 142, 91, 66]].forEach(([d, sys, dia, pulse]) => {
    measurements.push({ id: id++, type: 'bp', date: addDays(today, d), time: '19:00', value: { sys, dia, pulse }, source: 'manual' });
  });
  [[-41, '21:10', 38.3], [-40, '08:00', 37.6], [-40, '20:30', 37.9], [-39, '08:15', 37.0]].forEach(([d, time, value]) => {
    measurements.push({ id: id++, type: 'temp', date: addDays(today, d), time, value, source: 'manual' });
  });

  const documents = [
    {
      id: 101, date: addDays(today, -27), title: 'Blood test – follow-up', category: 'Blood test', correspondent: 'Laboratoire BioCentre', url: '',
      content: `LABORATOIRE BIOCENTRE – Sample no. 2026-88412-07\nPatient: Alex Example – born 14/03/1991\nCollected: ${dmy(-27)} 08:10, fasting\n\nTotal cholesterol   1.98 g/L    (< 2.00)\nLDL cholesterol     1.30 g/L    (< 1.60)\nHDL cholesterol     0.55 g/L    (> 0.40)\nTriglycerides       0.96 g/L    (< 1.50)\nVitamin D (25-OH)   31 ng/mL    (30 – 100)\nMagnesium           0.86 mmol/L (0.70 – 1.00)\nPotassium           4.2 mmol/L  (3.5 – 5.0)\n\nValidated by Dr. Claire Martin, biologist.`,
    },
    {
      id: 102, date: addDays(today, -128), title: 'Holter ECG, 24 h', category: 'Cardiology', correspondent: 'Dr. Laurent Petit – Cardiology', url: '',
      content: `24-HOUR HOLTER ECG\nPatient: Alex Example, DOB 14/03/1991, file 4481920377\nRecording started ${dmy(-129)} 09:30\n\nSinus rhythm throughout. Mean HR 72 bpm, min 48 bpm (sleep), max 141 bpm (exercise).\n312 isolated PVCs (< 1% of beats), no couplets, no runs.\nNo pauses > 2 s. No atrial fibrillation.\nPatient diary: palpitations at 15:20 match an isolated PVC.\n\nConclusion: benign isolated PVCs. No treatment needed. Reduce caffeine.\nDr. L. Petit – tel. 01 23 45 67 89 – l.petit@clinique-saint-roch.fr`,
    },
    {
      id: 103, date: addDays(today, -142), title: 'Echocardiogram report', category: 'Cardiology', correspondent: 'Dr. Laurent Petit – Cardiology', url: '',
      content: `TRANSTHORACIC ECHOCARDIOGRAM – Clinique Saint-Roch\nPatient: Alex Example, DOB 14/03/1991, ID 4481920377\nIndication: palpitations, soft systolic murmur.\n\nLeft ventricle: normal size and wall thickness. LVEF 62% (Simpson biplane).\nMitral valve: mild prolapse of the posterior leaflet, trace regurgitation.\nAortic valve: tricuspid, normal. Right heart normal. No pericardial effusion.\n\nConclusion: mild mitral valve prolapse with trace regurgitation. Normal LV function.\nFollow-up echo in 2 years, or earlier if symptoms change.\nDr. Laurent Petit, cardiologist.`,
    },
    {
      id: 104, date: addDays(today, -205), title: 'Blood test – annual check-up', category: 'Blood test', correspondent: 'Laboratoire BioCentre', url: '',
      content: `LABORATOIRE BIOCENTRE – Sample no. 2026-31877-02\nPatient: Alex Example – born 14/03/1991\nCollected: ${dmy(-205)} 07:55, fasting\n\nTotal cholesterol   2.15 g/L    (< 2.00)    HIGH\nLDL cholesterol     1.42 g/L    (< 1.60)\nHDL cholesterol     0.52 g/L    (> 0.40)\nTriglycerides       1.05 g/L    (< 1.50)\nFasting glucose     0.94 g/L    (0.70 – 1.00)\nHbA1c               5.3 %       (< 5.7)\nTSH                 2.1 mIU/L   (0.4 – 4.0)\nFerritin            38 µg/L     (30 – 400)\nVitamin D (25-OH)   18 ng/mL    (30 – 100)  LOW\nCreatinine          9.8 mg/L    (7 – 12), eGFR > 90\n\nValidated by Dr. Claire Martin, biologist.`,
    },
  ];

  const settings = { lastSync: health[addDays(today, -2)].syncedAt, redactWords: ['BioCentre', 'Clinique Saint-Roch'], excludedDocs: [] };
  return { profile, days, health, measurements, documents, settings, nextId: id, seededOn: today };
}
