// Statistics for the report. Pure functions over normalized days: [{ date, log, health, logged }].
//  - log is a version 2 log (normalizeLog), logged = hasContent(log).
//  - A day without a diary entry is unknown: it is never counted as "no symptoms" or "not taken".
//  - `skip` is a partial day (today) that is left out of averages.
import { addDays, diffDays, hmToMin, minToHm } from '../core/dates.js';
import { mean, median } from '../core/math.js';
import { counterTypes, CUSTOM_ID, measurementDef, periodOf } from '../core/schema.js';

/** A measurement definition: built-in or the user's own; a type that no longer exists is "Other measurement". */
export const measurementDefOf = type => measurementDef(type) || {
  label: 'Other measurement', custom: true, format: v => String(typeof v === 'object' ? JSON.stringify(v) : v), flag: () => null,
};

/** Counters: water, coffee, alcohol, the user's own (also hidden ones), and counters found in old logs ("Other counter"). */
export function counterList(days = []) {
  const list = counterTypes({ all: true });
  const known = new Set(list.map(c => c.key));
  for (const d of days) {
    for (const k of Object.keys((d.log && d.log.drinks) || {})) {
      if (!known.has(k) && CUSTOM_ID.test(k)) { known.add(k); list.push({ key: k, label: 'Other counter', one: 'time', many: 'times', custom: true }); }
    }
  }
  return list;
}

// ---------- Small helpers

export const round1 = v => (v == null ? null : Math.round(v * 10) / 10);

/** Bedtime in minutes after noon of the evening before, so 23:30 and 00:30 sort the right way. */
export const bedMinutes = hm => { const m = hmToMin(hm); return m == null ? null : m < 12 * 60 ? m + 1440 : m; };
export const bedTime = m => (m == null ? null : minToHm(m));

const symptomKey = name => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The most used spelling of a name in a group ("headache", "Headache" → "Headache"). */
function display(spellings) {
  const n = {};
  for (const s of spellings) n[s] = (n[s] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1] || (/^\p{Lu}/u.test(b[0]) ? 1 : 0) - (/^\p{Lu}/u.test(a[0]) ? 1 : 0))[0][0];
}

// ---------- Weeks: 7-day blocks that end on the last day of the period (the last block is complete).

export function weekBlocks(from, to) {
  const out = [];
  for (let end = to; end >= from; end = addDays(end, -7)) {
    const start = addDays(end, -6) < from ? from : addDays(end, -6);
    out.unshift({ start, end, days: diffDays(end, start) + 1 });
  }
  return out;
}

// ---------- Medication

const activeOn = (m, date) => (!m.since || m.since <= date) && (!m.until || m.until >= date);

/** True when the medication part of the day was filled in: a tick (or untick) for any medication, or an extra one. */
export const medsTouched = log => !!log && (Object.keys(log.meds.taken).length > 0 || log.meds.extra.length > 0);

/**
 * Scheduled medication: taken on how many days while it was active.
 * Only days where the medication part was filled in count. On such a day, no tick for an active medication
 * counts as "not taken". A day with only a glass of water recorded does not count.
 */
export function adherence(profile, days, { skip } = {}) {
  return (profile.medications || []).filter(m => !m.asNeeded).map(m => {
    const eligible = days.filter(d => d.logged && medsTouched(d.log) && d.date !== skip && activeOn(m, d.date));
    const taken = eligible.filter(d => (d.log.meds.taken[m.id] || {}).done);
    const times = taken.map(d => d.log.meds.taken[m.id].time).filter(Boolean).map(hmToMin);
    return {
      id: m.id, name: m.name, dose: m.dose, since: m.since, until: m.until,
      eligible: eligible.length, taken: taken.length,
      rate: eligible.length ? taken.length / eligible.length : null,
      missed: eligible.filter(d => !(d.log.meds.taken[m.id] || {}).done).map(d => d.date),
      usualTime: times.length ? minToHm(median(times)) : null,
    };
  }).filter(r => r.eligible > 0 || activeInPeriod(r, days));
}
const activeInPeriod = (m, days) => days.some(d => activeOn(m, d.date));

/** As-needed medication and other medication written in the diary: how often, at what time. */
export function asNeededUse(profile, days) {
  const meds = (profile.medications || []).filter(m => m.asNeeded);
  const groups = new Map();
  const add = (key, name, date, time) => {
    const g = groups.get(key) || { name, uses: 0, dates: new Set(), times: [], profile: false };
    g.uses++;
    g.dates.add(date);
    if (time) g.times.push(hmToMin(time));
    groups.set(key, g);
  };
  for (const m of meds) groups.set(`id:${m.id}`, { name: [m.name, m.dose].filter(Boolean).join(' '), uses: 0, dates: new Set(), times: [], profile: true });
  for (const d of days) {
    if (!d.log) continue;
    for (const m of meds) {
      const t = d.log.meds.taken[m.id];
      if (t && t.done) add(`id:${m.id}`, m.name, d.date, t.time);
    }
    for (const x of d.log.meds.extra) {
      const k = symptomKey(x.name);
      // "Paracetamol 1 g" in the diary is the profile's "Paracetamol".
      const m = meds.find(p => p.name && k.startsWith(symptomKey(p.name)));
      add(m ? `id:${m.id}` : `x:${k}`, x.name, d.date, x.time);
    }
  }
  return [...groups.values()].filter(g => g.uses || g.profile).map(g => ({
    name: g.name, uses: g.uses, days: g.dates.size, profile: g.profile,
    usualTime: g.times.length ? minToHm(median(g.times)) : null,
    timeOfDay: timeOfDayCounts(g.times.map(minToHm)),
  })).sort((a, b) => b.uses - a.uses);
}

function timeOfDayCounts(hms) {
  const c = {};
  for (const hm of hms) { const p = periodOf(hm); if (p) c[p] = (c[p] || 0) + 1; }
  return c;
}

/** Started and stopped dates of all medication, oldest first. */
export function medTimeline(profile, to) {
  const ev = [];
  for (const m of profile.medications || []) {
    const label = [m.name, m.dose].filter(Boolean).join(' ');
    if (m.since && m.since <= to) ev.push({ date: m.since, type: 'started', name: label, asNeeded: m.asNeeded });
    if (m.until && m.until <= to) ev.push({ date: m.until, type: 'stopped', name: label, asNeeded: m.asNeeded });
  }
  return ev.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Symptoms

/** Which parts of the day a symptom touched: 'day', 'morning'…, or 'unknown'. */
function whenKeys(s) {
  if (s.when === 'day') return ['day'];
  if (s.when === 'periods' && s.periods.length) return s.periods;
  if (s.when === 'time' && s.from) return [periodOf(s.from)];
  return ['unknown'];
}

/** Diary days needed in each half of the period to speak of a trend. */
export const MIN_HALF_DAYS = 7;

export function symptomStats(days, { from, to } = {}) {
  const logged = days.filter(d => d.logged);
  const span = diffDays(to, from) + 1;
  const mid = addDays(from, Math.floor(span / 2)); // second half starts here
  const halfDays = [logged.filter(d => d.date < mid).length, logged.filter(d => d.date >= mid).length];
  const weeks = weekBlocks(from, to);
  const groups = new Map();
  for (const d of logged) {
    for (const s of d.log.symptoms) {
      const k = symptomKey(s.name);
      const g = groups.get(k) || { key: k, spellings: [], dates: new Map(), sev: { 1: 0, 2: 0, 3: 0, unset: 0 }, when: {}, n: 0 };
      g.spellings.push(s.name.trim());
      g.n++;
      if (s.severity) g.sev[s.severity]++; else g.sev.unset++;
      for (const w of whenKeys(s)) g.when[w] = (g.when[w] || 0) + 1;
      // The worst severity of the day counts for that day.
      g.dates.set(d.date, Math.max(g.dates.get(d.date) || 0, s.severity || 0));
      groups.set(k, g);
    }
  }
  return [...groups.values()].map(g => {
    const dates = [...g.dates.keys()].sort();
    const first = dates.filter(x => x < mid), second = dates.filter(x => x >= mid);
    const sevOf = list => median(list.map(x => g.dates.get(x)).filter(Boolean));
    const rate = (n, of) => (of ? n / of : 0);
    const r1 = rate(first.length, halfDays[0]), r2 = rate(second.length, halfDays[1]);
    const s1 = sevOf(first), s2 = sevOf(second);
    // A trend needs enough diary days in each half: with fewer than 7, "new" or "more" means nothing.
    let trend = 'stable';
    if (halfDays[0] < MIN_HALF_DAYS || halfDays[1] < MIN_HALF_DAYS) trend = 'unknown';
    else if (!first.length && second.length >= 2) trend = 'new';
    else if (second.length - first.length >= 2 && r2 >= r1 * 1.5) trend = 'more';
    else if (s1 != null && s2 != null && s2 - s1 >= 1 && second.length >= 2) trend = 'worse';
    else if (first.length - second.length >= 2 && r1 >= r2 * 1.5) trend = 'less';
    return {
      key: g.key, name: display(g.spellings), days: dates.length, times: g.n, dates,
      severity: g.sev, median: median(dates.map(x => g.dates.get(x)).filter(Boolean)),
      worst: Math.max(0, ...dates.map(x => g.dates.get(x))) || null,
      severeDates: dates.filter(x => g.dates.get(x) === 3),
      when: g.when,
      halves: { first: first.length, second: second.length, loggedFirst: halfDays[0], loggedSecond: halfDays[1], mid },
      // null: no diary entry that week (unknown), shown as "–".
      weekly: weeks.map(w => (logged.some(d => d.date >= w.start && d.date <= w.end) ? dates.filter(x => x >= w.start && x <= w.end).length : null)),
      trend,
    };
  }).sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
}

// ---------- Drinks (null = not recorded, left out)

export function drinkStats(days, { skip } = {}) {
  return counterList(days).map(def => {
    const rec = days.filter(d => d.log && d.date !== skip && d.log.drinks[def.key] != null);
    const v = rec.map(d => d.log.drinks[def.key]);
    return {
      key: def.key, label: def.label, one: def.one, many: def.many, custom: !!def.custom,
      recorded: rec.length,
      average: v.length ? mean(v) : null,
      max: v.length ? Math.max(...v) : null,
      daysAny: v.filter(x => x > 0).length,
      daysHeavy: def.key === 'alcohol' ? v.filter(x => x >= 5).length : null,
      daysThreePlus: def.key === 'coffee' ? v.filter(x => x >= 3).length : null,
    };
  }).filter(x => x.recorded);
}

// ---------- Wearable (sleep is the night before the date)

const METRICS = {
  sleep: h => (h.sleep && h.sleep.total && !h.sleep.inBedOnly ? h.sleep.total : null),
  bed: h => (h.sleep ? bedMinutes(h.sleep.bed) : null),
  steps: h => (h.steps || null),
  restingHr: h => (h.restingHr || null),
  hrv: h => (h.hrv || null),
  // Apple Watch: blood oxygen (daily average and lowest, %) and respiratory rate (breaths per minute).
  spo2: h => (h.spo2 || null),
  spo2Min: h => (h.spo2Min || null),
  respiratoryRate: h => (h.respiratoryRate || null),
};
// Today's steps and heart data are not complete; last night's sleep is.
const PARTIAL_OK = new Set(['sleep', 'bed']);

function metricValues(days, key, skip) {
  return days.filter(d => d.health && (d.date !== skip || PARTIAL_OK.has(key))).map(d => METRICS[key](d.health)).filter(v => v != null);
}

export function wearableStats(days, { from, to, skip } = {}) {
  const withHealth = days.filter(d => d.health);
  if (!withHealth.length) return null;
  const summarize = list => Object.fromEntries(Object.keys(METRICS).map(k => {
    const v = metricValues(list, k, skip);
    return [k, v.length ? { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length } : null];
  }));
  const weeks = weekBlocks(from, to).map(w => {
    const list = days.filter(d => d.date >= w.start && d.date <= w.end);
    return { ...w, ...Object.fromEntries(Object.keys(METRICS).map(k => [k, median(metricValues(list, k, skip))])),
      nights: metricValues(list, 'sleep', skip).length };
  }).filter(w => Object.keys(METRICS).some(k => w[k] != null));
  let compare = null;
  if (diffDays(to, from) + 1 >= 56) {
    const firstEnd = addDays(from, 27), lastStart = addDays(to, -27);
    const a = summarize(days.filter(d => d.date <= firstEnd)), b = summarize(days.filter(d => d.date >= lastStart));
    compare = { first: { from, to: firstEnd, ...a }, last: { from: lastStart, to, ...b } };
  }
  const workouts = withHealth.filter(d => d.date !== skip).flatMap(d => d.health.workouts || []);
  const wk = {};
  for (const w of workouts) { const k = w.type || 'Workout'; wk[k] = wk[k] || { type: k, count: 0, minutes: 0 }; wk[k].count++; wk[k].minutes += w.minutes || 0; }
  return {
    days: withHealth.length, overall: summarize(days), weeks, compare,
    workouts: Object.values(wk).sort((a, b) => b.count - a.count),
    shortNights: metricValues(days, 'sleep', skip).filter(v => v < 360).length,
    // Days whose lowest blood oxygen was under 90 %, and the averages of the period.
    lowOxygenDays: days.filter(d => d.date !== skip && d.health && d.health.spo2Min != null && d.health.spo2Min < 90).map(d => ({ date: d.date, value: d.health.spo2Min })),
    spo2Mean: mean(metricValues(days, 'spo2', skip)),
    respiratoryMean: mean(metricValues(days, 'respiratoryRate', skip)),
  };
}

// ---------- Associations (descriptive only)

const FACTORS = [
  { key: 'coffee', label: 'coffee', a: '3 or more cups', b: 'fewer than 3 cups',
    test: d => (d.log.drinks.coffee == null ? null : d.log.drinks.coffee >= 3) },
  { key: 'alcohol', label: 'alcohol', a: 'any alcohol', b: 'no alcohol',
    test: d => (d.log.drinks.alcohol == null ? null : d.log.drinks.alcohol > 0) },
  { key: 'sleep', label: 'sleep the night before', a: 'under 6 h', b: '6 h or more',
    test: d => { const v = d.health && METRICS.sleep(d.health); return v == null ? null : v < 360; } },
];

/**
 * For each frequent symptom (4+ days): the share of diary days with the symptom, in two groups of days.
 * Never causal. `small` is true when a group or the symptom count is too small to read much into.
 */
export function associations(days, symptoms, { skip, max = 4 } = {}) {
  const logged = days.filter(d => d.logged && d.date !== skip);
  // The user's own counters join the scan when they were recorded on enough days, with some days at 0 and some above.
  const own = counterList(days).filter(c => c.custom).filter(c => {
    const v = logged.map(d => d.log.drinks[c.key]).filter(x => x != null);
    return v.length >= 14 && v.filter(x => x > 0).length >= 5 && v.filter(x => x === 0).length >= 5;
  }).map(c => ({ key: c.key, label: c.label, a: c.label, b: `no ${c.label}`, custom: true,
    test: d => (d.log.drinks[c.key] == null ? null : d.log.drinks[c.key] > 0) }));
  const out = [];
  for (const s of symptoms.filter(x => x.days >= 4).slice(0, max)) {
    const has = new Set(s.dates);
    for (const f of [...FACTORS, ...own]) {
      const a = { days: 0, with: 0 }, b = { days: 0, with: 0 };
      for (const d of logged) {
        const v = f.test(d);
        if (v == null) continue;
        const g = v ? a : b;
        g.days++;
        if (has.has(d.date)) g.with++;
      }
      if (!a.days || !b.days || !(a.with + b.with)) continue;
      const ra = a.with / a.days, rb = b.with / b.days;
      out.push({ symptom: s.name, factor: f.key, label: f.label, aLabel: f.a, bLabel: f.b, custom: !!f.custom, a, b,
        rateA: ra, rateB: rb, diff: ra - rb, small: a.days < 8 || b.days < 8 || a.with + b.with < 5 });
    }
  }
  return out;
}

// ---------- Measurements

/** One type: values in the period, the last one before as a baseline, and what stands out. */
export function measurementStats(type, list, { from, to }) {
  const def = measurementDefOf(type);
  const sorted = list.filter(m => m.type === type).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const rows = sorted.filter(m => m.date >= from && m.date <= to);
  const before = sorted.filter(m => m.date < from).slice(-1)[0] || null;
  const res = { type, label: def.label, custom: !!def.custom, rows, before, flagged: rows.filter(m => def.flag(m.value)) };
  if (def.custom) {
    // Own measurements: readings above or below the user's own range.
    res.above = rows.filter(m => def.high != null && m.value > def.high);
    res.below = rows.filter(m => def.low != null && m.value < def.low);
  }
  if (type === 'weight' && rows.length) {
    const start = rows.length >= 2 ? rows[0] : before;
    const end = rows[rows.length - 1];
    if (start && start !== end) res.change = { from: start, to: end, kg: round1(end.value - start.value), pct: (end.value - start.value) / start.value * 100 };
  }
  if (type === 'bp') {
    res.mean = rows.length ? { sys: Math.round(mean(rows.map(m => m.value.sys))), dia: Math.round(mean(rows.map(m => m.value.dia))), n: rows.length } : null;
    res.high = rows.filter(m => m.value.sys >= 140 || m.value.dia >= 90);
    res.low = rows.filter(m => m.value.sys < 90 || m.value.dia < 60);
  }
  if (type === 'temp') {
    // Fever readings on the same or the next day belong to one episode.
    const fever = rows.filter(m => m.value >= 38);
    const episodes = [];
    for (const m of fever) {
      const e = episodes[episodes.length - 1];
      if (e && diffDays(m.date, e.to) <= 1) { e.to = m.date; e.max = Math.max(e.max, m.value); e.readings++; } else episodes.push({ from: m.date, to: m.date, max: m.value, readings: 1 });
    }
    res.episodes = episodes;
  }
  return res;
}


// ---------- Monthly summaries (long periods)

/** One row per calendar month: diary days, symptom days, the most frequent symptoms, sleep, steps, coffee, alcohol. */
export function monthlyStats(days, { skip } = {}) {
  const months = new Map();
  for (const d of days) {
    const k = d.date.slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(d);
  }
  return [...months].map(([month, list]) => {
    const logged = list.filter(d => d.logged);
    const sym = new Map();
    for (const d of logged) {
      for (const n of new Set(d.log.symptoms.map(x => x.name.trim().toLowerCase()))) {
        const e = sym.get(n) || { name: d.log.symptoms.find(x => x.name.trim().toLowerCase() === n).name.trim(), days: 0 };
        e.days++;
        sym.set(n, e);
      }
    }
    const val = f => list.filter(d => d.date !== skip).map(f).filter(v => v != null);
    const coffee = val(d => (d.log ? d.log.drinks.coffee : null));
    const alcohol = val(d => (d.log ? d.log.drinks.alcohol : null));
    return {
      month, start: list[0].date, end: list[list.length - 1].date, days: list.length, diaryDays: logged.length,
      symptomDays: logged.filter(d => d.log.symptoms.length).length,
      symptoms: [...sym.values()].sort((a, b) => b.days - a.days).slice(0, 3),
      sleep: median(val(d => (d.health && d.health.sleep && !d.health.sleep.inBedOnly ? d.health.sleep.total || null : null))),
      steps: median(val(d => (d.health ? d.health.steps || null : null))),
      coffee: coffee.length ? mean(coffee) : null,
      alcoholDays: alcohol.length ? alcohol.filter(v => v > 0).length : null, alcoholRecorded: alcohol.length,
    };
  }).filter(m => m.diaryDays || m.sleep != null || m.steps != null);
}
