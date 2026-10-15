// Pure helpers for "My lists" (Profile → Settings): ids, presets, order, validation. No DOM.
// Unit-tested in tests/profile.test.js.
import { CUSTOM_ID, DOC_CATEGORIES, newId } from '../core/schema.js';

/** A new own id ("c_…") that matches CUSTOM_ID and is not in `taken`. */
export function customId(taken = []) {
  const used = new Set(taken);
  for (let i = 0; i < 20; i++) {
    const id = newId('c_').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 26);
    if (CUSTOM_ID.test(id) && !used.has(id)) return id;
  }
  throw new Error('Could not make a new id. Try again.');
}

const idsOf = catalog => [...catalog.measurements.map(m => m.id), ...catalog.counters.map(c => c.id)];

/** A measurement from a preset, ready to add. */
export function presetToMeasurement(p, catalog) {
  return { id: customId(idsOf(catalog)), name: p.name, unit: p.unit || '', low: p.low ?? null, high: p.high ?? null,
    min: p.min, max: p.max, step: p.step, hidden: false };
}

/** A counter from a preset, ready to add. */
export function presetToCounter(p, catalog) {
  return { id: customId(idsOf(catalog)), name: p.name, one: p.one, many: p.many, hidden: false };
}

/** True when the catalog already has this preset (same name and unit). */
export const hasMeasurementPreset = (catalog, p) => catalog.measurements.some(m => m.name === p.name && (m.unit || '') === (p.unit || ''));
export const hasCounterPreset = (catalog, p) => catalog.counters.some(c => c.name.toLowerCase() === p.name.toLowerCase());

/** A copy of list with item i moved by delta (−1 up, +1 down). Out of range: unchanged copy. */
export function moveItem(list, i, delta) {
  const out = [...list];
  const j = i + delta;
  if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

const num = v => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
const bad = v => v != null && !Number.isFinite(v);

/** Checks the "own measurement" form. Returns { value } or { error, field }. */
export function parseMeasurementForm(f) {
  const name = String(f.name || '').trim(), unit = String(f.unit || '').trim();
  const low = num(f.low), high = num(f.high), min = num(f.min), max = num(f.max), step = num(f.step);
  if (!name) return { error: 'Enter a name.', field: 'name' };
  if (name.length > 60) return { error: 'Use at most 60 characters for the name.', field: 'name' };
  if (unit.length > 20) return { error: 'Use at most 20 characters for the unit.', field: 'unit' };
  for (const [k, v] of Object.entries({ low, high, min, max, step })) if (bad(v)) return { error: 'Enter numbers only.', field: k };
  if (min == null || max == null) return { error: 'Enter the lowest and the highest value you can write.', field: min == null ? 'min' : 'max' };
  if (min >= max) return { error: 'The highest value must be more than the lowest value.', field: 'max' };
  if (!(step > 0)) return { error: 'The step must be more than 0. Example: 1, or 0.1 for one decimal.', field: 'step' };
  if (low != null && (low < min || low > max)) return { error: `The normal range must be from ${min} to ${max}.`, field: 'low' };
  if (high != null && (high < min || high > max)) return { error: `The normal range must be from ${min} to ${max}.`, field: 'high' };
  if (low != null && high != null && low >= high) return { error: 'The top of the normal range must be more than the bottom.', field: 'high' };
  return { value: { name, unit, low, high, min, max, step } };
}

/** Checks the "own counter" form. Returns { value } or { error, field }. */
export function parseCounterForm(f) {
  const name = String(f.name || '').trim(), one = String(f.one || '').trim(), many = String(f.many || '').trim();
  if (!name) return { error: 'Enter a name.', field: 'name' };
  if (name.length > 40) return { error: 'Use at most 40 characters for the name.', field: 'name' };
  if (!one) return { error: 'Enter the word for one. Example: cup.', field: 'one' };
  if (!many) return { error: 'Enter the word for more than one. Example: cups.', field: 'many' };
  if (one.length > 20 || many.length > 20) return { error: 'Use at most 20 characters for each word.', field: one.length > 20 ? 'one' : 'many' };
  return { value: { name, one, many } };
}

/** Checks a new symptom chip. Returns '' or an error. */
export function symptomError(name, list) {
  const n = String(name || '').trim();
  if (!n) return 'Enter a symptom.';
  if (n.length > 100) return 'Use at most 100 characters.';
  if (list.some(x => x.toLowerCase() === n.toLowerCase())) return 'This symptom is already in the list.';
  return '';
}

/** Checks a new (or renamed) document type. Returns '' or an error. */
export function docTypeError(name, catalog, { except = '' } = {}) {
  const n = String(name || '').trim();
  if (!n) return 'Enter a type.';
  if (n.length > 60) return 'Use at most 60 characters.';
  const all = [...DOC_CATEGORIES, ...catalog.docTypes.custom].filter(x => x !== except);
  if (all.some(x => x.toLowerCase() === n.toLowerCase())) return 'This type is already in the list.';
  return '';
}

/** Number of documents with this type. */
export const docTypeUse = (docs, type) => (docs || []).filter(d => d.category === type).length;
