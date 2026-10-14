// Quick add: the "+" button opens a sheet with large tiles. Each common entry takes 1–2 taps.
// openQuickAdd(ctx, preset) opens a form directly: 'meal' | 'snack' | 'drink' | 'symptom' | 'med' | 'weight' | 'bp' | 'temp' | 'note'.
// It writes to today, or to the day the Today screen shows. The day is read fresh just before each write.
import { addDays, label, nowHm, today as todayIso } from '../core/dates.js';
import { esc, plural } from '../core/format.js';
import {
  DRINKS, MEALS, MEASUREMENTS, PERIODS, activeMeds, asNeededMeds, mealAt, medLabel, normalizeLog, normalizeProfile, periodOf,
} from '../core/schema.js';
import { ICON, closeSheet, openSheet, toast } from '../core/ui.js';
import { appendMeal, appendNote, checkMeasurement, drinkText, newSymptom, stepDrink } from './today-model.js';
import { SEV_OPTIONS, radios } from './today-view.js';
import { forgetSymptomOrder, loadSymptomOrder } from './today.js';

const TILES = [
  ['meal', 'Meal', ICON.meal], ['snack', 'Snack', ICON.snack], ['drink', 'Drink', ICON.drink],
  ['symptom', 'Symptom', ICON.symptom], ['med', 'Medication', ICON.pill], ['note', 'Note', ICON.note],
  ['weight', 'Weight', ICON.scale], ['bp', 'Blood pressure', ICON.heart], ['temp', 'Temperature', ICON.thermo],
];
const TITLES = Object.fromEntries(TILES.map(([k, l]) => [k, l]));

/** "Tue 7 Oct". */
const dayName = d => label(d).replace(',', '');

/** The day to write to: the day on the Today screen, else today. */
function targetDate(ctx) {
  const t = todayIso();
  const d = ctx.tab === 'today' && ctx.params && ctx.params.date;
  return d && d < t ? d : t;
}

export function openQuickAdd(ctx, preset) {
  const date = targetDate(ctx);
  const isToday = date === todayIso();
  const q = { ctx, date, isToday, view: 'home', busy: false, form: {} };
  q.dayLabel = isToday ? 'today' : dayName(date);
  const body = openSheet({
    title: isToday ? 'Quick add' : `Add to ${dayName(date)}`,
    html: '<div class="qa" data-qa></div>',
    onAction: (act, el, e) => safely(q, () => onAction(q, act, el, e)),
    onSubmit: form => safely(q, () => onSubmit(q, form)),
    onInput: el => onInput(q, el),
  });
  q.root = body.querySelector('[data-qa]');
  q.root.addEventListener('keydown', onKeydown);
  show(q, TITLES[preset] ? preset : 'home');
}

// ---------- Drawing

function show(q, view) {
  q.view = view;
  q.form = {};
  q.root.innerHTML = view === 'home' ? home(q) : `${back(view)}<div class="qa-body" data-qa-body>${forms[view](q)}</div>`;
  const first = q.root.querySelector('[autofocus]')
    || q.root.querySelector(view === 'home' ? '.qa-tile' : '.qa-body button')
    || q.root.querySelector('.qa-head button');
  if (first) first.focus();
  q.initialFocus = first; // loaders move focus to their content only if it is still here
  if (loaders[view]) loaders[view](q);
}

function home(q) {
  return `<p class="hint">${esc(q.isToday ? 'What do you want to add?' : `This adds to ${label(q.date, { weekday: 'long', day: 'numeric', month: 'long' })}.`)}</p>
    <div class="qa-tiles">${TILES.map(([k, l, icon]) => `<button type="button" class="qa-tile" data-act="view" data-v="${esc(k)}">${icon}<span>${esc(l)}</span></button>`).join('')}</div>`;
}

function back(view) {
  return `<div class="qa-head"><button type="button" class="icon-btn" data-act="view" data-v="home" aria-label="Back to all types">${ICON.left}</button>
    <h3>${esc(TITLES[view])}</h3></div>`;
}

const timeField = (q, value = q.isToday ? nowHm() : '') => `<label class="field"><span>Time</span>
  <input class="time" type="time" name="time" value="${esc(value)}"></label>`;
const saveBtn = (text = 'Save') => `<button type="submit" class="btn primary wide">${esc(text)}</button>`;
const loading = text => `<p class="qa-loading" role="status">${esc(text)}</p>`;

const forms = {
  meal(q) {
    const m = mealAt(nowHm());
    q.form.meal = m.key;
    return `<form class="stack" data-form="log-meal" novalidate>
      <span class="label" id="qa-meal-l">Which meal?</span>
      ${radios({ name: 'pick-meal', i: 0, options: MEALS.map(x => ({ value: x.key, label: x.label })), value: m.key, labelId: 'qa-meal-l' })}
      <p class="hint qa-already" data-already hidden></p>
      <label class="field"><span>What did you eat?</span><textarea name="text" rows="3" autofocus placeholder="Food and drink"></textarea></label>
      <p class="field-error" role="alert" data-error></p>
      ${timeField(q, q.isToday ? nowHm() : m.typical)}
      ${saveBtn()}
    </form>`;
  },
  snack(q) {
    return `<form class="stack" data-form="log-snack" novalidate>
      <label class="field"><span>What did you eat?</span><input type="text" name="text" autofocus autocomplete="off" placeholder="For example: an apple"></label>
      <p class="field-error" role="alert" data-error></p>
      ${timeField(q)}
      ${saveBtn()}
    </form>`;
  },
  drink() {
    return `<p class="hint">One tap adds one and saves.</p>
      <div class="qa-drinks">${DRINKS.map(d => `<button type="button" class="qa-tile qa-drink" data-act="drink" data-v="${esc(d.key)}">
        ${ICON.plus}<span>${esc(`1 ${d.label}`)}</span><span class="qa-now" data-now="${esc(d.key)}">&nbsp;</span></button>`).join('')}</div>`;
  },
  symptom(q) {
    const period = q.isToday ? periodOf(nowHm()) : null;
    q.form.when = period || null;
    q.form.severity = null;
    return `<form class="stack" data-form="log-symptom" novalidate>
      <span class="label" id="qa-sym-l">Which symptom?</span>
      <div class="chips" role="group" aria-labelledby="qa-sym-l" data-chips>${loading('Loading…')}</div>
      <label class="field"><span class="sr-only">Other symptom</span><input type="text" name="other" autocomplete="off" maxlength="80" placeholder="Other symptom"></label>
      <div class="sym-field needs" data-sev>
        <span class="label" id="qa-sev-l">How bad?</span>
        ${radios({ name: 'pick-sev', i: 0, options: SEV_OPTIONS, value: null, labelId: 'qa-sev-l', cls: 'sev-seg' })}
      </div>
      <span class="label" id="qa-when-l">When?</span>
      ${radios({ name: 'pick-when', i: 0, options: whenOptions(q), value: q.form.when, labelId: 'qa-when-l', cls: 'qa-when' })}
      <p class="field-error" role="alert" data-error></p>
      ${saveBtn()}
    </form>`;
  },
  med() { return `<div data-meds>${loading('Loading your medication…')}</div>`; },
  note(q) {
    return `<form class="stack" data-form="log-note" novalidate>
      <label class="field"><span>Note</span><textarea name="text" rows="4" autofocus placeholder="What do you want to remember?"></textarea></label>
      ${q.isToday ? `<p class="hint">${esc(`It is added to the notes of today with the time (${nowHm()}).`)}</p>` : ''}
      <p class="field-error" role="alert" data-error></p>
      ${saveBtn()}
    </form>`;
  },
  weight: q => measureForm(q, 'weight'),
  bp: q => measureForm(q, 'bp'),
  temp: q => measureForm(q, 'temp'),
};

function whenOptions(q) {
  return [...(q.isToday ? [{ value: 'now', label: 'Now' }] : []),
    ...PERIODS.map(p => ({ value: p.key, label: p.label })), { value: 'day', label: 'All day' }];
}

function measureForm(q, type) {
  const def = MEASUREMENTS[type];
  const fields = def.fields.map((f, i) => `<label class="field"><span>${esc(f.key === 'kg' || f.key === 'c' ? `${def.label} (${f.label})` : f.label)}${f.required ? '' : ' <span class="muted">(optional)</span>'}</span>
      <input type="text" name="${esc(f.key)}" inputmode="${f.step < 1 ? 'decimal' : 'numeric'}" autocomplete="off" aria-describedby="qa-err"${i === 0 ? ' autofocus' : ''} data-field="${esc(f.key)}"></label>`).join('');
  return `<form class="stack" data-form="log-measure" data-type="${esc(type)}" novalidate>
    <div class="qa-fields">${fields}</div>
    <p class="field-error" id="qa-err" role="alert" data-error></p>
    <p class="hint" data-last></p>
    ${timeField(q)}
    ${saveBtn()}
  </form>`;
}

// ---------- Data shown in the forms (loaded after the form is on screen)

const loaders = {
  async meal(q) {
    const log = await dayLog(q);
    q.form.log = log;
    showAlready(q);
  },
  async drink(q) {
    const log = await dayLog(q);
    if (!log || q.view !== 'drink') return;
    for (const d of DRINKS) {
      const el = q.root.querySelector(`[data-now="${d.key}"]`);
      if (el) el.textContent = `Now: ${drinkText(d, log.drinks[d.key]).toLowerCase()}`;
    }
  },
  async symptom(q) {
    const names = await loadSymptomOrder(q.ctx.api);
    const box = q.view === 'symptom' && q.root.querySelector('[data-chips]');
    if (!box) return;
    box.innerHTML = names.slice(0, 10).map(n => `<button type="button" class="chip" data-act="pick-sym" data-v="${esc(n)}" aria-pressed="false">${esc(n)}</button>`).join('');
    if (document.activeElement === q.initialFocus) box.querySelector('button').focus();
  },
  async med(q) {
    const box = q.root.querySelector('[data-meds]');
    let profile, log;
    try {
      [profile, log] = await Promise.all([q.ctx.api.getProfile().then(normalizeProfile), dayLog(q, true)]);
    } catch (e) {
      if (q.view === 'med') box.innerHTML = `<div class="notice is-error" role="alert">${ICON.alert}<div><p>${esc(`Your medication did not load. ${e.message}`)}</p>
        <button type="button" class="btn small" data-act="view" data-v="med">Try again</button></div></div>`;
      return;
    }
    if (q.view !== 'med') return;
    const due = activeMeds(profile, q.date).filter(m => !(log.meds.taken[m.id] || {}).done);
    const prn = asNeededMeds(profile, q.date);
    const item = (act, m, sub) => `<button type="button" class="btn" data-act="${act}" data-v="${esc(m.id)}">${act === 'tick' ? ICON.check : ICON.plus}
      <span>${esc(m.name)}${sub ? `<span class="sub"> · ${esc(sub)}</span>` : ''}</span></button>`;
    box.innerHTML = `<div class="stack">
      ${activeMeds(profile, q.date).length ? `<span class="label">Regular medication</span>
        ${due.length ? `<div class="qa-list">${due.map(m => item('tick', m, m.dose)).join('')}</div>` : '<p class="hint">All regular medication is ticked for this day.</p>'}` : ''}
      ${prn.length ? `<span class="label">As needed</span><div class="qa-list">${prn.map(m => item('prn', m, m.dose)).join('')}</div>` : ''}
      <form class="stack" data-form="log-med" novalidate>
        <label class="field"><span>Other medication</span><input type="text" name="name" autocomplete="off" placeholder="Name and dose"></label>
        <p class="field-error" role="alert" data-error></p>
        <button type="submit" class="btn">Add</button>
      </form>
    </div>`;
    q.form.profile = profile;
    // Focus moves to the list only if the user has not moved on yet.
    const first = box.querySelector('button, input');
    if (first && (document.activeElement === q.initialFocus || !q.root.contains(document.activeElement))) first.focus();
  },
  async weight(q) { return lastValue(q, 'weight'); },
  async bp(q) { return lastValue(q, 'bp'); },
  async temp(q) { return lastValue(q, 'temp'); },
};

async function lastValue(q, type) {
  try {
    const list = await q.ctx.api.listMeasurements(type, addDays(q.date, -365), q.date);
    const last = list[list.length - 1];
    const el = q.view === type && q.root.querySelector('[data-last]');
    if (last && el) el.textContent = `Last: ${MEASUREMENTS[type].format(last.value)} on ${label(last.date, { day: 'numeric', month: 'short' })}.`;
  } catch (e) { /* only a hint */ }
}

/** The day's log for hints. `strict`: throw on error instead of returning null. */
async function dayLog(q, strict) {
  try { return normalizeLog((await q.ctx.api.getDay(q.date)).log); } catch (e) { if (strict) throw e; return null; }
}

function showAlready(q) {
  const el = q.root.querySelector('[data-already]');
  if (!el || !q.form.log) return;
  const m = q.form.log.meals[q.form.meal];
  const def = MEALS.find(x => x.key === q.form.meal);
  el.hidden = !m.text;
  el.textContent = m.text ? `${def.label} already has: “${m.text}”. Your text is added to it.` : '';
}

// ---------- Saving

/** Saves pending edits of the screen, reads the day fresh, changes it, saves it.
 *  message: text, or a function of the changed log. */
async function commitLog(q, mutate, message) {
  const { ctx, date } = q;
  if (ctx.screen && ctx.screen.leave) {
    const ok = await ctx.screen.leave(ctx);
    if (ok === false) throw new Error('Your last change is not saved yet. Check the connection, then try again.');
  }
  const log = normalizeLog((await ctx.api.getDay(date)).log);
  mutate(log);
  await ctx.api.saveLog(date, log);
  finish(q, typeof message === 'function' ? message(log) : message);
}

function finish(q, message) {
  closeSheet();
  toast(message);
  if (['today', 'body'].includes(q.ctx.tab)) q.ctx.refresh();
}

const where = q => (q.isToday ? 'today' : q.dayLabel);
const now = q => (q.isToday ? nowHm() : '');

async function safely(q, fn) {
  if (q.busy) return;
  q.busy = true;
  q.root.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || 'Something went wrong.', { tone: 'error' });
  } finally {
    q.busy = false;
    if (q.root.isConnected) q.root.removeAttribute('aria-busy');
  }
}

function fieldError(q, text, field) {
  const el = q.root.querySelector('[data-error]');
  if (el) el.textContent = text || '';
  q.root.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
  if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
}

async function onAction(q, act, el) {
  switch (act) {
    case 'view': show(q, el.dataset.v); return;
    case 'drink': {
      const d = DRINKS.find(x => x.key === el.dataset.v);
      await commitLog(q, log => { log.drinks[d.key] = stepDrink(log.drinks[d.key], 1); },
        log => `${d.label}: ${plural(log.drinks[d.key], d.one, d.many)} ${q.isToday ? 'today' : `on ${q.dayLabel}`}`);
      return;
    }
    case 'pick-meal':
      setRadio(el);
      q.form.meal = el.dataset.v;
      showAlready(q);
      return;
    case 'pick-sev':
      setRadio(el);
      q.form.severity = Number(el.dataset.v);
      el.closest('[data-sev]').classList.remove('needs');
      el.closest('[data-sev]').querySelector('.label').textContent = 'How bad';
      return;
    case 'pick-when': setRadio(el); q.form.when = el.dataset.v; return;
    case 'pick-sym': {
      const on = el.getAttribute('aria-pressed') !== 'true';
      q.root.querySelectorAll('[data-act="pick-sym"]').forEach(c => c.setAttribute('aria-pressed', 'false'));
      el.setAttribute('aria-pressed', String(on));
      q.form.symptom = on ? el.dataset.v : null;
      if (on) q.root.querySelector('[name="other"]').value = '';
      fieldError(q, '');
      return;
    }
    case 'tick': {
      const m = q.form.profile.medications.find(x => x.id === el.dataset.v);
      const time = now(q);
      await commitLog(q, log => { log.meds.taken[m.id] = { done: true, time }; },
        time ? `${m.name}: taken at ${time}` : `${m.name}: taken on ${q.dayLabel}`);
      return;
    }
    case 'prn': {
      const m = q.form.profile.medications.find(x => x.id === el.dataset.v);
      await commitLog(q, log => { log.meds.extra.push({ name: medLabel(m), time: now(q) }); }, `${m.name} added to ${where(q)}`);
      return;
    }
    default:
  }
}

function setRadio(el) {
  el.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]').forEach(r => {
    const on = r === el;
    r.setAttribute('aria-checked', String(on));
    r.setAttribute('tabindex', on ? '0' : '-1');
  });
}

async function onSubmit(q, form) {
  const v = name => (form.elements[name] ? form.elements[name].value.trim() : '');
  switch (form.dataset.form) {
    case 'log-meal': {
      const text = v('text');
      if (!text) return fieldError(q, 'Write what you ate.', form.elements.text);
      const key = q.form.meal;
      const def = MEALS.find(x => x.key === key);
      return commitLog(q, log => {
        const m = log.meals[key];
        log.meals[key] = { time: m.time || v('time'), text: appendMeal(m.text, text) };
      }, `${def.label} added to ${where(q)}`);
    }
    case 'log-snack': {
      const text = v('text');
      if (!text) return fieldError(q, 'Write what you ate.', form.elements.text);
      return commitLog(q, log => { log.snacks.push({ time: v('time'), text }); }, `Snack added to ${where(q)}`);
    }
    case 'log-note': {
      const text = v('text');
      if (!text) return fieldError(q, 'Write a note first.', form.elements.text);
      return commitLog(q, log => { log.notes = appendNote(log.notes, text, now(q)); }, `Note added to ${where(q)}`);
    }
    case 'log-symptom': {
      const name = v('other') || q.form.symptom;
      if (!name) return fieldError(q, 'Choose a symptom or write one.', q.root.querySelector('[data-act="pick-sym"]') || form.elements.other);
      const s = newSymptom(name, null);
      s.severity = q.form.severity;
      const w = q.form.when;
      if (w === 'day') s.when = 'day';
      else if (w === 'now') Object.assign(s, { when: 'time', from: nowHm() });
      else if (w) Object.assign(s, { when: 'periods', periods: [w] });
      await commitLog(q, log => { log.symptoms.push(s); }, `${name} added to ${where(q)}`);
      forgetSymptomOrder();
      return undefined;
    }
    case 'log-med': {
      const name = v('name');
      if (!name) return fieldError(q, 'Write the name of the medication.', form.elements.name);
      return commitLog(q, log => { log.meds.extra.push({ name, time: now(q) }); }, `${name} added to ${where(q)}`);
    }
    case 'log-measure': {
      const type = form.dataset.type;
      const def = MEASUREMENTS[type];
      const raw = Object.fromEntries(def.fields.map(f => [f.key, v(f.key)]));
      const res = checkMeasurement(type, raw);
      if (res.error) return fieldError(q, res.error, form.elements[res.field || def.fields[0].key]);
      await q.ctx.api.addMeasurement({ type, date: q.date, time: v('time'), value: res.value });
      const flag = def.flag(res.value);
      finish(q, `${def.label} saved: ${def.format(res.value)}${flag ? `. ${flag}` : ''}`);
      return undefined;
    }
    default: return undefined;
  }
}

function onInput(q, el) {
  if (el.name === 'other' && el.value) {
    q.root.querySelectorAll('[data-act="pick-sym"]').forEach(c => c.setAttribute('aria-pressed', 'false'));
    q.form.symptom = null;
  }
  if (el.getAttribute('aria-invalid') === 'true') { el.removeAttribute('aria-invalid'); const e = q.root.querySelector('[data-error]'); if (e) e.textContent = ''; }
}

/** Radio groups in the sheet: arrows move and select. */
function onKeydown(e) {
  const t = e.target;
  if (t.getAttribute('role') !== 'radio') return;
  const all = [...t.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')];
  const i = all.indexOf(t);
  const n = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  let j = n ? (i + n + all.length) % all.length : null;
  if (e.key === 'Home') j = 0;
  if (e.key === 'End') j = all.length - 1;
  if (j == null) return;
  e.preventDefault();
  all[j].focus();
  all[j].click();
}
