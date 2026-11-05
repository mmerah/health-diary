// Pure data for Trends → Compare: put 2 to 4 things on the same days. No DOM. Tested in tests/compare.test.js.
//
// An item has a key ("m:weight", "h:sleep", "c:coffee", "s:headache", "s:*", "f:pizza") and gives one value per day:
//  - kind 'num':   a number, or null (no value that day).
//  - kind 'event': null (unknown: no diary, or no meal written), 0 (no), 1 to 3 (yes, severity), -1 (yes, severity not set).
// The words never say that one thing causes the other.
import { addDays } from '../core/dates.js';
import { duration, fold, num, plural } from '../core/format.js';
import { mean, median } from '../core/math.js';
import { counterTypes, hasContent, MEALS, measurementDef, measurementTypes, normalizeLog, severityLabel } from '../core/schema.js';

export const MAX_ITEMS = 4;
export const COMPARE_RANGES = [
  { key: '30', days: 30, short: '30 days' },
  { key: '90', days: 90, short: '90 days' },
  { key: '180', days: 180, short: '180 days' },
];
export const compareRange = key => COMPARE_RANGES.find(r => r.key === key) || COMPARE_RANGES[1];

/** The dates of a range that ends today, oldest first. */
export function rangeDates(today, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

// ---------- Item definitions

const int = v => num(Math.round(v));
const HEALTH = [
  // Sleep belongs to the morning it ends: the night before the date.
  // The chart draws sleep in hours (scale), so the ticks are whole hours; the words use minutes.
  { id: 'sleep', label: 'Sleep', fmt: duration, axis: v => `${num(v)}h`, minSpan: 2, scale: 1 / 60,
    get: h => (h.sleep && !h.sleep.inBedOnly && h.sleep.total > 0 ? h.sleep.total : null), full: true },
  { id: 'steps', label: 'Steps', fmt: int, axis: v => (v >= 1000 ? `${num(v / 1000)}k` : int(v)), minSpan: 2000, get: h => h.steps },
  { id: 'restingHr', label: 'Resting heart rate', fmt: v => `${int(v)} bpm`, axis: int, minSpan: 10, get: h => h.restingHr },
  { id: 'hrv', label: 'Heart rate variability', fmt: v => `${int(v)} ms`, axis: int, minSpan: 20, get: h => h.hrv },
  { id: 'spo2', label: 'Blood oxygen', fmt: v => `${num(v, 1)}%`, axis: v => `${num(v)}%`, minSpan: 4, get: h => h.spo2 },
  { id: 'respiratoryRate', label: 'Respiratory rate', fmt: v => `${num(v, 1)} /min`, axis: num, minSpan: 4, get: h => h.respiratoryRate },
];

const MEAS_SPAN = { weight: 2, bp: 20, temp: 1 };
const decimalsOf = def => (String((def.fields[0] || {}).step || 1).split('.')[1] || '').length;

/** One measurement type as an item. Blood pressure gives the top number, and the bottom number as a second line. */
function measurementItem(type, def) {
  const d = type === 'bp' ? 0 : type === 'weight' || type === 'temp' ? 1 : decimalsOf(def);
  const f = def.fields[0] || {};
  return {
    key: `m:${type}`, kind: 'num', group: 'Measurements', label: def.label, style: 'line', sparse: true,
    fmt: type === 'bp' ? v => `${Math.round(v)}` : v => def.format(Math.round(v * 10 ** d) / 10 ** d),
    axis: v => num(v, Number.isInteger(v) ? 0 : d),
    minSpan: MEAS_SPAN[type] || Math.max((f.step || 1) * 4, ((f.max - f.min) || 10) / 20),
    unit: def.unit,
  };
}

function counterItem(c) {
  return {
    key: `c:${c.key}`, kind: 'num', group: 'Counters', label: c.label, style: 'bar',
    fmt: v => plural(v, c.one, c.many), axis: int, minSpan: 3, zero: true,
  };
}

const symptomItem = (key, label) => ({ key: `s:${key}`, kind: 'event', group: 'Symptoms', label, style: 'severity' });
const foodItem = word => ({ key: `f:${word}`, kind: 'event', group: 'Food', label: word.charAt(0).toUpperCase() + word.slice(1), style: 'mark' });

/** The item for a key, or null when the key is not valid (for example a deleted measurement). */
export function itemOf(key) {
  const [prefix, ...rest] = String(key || '').split(':');
  const id = rest.join(':');
  if (!id) return null;
  if (prefix === 'm') { const def = measurementDef(id); return def ? measurementItem(id, def) : null; }
  if (prefix === 'h') {
    const h = HEALTH.find(x => x.id === id);
    return h ? { key, kind: 'num', group: 'Apple Health', label: h.label, style: 'line', fmt: h.fmt, axis: h.axis, minSpan: h.minSpan, scale: h.scale } : null;
  }
  if (prefix === 'c') { const c = counterTypes({ all: true }).find(x => x.key === id); return c ? counterItem(c) : null; }
  if (prefix === 's') return id === '*' ? symptomItem('*', 'Any symptom') : symptomItem(id, id.charAt(0).toUpperCase() + id.slice(1));
  if (prefix === 'f') { const w = foodKey(id); return w ? foodItem(w) : null; }
  return null;
}

// ---------- Values per day

const symptomKey = name => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
/** A food word as it is stored in a key: lower case, no accents, one word or a short phrase. */
export const foodKey = s => fold(s).replace(/[^\p{L}\p{N}' -]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** All the meal and snack text of a day, folded, or '' when no meal was written. */
const mealText = log => fold([...MEALS.map(m => log.meals[m.key].text), ...log.snacks.map(s => s.text)].filter(Boolean).join(' \n '));

const worst = sevs => (sevs.some(s => s) ? Math.max(...sevs.filter(Boolean)) : -1);

/**
 * Days and measurements → a lookup per date. days: [{ date, log, health }] from api.listDays.
 * `today` is left out of steps and heart data (not complete yet); last night's sleep counts.
 */
export function prepare(days, measurements, today) {
  const byDate = new Map();
  for (const d of days) {
    const log = d.log ? normalizeLog(d.log) : null;
    byDate.set(d.date, { log, logged: !!log && hasContent(log), health: d.health || null, text: log ? mealText(log) : '' });
  }
  const meas = new Map(); // type → date → [values]
  for (const m of measurements) {
    if (!meas.has(m.type)) meas.set(m.type, new Map());
    const t = meas.get(m.type);
    t.set(m.date, [...(t.get(m.date) || []), m.value]);
  }
  return { byDate, meas, today };
}

const positive = v => (Number.isFinite(v) && v > 0 ? v : null);

/** One item over the dates → { values, values2? } (values2: the bottom number of blood pressure). */
export function seriesOf(item, prep, dates) {
  const [prefix, ...rest] = item.key.split(':');
  const id = rest.join(':');
  const day = date => prep.byDate.get(date);
  if (prefix === 'm') {
    const t = prep.meas.get(id) || new Map();
    if (id === 'bp') {
      return {
        values: dates.map(d => mean((t.get(d) || []).map(v => v.sys))),
        values2: dates.map(d => mean((t.get(d) || []).map(v => v.dia))),
      };
    }
    return { values: dates.map(d => mean(t.get(d) || [])) };
  }
  if (prefix === 'h') {
    const h = HEALTH.find(x => x.id === id);
    return { values: dates.map(d => { const x = day(d); return x && x.health && (h.full || d !== prep.today) ? positive(h.get(x.health)) : null; }) };
  }
  if (prefix === 'c') {
    return { values: dates.map(d => { const x = day(d); return x && x.log && x.log.drinks[id] != null ? x.log.drinks[id] : null; }) };
  }
  if (prefix === 's') {
    return { values: dates.map(d => {
      const x = day(d);
      if (!x || !x.logged) return null;
      const sevs = x.log.symptoms.filter(s => id === '*' || symptomKey(s.name) === id).map(s => s.severity);
      return sevs.length ? worst(sevs) : 0;
    }) };
  }
  if (prefix === 'f') {
    // A word at the start of a word: "pizza" finds "Pizza" and "pizzas", not "apizza".
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${reEscape(id)}`, 'u');
    return { values: dates.map(d => { const x = day(d); return x && x.text ? (re.test(x.text) ? 1 : 0) : null; }) };
  }
  return { values: dates.map(() => null) };
}

const known = v => v != null;
export const isYes = v => v != null && v !== 0;

// ---------- What can be compared in a period

// Small words and adjectives ("green tea", "dark chocolate"): the food is the other word.
const STOP = new Set(('and with the for from some little bit half only very more less one two three skipped nothing '
  + 'green dark red white black small big large fresh hot cold homemade leftover light '
  + 'avec des les une pour sans aux sur dans peu und mit der die das ein eine von zum zur ohne').split(' '));

/** Words found in the meals of the most days (3 days or more): [{ word, days }].
    Counter names (coffee, tea…) are left out: the counter already has the number. */
export function foodWords(prep, dates, max = 12) {
  const counters = new Set(counterTypes({ all: true }).map(c => fold(c.label)));
  const count = new Map();
  for (const d of dates) {
    const x = prep.byDate.get(d);
    if (!x || !x.text) continue;
    const words = new Set(x.text.split(/[^\p{L}\p{N}']+/u).filter(w => w.length >= 3 && !STOP.has(w) && !counters.has(w) && !/^\d+$/.test(w)));
    for (const w of words) count.set(w, (count.get(w) || 0) + 1);
  }
  return [...count].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max).map(([word, days]) => ({ word, days }));
}

/**
 * The items the user can pick, with data in the period: { groups: [{ name, items: [{ ...item, days }] }] }.
 * `days` is the number of days with a value (a "yes" for symptoms and food).
 */
export function availableItems(prep, dates) {
  const countNum = item => seriesOf(item, prep, dates).values.filter(known).length;
  const countYes = item => seriesOf(item, prep, dates).values.filter(isYes).length;
  const groups = [];
  const add = (name, items) => { const list = items.filter(i => i && i.days > 0); if (list.length) groups.push({ name, items: list }); };

  add('Measurements', Object.entries(measurementTypes()).map(([type, def]) => { const it = measurementItem(type, def); return { ...it, days: countNum(it) }; }));
  add('Apple Health', HEALTH.map(h => { const it = itemOf(`h:${h.id}`); return { ...it, days: countNum(it) }; }));
  add('Counters', counterTypes().map(c => { const it = counterItem(c); return { ...it, days: countNum(it) }; }));

  const names = new Map(); // key → { label, days }
  for (const d of dates) {
    const x = prep.byDate.get(d);
    if (!x || !x.logged) continue;
    for (const s of new Set(x.log.symptoms.map(s => symptomKey(s.name)).filter(Boolean))) {
      const label = x.log.symptoms.find(y => symptomKey(y.name) === s).name.trim();
      names.set(s, { label: (names.get(s) || {}).label || label, days: ((names.get(s) || {}).days || 0) + 1 });
    }
  }
  const sym = [...names].sort((a, b) => b[1].days - a[1].days || a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ ...symptomItem(k, v.label), days: v.days }));
  if (sym.length > 1) sym.push({ ...symptomItem('*', 'Any symptom'), days: countYes(symptomItem('*', 'Any symptom')) });
  add('Symptoms', sym);
  add('Food', foodWords(prep, dates).map(f => ({ ...foodItem(f.word), days: f.days })));
  return { groups };
}

/** A first choice when the user has not picked anything: sleep (or a measurement) and the most frequent symptom. */
export function defaultKeys(available) {
  const g = name => (available.groups.find(x => x.name === name) || { items: [] }).items;
  const first = g('Apple Health').find(i => i.key === 'h:sleep') || g('Measurements')[0] || g('Counters')[0];
  const second = g('Symptoms')[0] || g('Food')[0] || g('Counters').find(i => first && i.key !== first.key);
  return [first, second].filter(Boolean).map(i => i.key);
}

// ---------- Two items together, in words

/** Pearson correlation of paired values, or null with fewer than 3 pairs or no spread. */
export function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export const MIN_PAIRS = 10;   // two numbers: days with both
export const MIN_GROUP = 3;    // a number and an event: days in each group
export const SMALL_GROUP = 8;  // fewer days than this in a group: "few days, read with care"

/** The label inside a sentence: "Sleep" → "sleep", but "INR" and "SpO2" stay. */
const lower = item => (/^\p{Lu}\p{Ll}/u.test(item.label) ? item.label[0].toLowerCase() + item.label.slice(1) : item.label);
const fmtMid = (item, v) => (item.style === 'bar' ? `${num(v, 1)} ${(item.fmt(2).split(' ').slice(1).join(' '))}` : item.fmt(v));

/**
 * Two items over the same days → { a, b, type, n, ..., text, small }.
 * type: 'num-num' (r), 'num-event' (median on yes days and on no days), 'event-event' (share of days), or 'few'.
 */
export function pairSummary(a, sa, b, sb) {
  if (a.kind === 'event' && b.kind === 'num') return pairSummary(b, sb, a, sa);
  // Food first, symptom second: "Headache on 4 of 9 days with pizza".
  if (a.group === 'Symptoms' && b.group === 'Food') return pairSummary(b, sb, a, sa);
  const va = sa.values, vb = sb.values;
  if (a.kind === 'num' && b.kind === 'num') {
    const xs = [], ys = [];
    va.forEach((x, i) => { if (known(x) && known(vb[i])) { xs.push(x); ys.push(vb[i]); } });
    const n = xs.length;
    if (n < MIN_PAIRS) return { a, b, type: 'few', n, text: `${a.label} and ${lower(b)}: only ${plural(n, 'day')} with both. At least ${MIN_PAIRS} are needed.` };
    const r = correlation(xs, ys);
    const abs = Math.abs(r ?? 0);
    const strength = abs < 0.2 ? 'none' : abs < 0.4 ? 'weak' : 'clear';
    const rText = r == null ? '' : `r = ${r < 0 ? '−' : ''}${num(Math.abs(r), 2)}`;
    const text = strength === 'none'
      ? `${a.label} and ${lower(b)}: no clear link (${plural(n, 'day')} with both, ${rText}).`
      : `When ${lower(a)} is higher, ${lower(b)} is ${r > 0 ? 'often higher too' : 'often lower'} (${strength === 'weak' ? 'weak link' : 'clear link'}, ${plural(n, 'day')}, ${rText}).`;
    return { a, b, type: 'num-num', n, r, strength, text, small: n < 20 };
  }
  if (a.kind === 'num' && b.kind === 'event') {
    const yes = [], no = [];
    va.forEach((x, i) => { if (known(x) && known(vb[i])) (isYes(vb[i]) ? yes : no).push(x); });
    if (yes.length < MIN_GROUP || no.length < MIN_GROUP) {
      return { a, b, type: 'few', n: yes.length + no.length,
        text: `${a.label} and ${lower(b)}: not enough days with both yet (${plural(yes.length, 'day')} with ${lower(b)}, ${num(no.length)} without).` };
    }
    // Counters are small whole numbers: the median hides a change from 2 to 3 cups, the average shows it.
    const avg = a.style === 'bar';
    const mid = avg ? mean : median;
    const my = mid(yes), mn = mid(no);
    const word = b.group === 'Food' ? `with ${lower(b)} in a meal` : `with ${lower(b)}`;
    const text = `${a.label} (${avg ? 'average' : 'median'}): ${fmtMid(a, my)} on the ${plural(yes.length, 'day')} ${word}, ${fmtMid(a, mn)} on the ${plural(no.length, 'other day')}.`;
    return { a, b, type: 'num-event', n: yes.length + no.length, yes: { n: yes.length, value: my }, no: { n: no.length, value: mn }, text,
      small: yes.length < SMALL_GROUP || no.length < SMALL_GROUP };
  }
  // Two events: how often b happens on days with a, and on days without a.
  const g = { yes: { days: 0, with: 0 }, no: { days: 0, with: 0 } };
  va.forEach((x, i) => {
    if (!known(x) || !known(vb[i])) return;
    const grp = isYes(x) ? g.yes : g.no;
    grp.days++;
    if (isYes(vb[i])) grp.with++;
  });
  if (g.yes.days < MIN_GROUP || g.no.days < MIN_GROUP) {
    return { a, b, type: 'few', n: g.yes.days + g.no.days,
      text: `${a.label} and ${lower(b)}: not enough days with both yet (${plural(g.yes.days, 'day')} with ${lower(a)}, ${num(g.no.days)} without).` };
  }
  const pct = x => `${Math.round((x.with / x.days) * 100)}%`;
  const aWord = a.group === 'Food' ? `with ${lower(a)} in a meal` : `with ${lower(a)}`;
  const text = `${b.label}: on ${num(g.yes.with)} of ${plural(g.yes.days, 'day')} ${aWord} (${pct(g.yes)}), on ${num(g.no.with)} of ${plural(g.no.days, 'other day')} (${pct(g.no)}).`;
  return { a, b, type: 'event-event', n: g.yes.days + g.no.days, ...g, text,
    small: g.yes.days < SMALL_GROUP || g.no.days < SMALL_GROUP || g.yes.with + g.no.with < 5 };
}

/** Every pair of the picked items (at most 6 for 4 items), in the order they were picked. */
export function pairSummaries(items, series) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push(pairSummary(items[i], series[i], items[j], series[j]));
  }
  return out;
}

/** The value of an item on one day, in words, for the tooltip and the table. */
export function valueWords(item, s, j) {
  const v = s.values[j];
  if (item.key === 'm:bp') return v == null ? '–' : `${Math.round(v)}/${Math.round(s.values2[j])} mmHg`;
  if (item.kind === 'num') return v == null ? '–' : item.fmt(v);
  if (v == null) return item.group === 'Food' ? 'No meal written' : 'No diary';
  if (v === 0) return 'No';
  return item.group === 'Food' ? 'Yes' : severityLabel(v === -1 ? null : v);
}
