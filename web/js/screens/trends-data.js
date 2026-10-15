// Pure data helpers for the Trends screen. No DOM. Unit-tested in tests/trends.test.js.
import { addDays, parse } from '../core/dates.js';
import { median, mean } from '../core/math.js';
import { hasContent, normalizeLog } from '../core/schema.js';

/** Weight chart ranges: key, days back (null = all), button text, words. */
export const RANGES = [
  { key: '3m', days: 91, short: '3M', words: '3 months' },
  { key: '6m', days: 182, short: '6M', words: '6 months' },
  { key: '1y', days: 365, short: '1Y', words: '1 year' },
  { key: 'all', days: null, short: 'All', words: 'all time' },
];
export const rangeOf = key => RANGES.find(r => r.key === key) || RANGES[1];

/** Time of a measurement in ms (local), for the x axis. */
export function timeOf(m) {
  const d = parse(m.date);
  if (m.time && /^\d{2}:\d{2}$/.test(m.time)) d.setHours(Number(m.time.slice(0, 2)), Number(m.time.slice(3)));
  return d.getTime();
}

/** Measurements sorted oldest first (date, then time). */
export const sortByTime = list => [...list].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));

/** The measurements inside a range that ends today. */
export function inRange(list, rangeKey, today) {
  const r = rangeOf(rangeKey);
  if (!r.days) return list;
  const from = addDays(today, -r.days);
  return list.filter(m => m.date >= from);
}

/** Change from the first to the last weight in a list: { delta, from } or null when fewer than 2. */
export function weightChange(list) {
  if (list.length < 2) return null;
  const first = list[0], last = list[list.length - 1];
  return { delta: Math.round((last.value - first.value) * 10) / 10, from: first.date };
}

/**
 * Weekly medians for the last `weeks` weeks. Weeks are 7-day blocks that end today.
 * days: [{ date, log, health }] from api.listDays. Returns oldest first:
 * [{ start, end, sleep (minutes), steps, restingHr, nights, stepDays, hrDays }]
 */
export function weeklyMedians(days, today, weeks = 8) {
  const out = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const end = addDays(today, -7 * k), start = addDays(end, -6);
    const inWeek = days.filter(d => d.date >= start && d.date <= end && d.health);
    const sleep = inWeek.map(d => d.health.sleep && !d.health.sleep.inBedOnly ? d.health.sleep.total : null).filter(v => v > 0);
    const steps = inWeek.map(d => d.health.steps).filter(v => Number.isFinite(v) && v > 0);
    const hr = inWeek.map(d => d.health.restingHr).filter(v => Number.isFinite(v) && v > 0);
    out.push({
      start, end,
      sleep: median(sleep), steps: steps.length ? Math.round(median(steps)) : null, restingHr: hr.length ? Math.round(median(hr)) : null,
      nights: sleep.length, stepDays: steps.length, hrDays: hr.length,
    });
  }
  return out;
}

/** Heatmap cell values. */
export const CELL = { NO_ENTRY: null, NONE: 0, NOT_SET: -1 };

/** Worst severity of a list: 3, 2, 1, or NOT_SET when none of them has a severity. */
const worst = sevs => (sevs.some(s => s) ? Math.max(...sevs.filter(Boolean)) : CELL.NOT_SET);

/**
 * Symptom heatmap for the last `weeks` weeks: the most frequent symptoms (max `maxRows`), one cell per day.
 * Cell: null = no diary that day, 0 = not written that day, 1–3 = worst severity, -1 = severity not set.
 * Returns { dates, rows: [{ name, days, cells }] }, rows sorted by number of days (most first).
 */
export function symptomGrid(days, today, { weeks = 8, maxRows = 6 } = {}) {
  const dates = [];
  for (let i = weeks * 7 - 1; i >= 0; i--) dates.push(addDays(today, -i));
  const byDate = new Map(days.map(d => [d.date, d.log ? normalizeLog(d.log) : null]));
  const names = new Map(); // lower-case name → { name, perDay: Map(date → [severity]) }
  for (const date of dates) {
    const log = byDate.get(date);
    if (!log) continue;
    for (const s of log.symptoms) {
      const key = s.name.trim().toLowerCase();
      if (!key) continue;
      if (!names.has(key)) names.set(key, { name: s.name.trim(), perDay: new Map() });
      const per = names.get(key).perDay;
      per.set(date, [...(per.get(date) || []), s.severity]);
    }
  }
  const rows = [...names.values()].map(x => ({
    name: x.name,
    days: x.perDay.size,
    cells: dates.map(d => {
      if (x.perDay.has(d)) return worst(x.perDay.get(d));
      const log = byDate.get(d);
      return log && hasContent(log) ? CELL.NONE : CELL.NO_ENTRY;
    }),
  }));
  rows.sort((a, b) => b.days - a.days || Math.max(...b.cells) - Math.max(...a.cells) || a.name.localeCompare(b.name));
  return { dates, rows: rows.slice(0, maxRows), more: Math.max(0, rows.length - maxRows) };
}

/** Per-week summary of one heatmap row, for the table: [{ start, days, worst }] (worst: 1–3, -1 or 0). */
export function weeklySymptomSummary(row, dates) {
  const out = [];
  for (let i = 0; i < dates.length; i += 7) {
    const cells = row.cells.slice(i, i + 7).filter(v => v != null && v !== 0);
    out.push({ start: dates[i], days: cells.length, worst: cells.length ? Math.max(...cells) : 0 });
  }
  return out;
}

/** "Down 1.6 kg since 12 Apr" style words for a weight change. */
export function changeWords(change, fmtDate) {
  if (!change) return '';
  const d = Math.abs(change.delta).toFixed(1);
  if (change.delta === 0) return `No change since ${fmtDate(change.from)}`;
  return `${change.delta < 0 ? 'Down' : 'Up'} ${d} kg since ${fmtDate(change.from)}`;
}

/**
 * The overview at the top of Trends.
 * Returns { weight: { last, change }, bp: { last, avg: { sys, dia }, n }, temp: { last } | null,
 *           sleep: { median, nights }, symptomDays }
 */
export function trendSummary(measurements, days, today, rangeKey) {
  const of = type => sortByTime(measurements.filter(m => m.type === type));
  const weights = of('weight'), bps = of('bp'), temps = of('temp');
  const from30 = addDays(today, -29);
  const recentBp = bps.filter(m => m.date >= from30);
  const lastTemp = temps[temps.length - 1];
  const from7 = addDays(today, -6), from28 = addDays(today, -27);
  const nights = days.filter(d => d.date >= from7 && d.date <= today && d.health && d.health.sleep && !d.health.sleep.inBedOnly)
    .map(d => d.health.sleep.total).filter(v => v > 0);
  const symptomDays = days.filter(d => d.date >= from28 && d.date <= today && d.log && normalizeLog(d.log).symptoms.length).length;
  return {
    weight: { last: weights[weights.length - 1] || null, change: weightChange(inRange(weights, rangeKey, today)) },
    bp: {
      last: bps[bps.length - 1] || null,
      avg: recentBp.length ? { sys: Math.round(mean(recentBp.map(m => m.value.sys))), dia: Math.round(mean(recentBp.map(m => m.value.dia))) } : null,
      n: recentBp.length,
    },
    // A temperature is "recent" for 14 days.
    temp: lastTemp && lastTemp.date >= addDays(today, -13) ? { last: lastTemp } : null,
    sleep: { median: median(nights), nights: nights.length },
    symptomDays,
  };
}
