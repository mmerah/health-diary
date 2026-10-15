// HTML templates for the Today screen. Pure functions: state in, HTML string out.
// Every value goes through esc(). Behaviour lives in today.js.
import { label, longLabel, relativeDay } from '../core/dates.js';
import { duration, esc, fold, num, plural } from '../core/format.js';
import { DRINKS, MEALS, MEASUREMENTS, PERIODS, SEVERITIES, bmi, medLabel } from '../core/schema.js';
import { ICON } from '../core/ui.js';
import {
  clip, drinksSummary, healthItems, healthSource, mealSummary, measurementsSummary, medsSummary,
  sleepStages, snacksSummary, symptomDetail, symptomsSummary,
} from './today-model.js';

const CHIPS_SHOWN = 8;

// ---------- Header and week strip

export function header(st) {
  // "Today · Wednesday", "3 days ago · Sunday"; older days: the weekday, and the year if it is not this year.
  const rel = relativeDay(st.date);
  const wd = label(st.date, { weekday: 'long' });
  const year = st.date.slice(0, 4);
  const eyebrow = !/\d{4}/.test(rel) ? `${rel} · ${wd}` : year === st.today.slice(0, 4) ? wd : `${wd} · ${year}`;
  const main = label(st.date, { day: 'numeric', month: 'long' });
  return `<header class="today-head">
    <div class="today-title-row">
      <h1 class="today-title">
        <button type="button" class="date-btn" data-act="pick-date" aria-label="${esc(`${longLabel(st.date)}. Choose another day.`)}">
          <span class="date-eyebrow">${esc(eyebrow)}</span>
          <span class="date-main">${esc(main)}${ICON.down}</span>
        </button>
      </h1>
      <input type="date" class="date-input" data-f="date" value="${esc(st.date)}" max="${esc(st.today)}" tabindex="-1" aria-hidden="true">
      <div class="day-nav">
        <button type="button" class="icon-btn" data-act="day" data-step="-1" aria-label="Previous day">${ICON.left}</button>
        <button type="button" class="icon-btn" data-act="day" data-step="1" aria-label="Next day"${st.isToday ? ' disabled' : ''}>${ICON.right}</button>
      </div>
    </div>
    ${st.isToday ? '' : `<button type="button" class="back-today" data-act="go-today">${ICON.calendar}<span>Back to today</span></button>`}
  </header>`;
}

export function weekStrip(st) {
  const days = st.week.map(d => {
    const future = d > st.today;
    const selected = d === st.date;
    const focusable = st.week.includes(st.date) ? selected : d === st.week[0];
    const has = !!st.weekHas[d];
    const words = [longLabel(d), d === st.today ? 'today' : '', selected ? 'shown' : '', future ? 'in the future' : has ? 'has entries' : 'no entries']
      .filter(Boolean).join(', ');
    return `<li><button type="button" class="wd${selected ? ' is-selected' : ''}${d === st.today ? ' is-today' : ''}" data-act="pick" data-date="${esc(d)}"
        aria-label="${esc(words)}"${d === st.today ? ' aria-current="date"' : ''}${future ? ' disabled' : ''} tabindex="${focusable ? '0' : '-1'}">
        <span class="wd-name" aria-hidden="true">${esc(label(d, { weekday: 'short' }))}</span>
        <span class="wd-num" aria-hidden="true">${esc(label(d, { day: 'numeric' }))}</span>
        <span class="wd-dot${has ? ' on' : ''}" aria-hidden="true"></span>
      </button></li>`;
  }).join('');
  const first = st.week[0], last = st.week[6];
  const range = first.slice(5, 7) === last.slice(5, 7)
    ? `${label(first, { day: 'numeric' })}–${label(last, { day: 'numeric', month: 'short' })}`
    : `${label(first, { day: 'numeric', month: 'short' })} – ${label(last, { day: 'numeric', month: 'short' })}`;
  return `<nav class="week" aria-label="Days of the week">
    <div class="week-head">
      <span class="week-range" aria-live="polite">${esc(range)}</span>
      <button type="button" class="icon-btn" data-act="week" data-step="-1" aria-label="Previous week">${ICON.left}</button>
      <button type="button" class="icon-btn" data-act="week" data-step="1" aria-label="Next week"${last >= st.today ? ' disabled' : ''}>${ICON.right}</button>
    </div>
    <ol class="week-days">${days}</ol>
  </nav>`;
}

// ---------- Collapsible rows

/** A row with a toggle button (aria-expanded) that controls a region. */
function row(st, key, { icon, title, summary, level = 3, body }) {
  const empty = emptyOf(st, key);
  const open = st.open.has(key);
  return `<div class="trow${open ? ' is-open' : ''}" data-row="${esc(key)}">
    <h${level} class="trow-h">
      <button type="button" class="trow-btn" id="tb-${esc(key)}" data-act="toggle" data-key="${esc(key)}" aria-expanded="${open}" aria-controls="tr-${esc(key)}">
        <span class="trow-icon">${icon}</span>
        <span class="trow-text">
          <span class="trow-title">${esc(title)}</span>
          <span class="trow-sum${summary ? '' : ' is-empty'}" data-sum="${esc(key)}">${esc(summary || empty)}</span>
        </span>
        <span class="trow-chev">${ICON.down}</span>
      </button>
    </h${level}>
    <div class="trow-body" id="tr-${esc(key)}" role="region" aria-labelledby="tb-${esc(key)}"${open ? '' : ' hidden'}>${body}</div>
  </div>`;
}

/** Text for a collapsed row when nothing is logged. */
export function emptyOf(st, key) {
  return {
    snacks: 'None logged', drinks: 'Not recorded',
    meds: st.scheduled.length ? 'Nothing taken yet' : st.asNeeded.length || st.profileError ? 'None logged' : 'Add your medication in Profile',
    symptoms: 'None logged', notes: 'No notes', measurements: st.measures === 'loading' ? 'Loading…' : 'None this day',
  }[key] || 'Not logged yet';
}

/** Text for a collapsed row, or '' when empty. */
export function summaryOf(st, key) {
  const l = st.log;
  if (l.meals[key]) return mealSummary(l.meals[key]);
  switch (key) {
    case 'snacks': return snacksSummary(l.snacks);
    case 'drinks': return drinksSummary(l.drinks);
    case 'meds': return medsSummary(l, st.scheduled);
    case 'activities': return clip(l.activities);
    case 'symptoms': return symptomsSummary(l.symptoms);
    case 'notes': return clip(l.notes);
    case 'measurements': return Array.isArray(st.measures) ? measurementsSummary(st.measures) : '';
    default: return '';
  }
}

// ---------- Sections
// Phone: one column in reading order (Health, Meals, Drinks, Medication, What I did, Symptoms, Notes,
// Measurements). Wide screens: two columns, and the DOM follows the columns (writing, then numbers),
// so Tab and screen readers read one column after the other.

export function sections(st) {
  const s = {
    health: healthSection(st),
    meals: `<section class="tsec card" data-sec="meals" aria-labelledby="h-meals">
      <h2 class="tsec-title" id="h-meals">Meals</h2>
      ${row(st, 'breakfast', mealRowOpts(st, 'breakfast'))}
      ${row(st, 'lunch', mealRowOpts(st, 'lunch'))}
      ${row(st, 'snacks', { icon: ICON.snack, title: 'Snacks', summary: summaryOf(st, 'snacks'), body: snacksBody(st) })}
      ${row(st, 'dinner', mealRowOpts(st, 'dinner'))}
    </section>`,
    drinks: single(st, 'drinks', { icon: ICON.drink, title: 'Drinks', body: drinksBody(st) }),
    meds: single(st, 'meds', { icon: ICON.pill, title: 'Medication', body: medsBody(st) }),
    activities: single(st, 'activities', { icon: ICON.activity, title: 'What I did', body: textBody(st, 'activities', 'What did you do?', 'Work, sport, rest, travel…') }),
    symptoms: single(st, 'symptoms', { icon: ICON.symptom, title: 'Symptoms', body: symptomsBody(st) }),
    notes: single(st, 'notes', { icon: ICON.note, title: 'Notes', body: textBody(st, 'notes', 'Notes', 'Anything else you want to remember') }),
    measurements: single(st, 'measurements', { icon: ICON.scale, title: 'Measurements', body: measurementsBody(st) }),
  };
  const pick = keys => keys.map(k => s[k]).join('');
  if (st.wide) {
    return `<div class="today-cols">
      <div class="today-col" data-col="write">${pick(['meals', 'activities', 'symptoms', 'notes'])}</div>
      <div class="today-col" data-col="numbers">${pick(['health', 'drinks', 'meds', 'measurements'])}</div>
    </div>`;
  }
  return `<div class="today-col">${pick(['health', 'meals', 'drinks', 'meds', 'activities', 'symptoms', 'notes', 'measurements'])}</div>`;
}

function single(st, key, opts) {
  return `<section class="tsec card" data-sec="${esc(key)}">${row(st, key, { ...opts, level: 2, summary: summaryOf(st, key) })}</section>`;
}

function mealRowOpts(st, key) {
  const m = MEALS.find(x => x.key === key);
  return { icon: ICON.meal, title: m.label, summary: summaryOf(st, key), body: mealBody(st, key) };
}

export function bodyOf(st, key) {
  if (st.log.meals[key]) return mealBody(st, key);
  return {
    snacks: snacksBody, drinks: drinksBody, meds: medsBody, symptoms: symptomsBody, measurements: measurementsBody,
    activities: s => textBody(s, 'activities', 'What did you do?', 'Work, sport, rest, travel…'),
    notes: s => textBody(s, 'notes', 'Notes', 'Anything else you want to remember'),
  }[key](st);
}

// ---------- Health: one slim row, details on demand

export function healthSection(st) {
  const h = st.health;
  const items = healthItems(h);
  const open = st.open.has('health');
  const canSync = st.canSync && st.isToday;
  const icon = { sleep: ICON.moon, steps: ICON.steps, restingHr: ICON.heart, hrv: ICON.symptom };
  const inner = items.length
    ? `<span class="sr-only">Apple Health: </span><span class="h-items">${items.map(i => `<span class="h-item h-${esc(i.key)}">${icon[i.key]}<span class="sr-only">${esc(i.label)} </span><span class="h-val">${esc(i.value)}</span>${i.unit ? `<span class="h-unit">${esc(i.unit === 'ms HRV' ? 'ms' : i.unit)}</span>` : ''}</span>`).join('')}</span>`
    : `<span class="h-items"><span class="h-item h-empty">${ICON.heart}<span>Apple Health: no data for this day</span></span></span>`;
  // A small icon button in the row: it does not compete with the quick-add button.
  const quickSync = canSync
    ? `<button type="button" class="icon-btn h-sync" data-act="sync" aria-label="Sync Apple Health" title="Sync Apple Health">${ICON.sync}</button>` : '';
  return `<section class="tsec card tsec-health" data-sec="health" aria-labelledby="h-health">
    <h2 class="sr-only" id="h-health">Health</h2>
    <div class="trow${open ? ' is-open' : ''}" data-row="health">
      <div class="h-row">
        <button type="button" class="trow-btn h-toggle" id="tb-health" data-act="toggle" data-key="health" aria-expanded="${open}" aria-controls="tr-health">
          ${inner}<span class="trow-chev">${ICON.down}</span>
        </button>
        ${quickSync}
      </div>
      <div class="trow-body" id="tr-health" role="region" aria-labelledby="h-health"${open ? '' : ' hidden'}>${healthBody(st)}</div>
    </div>
  </section>`;
}

function healthBody(st) {
  const h = st.health;
  const canSync = st.canSync && st.isToday;
  const edited = (h && h.edited) || [];
  const mark = k => (edited.includes(k) ? '<span class="edited" title="Corrected by hand"><span aria-hidden="true">✎</span><span class="sr-only">(corrected by hand)</span></span>' : '');
  const syncBtn = canSync
    ? `<button type="button" class="btn" data-act="sync">${ICON.sync}<span>${h ? 'Sync again' : 'Sync now'}</span></button>` : '';
  const editBtn = `<button type="button" class="btn" data-act="health-edit" aria-expanded="${st.healthForm}" aria-controls="health-form">${ICON.edit}<span>${h ? 'Correct by hand' : 'Enter by hand'}</span></button>`;
  let details;
  if (!h) {
    details = `<p><strong>No Apple Health data for this day.</strong></p><p class="hint">${esc(canSync ? 'Sync to get last night’s sleep and today’s steps. You can sync again later in the day.'
      : st.isToday ? 'Nothing received yet. Sync from your iPhone, or enter the data by hand.' : 'You can enter the data for this day by hand.')}</p>`;
  } else {
    const s = h.sleep || {};
    const stages = sleepStages(s);
    const naps = (s.naps || []).map(n => `Nap ${n.start}–${n.end} (${duration(n.minutes)})`);
    details = `<dl class="h-details">
      <div class="h-d h-d-sleep"><dt>${ICON.moon}${s.inBedOnly ? 'Time in bed' : 'Sleep, night before'} ${mark('sleep')}</dt>
        <dd><span class="h-big">${esc(duration(s.total))}</span>${s.bed && s.wake ? `<span class="h-sub">${esc(s.bed)} → ${esc(s.wake)}</span>` : ''}</dd>
        ${stages.length ? `<dd class="stages"><span class="stage-bar" aria-hidden="true">${stages.map(p => `<span class="stage stage-${esc(p.key)}" data-share="${esc(p.share)}"></span>`).join('')}</span>
          <span class="stage-legend">${stages.map(p => `<span><i class="stage-key stage-${esc(p.key)}" aria-hidden="true"></i>${esc(p.label)} ${esc(duration(p.minutes))}</span>`).join('')}</span></dd>` : ''}
        ${naps.length ? `<dd class="h-sub">${esc(naps.join(' · '))}</dd>` : ''}
        ${s.inBedOnly ? '<dd class="h-sub">Only time in bed was recorded. Wear your watch at night to get sleep stages.</dd>' : ''}
      </div>
      <div class="h-d"><dt>${ICON.steps}Steps ${mark('steps')}</dt><dd><span class="h-big">${esc(num(h.steps))}</span>${st.isToday && h.steps != null ? '<span class="h-sub">so far</span>' : ''}</dd></div>
      <div class="h-d"><dt>${ICON.heart}Resting HR ${mark('restingHr')}</dt><dd><span class="h-big">${esc(num(h.restingHr))}</span><span class="h-sub">bpm</span></dd></div>
      <div class="h-d"><dt>${ICON.symptom}HRV ${mark('hrv')}</dt><dd><span class="h-big">${esc(num(h.hrv))}</span><span class="h-sub">ms</span></dd></div>
      ${h.workouts && h.workouts.length ? `<div class="h-d h-d-wide"><dt>${ICON.activity}Workouts</dt>${h.workouts.map(w => `<dd>${esc(w.type)} · ${esc(w.minutes)} min active${w.start ? ` · from ${esc(w.start)}` : ''}</dd>`).join('')}</div>` : ''}
    </dl>
    <p class="h-source">${esc(healthSource(h, st.today))}${edited.length ? ' · ✎ Corrected by hand. A new sync keeps your corrections.' : ''}</p>`;
  }
  return `${details}<div class="btn-row">${syncBtn}${editBtn}</div>${healthForm(st)}`;
}

function healthForm(st) {
  const h = st.health || {};
  const s = h.sleep || {};
  const v = x => esc(x == null ? '' : x);
  const f = (name, lbl, value, extra = '') => `<label class="field"><span>${esc(lbl)}</span><input name="${esc(name)}" ${extra} value="${value}"></label>`;
  const n = 'type="number" inputmode="numeric"';
  return `<form class="health-form stack" id="health-form" data-form="health"${st.healthForm ? '' : ' hidden'} novalidate>
    <div class="grid2">
      ${f('sleepH', 'Sleep, hours', s.total != null ? esc(Math.floor(s.total / 60)) : '', `${n} min="0" max="24"`)}
      ${f('sleepM', 'Sleep, minutes', s.total != null ? esc(Math.round(s.total % 60)) : '', `${n} min="0" max="59"`)}
      ${f('bed', 'Bedtime', v(s.bed), 'type="time"')}
      ${f('wake', 'Woke up', v(s.wake), 'type="time"')}
      ${f('steps', 'Steps', v(h.steps), `${n} min="0" max="200000"`)}
      ${f('restingHr', 'Resting HR (bpm)', v(h.restingHr), `${n} min="20" max="250"`)}
      ${f('hrv', 'HRV (ms)', v(h.hrv), `${n} min="1" max="400"`)}
    </div>
    <p class="field-error" role="alert" data-error="health"></p>
    <p class="hint">A new sync does not change the values you correct here.</p>
    <div class="btn-row"><button type="submit" class="btn primary">Save</button><button type="button" class="btn" data-act="health-edit">Cancel</button></div>
  </form>`;
}

// ---------- Section bodies

function mealBody(st, key) {
  const m = st.log.meals[key];
  const def = MEALS.find(x => x.key === key);
  return `<div class="meal-edit">
    <label class="field grow"><span>What did you eat?</span><textarea rows="2" data-f="meal-text" data-meal="${esc(key)}" placeholder="${esc(`${def.label}: food and drink`)}">${esc(m.text)}</textarea></label>
    <label class="field meal-time"><span>Time</span><input class="time" type="time" data-f="meal-time" data-meal="${esc(key)}" value="${esc(m.time)}"></label>
  </div>`;
}

function snacksBody(st) {
  const list = st.log.snacks.map((s, i) => `<li class="snack" data-i="${esc(i)}">
      <input class="time" type="time" data-f="snack-time" data-i="${esc(i)}" value="${esc(s.time)}" aria-label="${esc(`Time of snack ${i + 1}`)}">
      <input type="text" data-f="snack-text" data-i="${esc(i)}" value="${esc(s.text)}" aria-label="${esc(`Snack ${i + 1}`)}" placeholder="What did you eat?">
      <button type="button" class="icon-btn" data-act="del-snack" data-i="${esc(i)}" aria-label="${esc(`Remove snack ${i + 1}`)}">${ICON.trash}</button>
    </li>`).join('');
  return `${list ? `<ul class="snack-list">${list}</ul>` : '<p class="hint">No snacks yet.</p>'}
    <button type="button" class="btn small add-btn" data-act="add-snack">${ICON.plus}<span>Add a snack</span></button>`;
}

const drinkCount = (d, v) => (v == null ? 'Not recorded' : v === 0 ? 'None' : plural(v, d.one, d.many));

function drinksBody(st) {
  return `<ul class="drink-list">${DRINKS.map(d => {
    const v = st.log.drinks[d.key];
    return `<li class="drink" data-drink="${esc(d.key)}">
      <span class="drink-name">${esc(d.label)}<span class="drink-val${v == null ? ' is-empty' : ''}" id="dv-${esc(d.key)}" aria-live="polite">${esc(drinkCount(d, v))}</span></span>
      <span class="stepper">
        <button type="button" class="icon-btn step" data-act="drink" data-key="${esc(d.key)}" data-d="-1" aria-label="${esc(`One ${d.one} less of ${d.label.toLowerCase()}`)}" aria-describedby="dv-${esc(d.key)}"${v === 0 ? ' disabled' : ''}>${ICON.minus}</button>
        <span class="step-num" aria-hidden="true">${esc(v == null ? '–' : v)}</span>
        <button type="button" class="icon-btn step" data-act="drink" data-key="${esc(d.key)}" data-d="1" aria-label="${esc(`One more ${d.one} of ${d.label.toLowerCase()}`)}" aria-describedby="dv-${esc(d.key)}">${ICON.plus}</button>
      </span>
    </li>`;
  }).join('')}</ul>
  <p class="hint">Tap − once to record “none”.</p>`;
}

function medsBody(st) {
  const l = st.log;
  if (st.profileError) {
    return `<div class="notice is-error" role="alert">${ICON.alert}<div><p>Your medication list did not load.</p>
      <button type="button" class="btn small" data-act="reload">Try again</button></div></div>`;
  }
  const scheduled = st.scheduled.length ? `<ul class="rows med-list">${st.scheduled.map(m => {
    const t = l.meds.taken[m.id] || {};
    return `<li class="med${t.done ? ' is-done' : ''}" data-id="${esc(m.id)}"><label class="check grow">
        <input type="checkbox" data-f="med" data-id="${esc(m.id)}"${t.done ? ' checked' : ''}>
        <span class="grow">${esc(m.name)}${m.dose ? `<span class="sub">${esc(m.dose)}</span>` : ''}</span></label>
        ${t.done ? timeChip(st, `med:${m.id}`, t.time, m.name, `data-f="med-time" data-id="${esc(m.id)}"`) : ''}
      </li>`;
  }).join('')}</ul>`
    : `<p class="hint">${esc(st.asNeeded.length ? 'No regular medication for this day.' : 'Add your medication in Profile. Then you can tick it here each day.')}</p>
       <button type="button" class="btn small add-btn" data-act="open-profile">${ICON.user}<span>Add medication in Profile</span></button>`;
  const extra = l.meds.extra.length ? `<ul class="extra-list">${l.meds.extra.map((x, i) => `<li class="extra" data-i="${esc(i)}">
      <input type="text" data-f="extra-name" data-i="${esc(i)}" value="${esc(x.name)}" aria-label="${esc(`Other medication ${i + 1}`)}">
      ${timeChip(st, `extra:${i}`, x.time, x.name || 'medication', `data-f="extra-time" data-i="${esc(i)}"`)}
      <button type="button" class="icon-btn" data-act="del-extra" data-i="${esc(i)}" aria-label="${esc(`Remove ${x.name || 'medication'}`)}">${ICON.trash}</button>
    </li>`).join('')}</ul>` : '';
  const prn = st.asNeeded.map(m => `<button type="button" class="chip" data-act="add-prn" data-id="${esc(m.id)}">${ICON.plus}${esc(medLabel(m))}</button>`).join('');
  return `${scheduled}
    <div class="sub-block">
      <h3 class="sub-title">Other medication</h3>
      ${extra}
      ${prn ? `<div class="chips" role="group" aria-label="As needed">${prn}</div>` : ''}
      <form class="inline-add" data-form="add-extra">
        <label class="sr-only" for="extra-new">Name and dose of other medication</label>
        <input id="extra-new" name="name" type="text" placeholder="Name and dose" autocomplete="off">
        <button type="submit" class="btn">Add</button>
      </form>
    </div>`;
}

/**
 * The time a medication was taken: a button "✓ 21:05" that turns into a time field when tapped.
 * The report uses these times, so they must be easy to correct.
 */
function timeChip(st, key, time, name, fieldAttrs) {
  if (st.editTime === key) {
    return `<input class="time med-time-input" type="time" ${fieldAttrs} value="${esc(time)}" aria-label="${esc(`Time ${name} was taken`)}">`;
  }
  return `<button type="button" class="med-time" data-act="edit-time" data-key="${esc(key)}"
    aria-label="${esc(time ? `Taken at ${time}. Change the time.` : `Add the time ${name} was taken.`)}">${ICON.check}<span>${esc(time || 'Add time')}</span></button>`;
}

function textBody(st, key, lbl, placeholder) {
  return `<label class="field"><span class="sr-only">${esc(lbl)}</span>
    <textarea rows="4" data-f="${esc(key)}" placeholder="${esc(placeholder)}">${esc(st.log[key])}</textarea></label>`;
}

/** Radio group with roving tabindex (arrow keys in today.js). */
export function radios({ name, i, options, value, labelId, cls = '' }) {
  const tabbable = options.some(o => o.value === value) ? value : options[0].value;
  return `<div class="seg ${cls}" role="radiogroup" aria-labelledby="${esc(labelId)}">${options.map(o => `<button type="button" role="radio"
      class="${esc(o.cls || '')}" data-act="${esc(name)}" data-i="${esc(i)}" data-v="${esc(o.value)}" aria-checked="${o.value === value}"
      tabindex="${o.value === tabbable ? '0' : '-1'}">${o.dot ? '<span class="sev-dot" aria-hidden="true"></span>' : ''}${esc(o.label)}</button>`).join('')}</div>`;
}

export const SEV_OPTIONS = SEVERITIES.map(s => ({ value: String(s.value), label: s.label, cls: `sev-${s.value}`, dot: true }));
const WHEN_OPTIONS = [{ value: 'day', label: 'All day' }, { value: 'periods', label: 'Part of day' }, { value: 'time', label: 'Time' }];

export function symptomChips(st) {
  const logged = new Set(st.log.symptoms.map(s => fold(s.name)));
  const names = st.symptomNames;
  const shown = st.showAllSymptoms ? names : names.slice(0, CHIPS_SHOWN);
  // Logged symptoms always show, also when they are far down the list.
  for (const s of st.log.symptoms) if (!shown.some(n => fold(n) === fold(s.name))) shown.push(s.name);
  const chips = shown.map(n => {
    const on = logged.has(fold(n));
    return `<button type="button" class="chip${on ? ' is-logged' : ''}" data-act="sym-chip" data-name="${esc(n)}" aria-pressed="${on}">${on ? ICON.check : ''}${esc(n)}</button>`;
  }).join('');
  const more = names.length > CHIPS_SHOWN
    ? `<button type="button" class="btn ghost small" data-act="sym-more" aria-expanded="${!!st.showAllSymptoms}">${st.showAllSymptoms ? 'Fewer' : 'More symptoms'}</button>` : '';
  return `<div class="chips" role="group" aria-label="Add a symptom">${chips}${more}</div>`;
}

function symptomsBody(st) {
  const list = st.log.symptoms.map((s, i) => symptomItem(st, s, i)).join('');
  return `<p class="hint">Tap a symptom to add it.</p>
    <div data-chips>${symptomChips(st)}</div>
    <form class="inline-add" data-form="add-symptom">
      <label class="sr-only" for="sym-new">Other symptom</label>
      <input id="sym-new" name="name" type="text" placeholder="Other symptom" autocomplete="off" maxlength="80">
      <button type="submit" class="btn">Add</button>
    </form>
    ${list ? `<ul class="sym-list">${list}</ul>` : ''}`;
}

export function symptomItem(st, s, i) {
  const sevId = `sev-l-${i}`, whenId = `when-l-${i}`;
  const needs = s.severity == null;
  const detail = symptomDetail(s);
  return `<li class="sym${s.severity ? ` sev-${esc(s.severity)}` : ''}" data-i="${esc(i)}" id="sym-${esc(i)}">
    <div class="sym-head">
      <h3 class="sym-name" tabindex="-1"><span class="sev-dot" aria-hidden="true"></span>${esc(s.name)}</h3>
      ${detail ? `<span class="sym-detail">${esc(detail)}</span>` : ''}
      <button type="button" class="icon-btn" data-act="del-sym" data-i="${esc(i)}" aria-label="${esc(`Remove ${s.name}`)}">${ICON.trash}</button>
    </div>
    <div class="sym-field${needs ? ' needs' : ''}">
      <span class="label-row"><span class="label" id="${esc(sevId)}">How bad?<span class="sr-only"> (${esc(s.name)})</span></span>${needs ? '<span class="hint">Not chosen yet</span>' : ''}</span>
      ${radios({ name: 'sev', i, options: SEV_OPTIONS, value: s.severity == null ? null : String(s.severity), labelId: sevId, cls: 'sev-seg' })}
    </div>
    <div class="sym-field">
      <span class="label" id="${esc(whenId)}">When?</span>
      ${radios({ name: 'when', i, options: WHEN_OPTIONS, value: s.when, labelId: whenId })}
      ${s.when === 'periods' ? `<div class="chips" role="group" aria-label="${esc(`Parts of the day with ${s.name.toLowerCase()}`)}">${PERIODS.map(p => `<button type="button" class="chip" data-act="period" data-i="${esc(i)}" data-v="${esc(p.key)}" aria-pressed="${s.periods.includes(p.key)}">${esc(p.label)}</button>`).join('')}</div>` : ''}
      ${s.when === 'time' ? `<div class="time-range">
        <label class="field"><span>From</span><input class="time" type="time" data-f="sym-from" data-i="${esc(i)}" value="${esc(s.from)}"></label>
        <label class="field"><span>To (if it stopped)</span><input class="time" type="time" data-f="sym-to" data-i="${esc(i)}" value="${esc(s.to)}"></label>
      </div>` : ''}
    </div>
    <button type="button" class="btn ghost small again" data-act="sym-again" data-i="${esc(i)}">${ICON.plus}<span>${esc(`Add ${s.name.toLowerCase()} again`)}</span></button>
  </li>`;
}

function measurementsBody(st) {
  const add = `<div class="btn-row">${Object.entries(MEASUREMENTS).map(([type, def]) => `<button type="button" class="btn small" data-act="add-measure" data-type="${esc(type)}">${ICON.plus}<span>${esc(def.label)}</span></button>`).join('')}</div>`;
  if (st.measures === 'loading') return `<p class="hint loading" role="status">Loading measurements…</p>${add}`;
  if (!Array.isArray(st.measures)) {
    return `<div class="notice is-error" role="alert">${ICON.alert}<div><p>Measurements did not load.</p>
      <button type="button" class="btn small" data-act="reload-measures">Try again</button></div></div>${add}`;
  }
  const list = st.measures.map(m => {
    const def = MEASUREMENTS[m.type];
    if (!def) return '';
    const flag = def.flag(m.value);
    const b = m.type === 'weight' ? bmi(m.value, st.heightCm) : null;
    return `<li data-id="${esc(m.id)}"><span class="grow">${esc(def.label)}<span class="sub">${esc([m.time, m.source === 'apple' ? 'Apple Health' : ''].filter(Boolean).join(' · ') || 'No time')}</span></span>
      <span class="m-val num">${esc(def.format(m.value))}${b ? `<span class="sub">BMI ${esc(b)}</span>` : ''}</span>${flag ? `<span class="pill caution">${esc(flag)}</span>` : ''}
      <button type="button" class="icon-btn" data-act="del-measure" data-id="${esc(m.id)}" aria-label="${esc(`Remove ${def.label.toLowerCase()} ${def.format(m.value)}`)}">${ICON.trash}</button></li>`;
  }).join('');
  return `${list ? `<ul class="rows m-list">${list}</ul>` : '<p class="hint">No measurements for this day.</p>'}${add}`;
}

export function page(st) {
  return `<div class="today" data-today="${esc(st.id)}">
    <div class="today-top">${header(st)}${weekStrip(st)}</div>
    ${sections(st)}
  </div>`;
}
