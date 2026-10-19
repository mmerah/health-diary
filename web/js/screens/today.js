// Today: the day log. A slim Apple Health row, then collapsible sections with one-line summaries.
// Edits save automatically (autosave.js). Templates are in today-view.js, pure helpers in today-model.js.
import { api } from '../api/index.js';
import { createAutosave } from '../core/autosave.js';
import { addDays, nowHm, today as todayIso } from '../core/dates.js';
import { fold, listJoin } from '../core/format.js';
import { MEALS, activeMeds, asNeededMeds, hasContent, medLabel, normalizeLog, normalizeProfile, periodOf, symptomChips } from '../core/schema.js';
import { session } from '../core/session.js';
import { store, toast } from '../core/ui.js';
import {
  changedSections, clampDate, correctHealth, defaultOpen, mergeLog, newSymptom, saveMerging, stepDrink,
  symptomChipList, weekDays, healthPatch,
} from './today-model.js';
import { bodyOf, chipsHtml, emptyOf, healthSection, mealChipsHtml, page, summaryOf, symptomItem, weekStrip } from './today-view.js';

const WIDE = '(min-width: 1000px)';

// ---------- Versions: each day's log has a version on the server. A save sends the version it
// started from; if another device saved in between, saveMerging() merges section by section.

const bases = new Map(); // date → { version, log } as last loaded or saved
const baseKey = () => `log-bases-${session.uid}`;
function loadBases() {
  if (bases.size) return;
  for (const [d, b] of store.get(baseKey(), [])) bases.set(d, b);
}
/** Keep the bases of days with unsaved edits in this browser, so a merge also works after a reload. */
function persistBases() {
  store.set(baseKey(), [...bases].filter(([d]) => saver.has(d) || (st && st.date === d)));
}
function setBase(date, version, log) {
  bases.set(date, { version, log: structuredClone(log) });
  persistBases();
}

async function saveDay(date, log) {
  loadBases();
  const base = bases.get(date) || null;
  const r = await saveMerging((d, l, v) => api.saveLog(d, l, v), date, log, base);
  setBase(date, r.version, r.log);
  if (r.merged) afterMerge(date, log, r.log, r.conflicts);
}

/** Shows the merged day: sections changed here since the save keep the newest typing. */
function afterMerge(date, sent, merged, conflicts) {
  if (isLive(st) && st.date === date) {
    const before = st.log;
    st.log = mergeLog(sent, before, merged).log;
    const rows = new Set(changedSections(before, st.log).map(path => (path[0] === 'meals' ? path[1] : path[0])));
    rows.forEach(k => redraw(k));
    if (rows.has('symptoms')) redrawChips();
    if (JSON.stringify(st.log) !== JSON.stringify(merged)) saver.queue(date, st.log);
  } else if (saver.has(date) && saver.get(date) !== sent) {
    saver.queue(date, mergeLog(sent, saver.get(date), merged).log);
  }
  toast(conflicts.length
    ? `Merged with changes from another device. Your version was kept for: ${listJoin(conflicts)}.`
    : 'Merged with changes from another device.', { ms: 6000 });
}

const saver = createAutosave('log', saveDay);

let st = null;              // state of the day on display
const pending = new Map();  // render id → state, until mounted
let seq = 0;
let openMemory = { date: null, wide: null, keys: new Set() }; // open sections, kept while on the same day
let flashHealthNext = false; // after a sync, highlight the health row once
let mq = null;              // the wide-screen media query, to switch layouts

// ---------- Chips learnt from the last 60 days. Symptoms: the user's own list (Profile → Settings), then
// up to 3 names used that are not in it. Meals: the texts typed most often (recentMeals).
// Only the days are cached, so a list edit shows at once.

let recentCache = null, recentTo = null;
export function loadRecentDays(a = api) {
  const to = todayIso();
  if (!recentCache || recentTo !== to) {
    recentTo = to;
    recentCache = a.listDays(addDays(to, -60), to).catch(e => { recentCache = null; console.error(e); return []; });
  }
  return recentCache;
}
export async function loadSymptomOrder(a = api) {
  return symptomChipList(symptomChips(), await loadRecentDays(a));
}
/** Quick add calls this after it logs a symptom or a meal, so the chips learn it. */
export function forgetSymptomOrder() { recentCache = null; }

/** Saves a log of another day than the one on display (Undo after a day change, quick add). */
export async function saveOtherDay(date, change) {
  await saver.flush();
  loadBases();
  const day = await api.getDay(date);
  const pendingLog = saver.has(date) ? saver.get(date) : null;
  const log = normalizeLog(pendingLog || day.log);
  if (!pendingLog) setBase(date, day.logVersion, normalizeLog(day.log));
  change(log);
  await saveDay(date, log);
}

// ---------- Render

async function weekHasOf(week) {
  const list = await api.listDays(week[0], week[6]).catch(() => []);
  return Object.fromEntries((list || []).map(d => [d.date, hasContent(saver.has(d.date) ? saver.get(d.date) : d.log)]));
}

async function render(ctx, params = {}) {
  loadBases();
  const today = todayIso();
  const date = clampDate(params.date, today);
  const week = weekDays(date);
  const wide = window.matchMedia(WIDE).matches;
  const [day, profile, weekHas] = await Promise.all([
    api.getDay(date),
    api.getProfile().then(normalizeProfile).catch(e => { console.error(e); return null; }),
    weekHasOf(week),
  ]);
  // A change that is not saved yet (offline) wins over the server copy; its base stays the one it started from.
  const unsaved = saver.has(date);
  const log = normalizeLog(unsaved ? saver.get(date) : day.log);
  if (!unsaved || !bases.has(date)) setBase(date, day.logVersion, normalizeLog(day.log));
  if (openMemory.date !== date || openMemory.wide !== wide) {
    openMemory = { date, wide, keys: defaultOpen(log, { isToday: date === today, now: nowHm(), wide }) };
  }
  weekHas[date] = hasContent(log);

  const state = {
    id: String(++seq), ctx, date, today, isToday: date === today, week, weekHas, log, wide,
    health: day.health || null,
    profileError: !profile,
    heightCm: profile && profile.heightCm,
    scheduled: profile ? activeMeds(profile, date) : [],
    asNeeded: profile ? asNeededMeds(profile, date) : [],
    canSync: !!(api.can && api.can.sync),
    measures: 'loading',
    symptomNames: symptomChips().slice(),
    showAllSymptoms: false,
    healthForm: false,
    editTime: null,
    open: openMemory.keys,
    recentDays: null,
  };
  pending.clear();
  pending.set(state.id, state);
  return page(state);
}

function mounted(ctx) {
  const root = ctx.view.querySelector('[data-today]');
  st = pending.get(root.dataset.today);
  pending.clear();
  st.root = root;
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('focusout', onFocusout);
  setupSwipe(root);
  sizeStages(root);
  // Phone and desktop have different DOM orders: draw again when the width crosses the line.
  if (!mq) {
    mq = window.matchMedia(WIDE);
    mq.addEventListener('change', () => { if (isLive(st) && st.ctx.tab === 'today') st.ctx.refresh(); });
  }
  loadMeasures();
  if (flashHealthNext) { flashHealthNext = false; flash(root.querySelector('.tsec-health')); }
  loadSymptomOrder().then(names => {
    if (!st || st.root !== root) return;
    st.symptomNames = names;
    redrawChips();
  });
  loadRecentDays().then(days => {
    if (!st || st.root !== root) return;
    st.recentDays = days;
    for (const m of MEALS) redrawMealChips(m.key);
  });
}

/** Saves pending edits. Quick add also calls it before it writes, so it must not change the screen. */
function leave() {
  return saver.flush();
}

// ---------- Helpers

const isLive = s => s && s.root && s.root.isConnected;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Navigates to a day. Today is stored as null, so the Today tab and the sheet agree. */
function goDay(ctx, date) {
  const d = clampDate(date, st.today);
  return ctx.go('today', { date: d === st.today ? null : d });
}

/** The log changed: queue the save, refresh the summary of the given sections, and the week dot. */
function changed(...keys) {
  saver.queue(st.date, st.log);
  for (const k of keys) updateSummary(k);
  const dot = st.root.querySelector(`.wd[data-date="${st.date}"] .wd-dot`);
  if (dot) dot.classList.toggle('on', hasContent(st.log));
}

function updateSummary(key) {
  const el = st.root.querySelector(`[data-sum="${key}"]`);
  if (!el) return;
  const text = summaryOf(st, key);
  el.textContent = text || emptyOf(st, key);
  el.classList.toggle('is-empty', !text);
}

/** A key that identifies a control across a redraw, to give focus back to it. */
const focusKey = el => (el && el.dataset ? ['act', 'f', 'i', 'id', 'key', 'v', 'd', 'meal', 'name'].map(k => el.dataset[k] || '').join('|') : '');

/** Draws a section body again, keeping focus on the same control when it still exists. */
function redraw(key, focusSel) {
  const region = st.root.querySelector(`#tr-${key}`);
  if (!region) return;
  const active = region.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  region.innerHTML = bodyOf(st, key);
  updateSummary(key);
  let target = focusSel ? region.querySelector(focusSel) : null;
  if (!target && active) target = [...region.querySelectorAll('button, input, textarea')].find(x => focusKey(x) === active);
  if (target) target.focus({ preventScroll: !focusSel });
}

/** Meal chips show only while the meal is empty. */
function redrawMealChips(key) {
  const box = isLive(st) && st.root.querySelector(`[data-meal-chips="${key}"]`);
  if (!box) return;
  box.innerHTML = mealChipsHtml(st, key);
  box.hidden = !box.innerHTML;
}

function redrawChips() {
  const box = isLive(st) && st.root.querySelector('[data-chips]');
  if (!box) return;
  const active = box.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  box.innerHTML = chipsHtml(st);
  if (active) { const t = [...box.querySelectorAll('button')].find(x => focusKey(x) === active); if (t) t.focus(); }
}

/** Health changes the row itself too: draw the whole section again. */
function redrawHealth(focusSel) {
  const old = st.root.querySelector('[data-sec="health"]');
  const tmp = document.createElement('div');
  tmp.innerHTML = healthSection(st);
  const fresh = tmp.firstElementChild;
  old.replaceWith(fresh);
  sizeStages(fresh);
  if (focusSel) { const t = fresh.querySelector(focusSel); if (t) t.focus(); }
}

/** A short highlight that says "done" where the change happened. */
function flash(el) {
  if (!el) return;
  el.classList.remove('is-flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 1000);
}

function setOpen(key, open) {
  const rowEl = st.root.querySelector(`[data-row="${key}"]`);
  if (!rowEl) return;
  const btn = rowEl.querySelector(`#tb-${key}`);
  const region = rowEl.querySelector(`#tr-${key}`);
  btn.setAttribute('aria-expanded', String(open));
  region.hidden = !open;
  rowEl.classList.toggle('is-open', open);
  if (open) st.open.add(key); else st.open.delete(key);
}

/** Sleep stage bar: widths come from data, set through the CSSOM (no inline style attributes). */
function sizeStages(root) {
  root.querySelectorAll('.stage[data-share]').forEach(s => { s.style.flexGrow = s.dataset.share; });
}

/** Runs a callback outside main.js's dispatcher (undo, timers) and reports its error. */
async function safely(fn) {
  try { await fn(); } catch (e) { console.error(e); toast(e.message || 'Something went wrong.', { tone: 'error' }); }
}

/**
 * Changes a day's log. The day on display is changed in place; another day is read fresh,
 * changed and saved (used by Undo after the user moved to another day).
 */
async function changeDay(date, fn, key) {
  if (isLive(st) && st.date === date) {
    fn(st.log);
    changed(key);
    if (key === 'symptoms') redrawChips();
    redraw(key);
    return;
  }
  await saveOtherDay(date, fn);
}

/** Removes item i of a list in the log, with a 5-second "Undo". */
function removeWithUndo(key, getList, i, message) {
  const date = st.date;
  const [item] = getList(st.log).splice(i, 1);
  changed(key);
  if (key === 'symptoms') redrawChips();
  redraw(key);
  const region = st.root.querySelector(`#tr-${key}`);
  const next = region.querySelector(`[data-act^="del"][data-i="${Math.min(i, getList(st.log).length - 1)}"]`)
    || region.querySelector('[data-act^="add"], input, button');
  if (next) next.focus();
  toast(message, { action: { label: 'Undo', run: () => safely(() => changeDay(date, log => {
    const list = getList(log);
    list.splice(Math.min(i, list.length), 0, item);
  }, key)) } });
}

// ---------- Measurements of the day (async, with loading and error states)

async function loadMeasures() {
  const mine = st;
  mine.measures = 'loading';
  try {
    mine.measures = await api.listMeasurements('', mine.date, mine.date);
  } catch (e) {
    console.error(e);
    mine.measures = e;
  }
  if (st === mine && isLive(mine)) redraw('measurements');
}

// ---------- Week strip: ‹ › buttons, swipe and Page Up/Down show another week without
// leaving the day on display; a tap on a day opens it. "Last Tuesday" = 2 taps.

async function showWeek(delta) {
  const mine = st;
  const anchor = addDays(mine.week[0], 7 * delta);
  if (anchor > mine.today) return;
  mine.week = weekDays(anchor);
  Object.assign(mine.weekHas, await weekHasOf(mine.week));
  mine.weekHas[mine.date] = hasContent(mine.log);
  if (st !== mine || !isLive(mine)) return;
  const old = mine.root.querySelector('.week');
  const hadFocus = old.contains(document.activeElement) ? document.activeElement : null;
  const tmp = document.createElement('div');
  tmp.innerHTML = weekStrip(mine);
  old.replaceWith(tmp.firstElementChild);
  if (hadFocus) {
    const same = hadFocus.dataset.act === 'week' && mine.root.querySelector(`.week [data-act="week"][data-step="${hadFocus.dataset.step}"]:not(:disabled)`);
    (same || mine.root.querySelector('.wd[tabindex="0"]')).focus();
  }
}

let swipedAt = 0;
function setupSwipe(root) {
  let start = null;
  root.addEventListener('pointerdown', e => { if (e.isPrimary && e.target.closest('.week-days')) start = { x: e.clientX, y: e.clientY }; });
  root.addEventListener('pointercancel', () => { start = null; });
  root.addEventListener('pointerup', e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    swipedAt = Date.now();
    safely(() => showWeek(dx < 0 ? 1 : -1));
  });
}

/** A time field (medication taken) closes when focus leaves it. */
function onFocusout(e) {
  if (!e.target.classList.contains('med-time-input') || !isLive(st)) return;
  const key = st.editTime;
  setTimeout(() => {
    if (!isLive(st) || st.editTime !== key) return;
    st.editTime = null;
    redraw('meds');
  }, 0);
}

function onKeydown(e) {
  const t = e.target;
  // Radio groups (severity, when): arrows move and select, Home/End jump.
  if (t.getAttribute('role') === 'radio') {
    const radios = [...t.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')];
    const i = radios.indexOf(t);
    const n = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let j = null;
    if (n) j = (i + n + radios.length) % radios.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = radios.length - 1;
    if (j == null) return;
    e.preventDefault();
    radios[j].click();
    return;
  }
  if (t.classList.contains('wd')) {
    const days = [...st.root.querySelectorAll('.wd:not([disabled])')];
    const i = days.indexOf(t);
    const n = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    let j = null;
    if (n) j = i + n;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = days.length - 1;
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      safely(() => showWeek(e.key === 'PageDown' ? 1 : -1));
      return;
    }
    if (j == null || j < 0 || j >= days.length) return;
    e.preventDefault();
    days.forEach(d => d.setAttribute('tabindex', '-1'));
    days[j].setAttribute('tabindex', '0');
    days[j].focus();
  }
}

// ---------- Radios after a change: update in place so focus stays

function setRadios(group, value) {
  group.querySelectorAll('[role="radio"]').forEach(r => {
    const on = r.dataset.v === value;
    r.setAttribute('aria-checked', String(on));
    r.setAttribute('tabindex', on ? '0' : '-1');
  });
}

function redrawSymptom(i, focusSel) {
  const li = st.root.querySelector(`#sym-${i}`);
  if (!li) return redraw('symptoms');
  const active = li.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  const tmp = document.createElement('ul');
  tmp.innerHTML = symptomItem(st, st.log.symptoms[i], i);
  const fresh = tmp.firstElementChild;
  li.replaceWith(fresh);
  let target = focusSel ? fresh.querySelector(focusSel) : null;
  if (!target && active) target = [...fresh.querySelectorAll('button, input')].find(x => focusKey(x) === active);
  if (target) target.focus();
  updateSummary('symptoms');
  return fresh;
}

function addSymptom(name, after) {
  const s = newSymptom(name, st.isToday ? periodOf(nowHm()) : null);
  const i = after == null ? st.log.symptoms.length : after + 1;
  st.log.symptoms.splice(i, 0, s);
  changed('symptoms');
  redraw('symptoms');
  redrawChips();
  const li = st.root.querySelector(`#sym-${i}`);
  if (li) {
    li.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
    const first = li.querySelector('.sev-seg [role="radio"]');
    if (first) first.focus({ preventScroll: true });
    flash(li);
  }
}

// ---------- Actions ([data-act] clicks)

const actions = {
  'pick-date'() {
    const input = st.root.querySelector('.date-input');
    try {
      if (input.showPicker) { input.showPicker(); return; }
    } catch (e) { /* not allowed here: fall back */ }
    input.focus();
    input.click();
  },
  day(el, e, ctx) { return goDay(ctx, addDays(st.date, Number(el.dataset.step))); },
  'go-today'(el, e, ctx) { return ctx.go('today', { date: null }); },
  week(el) { return showWeek(Number(el.dataset.step)); },
  'edit-symptoms'(el, e, ctx) { return ctx.go('profile', { view: 'settings' }); },
  'edit-time'(el) {
    st.editTime = el.dataset.key;
    redraw('meds', '.med-time-input');
  },
  pick(el, e, ctx) {
    if (Date.now() - swipedAt < 400) return undefined; // the tap ended a swipe
    if (el.dataset.date === st.date) return undefined;
    return goDay(ctx, el.dataset.date);
  },
  toggle(el) {
    const key = el.dataset.key;
    setOpen(key, el.getAttribute('aria-expanded') !== 'true');
  },
  reload(el, e, ctx) { return ctx.refresh(); },
  'open-profile'(el, e, ctx) { return ctx.go('profile'); },

  // Drinks: one full-width row each, − and + buttons.
  drink(el) {
    const key = el.dataset.key;
    st.log.drinks[key] = stepDrink(st.log.drinks[key], Number(el.dataset.d));
    changed('drinks');
    redraw('drinks');
    flash(st.root.querySelector(`[data-drink="${key}"]`));
  },

  'add-snack'() {
    st.log.snacks.push({ time: st.isToday ? nowHm() : '', text: '' });
    changed('snacks');
    redraw('snacks', `.snack:last-child input[data-f="snack-text"]`);
  },
  'del-snack'(el) {
    const i = Number(el.dataset.i);
    const s = st.log.snacks[i];
    removeWithUndo('snacks', l => l.snacks, i, s.text ? `Snack removed: ${s.text}` : 'Snack removed');
  },
  'add-prn'(el) {
    const m = st.asNeeded.find(x => x.id === el.dataset.id);
    if (!m) return;
    st.log.meds.extra.push({ name: medLabel(m), time: st.isToday ? nowHm() : '' });
    changed('meds');
    redraw('meds');
    flash(st.root.querySelector('.extra:last-child'));
  },
  'del-extra'(el) {
    const i = Number(el.dataset.i);
    const name = st.log.meds.extra[i].name;
    removeWithUndo('meds', l => l.meds.extra, i, name ? `Removed: ${name}` : 'Medication removed');
  },

  // Symptoms
  'sym-chip'(el) {
    const name = el.dataset.name;
    const i = st.log.symptoms.findIndex(s => fold(s.name) === fold(name));
    if (i < 0) return addSymptom(name);
    // Already logged: go to it instead of adding a duplicate.
    const li = st.root.querySelector(`#sym-${i}`);
    li.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    li.querySelector('.sym-name').focus({ preventScroll: true });
    flash(li);
    return undefined;
  },
  'sym-more'() {
    st.showAllSymptoms = !st.showAllSymptoms;
    redrawChips();
    const more = st.root.querySelector('[data-act="sym-more"]');
    if (more) more.focus();
  },
  'sym-again'(el) { addSymptom(st.log.symptoms[Number(el.dataset.i)].name, Number(el.dataset.i)); },
  'del-sym'(el) {
    const i = Number(el.dataset.i);
    removeWithUndo('symptoms', l => l.symptoms, i, `Removed: ${st.log.symptoms[i].name}`);
  },
  sev(el) {
    const i = Number(el.dataset.i);
    st.log.symptoms[i].severity = Number(el.dataset.v);
    changed('symptoms');
    redrawSymptom(i, `[data-act="sev"][data-v="${el.dataset.v}"]`);
  },
  when(el) {
    const i = Number(el.dataset.i);
    const s = st.log.symptoms[i];
    const v = el.dataset.v;
    if (s.when === v) { setRadios(el.parentElement, v); return; }
    s.when = v;
    if (v === 'periods' && !s.periods.length && st.isToday) s.periods = [periodOf(nowHm())];
    if (v === 'time' && !s.from && st.isToday) s.from = nowHm();
    changed('symptoms');
    redrawSymptom(i, `[data-act="when"][data-v="${v}"]`);
  },
  period(el) {
    const i = Number(el.dataset.i);
    const s = st.log.symptoms[i];
    const p = el.dataset.v;
    s.periods = s.periods.includes(p) ? s.periods.filter(x => x !== p) : [...s.periods, p];
    changed('symptoms');
    redrawSymptom(i, `[data-act="period"][data-v="${p}"]`);
  },

  // Meals: a chip fills an empty meal with a text the user often types.
  'use-meal'(el) {
    const key = el.dataset.meal;
    const meal = st.log.meals[key];
    if (!meal || meal.text.trim()) return;
    meal.text = el.dataset.text;
    if (st.isToday && !meal.time) meal.time = nowHm();
    changed(key);
    redraw(key);
    // Focus goes to the row, not to the text: on a phone the keyboard stays closed.
    st.root.querySelector(`#tb-${key}`).focus();
    flash(st.root.querySelector(`[data-row="${key}"]`));
  },

  // Health
  async sync(el, e, ctx) {
    el.disabled = true;
    el.setAttribute('aria-busy', 'true');
    const label = el.querySelector('span');
    if (label) label.textContent = 'Syncing…';
    try {
      const done = await api.sync();
      if (!done) return; // iPhone: the shortcut opens and the page changes
      flashHealthNext = true;
      await ctx.refresh();
    } catch (err) {
      el.disabled = false;
      el.removeAttribute('aria-busy');
      if (label) label.textContent = 'Sync again';
      throw new Error(`Sync failed. ${err.message}`);
    }
  },
  'health-edit'(el) {
    st.healthForm = !st.healthForm;
    if (st.healthForm) setOpen('health', true);
    redrawHealth(st.healthForm ? '#health-form input' : '[data-act="health-edit"]');
  },

  // Measurements (stored apart from the log)
  'add-measure'(el, e, ctx) { return ctx.quickAdd(el.dataset.type); },
  'reload-measures'() { return loadMeasures(); },
  async 'del-measure'(el) {
    const id = Number(el.dataset.id) || el.dataset.id;
    const m = st.measures.find(x => String(x.id) === String(el.dataset.id));
    if (!m) return;
    el.disabled = true;
    try { await api.deleteMeasurement(id); } catch (err) { el.disabled = false; throw new Error(`Not removed. ${err.message}`); }
    const mine = st;
    mine.measures = mine.measures.filter(x => x !== m);
    redraw('measurements', '[data-act="add-measure"]');
    toast(`Removed: ${m.type === 'bp' ? 'blood pressure' : m.type === 'temp' ? 'temperature' : 'weight'}`, {
      action: { label: 'Undo', run: () => safely(async () => {
        await api.addMeasurement({ type: m.type, date: m.date, time: m.time || '', value: m.value });
        if (st === mine && isLive(mine)) await loadMeasures();
      }) },
    });
  },
};

// ---------- Forms

const forms = {
  'add-symptom'(form) {
    const input = form.elements.name;
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    input.value = '';
    const i = st.log.symptoms.findIndex(s => fold(s.name) === fold(name));
    if (i >= 0) { actions['sym-chip']({ dataset: { name } }); return; }
    addSymptom(name);
  },
  'add-extra'(form) {
    const input = form.elements.name;
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    st.log.meds.extra.push({ name, time: st.isToday ? nowHm() : '' });
    changed('meds');
    redraw('meds', '#extra-new');
    flash(st.root.querySelector('.extra:last-child'));
  },
  async health(form) {
    const err = form.querySelector('[data-error="health"]');
    const values = Object.fromEntries(['sleepH', 'sleepM', 'bed', 'wake', 'steps', 'restingHr', 'hrv', 'spo2', 'spo2Min', 'respiratoryRate'].map(k => [k, form.elements[k].value.trim()]));
    const date = st.date;
    const fresh = (await api.getDay(date)).health; // the latest copy, in case a sync came in
    const res = correctHealth(fresh, values);
    if (res.error) { err.textContent = res.error; return; }
    err.textContent = '';
    // Send only what changed. The server merges it into the newest data, so a sync in between is kept.
    const patch = healthPatch(fresh, res.next);
    const merged = Object.keys(patch).length ? await api.patchHealth(date, patch) : fresh;
    if (st.date !== date || !isLive(st)) return;
    st.health = merged;
    st.healthForm = false;
    redrawHealth('[data-act="health-edit"]');
    flash(st.root.querySelector('.tsec-health'));
  },
};

// ---------- Typing (input and change events)

function input(el) {
  if (!isLive(st)) return;
  const f = el.dataset.f;
  if (!f) return;
  const l = st.log;
  const i = Number(el.dataset.i);
  switch (f) {
    case 'date':
      if (el.value && el.value !== st.date) goDay(st.ctx, el.value);
      return;
    case 'meal-text': {
      const meal = l.meals[el.dataset.meal];
      // The first letters in an empty meal on today also set the time.
      if (st.isToday && !meal.text && !meal.time && el.value.trim()) {
        meal.time = nowHm();
        const t = st.root.querySelector(`[data-f="meal-time"][data-meal="${el.dataset.meal}"]`);
        if (t) t.value = meal.time;
      }
      const wasEmpty = !meal.text.trim();
      meal.text = el.value;
      if (wasEmpty !== !meal.text.trim()) redrawMealChips(el.dataset.meal);
      return changed(el.dataset.meal);
    }
    case 'meal-time': l.meals[el.dataset.meal].time = el.value; return changed(el.dataset.meal);
    case 'snack-text': l.snacks[i].text = el.value; return changed('snacks');
    case 'snack-time': l.snacks[i].time = el.value; return changed('snacks');
    case 'extra-name': l.meds.extra[i].name = el.value; return changed('meds');
    case 'extra-time': l.meds.extra[i].time = el.value; return changed('meds');
    case 'med-time': {
      const t = l.meds.taken[el.dataset.id];
      if (t) t.time = el.value;
      return changed('meds');
    }
    case 'activities': case 'notes': l[f] = el.value; return changed(f);
    case 'sym-from': l.symptoms[i].from = el.value; return changed('symptoms');
    case 'sym-to': l.symptoms[i].to = el.value; return changed('symptoms');
    case 'med': {
      const id = el.dataset.id;
      // Ticking stores the time (today); unticking clears it.
      l.meds.taken[id] = el.checked ? { done: true, time: st.isToday ? nowHm() : '' } : { done: false, time: '' };
      changed('meds');
      redraw('meds');
      flash(st.root.querySelector(`.med[data-id="${CSS.escape(id)}"]`));
      return undefined;
    }
    default: return undefined;
  }
}

export default { render, mounted, leave, actions, forms, input };
