// Trends tab: weight, blood pressure, temperature, weekly sleep and activity, and a symptom heatmap.
// Charts come from chart.js; the numbers from trends-data.js (pure, tested).
import { fullLabel, label as dateLabel, parse, relativeDay, shortLabel, today as todayIso, addDays } from '../core/dates.js';
import { duration, esc, num, plural } from '../core/format.js';
import { bmi, MEASUREMENTS, normalizeProfile, severityLabel } from '../core/schema.js';
import { ICON, store, toast } from '../core/ui.js';
import { lineChart, stripHeatmap, tableToggle, toggleTable } from './chart.js';
import {
  CELL, changeWords, inRange, RANGES, rangeOf, sortByTime, symptomGrid, timeOf, trendSummary, weeklyMedians,
  weeklySymptomSummary, weightChange,
} from './trends-data.js';

const WEEKS = 8;
let data = null;      // { measurements, profile, days, today }
let charts = [];      // live charts, destroyed on leave

const rangeKey = () => rangeOf(store.get('trends-range', '6m')).key;
const dayTime = m => `${fullLabel(m.date)}${m.time ? ` · ${m.time}` : ''}`;
const hm = min => (min == null ? '–' : duration(min));

// ---------- Small pieces

const addBtn = (type, what) => `<button type="button" class="btn small" data-act="add" data-type="${type}" aria-label="Add ${esc(what)}">${ICON.plus}Add</button>`;

function cardHead(id, title, icon, type, what) {
  return `<div class="card-head trend-head"><h2 id="${id}-title" class="trend-title" tabindex="-1">${icon}${esc(title)}</h2>${type ? addBtn(type, what) : ''}</div>`;
}

const sourceText = m => (m.source === 'apple' ? 'Apple Health' : m.source === 'import' ? 'Imported' : 'Added by hand');

function deleteBtn(m, what) {
  return `<button type="button" class="icon-btn" data-act="del" data-id="${esc(m.id)}" aria-label="Delete ${esc(what)} from ${esc(fullLabel(m.date))}">${ICON.trash}</button>`;
}

function flagPill(text) {
  return text ? `<span class="pill high">${ICON.alert}${esc(text)}</span>` : '';
}

function emptyState(icon, title, how) {
  return `<div class="empty trend-empty">${icon}<p><strong>${esc(title)}</strong></p><p>${esc(how)}</p></div>`;
}

const table = (id, caption, head, body) => `<div class="table-wrap" id="${id}-table" hidden>
  <table class="table"><caption class="sr-only">${esc(caption)}</caption>
  <thead><tr>${head.map(h => `<th scope="col"${h.num ? ' class="num"' : ''}>${esc(h.text)}</th>`).join('')}</tr></thead>
  <tbody>${body.map(r => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td${head[i].num ? ' class="num"' : ''}>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody>
  </table></div>`;

/** Every reading of a type, newest first, behind one disclosure: the same on every card. */
function allReadings(list, what) {
  if (!list.length) return '';
  return `<details class="trend-more" data-list="${esc(list[0].type)}"><summary>All readings (${esc(num(list.length))})</summary>
    <ul class="rows">${[...list].reverse().map(m => readingRow(m, what)).join('')}</ul></details>`;
}

/** The latest reading of a card, large, with its date and flag in words. */
function latestHero(m) {
  const v = m.value;
  const main = m.type === 'bp' ? `${v.sys}/${v.dia}` : num(v, 1);
  const flag = MEASUREMENTS[m.type].flag(v);
  return `<div class="trend-hero">
    <p class="trend-big trend-big-sm"><span class="num">${esc(main)}</span><span class="unit">${esc(MEASUREMENTS[m.type].unit)}</span></p>
    <p class="trend-sub">${esc([relativeDay(m.date), m.time, m.type === 'bp' && v.pulse ? `pulse ${v.pulse}` : ''].filter(Boolean).join(' · '))}</p>
    ${flag ? `<p>${flagPill(flag)}</p>` : ''}
  </div>`;
}

// ---------- Overview

function summaryStrip() {
  const s = trendSummary(data.measurements, data.days, data.today, rangeKey());
  const tile = (target, label, value, sub) => `<li><button type="button" class="sum-tile" data-act="jump" data-target="${target}">
    <span class="sum-label">${esc(label)}</span><span class="sum-value num">${esc(value)}</span><span class="sum-sub">${esc(sub)}</span></button></li>`;
  const w = s.weight.last, bp = s.bp.last;
  const tiles = [
    tile('weight', 'Weight', w ? MEASUREMENTS.weight.format(w.value) : '–',
      w ? (s.weight.change ? changeWords(s.weight.change, shortLabel) : relativeDay(w.date)) : 'No weight yet'),
    tile('bp', 'Blood pressure', bp ? `${bp.value.sys}/${bp.value.dia}` : '–',
      s.bp.avg ? `Average 30 days: ${s.bp.avg.sys}/${s.bp.avg.dia} (${plural(s.bp.n, 'reading')})` : bp ? `Last: ${relativeDay(bp.date)}` : 'No reading yet'),
    s.temp ? tile('temp', 'Temperature', MEASUREMENTS.temp.format(s.temp.last.value), relativeDay(s.temp.last.date)) : '',
    tile('weekly', 'Sleep', s.sleep.median == null ? '–' : hm(s.sleep.median), s.sleep.nights ? `Median, last 7 days (${plural(s.sleep.nights, 'night')})` : 'No sleep data in 7 days'),
    tile('sym', 'Symptoms', plural(s.symptomDays, 'day'), 'With a symptom, last 4 weeks'),
  ].filter(Boolean);
  return `<nav class="trend-summary" aria-label="Overview"><ul>${tiles.join('')}</ul></nav>`;
}

// ---------- Weight

function weightCard() {
  const all = sortByTime(data.measurements.filter(m => m.type === 'weight'));
  const key = rangeKey(), range = rangeOf(key);
  const shown = inRange(all, key, data.today);
  const last = all[all.length - 1];
  const b = last ? bmi(last.value, data.profile.heightCm) : null;
  const change = weightChange(shown);
  const seg = `<div class="seg trend-range" role="group" aria-label="Weight period">${RANGES.map(r =>
    `<button type="button" data-act="range" data-value="${r.key}" aria-pressed="${r.key === key}" aria-label="${esc(r.words)}">${esc(r.short)}</button>`).join('')}</div>`;

  let body;
  if (!last) {
    body = emptyState(ICON.scale, 'No weight yet.', 'Tap Add to write your weight. Weights from Apple Health appear here after a sync.');
  } else {
    const hero = `<div class="trend-hero">
      <p class="trend-big"><span class="num">${esc(num(last.value, 1))}</span><span class="unit">kg</span></p>
      <p class="trend-sub">${esc(relativeDay(last.date))}${b ? ` · BMI <span class="num">${esc(num(b, 1))}</span>` : ''}</p>
      ${change ? `<p class="trend-change">${esc(changeWords(change, shortLabel))}</p>` : ''}
      ${!data.profile.heightCm ? '<p class="hint">Add your height in Profile to see your BMI.</p>' : ''}
    </div>`;
    const chart = shown.length >= 2
      ? `<div class="chart-box" id="weight-chart"></div>
         ${table('weight-chart', `Weights, ${range.words}`, [{ text: 'Date' }, { text: 'Weight (kg)', num: true }],
    [...shown].reverse().map(m => [dayTime(m), num(m.value, 1)]))}
         <div class="trend-tools">${tableToggle('weight-chart')}</div>`
      : `<p class="hint chart-none">${shown.length ? 'There is one weight in this period. Add one more to see a line.' : `No weight in the last ${esc(range.words)}. Choose a longer period.`}</p>`;
    body = `${hero}${seg}${chart}
      ${allReadings(all, 'weight')}`;
  }
  return `<section class="card trend-card trend-weight" id="weight-card" aria-labelledby="weight-title">
    ${cardHead('weight', 'Weight', ICON.scale, 'weight', 'weight')}${body}</section>`;
}

function mountWeight() {
  const host = document.getElementById('weight-chart');
  if (!host) return;
  const key = rangeKey(), range = rangeOf(key);
  const shown = inRange(sortByTime(data.measurements.filter(m => m.type === 'weight')), key, data.today);
  const t1 = parse(data.today).getTime() + 86399000;
  const t0 = range.days ? parse(addDays(data.today, -range.days)).getTime() : timeOf(shown[0]);
  charts.push(lineChart(host, {
    label: `Weight, ${range.words}`,
    rows: shown.map(m => ({ t: timeOf(m), v: [m.value], m })),
    series: [{ key: 'series-weight', name: 'Weight' }],
    domain: [t0, t1],
    minSpan: 4,
    area: true,
    yFormat: v => num(v, Number.isInteger(v) ? 0 : 1),
    tip: r => ({ title: dayTime(r.m), lines: [{ text: MEASUREMENTS.weight.format(r.m.value) }] }),
  }));
}

// ---------- Blood pressure

function bpCard() {
  const all = sortByTime(data.measurements.filter(m => m.type === 'bp'));
  let body;
  if (!all.length) {
    body = emptyState(ICON.heart, 'No blood pressure yet.', 'Tap Add to write a reading from your blood pressure monitor.');
  } else {
    const flag = MEASUREMENTS.bp.flag;
    body = `${latestHero(all[all.length - 1])}${all.length >= 2 ? `
      <ul class="chart-legend" aria-label="Legend">
        <li><i class="chart-key series-sys" aria-hidden="true"></i>Systolic (top number)</li>
        <li><i class="chart-key series-dia is-dashed" aria-hidden="true"></i>Diastolic (bottom number)</li>
        <li><i class="chart-key key-band" aria-hidden="true"></i>High: 140 or above</li>
      </ul>
      <div class="chart-box" id="bp-chart"></div>
      ${table('bp-chart', 'Blood pressure readings', [{ text: 'Date' }, { text: 'Systolic', num: true }, { text: 'Diastolic', num: true }, { text: 'Pulse', num: true }, { text: 'Note' }],
    [...all].reverse().map(m => [dayTime(m), m.value.sys, m.value.dia, m.value.pulse ?? '–', (flag(m.value) || '').split(' (')[0]]))}
      <div class="trend-tools">${tableToggle('bp-chart')}</div>` : ''}
      ${allReadings(all, 'blood pressure')}`;
  }
  return `<section class="card trend-card" id="bp-card" aria-labelledby="bp-title">${cardHead('bp', 'Blood pressure', ICON.heart, 'bp', 'blood pressure')}${body}</section>`;
}

/** A reading in a list: value, date, flag (in words) and delete. */
function readingRow(m, what) {
  const v = m.value;
  const [main, unit, extra] = m.type === 'bp'
    ? [`${v.sys}/${v.dia}`, 'mmHg', v.pulse ? `Pulse ${v.pulse}` : '']
    : [num(v, 1), MEASUREMENTS[m.type].unit, m.type === 'weight' ? sourceText(m) : ''];
  const flag = MEASUREMENTS[m.type].flag(v);
  return `<li class="reading-row"><span class="grow">
      <span class="reading"><span class="num">${esc(main)}</span> <span class="unit">${esc(unit)}</span></span>
      <span class="sub">${esc([dayTime(m), extra].filter(Boolean).join(' · '))}</span>
      ${flag ? `<span class="reading-flag">${flagPill(flag)}</span>` : ''}
    </span>${deleteBtn(m, `${what} ${MEASUREMENTS[m.type].format(v)}`)}</li>`;
}

function mountBp() {
  const host = document.getElementById('bp-chart');
  if (!host) return;
  const all = sortByTime(data.measurements.filter(m => m.type === 'bp'));
  charts.push(lineChart(host, {
    label: 'Blood pressure readings',
    rows: all.map(m => ({ t: timeOf(m), v: [m.value.sys, m.value.dia], m })),
    series: [{ key: 'series-sys', name: 'Systolic', short: 'Sys' }, { key: 'series-dia', name: 'Diastolic', short: 'Dia', dashed: true }],
    minSpan: 40,
    include: [150, 70],
    band: { from: 140, label: 'High' },
    refLines: [{ v: 90, label: 'Diastolic high: 90' }],
    endLabels: true,
    tip: r => ({
      title: dayTime(r.m),
      lines: [{ text: `Systolic ${r.m.value.sys}`, key: 'series-sys' }, { text: `Diastolic ${r.m.value.dia}`, key: 'series-dia is-dashed' },
        ...(r.m.value.pulse ? [{ text: `Pulse ${r.m.value.pulse}` }] : []),
        ...(MEASUREMENTS.bp.flag(r.m.value) ? [{ text: MEASUREMENTS.bp.flag(r.m.value) }] : [])],
    }),
  }));
}

// ---------- Temperature

function tempCard() {
  const all = sortByTime(data.measurements.filter(m => m.type === 'temp'));
  const body = all.length
    ? `${latestHero(all[all.length - 1])}${allReadings(all, 'temperature')}`
    : emptyState(ICON.thermo, 'No temperature yet.', 'Tap Add when you take your temperature, for example when you feel ill.');
  return `<section class="card trend-card" id="temp-card" aria-labelledby="temp-title">${cardHead('temp', 'Temperature', ICON.thermo, 'temp', 'temperature')}${body}</section>`;
}

// ---------- Sleep and activity: weekly medians

const WEEKLY = [
  { key: 'sleep', id: 'wk-sleep', title: 'Sleep', icon: ICON.moon, series: 'series-sleep', fmt: hm, scale: 1 / 60, axis: v => (Number.isInteger(v) ? `${v}h` : `${Math.floor(v)}h${String(Math.round((v % 1) * 60)).padStart(2, '0')}`), minSpan: 2, what: 'nights' },
  { key: 'steps', id: 'wk-steps', title: 'Steps', icon: ICON.steps, series: 'series-steps', fmt: v => (v == null ? '–' : num(v)), axis: v => (v >= 1000 ? `${num(v / 1000)}k` : num(v)), minSpan: 2000, what: 'days' },
  { key: 'restingHr', id: 'wk-hr', title: 'Resting heart rate', icon: ICON.heart, series: 'series-hr', fmt: v => (v == null ? '–' : `${num(v)} bpm`), axis: v => num(v), minSpan: 10, what: 'days' },
];
const countKey = { sleep: 'nights', steps: 'stepDays', restingHr: 'hrDays' };
const weekTitle = w => `Week ${shortLabel(w.start)} – ${shortLabel(w.end)}`;

function weeklySection() {
  const weeks = weeklyMedians(data.days, data.today, WEEKS);
  const any = weeks.some(w => w.sleep != null || w.steps != null || w.restingHr != null);
  const inner = !any
    ? emptyState(ICON.sync, 'No sleep or activity data yet.', 'This data comes from Apple Health. Set up the shortcut in Profile → Settings, or import your history there.')
    : `<div class="weekly-grid" id="weekly-charts">${WEEKLY.map(m => {
      const latest = [...weeks].reverse().find(w => w[m.key] != null);
      return `<div class="weekly-item">
        <h3 class="weekly-title">${m.icon}${esc(m.title)}</h3>
        <p class="weekly-value"><span class="num">${esc(latest ? m.fmt(latest[m.key]) : '–')}</span></p>
        <p class="weekly-sub">${latest ? `Median, ${esc(weekTitle(latest).replace('Week ', 'week '))}` : 'No data in 8 weeks'}</p>
        <div class="chart-box chart-small" id="${m.id}"></div>
      </div>`;
    }).join('')}</div>
    ${table('weekly-charts', 'Weekly medians, last 8 weeks',
    [{ text: 'Week' }, { text: 'Sleep', num: true }, { text: 'Steps', num: true }, { text: 'Resting heart rate', num: true }],
    [...weeks].reverse().map(w => [weekTitle(w), hm(w.sleep), w.steps == null ? '–' : num(w.steps), w.restingHr == null ? '–' : `${w.restingHr} bpm`]))}
    <div class="trend-tools">${tableToggle('weekly-charts')}</div>`;
  return `<section class="card trend-card trend-wide" id="weekly-card" aria-labelledby="weekly-title">
    <div class="card-head"><h2 id="weekly-title" class="trend-title" tabindex="-1">${ICON.activity}Sleep and activity</h2></div>
    <p class="hint">Weekly median (middle value) of the last 8 weeks. One unusual day does not change it much.</p>
    ${inner}</section>`;
}

function mountWeekly() {
  if (!document.getElementById('weekly-charts')) return;
  const weeks = weeklyMedians(data.days, data.today, WEEKS);
  for (const m of WEEKLY) {
    const host = document.getElementById(m.id);
    if (!weeks.some(w => w[m.key] != null)) { host.innerHTML = '<p class="hint">No data.</p>'; continue; }
    charts.push(lineChart(host, {
      label: `${m.title}, weekly median, last 8 weeks`,
      rows: weeks.map(w => ({ t: parse(w.start).getTime() + 3 * 86400000, v: [w[m.key] == null ? null : w[m.key] * (m.scale || 1)], w })),
      series: [{ key: m.series, name: m.title }],
      minSpan: m.minSpan,
      height: 132,
      ticks: 3,
      yFormat: m.axis,
      tip: r => ({ title: weekTitle(r.w), lines: [{ text: `${m.fmt(r.w[m.key])}${r.w[m.key] == null ? ' (no data)' : ''}` }, { text: plural(r.w[countKey[m.key]], m.what === 'nights' ? 'night' : 'day') }] }),
    }));
  }
}

// ---------- Symptoms heatmap

const CELL_TEXT = v => (v === CELL.NO_ENTRY ? 'No diary' : v === CELL.NONE ? 'Not written' : v === CELL.NOT_SET ? 'Severity not set' : severityLabel(v));
const cellClass = v => (v === CELL.NO_ENTRY ? 'cell-empty' : v === CELL.NONE ? 'cell-none' : v === CELL.NOT_SET ? 'cell-unset' : `cell-sev-${v}`);

function symptomsSection() {
  const grid = symptomGrid(data.days, data.today, { weeks: WEEKS, maxRows: 6 });
  const inner = !grid.rows.length
    ? emptyState(ICON.symptom, 'No symptoms in the last 8 weeks.', 'When you add a symptom on the Today screen, it appears here.')
    : `<ul class="chart-legend heat-legend" aria-label="Legend">
        <li><i class="chart-key cell-sev-1" aria-hidden="true"></i>Mild</li>
        <li><i class="chart-key cell-sev-2" aria-hidden="true"></i>Moderate</li>
        <li><i class="chart-key cell-sev-3" aria-hidden="true"></i>Severe</li>
        <li><i class="chart-key cell-unset" aria-hidden="true"></i>Severity not set</li>
        <li><i class="chart-key cell-none" aria-hidden="true"></i>Diary, no symptom</li>
        <li><i class="chart-key cell-empty" aria-hidden="true"></i>No diary</li>
      </ul>
      <div class="chart-box" id="sym-chart"></div>
      ${table('sym-chart', 'Symptoms per week: days and worst severity',
    [{ text: 'Symptom' }, ...grid.dates.filter((_, i) => i % 7 === 0).map(d => ({ text: `Week of ${shortLabel(d)}` }))],
    grid.rows.map(r => [`${r.name} (${plural(r.days, 'day')})`, ...weeklySymptomSummary(r, grid.dates).map(w => (w.days ? `${plural(w.days, 'day')}, ${CELL_TEXT(w.worst).toLowerCase()}` : '–'))]))}
      <div class="trend-tools">${tableToggle('sym-chart')}</div>
      ${grid.more ? `<p class="hint">${esc(plural(grid.more, 'other symptom'))} not shown. The chart shows the 6 most frequent.</p>` : ''}`;
  return `<section class="card trend-card trend-wide" id="sym-card" aria-labelledby="sym-title">
    <div class="card-head"><h2 id="sym-title" class="trend-title" tabindex="-1">${ICON.symptom}Symptoms</h2></div>
    <p class="hint">Last 8 weeks. One row per symptom, one block per day. The color shows the worst severity of the day.</p>
    ${inner}</section>`;
}

function mountSymptoms() {
  const host = document.getElementById('sym-chart');
  if (!host) return;
  const grid = symptomGrid(data.days, data.today, { weeks: WEEKS, maxRows: 6 });
  charts.push(stripHeatmap(host, {
    label: 'Symptoms, last 8 weeks',
    dates: grid.dates,
    rows: grid.rows,
    cellClass,
    tip: (row, j) => ({ title: dateLabel(grid.dates[j]), lines: [{ text: `${row.name}: ${CELL_TEXT(row.cells[j])}` }] }),
  }));
}

// ---------- Screen

function mountCharts() {
  charts.forEach(c => c.destroy());
  charts = [];
  mountWeight();
  mountBp();
  mountWeekly();
  mountSymptoms();
}

const TYPE_WORDS = { weight: 'Weight', bp: 'Blood pressure', temp: 'Temperature' };

export default {
  async render(ctx) {
    const today = todayIso();
    const [measurements, profile, days] = await Promise.all([
      ctx.api.listMeasurements(),
      ctx.api.getProfile(),
      ctx.api.listDays(addDays(today, -(WEEKS * 7 - 1)), today),
    ]);
    data = { measurements, profile: normalizeProfile(profile), days, today };
    return `<div class="screen-head"><h1 class="screen-title">Trends</h1></div>
      ${summaryStrip()}
      <div class="trends-grid">
        ${weightCard()}
        ${bpCard()}
        ${tempCard()}
        ${weeklySection()}
        ${symptomsSection()}
      </div>`;
  },

  mounted() { mountCharts(); },

  async leave() {
    charts.forEach(c => c.destroy());
    charts = [];
  },

  actions: {
    add(el, e, ctx) { return ctx.quickAdd(el.dataset.type); },

    range(el) {
      store.set('trends-range', el.dataset.value);
      const card = document.getElementById('weight-card');
      const value = el.dataset.value;
      const tmp = document.createElement('div');
      tmp.innerHTML = weightCard();
      card.replaceWith(tmp.firstElementChild);
      mountCharts();
      document.querySelector(`#weight-card [data-act="range"][data-value="${CSS.escape(value)}"]`)?.focus();
    },

    'chart-table'(el, e, ctx) { toggleTable(el, ctx.view); },

    jump(el) {
      const h = document.getElementById(`${el.dataset.target}-title`);
      if (!h) return;
      h.closest('section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      h.focus({ preventScroll: true });
    },

    async del(el, e, ctx) {
      const id = el.dataset.id;
      const m = data.measurements.find(x => String(x.id) === id);
      if (!m) throw new Error('This value is no longer here. Reload the screen.');
      const card = el.closest('section');
      const cardId = card.id;
      const index = [...card.querySelectorAll('[data-act="del"]')].indexOf(el);
      await ctx.api.deleteMeasurement(m.id);
      const words = `${TYPE_WORDS[m.type] || 'Value'} ${MEASUREMENTS[m.type] ? MEASUREMENTS[m.type].format(m.value) : ''}`.trim();
      await ctx.refresh();
      // Focus goes to the next reading of the same list, or to the card title when the list is empty.
      const fresh = document.getElementById(cardId);
      if (fresh) {
        const list = fresh.querySelector('details.trend-more');
        if (list) list.open = true;
        const btns = fresh.querySelectorAll('[data-act="del"]');
        const next = btns[Math.min(index, btns.length - 1)];
        (next || fresh.querySelector('h2')).focus();
      }
      toast(`${words} deleted`, {
        action: {
          label: 'Undo',
          run: async () => {
            try {
              await ctx.api.addMeasurement({ type: m.type, date: m.date, time: m.time || '', value: m.value, source: m.source || 'manual' });
              toast(`${words} restored`);
              if (ctx.tab === 'body') ctx.refresh();
            } catch (err) {
              toast(`Could not restore the value. ${err.message}`, { tone: 'error' });
            }
          },
        },
      });
    },
  },
};
