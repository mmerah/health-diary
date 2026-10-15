// Pure helpers for the Today screen and the quick-add sheet: no DOM, no API.
// Summaries for collapsed rows, drink stepping, the week strip, symptom chip order,
// hand corrections of health data, and measurement form checks. Tested in tests/today.test.js.
import { addDays, hmToMin, isValidDate, parse } from '../core/dates.js';
import { duration, fold, num } from '../core/format.js';
import {
  MEALS, SYMPTOMS, counterTypes, describeWhen, drinkSummary, mealAt, measurementDef, measurementTypes, normalizeLog, parseMeasurement,
  severityLabel,
} from '../core/schema.js';

/** First words of a text, on one line, with "…" when cut. */
export function clip(text, max = 44) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

// ---------- Days and weeks

/** A valid date that is not after `max` (today). Anything else gives `max`. */
export function clampDate(date, max) {
  if (!date || !isValidDate(date)) return max;
  return date > max ? max : date;
}

/** The 7 days (Monday to Sunday) of the week that contains `date`. */
export function weekDays(date) {
  const monday = addDays(date, -((parse(date).getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The same weekday `n` weeks later or earlier, never after `max`. */
export const shiftWeek = (date, n, max) => clampDate(addDays(date, 7 * n), max);

// ---------- Drinks

/** null = not recorded. The first + gives 1, the first − gives 0 ("none"). Never below 0. */
export function stepDrink(value, delta) {
  if (value == null) return delta > 0 ? 1 : 0;
  return Math.max(0, value + delta);
}

// ---------- One-line summaries for collapsed rows. '' means "nothing logged".

export function mealSummary(meal) {
  if (!meal || !meal.text) return '';
  return [meal.time, clip(meal.text)].filter(Boolean).join(' · ');
}

export function snacksSummary(snacks) {
  const list = (snacks || []).filter(s => s.text || s.time);
  if (!list.length) return '';
  return clip(list.map(s => s.text || s.time).join(', '));
}

/** "7 water · 2 coffee" (shared wording, also used by the report). */
export const drinksSummary = drinks => drinkSummary(drinks);

/** "2 of 3 taken · 1 extra". `scheduled` = activeMeds(profile, date). */
export function medsSummary(log, scheduled) {
  const parts = [];
  if (scheduled.length) {
    const done = scheduled.filter(m => (log.meds.taken[m.id] || {}).done).length;
    parts.push(`${done} of ${scheduled.length} taken`);
  }
  const extra = log.meds.extra.filter(x => x.name).length;
  if (extra) parts.push(`${extra} extra`);
  return parts.join(' · ');
}

export function symptomsSummary(symptoms) {
  return clip((symptoms || []).map(s => (s.severity ? `${s.name} (${severityLabel(s.severity).toLowerCase()})` : s.name)).join(', '), 60);
}

/** One symptom in words: "Moderate · afternoon". */
export function symptomDetail(s) {
  return [s.severity ? severityLabel(s.severity) : '', describeWhen(s)].filter(Boolean).join(' · ');
}

/** Latest value of each type: "Weight 76.9 kg · Blood pressure 142/91 mmHg". */
export function measurementsSummary(list) {
  const latest = {};
  for (const m of [...(list || [])].sort((a, b) => (a.time || '').localeCompare(b.time || ''))) latest[m.type] = m;
  // Built-in types first, then the user's own (also hidden ones: old values still show).
  return Object.entries(measurementTypes({ all: true })).filter(([t]) => latest[t])
    .map(([t, def]) => `${def.label} ${def.format(latest[t].value)}`).join(' · ');
}

/** Items of the slim health row. Empty array: no data. */
export function healthItems(h) {
  if (!h) return [];
  const s = h.sleep || {};
  const items = [];
  if (s.total != null) items.push({ key: 'sleep', label: s.inBedOnly ? 'Time in bed' : 'Sleep', value: duration(s.total), unit: '' });
  if (h.steps != null) items.push({ key: 'steps', label: 'Steps', value: num(h.steps), unit: '' });
  if (h.restingHr != null) items.push({ key: 'restingHr', label: 'Resting heart rate', value: num(h.restingHr), unit: 'bpm' });
  if (h.hrv != null) items.push({ key: 'hrv', label: 'Heart rate variability', value: num(h.hrv), unit: 'ms HRV' });
  return items;
}

/** Sleep stages as shares of the total (for the bar), only when the stages are known. */
export function sleepStages(sleep) {
  const s = sleep || {};
  const parts = [['deep', 'Deep'], ['core', 'Core'], ['rem', 'REM'], ['awake', 'Awake']]
    .filter(([k]) => s[k] > 0).map(([key, label]) => ({ key, label, minutes: s[key] }));
  const sum = parts.reduce((a, p) => a + p.minutes, 0);
  if (!sum || parts.length < 2) return [];
  return parts.map(p => ({ ...p, share: p.minutes / sum }));
}

/** "Synced 08:12" (today) or "Synced 13 Oct 08:12", or "Entered by hand". */
export function healthSource(h, todayIso) {
  if (!h) return '';
  if (h.source === 'manual' || !h.syncedAt) return 'Entered by hand';
  const day = h.syncedAt.slice(0, 10), hm = h.syncedAt.slice(11, 16);
  if (day === todayIso) return `Synced ${hm}`;
  return `Synced ${parse(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hm}`;
}

// ---------- Which sections are open at first

/** All sections that can open. */
export const SECTION_KEYS = ['health', ...MEALS.map(m => m.key), 'snacks', 'drinks', 'meds', 'activities', 'symptoms', 'notes', 'measurements'];

/**
 * Wide screens: everything open. Phone, today: the meal that fits the time of day, if it is still empty.
 * Phone, other days: none.
 */
export function defaultOpen(log, { isToday, now, wide = false }) {
  if (wide) return new Set(SECTION_KEYS);
  if (!isToday) return new Set();
  const meal = mealAt(now);
  return log.meals[meal.key].text ? new Set() : new Set([meal.key]);
}

// ---------- Symptom chips: the user's own symptoms first (most frequent), then the defaults

/** days: [{ log }] from api.listDays. Returns symptom names, most used first. */
export function symptomOrder(days, defaults = SYMPTOMS) {
  const count = new Map(), first = new Map();
  let i = 0;
  for (const d of days || []) {
    for (const s of (d && d.log && d.log.symptoms) || []) {
      const name = s && s.name;
      if (!name) continue;
      const key = fold(name.trim());
      if (!count.has(key)) first.set(key, { name: name.trim(), i: i++ });
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  const mine = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || first.get(a).i - first.get(b).i)
    .map(k => first.get(k).name);
  const seen = new Set(mine.map(fold));
  return [...mine, ...defaults.filter(n => !seen.has(fold(n)))];
}

/**
 * The symptom chips: the user's own list in their order, then up to `extra` names they used in the
 * last days (most used first) that are not in the list. days: [{ log }] from api.listDays.
 */
export function symptomChipList(own, days, extra = 3) {
  const inList = new Set((own || []).map(fold));
  const recent = symptomOrder(days, []).filter(n => !inList.has(fold(n))).slice(0, extra);
  return [...(own || []), ...recent];
}

/** A new symptom: no severity yet. On today, "when" is the current part of the day. */
export function newSymptom(name, period) {
  return { name, severity: null, when: period ? 'periods' : null, periods: period ? [period] : [], from: '', to: '' };
}

// ---------- Text appends (quick add)

/** Adds a line "HH:MM — text" (or just text) at the end of the notes. */
export function appendNote(notes, text, hm) {
  const line = hm ? `${hm} — ${text.trim()}` : text.trim();
  const old = String(notes || '').replace(/\s+$/, '');
  return old ? `${old}\n${line}` : line;
}

/** Adds to a meal that already has text, instead of replacing it. */
export function appendMeal(old, text) {
  const a = String(old || '').trim(), b = String(text || '').trim();
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/[,;.]+$/, '')}, ${b}`;
}

/**
 * Time to prefill for a meal. On today: now, unless the meal's usual time is more than 3 hours away
 * (breakfast chosen at 15:00), then the usual time. Other days: the usual time.
 */
export function mealTime(mealKey, now, isToday) {
  const def = MEALS.find(m => m.key === mealKey);
  if (!isToday) return { time: def.typical, usual: true };
  const gap = Math.abs(hmToMin(now) - hmToMin(def.typical));
  return Math.min(gap, 1440 - gap) > 180 ? { time: def.typical, usual: true } : { time: now, usual: false };
}

/**
 * Recent texts of a meal, for one-tap chips: yesterday's first ("Same as yesterday"), then up to
 * 3 other distinct texts from the days before, newest first. days: [{ date, log }].
 */
export function recentMeals(days, mealKey, date, max = 3) {
  const list = [...(days || [])].filter(d => d && d.log && d.date < date).sort((a, b) => b.date.localeCompare(a.date));
  const text = d => (((d.log.meals || {})[mealKey] || {}).text || '').trim();
  const yesterday = list.find(d => d.date === addDays(date, -1) && text(d));
  const seen = new Set();
  const out = [];
  if (yesterday) { out.push({ label: 'Same as yesterday', text: text(yesterday) }); seen.add(fold(text(yesterday))); }
  for (const d of list) {
    const t = text(d);
    if (!t || seen.has(fold(t))) continue;
    seen.add(fold(t));
    out.push({ label: clip(t, 32), text: t });
    if (out.length >= max + (yesterday ? 1 : 0)) break;
  }
  return out;
}

// ---------- Health corrected by hand

const intOrNull = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

/**
 * Applies the "Correct by hand" form to the day's health object.
 * values: { sleepH, sleepM, bed, wake, steps, restingHr, hrv, spo2?, spo2Min?, respiratoryRate? } as typed (strings).
 * Returns { next } (with `edited` updated) or { error }.
 */
export function correctHealth(old, values) {
  const prev = old || {};
  const os = prev.sleep || {};
  const h = intOrNull(values.sleepH), m = intOrNull(values.sleepM);
  const total = h == null && m == null ? null : (h || 0) * 60 + (m || 0);
  if (total != null && (total < 0 || total > 24 * 60 || (m != null && (m < 0 || m > 59)))) return { error: 'Sleep: enter 0 to 24 hours and 0 to 59 minutes.' };
  const steps = intOrNull(values.steps), restingHr = intOrNull(values.restingHr), hrv = intOrNull(values.hrv);
  if (steps != null && (steps < 0 || steps > 200000)) return { error: 'Steps: enter a number from 0 to 200,000.' };
  if (restingHr != null && (restingHr < 20 || restingHr > 250)) return { error: 'Resting heart rate: enter a value from 20 to 250.' };
  if (hrv != null && (hrv < 1 || hrv > 400)) return { error: 'HRV: enter a value from 1 to 400.' };
  const dec = v => (v === '' || v == null || Number.isNaN(Number(String(v).replace(',', '.'))) ? null : Math.round(Number(String(v).replace(',', '.')) * 10) / 10);
  const spo2 = dec(values.spo2), spo2Min = intOrNull(values.spo2Min), respiratoryRate = dec(values.respiratoryRate);
  if (spo2 != null && (spo2 < 50 || spo2 > 100)) return { error: 'Oxygen: enter a value from 50 to 100 %.' };
  if (spo2Min != null && (spo2Min < 50 || spo2Min > 100)) return { error: 'Lowest oxygen: enter a value from 50 to 100 %.' };
  if (respiratoryRate != null && (respiratoryRate < 4 || respiratoryRate > 60)) return { error: 'Respiratory rate: enter a value from 4 to 60 per minute.' };
  const bed = values.bed || null, wake = values.wake || null;

  const sleepChanged = total !== (os.total ?? null) || bed !== (os.bed ?? null) || wake !== (os.wake ?? null);
  const next = { ...prev, steps, restingHr, hrv, source: prev.source || 'manual', workouts: prev.workouts || [] };
  if (sleepChanged) {
    // A new total makes the old stages wrong: keep them only if the total is the same.
    const sameTotal = total === (os.total ?? null);
    next.sleep = total == null && !bed && !wake ? null : {
      ...(sameTotal ? os : { naps: os.naps || [], inBedOnly: false }),
      total, bed, wake,
    };
  } else next.sleep = prev.sleep ?? null;
  const edited = new Set(prev.edited || []);
  if (sleepChanged) edited.add('sleep');
  if (steps !== (prev.steps ?? null)) edited.add('steps');
  if (restingHr !== (prev.restingHr ?? null)) edited.add('restingHr');
  if (hrv !== (prev.hrv ?? null)) edited.add('hrv');
  // The newer fields are only part of the form when the form sends them.
  for (const [k, v] of [['spo2', spo2], ['spo2Min', spo2Min], ['respiratoryRate', respiratoryRate]]) {
    if (!(k in values)) continue;
    next[k] = v;
    if (v !== (prev[k] ?? null)) edited.add(k);
  }
  next.edited = [...edited];
  return { next };
}

// ---------- Measurement forms

/**
 * Validates raw form values with parseMeasurement. On error, also says which field is wrong
 * (null when the error is about the values together, like systolic below diastolic).
 */
export function checkMeasurement(type, raw) {
  const def = measurementDef(type);
  const res = parseMeasurement(type, { ...raw });
  if (!res.error) return { value: res.value };
  const bad = def.fields.find(f => {
    const v = raw[f.key];
    if (v === '' || v == null) return f.required;
    const n = Number(String(v).replace(',', '.'));
    return !(n >= f.min && n <= f.max);
  });
  return { error: res.error, field: bad ? bad.key : null };
}

/** Minutes since midnight, for sorting rows by time ('' last). */
export const timeKey = hm => (hm ? hmToMin(hm) : 24 * 60);

// ---------- Two devices: versions and a section-level three-way merge

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const getAt = (o, path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
function setAt(o, path, v) {
  const last = path[path.length - 1];
  const parent = path.slice(0, -1).reduce((x, k) => x[k], o);
  if (v === undefined) delete parent[last]; else parent[last] = structuredClone(v);
}

/** Counter keys: built-in, the user's own, and any other key found in the logs. */
const drinkKeys = logs => [...new Set([...counterTypes({ all: true }).map(d => d.key), ...logs.flatMap(l => Object.keys(l.drinks || {}))])];

/** The parts of a log that merge on their own, with a name for messages. */
export function logSections(...logs) {
  const ids = new Set();
  logs.forEach(l => Object.keys(l.meds.taken).forEach(id => ids.add(id)));
  return [
    ...MEALS.map(m => ({ path: ['meals', m.key], name: m.label })),
    { path: ['snacks'], name: 'Snacks' },
    ...drinkKeys(logs).map(k => ({ path: ['drinks', k], name: (counterTypes({ all: true }).find(d => d.key === k) || { label: 'Counter' }).label })),
    ...[...ids].sort().map(id => ({ path: ['meds', 'taken', id], name: 'Medication' })),
    { path: ['meds', 'extra'], name: 'Other medication' },
    { path: ['activities'], name: 'What I did' },
    { path: ['symptoms'], name: 'Symptoms' },
    { path: ['notes'], name: 'Notes' },
  ];
}

/**
 * Three-way merge. Starts from the server copy and puts back each section the user changed
 * since `base`. When the other device changed the same section too, the user's change wins and
 * the section name is listed in `conflicts`. All three logs are normalized.
 */
export function mergeLog(base, local, server) {
  const out = structuredClone(server);
  const conflicts = [];
  for (const { path, name } of logSections(base, local, server)) {
    const b = getAt(base, path), l = getAt(local, path), s = getAt(server, path);
    if (same(l, b)) continue; // not changed here: keep the server copy
    if (!same(s, b) && !same(s, l) && !conflicts.includes(name)) conflicts.push(name);
    setAt(out, path, l);
  }
  return { log: out, conflicts };
}

/** The sections (by path) that differ between two logs. */
export const changedSections = (a, b) => logSections(a, b).filter(x => !same(getAt(a, x.path), getAt(b, x.path))).map(x => x.path);

/**
 * Saves a log with its base version. On a conflict (409 with the newer server copy) it merges
 * and saves again with the new version; one more conflict is retried once.
 * save(date, log, baseVersion) → { logVersion }. base: { version, log } or null.
 * Returns { log, version, merged, conflicts }.
 */
export async function saveMerging(save, date, local, base) {
  let conflict;
  try {
    const r = await save(date, local, base ? base.version : undefined);
    return { log: local, version: r ? r.logVersion : undefined, merged: false, conflicts: [] };
  } catch (e) {
    if (e.status !== 409 || !e.data) throw e;
    conflict = e.data;
  }
  for (let attempt = 0; ; attempt++) {
    const server = normalizeLog(conflict.log);
    const { log, conflicts } = mergeLog(base ? base.log : server, local, server);
    try {
      const r = await save(date, log, conflict.logVersion);
      return { log, version: r ? r.logVersion : conflict.logVersion, merged: true, conflicts };
    } catch (e) {
      if (e.status !== 409 || !e.data || attempt >= 1) throw e;
      conflict = e.data;
    }
  }
}

/** "Oxygen 97.1 % (lowest 92 %)" and "Respiratory rate 14.2 /min", when Apple Health sent them. */
export function healthExtras(h) {
  if (!h) return [];
  const one = v => (Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(1));
  const out = [];
  if (h.spo2 != null) out.push({ key: 'spo2', label: 'Oxygen', text: `${one(h.spo2)} %${h.spo2Min != null ? ` (lowest ${one(h.spo2Min)} %)` : ''}` });
  else if (h.spo2Min != null) out.push({ key: 'spo2', label: 'Oxygen', text: `lowest ${one(h.spo2Min)} %` });
  if (h.respiratoryRate != null) out.push({ key: 'respiratoryRate', label: 'Respiratory rate', text: `${one(h.respiratoryRate)} /min` });
  return out;
}
