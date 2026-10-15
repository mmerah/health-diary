// The data model of the diary, in one place. Screens, forms and the report read these
// definitions, so a new meal, drink or measurement type is added here only.
import { hmToMin, isValidTime } from './dates.js';

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

/** Types for documents kept in the diary. The server suggests one from the text; the user confirms.
    Paperless documents keep the type they have in Paperless. */
export const DOC_CATEGORIES = ['Blood test', 'Cardiology', 'Imaging', 'Consultation letter', 'Prescription',
  'Hospital stay', 'Vaccination', 'Other'];

/** Common symptoms, offered as one-tap chips. Users can add any other name. */
export const SYMPTOMS = ['Fatigue', 'Headache', 'Palpitations', 'Dizziness', 'Short of breath', 'Chest tightness',
  'Bloating', 'Nausea', 'Back pain', 'Joint pain'];

const one = v => Number(v).toFixed(1);

/** Body mass index, or null when weight or height is missing or not plausible. */
export function bmi(kg, heightCm) {
  const w = Number(kg), h = Number(heightCm);
  if (!(w >= 20 && w <= 300) || !(h >= 50 && h <= 250)) return null;
  return Math.round((w / ((h / 100) ** 2)) * 10) / 10;
}

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
  const def = measurementDef(type);
  if (!def) return { error: 'This measurement type no longer exists.' };
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

export const medLabel = m => [m.name, m.dose].filter(Boolean).join(' ');

/** Medications that are scheduled (not "as needed") and active on a date. */
export const activeMeds = (profile, date) => (profile.medications || [])
  .filter(m => !m.asNeeded && (!m.since || m.since <= date) && (!m.until || m.until >= date));

export const asNeededMeds = (profile, date) => (profile.medications || [])
  .filter(m => m.asNeeded && (!m.until || m.until >= date));

export function normalizeProfile(raw) {
  const p = { ...(raw || {}) };
  p.medications = (Array.isArray(p.medications) ? p.medications : []).map(m => ({ id: m.id || newId(), name: m.name || '', dose: m.dose || '',
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

/** A stored log → a complete, safe log: missing parts are filled in, bad values dropped. Every reader calls this. */
export function normalizeLog(raw) {
  const base = emptyLog();
  if (!raw) return base;
  const log = { ...base, v: LOG_VERSION };
  for (const m of MEALS) {
    const x = (raw.meals || {})[m.key] || {};
    log.meals[m.key] = { time: time(x.time), text: str(x.text) };
  }
  log.snacks = (raw.snacks || []).map(s => ({ time: time(s.time), text: str(s.text) }));
  // Built-in drinks, plus the user's own counters (ids "c_…"; kept even when the counter is deleted later).
  const keys = new Set([...DRINKS.map(d => d.key), ...Object.keys(raw.drinks || {}).filter(k => CUSTOM_ID.test(k))]);
  for (const k of keys) {
    const v = (raw.drinks || {})[k];
    log.drinks[k] = v == null || v === '' ? null : Math.min(999, Math.max(0, Math.round(Number(v)) || 0));
  }
  const taken = (raw.meds || {}).taken || {};
  log.meds = {
    taken: Object.fromEntries(Object.entries(taken).map(([k, v]) => [k, { done: !!(v && v.done), time: time(v && v.time) }])),
    extra: ((raw.meds || {}).extra || []).map(x => ({ name: str(x.name), time: time(x.time) })),
  };
  log.activities = str(raw.activities);
  log.notes = str(raw.notes);
  log.symptoms = (raw.symptoms || []).filter(s => s && typeof s === 'object').map(s => ({
    name: str(s.name),
    severity: [1, 2, 3].includes(s.severity) ? s.severity : null,
    when: ['day', 'periods', 'time'].includes(s.when) ? s.when : null,
    periods: (s.periods || []).filter(p => PERIODS.some(x => x.key === p)),
    from: time(s.from),
    to: time(s.to),
  })).filter(s => s.name);
  return log;
}

/** True when the user wrote or ticked anything for the day. */
export function hasContent(log) {
  const l = normalizeLog(log);
  return !!(l.activities || l.notes || l.symptoms.length || l.snacks.length || l.meds.extra.length
    || Object.values(l.meds.taken).some(t => t.done)
    || Object.values(l.drinks).some(v => v != null)
    || MEALS.some(m => l.meals[m.key].text));
}

/** "7 water · 2 coffee · 0 alcohol · 3 tea" for the counters that were recorded; '' when none was. */
export const drinkSummary = drinks => counterTypes({ all: true })
  .filter(d => drinks && drinks[d.key] != null)
  .map(d => `${drinks[d.key]} ${d.label.toLowerCase()}`)
  .join(' · ');

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

// ---------- The user's own catalog: symptoms, document types, measurements and counters
// Built-in items stay and keep their special logic (blood pressure, BMI, the report's coffee and
// alcohol links). The user adds their own items next to them. Own ids start with "c_".
// main.js loads the catalog after login and calls setCatalog(); screens use the functions below.

export const CUSTOM_ID = /^c_[a-z0-9]{2,24}$/;
const MAX_ITEMS = 60;

/** Ready-made measurements to add in one tap (normal limits are common adult values; the user can change them). */
export const MEASUREMENT_PRESETS = [
  { name: 'Blood glucose', unit: 'mmol/L', low: 3.9, high: 7.8, min: 0.5, max: 40, step: 0.1 },
  { name: 'Blood glucose', unit: 'mg/dL', low: 70, high: 140, min: 10, max: 700, step: 1 },
  { name: 'Oxygen (SpO2)', unit: '%', low: 95, high: null, min: 50, max: 100, step: 1 },
  { name: 'Heart rate', unit: 'bpm', low: 50, high: 100, min: 20, max: 250, step: 1 },
  { name: 'Peak flow', unit: 'L/min', low: null, high: null, min: 50, max: 900, step: 10 },
  { name: 'INR', unit: '', low: 2, high: 3, min: 0.5, max: 10, step: 0.1 },
  { name: 'Pain', unit: '/10', low: null, high: 4, min: 0, max: 10, step: 1 },
  { name: 'Waist', unit: 'cm', low: null, high: null, min: 30, max: 250, step: 0.5 },
];

/** Ready-made counters next to water, coffee and alcohol. */
export const COUNTER_PRESETS = [
  { name: 'Tea', one: 'cup', many: 'cups' },
  { name: 'Energy drink', one: 'can', many: 'cans' },
  { name: 'Soft drink', one: 'glass', many: 'glasses' },
  { name: 'Cigarettes', one: 'cigarette', many: 'cigarettes' },
];

export function emptyCatalog() {
  return { v: 1, symptoms: [...SYMPTOMS], docTypes: { custom: [], hidden: [] }, measurements: [], counters: [] };
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numOrNull = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** Any stored catalog → a complete, safe one. Every reader goes through this. */
export function normalizeCatalog(raw) {
  const c = emptyCatalog();
  if (!raw) return c;
  if (Array.isArray(raw.symptoms)) {
    c.symptoms = [...new Set(raw.symptoms.map(x => text(x, 100)).filter(Boolean))].slice(0, MAX_ITEMS);
  }
  const dt = raw.docTypes || {};
  c.docTypes.custom = [...new Set((dt.custom || []).map(x => text(x, 60)).filter(x => x && !DOC_CATEGORIES.includes(x)))].slice(0, MAX_ITEMS);
  c.docTypes.hidden = (dt.hidden || []).filter(x => DOC_CATEGORIES.includes(x) && x !== 'Other');
  c.measurements = (raw.measurements || []).filter(m => m && CUSTOM_ID.test(m.id) && text(m.name, 60)).slice(0, MAX_ITEMS).map(m => {
    const min = numOrNull(m.min) ?? 0, max = numOrNull(m.max) ?? 100000;
    return { id: m.id, name: text(m.name, 60), unit: text(m.unit, 20), low: numOrNull(m.low), high: numOrNull(m.high),
      min: Math.min(min, max), max: Math.max(min, max), step: numOrNull(m.step) || 0.1, hidden: !!m.hidden };
  });
  c.counters = (raw.counters || []).filter(x => x && CUSTOM_ID.test(x.id) && text(x.name, 40)).slice(0, MAX_ITEMS).map(x => ({
    id: x.id, name: text(x.name, 40), one: text(x.one, 20) || 'time', many: text(x.many, 20) || 'times', hidden: !!x.hidden,
  }));
  return c;
}

let current = emptyCatalog();
/** main.js calls this after login and after every catalog change. */
export function setCatalog(raw) { current = normalizeCatalog(raw); return current; }
export const getCatalog = () => current;

const decimals = step => (String(step).split('.')[1] || '').length;

/** A measurement definition (like MEASUREMENTS.weight) for one of the user's own measurements. */
export function customMeasurementDef(m) {
  const d = decimals(m.step);
  const fmt = v => `${Number(v).toFixed(d)}${m.unit ? (m.unit.startsWith('/') ? m.unit : ` ${m.unit}`) : ''}`;
  return {
    label: m.name, unit: m.unit, custom: true, low: m.low, high: m.high,
    fields: [{ key: 'v', label: m.unit || m.name, min: m.min, max: m.max, step: m.step, required: true }],
    parse: f => ({ value: Math.round(Number(f.v) * 10 ** d) / 10 ** d }),
    format: fmt,
    flag: v => (m.low != null && v < m.low ? `Below your range (under ${fmt(m.low)})`
      : m.high != null && v > m.high ? `Above your range (over ${fmt(m.high)})` : null),
  };
}

/** All measurement types: built-in first, then the user's own (hidden ones only with all: true, for old values). */
export function measurementTypes({ all = false } = {}) {
  const out = { ...MEASUREMENTS };
  for (const m of current.measurements) if (all || !m.hidden) out[m.id] = customMeasurementDef(m);
  return out;
}
export const measurementDef = type => measurementTypes({ all: true })[type] || null;

/** All counters on the Today screen: water, coffee, alcohol, then the user's own. */
export function counterTypes({ all = false } = {}) {
  return [...DRINKS, ...current.counters.filter(x => all || !x.hidden).map(x => ({ key: x.id, label: x.name, one: x.one, many: x.many, custom: true }))];
}

/** Document types to choose from: built-in ones that are not hidden, then the user's own. */
export const docCategories = () => [...DOC_CATEGORIES.filter(x => !current.docTypes.hidden.includes(x)), ...current.docTypes.custom];
/** True for built-in types. The AI report shows only these; own types become "Medical document". */
export const isBuiltInDocType = t => DOC_CATEGORIES.includes(t);

/** The one-tap symptom chips, in the user's order. */
export const symptomChips = () => current.symptoms;
