// The data model of the diary, in one place. Screens, forms and the report read these
// definitions, so a new meal, drink or measurement type is added here only.
import { hmToMin, isValidTime } from './dates.js';
import { lines } from './format.js';

export const LOG_VERSION = 2;

export const MEALS = [
  { key: 'breakfast', label: 'Breakfast', typical: '08:00', from: '04:00' },
  { key: 'lunch', label: 'Lunch', typical: '12:30', from: '11:00' },
  { key: 'dinner', label: 'Dinner', typical: '19:30', from: '17:00' },
];

/** The meal that fits a time of day, for quick add. */
export function mealAt(hm) {
  const m = hmToMin(hm);
  return [...MEALS].reverse().find(x => m >= hmToMin(x.from)) || MEALS[MEALS.length - 1];
}

export const DRINKS = [
  { key: 'water', label: 'Water', one: 'glass', many: 'glasses' },
  { key: 'coffee', label: 'Coffee', one: 'cup', many: 'cups' },
  { key: 'alcohol', label: 'Alcohol', one: 'drink', many: 'drinks' },
];

export const SEVERITIES = [
  { value: 1, label: 'Mild' },
  { value: 2, label: 'Moderate' },
  { value: 3, label: 'Severe' },
];
export const severityLabel = v => (SEVERITIES.find(s => s.value === v) || {}).label || 'Severity not set';

export const PERIODS = [
  { key: 'morning', label: 'Morning', from: 6 * 60, until: 12 * 60 },
  { key: 'afternoon', label: 'Afternoon', from: 12 * 60, until: 18 * 60 },
  { key: 'evening', label: 'Evening', from: 18 * 60, until: 22 * 60 },
  { key: 'night', label: 'Night', from: 22 * 60, until: 6 * 60 },
];
export function periodOf(hm) {
  const m = hmToMin(hm);
  if (m == null) return null;
  return (PERIODS.find(p => (p.from < p.until ? m >= p.from && m < p.until : m >= p.from || m < p.until)) || {}).key;
}

/** Common symptoms, offered as one-tap chips. Users can add any other name. */
export const SYMPTOMS = ['Fatigue', 'Headache', 'Palpitations', 'Dizziness', 'Short of breath', 'Chest tightness',
  'Bloating', 'Nausea', 'Back pain', 'Joint pain'];

const one = v => Number(v).toFixed(1);

/** Measurement types. `fields` drive the forms, `parse` validates them, `format` and `flag` drive display and report. */
export const MEASUREMENTS = {
  weight: {
    label: 'Weight', unit: 'kg',
    fields: [{ key: 'kg', label: 'kg', min: 20, max: 300, step: 0.1, required: true }],
    parse: f => ({ value: Math.round(Number(f.kg) * 10) / 10 }),
    format: v => `${one(v)} kg`,
    flag: () => null,
  },
  bp: {
    label: 'Blood pressure', unit: 'mmHg',
    fields: [
      { key: 'sys', label: 'Sys', min: 60, max: 260, step: 1, required: true },
      { key: 'dia', label: 'Dia', min: 30, max: 160, step: 1, required: true },
      { key: 'pulse', label: 'Pulse', min: 20, max: 220, step: 1 },
    ],
    parse: f => {
      const sys = Math.round(Number(f.sys)), dia = Math.round(Number(f.dia));
      if (sys <= dia) return { error: 'The first number (systolic) must be higher than the second (diastolic).' };
      return { value: { sys, dia, pulse: f.pulse === '' || f.pulse == null ? null : Math.round(Number(f.pulse)) } };
    },
    format: v => `${v.sys}/${v.dia} mmHg${v.pulse ? ` · pulse ${v.pulse}` : ''}`,
    flag: v => (v.sys >= 140 || v.dia >= 90 ? 'High (140/90 or above)' : v.sys < 90 || v.dia < 60 ? 'Low (under 90/60)' : null),
  },
  temp: {
    label: 'Temperature', unit: '°C',
    fields: [{ key: 'c', label: '°C', min: 34, max: 43, step: 0.1, required: true }],
    parse: f => ({ value: Math.round(Number(f.c) * 10) / 10 }),
    format: v => `${one(v)} °C`,
    flag: v => (v >= 38 ? 'Fever (38 °C or above)' : v < 35.5 ? 'Low (under 35.5 °C)' : null),
  },
};

/** Checks raw form values against the field limits, then parses them. Returns {value} or {error}. */
export function parseMeasurement(type, raw) {
  const def = MEASUREMENTS[type];
  for (const f of def.fields) {
    const v = raw[f.key];
    if (v === '' || v == null) {
      if (f.required) return { error: `Enter the ${f.label === 'kg' || f.label === '°C' ? def.label.toLowerCase() : f.label.toLowerCase()}.` };
      continue;
    }
    const n = Number(String(v).replace(',', '.'));
    if (!(n >= f.min && n <= f.max)) return { error: `${def.label}: enter a value from ${f.min} to ${f.max}.` };
    raw[f.key] = n;
  }
  return def.parse(raw);
}

// ---------- Medications (profile) and the daily log

let seq = 0;
export const newId = (prefix = 'm') => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Stable id for a medication that came from the old one-line-per-medication text. */
function legacyMedId(line) {
  let h = 5381;
  for (const c of line) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return `l${h.toString(36)}`;
}

export const medLabel = m => [m.name, m.dose].filter(Boolean).join(' ');

/** Medications that are scheduled (not "as needed") and active on a date. */
export const activeMeds = (profile, date) => (profile.medications || [])
  .filter(m => !m.asNeeded && (!m.since || m.since <= date) && (!m.until || m.until >= date));

export const asNeededMeds = (profile, date) => (profile.medications || [])
  .filter(m => m.asNeeded && (!m.until || m.until >= date));

export function normalizeProfile(raw) {
  const p = { ...(raw || {}) };
  if (typeof p.medications === 'string') {
    p.medications = lines(p.medications).map(l => ({ id: legacyMedId(l), name: l, dose: '', since: '', until: '', asNeeded: false }));
  }
  p.medications = (p.medications || []).map(m => ({ id: m.id || newId(), name: m.name || '', dose: m.dose || '',
    since: m.since || '', until: m.until || '', asNeeded: !!m.asNeeded }));
  return p;
}

export function emptyLog() {
  return {
    v: LOG_VERSION,
    meals: Object.fromEntries(MEALS.map(m => [m.key, { time: '', text: '' }])),
    snacks: [],
    // null = not recorded. 0 = recorded as none.
    drinks: Object.fromEntries(DRINKS.map(d => [d.key, null])),
    meds: { taken: {}, extra: [] },
    activities: '',
    symptoms: [], // { name, severity: 1|2|3|null, when: 'day'|'periods'|'time'|null, periods: [], from, to }
    notes: '',
  };
}

const str = v => (typeof v === 'string' ? v : '');
const time = v => (isValidTime(str(v)) ? str(v) : '');

/** Any stored log (old or new format) → a complete version 2 log. Every reader calls this. */
export function normalizeLog(raw) {
  const base = emptyLog();
  if (!raw) return base;
  const log = { ...base, v: LOG_VERSION };
  for (const m of MEALS) {
    const x = (raw.meals || {})[m.key] || {};
    log.meals[m.key] = { time: time(x.time), text: str(x.text) };
  }
  log.snacks = (raw.snacks || []).map(s => ({ time: time(s.time), text: str(s.text) }));
  for (const d of DRINKS) {
    const v = (raw.drinks || {})[d.key];
    log.drinks[d.key] = v == null || v === '' ? null : Math.max(0, Math.round(Number(v)) || 0);
  }
  const taken = (raw.meds || {}).taken || {};
  log.meds = {
    taken: Object.fromEntries(Object.entries(taken).map(([k, v]) =>
      // Version 1 stored {"<medication line>": true}.
      typeof v === 'boolean' ? [legacyMedId(k), { done: v, time: '' }] : [k, { done: !!(v && v.done), time: time(v && v.time) }])),
    extra: ((raw.meds || {}).extra || []).map(x => ({ name: str(x.name), time: time(x.time) })),
  };
  log.activities = str(raw.activities);
  log.notes = str(raw.notes);
  log.symptoms = (raw.symptoms || []).map(s => (typeof s === 'string'
    ? { name: s, severity: null, when: null, periods: [], from: '', to: '' }
    : {
      name: str(s.name),
      severity: [1, 2, 3].includes(s.severity) ? s.severity : null,
      when: ['day', 'periods', 'time'].includes(s.when) ? s.when : (s.time ? 'time' : null),
      periods: (s.periods || []).filter(p => PERIODS.some(x => x.key === p)),
      from: time(s.from || s.time),
      to: time(s.to),
    })).filter(s => s.name);
  return log;
}

/** True when the user wrote or ticked anything for the day. */
export function hasContent(log) {
  const l = normalizeLog(log);
  return !!(l.activities || l.notes || l.symptoms.length || l.snacks.length || l.meds.extra.length
    || Object.values(l.meds.taken).some(t => t.done)
    || DRINKS.some(d => l.drinks[d.key] != null)
    || MEALS.some(m => l.meals[m.key].text));
}

/** When a symptom happened, in words: "all day", "morning and evening", "15:10–15:20". */
export function describeWhen(s) {
  if (s.when === 'day') return 'all day';
  if (s.when === 'periods' && s.periods.length) {
    const p = PERIODS.filter(x => s.periods.includes(x.key)).map(x => x.key);
    return p.length > 1 ? `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}` : p[0];
  }
  if (s.when === 'time' && s.from) return s.to ? `${s.from}–${s.to}` : s.from;
  return '';
}

/** Health data merge rule (same as the server): new values win, except fields corrected by hand. */
export function mergeHealth(old, fresh, syncedAt) {
  const prev = old || {};
  const edited = prev.edited || [];
  const out = { ...prev };
  for (const [k, v] of Object.entries(fresh)) if (v != null && !edited.includes(k)) out[k] = v;
  out.edited = edited;
  out.source = out.source || 'apple';
  if (syncedAt) out.syncedAt = syncedAt;
  return out;
}
