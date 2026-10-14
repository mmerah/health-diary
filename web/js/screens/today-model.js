// Pure helpers for the Today screen and the quick-add sheet: no DOM, no API.
// Summaries for collapsed rows, drink stepping, the week strip, symptom chip order,
// hand corrections of health data, and measurement form checks. Tested in tests/today.test.js.
import { addDays, hmToMin, isValidDate, parse } from '../core/dates.js';
import { duration, num, plural } from '../core/format.js';
import { DRINKS, MEALS, MEASUREMENTS, SYMPTOMS, describeWhen, mealAt, parseMeasurement, severityLabel } from '../core/schema.js';

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

export function drinkText(drink, value) {
  if (value == null) return 'Not recorded';
  if (value === 0) return 'None';
  return plural(value, drink.one, drink.many);
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

export function drinksSummary(drinks) {
  return DRINKS.filter(d => drinks[d.key] != null).map(d => `${d.label} ${num(drinks[d.key])}`).join(' · ');
}

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
  return Object.keys(MEASUREMENTS).filter(t => latest[t])
    .map(t => `${MEASUREMENTS[t].label} ${MEASUREMENTS[t].format(latest[t].value)}`).join(' · ');
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

/** On today, open the meal that fits the time of day, if it is still empty. Other days: none. */
export function defaultOpen(log, { isToday, now }) {
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
      const name = typeof s === 'string' ? s : s && s.name;
      if (!name) continue;
      const key = name.trim().toLowerCase();
      if (!count.has(key)) first.set(key, { name: name.trim(), i: i++ });
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  const mine = [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || first.get(a).i - first.get(b).i)
    .map(k => first.get(k).name);
  const seen = new Set(mine.map(n => n.toLowerCase()));
  return [...mine, ...defaults.filter(n => !seen.has(n.toLowerCase()))];
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

/** Breakfast/Lunch/Dinner keys in order, used by sections. */
export const MEAL_KEYS = MEALS.map(m => m.key);

// ---------- Health corrected by hand

const intOrNull = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

/**
 * Applies the "Correct by hand" form to the day's health object.
 * values: { sleepH, sleepM, bed, wake, steps, restingHr, hrv } as typed (strings).
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
  next.edited = [...edited];
  return { next };
}

// ---------- Measurement forms

/**
 * Validates raw form values with parseMeasurement. On error, also says which field is wrong
 * (null when the error is about the values together, like systolic below diastolic).
 */
export function checkMeasurement(type, raw) {
  const def = MEASUREMENTS[type];
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
