// Profile → "My health": about you, medical history, and the medication editor.
// The whole profile autosaves (createAutosave); leaving the screen flushes it.
import { fullLabel, isValidDate, today as todayIso } from '../core/dates.js';
import { esc } from '../core/format.js';
import { createAutosave } from '../core/autosave.js';
import { medLabel, newId, normalizeProfile } from '../core/schema.js';
import { closeSheet, ICON, openSheet, toast } from '../core/ui.js';
import { medStatus, parseHeight, parseMedForm, sortMeds } from './profile-account.js';
import { mergeProfile } from './profile-merge.js';

const KEY = 'profile';
let saver = null;
let P = null;    // the profile being edited (live)
let base = null; // { version, profile }: the newest server copy the edits build on
let ours = new Set(); // versions written by this device since `base` last came from the server

const SEXES = [['', 'Not set'], ['Female', 'Female'], ['Male', 'Male'], ['Intersex', 'Intersex'], ['Prefer not to say', 'Prefer not to say']];
const HISTORY = [
  ['conditions', 'Conditions and diagnoses', 'Example: Asthma (since childhood)'],
  ['allergies', 'Allergies', 'Example: Penicillin (rash)'],
  ['surgeries', 'Surgeries and hospital stays', 'Example: Appendectomy (2009)'],
  ['familyHistory', 'Family history', 'Example: Father: high blood pressure'],
  ['lifestyle', 'Lifestyle and other notes', 'Example: Non-smoker. Office job.'],
];

/**
 * Loads the profile. Edits not saved yet (from an earlier visit) win over the server copy.
 * The queued value carries the version it started from: { profile, baseVersion, base }.
 */
export async function loadProfile(ctx) {
  if (!saver) saver = createAutosave(KEY, (_, entry) => saveVersioned(ctx.api, entry));
  if (saver.has(KEY)) {
    const entry = saver.get(KEY);
    P = normalizeProfile(entry.profile);
    base = entry.base ? { version: entry.baseVersion, profile: entry.base } : null;
    ours = new Set();
  } else {
    const raw = await ctx.api.getProfile();
    const version = raw && raw.version != null ? raw.version : null; // non-enumerable: read it before copying
    P = normalizeProfile(raw);
    base = { version, profile: structuredClone(P) };
    ours = new Set([version]);
  }
  return P;
}

export const flushProfile = () => (saver ? saver.flush() : Promise.resolve());
const queue = () => saver.queue(KEY, { profile: P, baseVersion: base ? base.version : null, base: base ? base.profile : null });

/**
 * Saves with the version the edits started from. On 409 (another device saved in between):
 * merge field by field, save again once with the new version, and tell the user.
 */
async function saveVersioned(api, entry) {
  const sent = normalizeProfile(entry.profile);
  let baseVersion = entry.baseVersion;
  let baseCopy = entry.base;
  // Newer versions written by this device only: this entry is simply newer, build on the latest.
  if (base && baseVersion != null && ours.has(baseVersion)) { baseVersion = base.version; baseCopy = base.profile; }
  let toSave = sent, merged = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await api.saveProfile(toSave, baseVersion == null ? undefined : baseVersion);
      const version = r && r.version != null ? r.version : null;
      base = { version, profile: structuredClone(toSave) };
      ours.add(version);
      break;
    } catch (e) {
      if (e.status !== 409 || !e.data || attempt > 0) throw e;
      const theirs = normalizeProfile(e.data.profile);
      toSave = mergeProfile(baseCopy && normalizeProfile(baseCopy), sent, theirs);
      baseVersion = e.data.version;
      baseCopy = theirs;
      ours = new Set([e.data.version]);
      merged = true;
    }
  }
  if (merged) {
    // Keep edits made while saving: three-way merge of the live copy onto the merged result.
    P = normalizeProfile(mergeProfile(sent, P, toSave));
    redrawFields();
    toast('Merged with changes from another device.');
  }
}

/** After a merge: show the new values, but do not touch the field the user is typing in. */
function redrawFields() {
  document.querySelectorAll('[data-pfield]').forEach(el => {
    if (el === document.activeElement) return;
    const v = P[el.dataset.pfield];
    el.value = v == null ? '' : String(v);
  });
  redrawMeds();
}

// ---------- Rendering

function textField(key, label, { type = 'text', hint = '', attrs = '' } = {}) {
  const id = `p-${key}`;
  return `<div class="field"><label class="label" for="${id}">${esc(label)}</label>
    <input id="${id}" type="${type}" data-pfield="${key}" value="${esc(P[key] ?? '')}"${hint ? ` aria-describedby="${id}-hint"` : ''} ${attrs}>
    ${hint ? `<p class="hint" id="${id}-hint">${esc(hint)}</p>` : ''}
    <p class="field-error" id="${id}-error" role="alert"></p></div>`;
}

function aboutCard() {
  return `<section class="card form-card" aria-labelledby="about-title">
    <h2 id="about-title">About you</h2>
    ${textField('name', 'Name', { hint: 'Shown in doctor reports only. Reports for an AI never show it.', attrs: 'autocomplete="name" maxlength="200"' })}
    <div class="grid2">
      ${textField('dob', 'Date of birth', { type: 'date', attrs: `max="${todayIso()}"` })}
      <div class="field"><label class="label" for="p-sex">Sex</label>
        <select id="p-sex" data-pfield="sex">${SEXES.map(([v, l]) => `<option value="${esc(v)}"${(P.sex || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      ${textField('heightCm', 'Height (cm)', { type: 'number', attrs: 'inputmode="numeric" min="50" max="250" step="1"' })}
    </div>
    ${textField('ethnicity', 'Ethnicity', { attrs: 'maxlength="100"' })}
  </section>`;
}

function historyCard() {
  return `<section class="card form-card" aria-labelledby="history-title">
    <h2 id="history-title">Medical history</h2>
    <p class="hint">Write one item on each line.</p>
    ${HISTORY.map(([key, label, ph]) => `<div class="field"><label class="label" for="p-${key}">${esc(label)}</label>
      <textarea id="p-${key}" rows="3" data-pfield="${key}" maxlength="5000" placeholder="${esc(ph)}">${esc(P[key] || '')}</textarea></div>`).join('')}
  </section>`;
}

function medRow(m, today) {
  const status = medStatus(m, today);
  const when = [
    m.asNeeded ? 'As needed' : 'Every day',
    status === 'planned' ? `Starts ${fullLabel(m.since)}` : m.since ? `Since ${fullLabel(m.since)}` : '',
    status === 'stopped' ? `Stopped ${fullLabel(m.until)}` : m.until ? `Until ${fullLabel(m.until)}` : '',
  ].filter(Boolean).join(' · ');
  const name = medLabel(m);
  return `<li class="med-row${status === 'stopped' ? ' is-stopped' : ''}">
    <span class="med-icon" aria-hidden="true">${ICON.pill}</span>
    <span class="grow"><strong class="med-name">${esc(m.name)}</strong>${m.dose ? `<span class="med-dose">${esc(m.dose)}</span>` : ''}
      <span class="sub">${esc(when)}</span></span>
    <span class="med-actions">
      ${status !== 'stopped' ? `<button type="button" class="btn small" data-act="med-stop" data-id="${esc(m.id)}" aria-label="Stop ${esc(name)} today">Stop</button>` : ''}
      <button type="button" class="icon-btn" data-act="med-edit" data-id="${esc(m.id)}" aria-label="Edit ${esc(name)}">${ICON.edit}</button>
      <button type="button" class="icon-btn" data-act="med-delete" data-id="${esc(m.id)}" aria-label="Delete ${esc(name)}">${ICON.trash}</button>
    </span></li>`;
}

export function medList() {
  const today = todayIso();
  const { current, stopped } = sortMeds(P.medications, today);
  return `${current.length
    ? `<ul class="rows med-list">${current.map(m => medRow(m, today)).join('')}</ul>`
    : `<div class="empty med-empty">${ICON.pill}<p>No medication yet. Add the medication you take every day, and the medication you take only when you need it.</p></div>`}
    ${stopped.length ? `<details class="med-stopped"><summary>Stopped medication (${stopped.length})</summary>
      <ul class="rows med-list">${stopped.map(m => medRow(m, today)).join('')}</ul></details>` : ''}`;
}

function medsCard() {
  return `<section class="card form-card" aria-labelledby="meds-title">
    <div class="card-head"><h2 id="meds-title">Medication</h2>
      <button type="button" class="btn small" data-act="med-add">${ICON.plus}Add medication</button></div>
    <p class="hint">Medication you take every day becomes a checklist on the Today screen. Medication you take “as needed” becomes a quick button there.</p>
    <div id="med-list">${medList()}</div>
  </section>`;
}

export function healthView(ctx) {
  return `${ctx.api.isDemo ? `<div class="notice is-caution">${ICON.info}<div><p>This is sample data. Do not enter real health data in the demo.</p></div></div>` : ''}
    <div class="profile-grid">
      <div class="profile-col">${aboutCard()}${medsCard()}</div>
      <div class="profile-col">${historyCard()}</div>
    </div>`;
}

function redrawMeds() {
  const el = document.getElementById('med-list');
  if (el) el.innerHTML = medList();
}

// ---------- Medication sheet

function medForm(m) {
  const v = m || { name: '', dose: '', since: '', until: '', asNeeded: false };
  return `<form class="stack med-form" novalidate>
    <div class="field"><label class="label" for="med-name">Name</label>
      <input id="med-name" name="name" type="text" maxlength="200" value="${esc(v.name)}" autocomplete="off" required autofocus></div>
    <div class="field"><label class="label" for="med-dose">Dose and when</label>
      <input id="med-dose" name="dose" type="text" maxlength="100" value="${esc(v.dose)}" placeholder="Example: 300 mg, evening" autocomplete="off"></div>
    <label class="check switch"><input type="checkbox" role="switch" name="asNeeded"${v.asNeeded ? ' checked' : ''}>
      <span>As needed<span class="hint switch-hint">Only when you need it, for example for pain.</span></span></label>
    <div class="grid2">
      <div class="field"><label class="label" for="med-since">Since</label><input id="med-since" name="since" type="date" value="${esc(v.since)}"></div>
      <div class="field"><label class="label" for="med-until">Until</label><input id="med-until" name="until" type="date" value="${esc(v.until)}"></div>
    </div>
    <p class="hint">Leave the dates empty if you do not know them.</p>
    <p class="field-error" id="med-error" role="alert"></p>
    <div class="btn-row"><button type="submit" class="btn primary">${m ? 'Save changes' : 'Add medication'}</button>
      <button type="button" class="btn ghost" data-sheet-close>Cancel</button></div>
  </form>`;
}

function openMedSheet(id) {
  const m = id ? P.medications.find(x => x.id === id) : null;
  if (id && !m) throw new Error('This medication is no longer in the list.');
  openSheet({
    title: m ? `Edit ${m.name}` : 'Add medication',
    html: medForm(m),
    onSubmit(form) {
      const fd = new FormData(form);
      const r = parseMedForm({ name: fd.get('name'), dose: fd.get('dose'), since: fd.get('since'), until: fd.get('until'), asNeeded: fd.get('asNeeded') === 'on' });
      form.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
      if (r.error) {
        form.querySelector('#med-error').textContent = r.error;
        const f = form.querySelector(`[name="${r.field}"]`);
        if (f) { f.setAttribute('aria-invalid', 'true'); f.focus(); }
        return;
      }
      if (m) Object.assign(m, r.value);
      else P.medications.push({ id: newId('m'), ...r.value });
      queue();
      closeSheet();
      redrawMeds();
      toast(m ? 'Medication saved' : 'Medication added');
    },
  });
}

// ---------- Handlers

export const healthActions = {
  'med-add'() { openMedSheet(null); },
  'med-edit'(el) { openMedSheet(el.dataset.id); },
  'med-stop'(el) {
    const m = P.medications.find(x => x.id === el.dataset.id);
    if (!m) throw new Error('This medication is no longer in the list.');
    const before = m.until;
    m.until = todayIso();
    queue();
    redrawMeds();
    toast(`${m.name} stopped today`, { action: { label: 'Undo', run: () => { m.until = before; queue(); redrawMeds(); } } });
    document.querySelector('[data-act="med-add"]')?.focus();
  },
  'med-delete'(el) {
    const i = P.medications.findIndex(x => x.id === el.dataset.id);
    if (i < 0) throw new Error('This medication is no longer in the list.');
    const [m] = P.medications.splice(i, 1);
    queue();
    redrawMeds();
    toast(`${m.name} deleted`, { action: { label: 'Undo', run: () => { P.medications.splice(i, 0, m); queue(); redrawMeds(); } } });
    document.querySelector('[data-act="med-add"]')?.focus();
  },
};

/** Text, select and date fields of the profile. Returns true when it handled the event. */
export function healthInput(el) {
  const key = el.dataset.pfield;
  if (!key || !P) return false;
  const err = document.getElementById(`${el.id}-error`);
  const fail = msg => { el.setAttribute('aria-invalid', 'true'); if (err) err.textContent = msg; };
  el.removeAttribute('aria-invalid');
  if (err) err.textContent = '';
  if (key === 'heightCm') {
    const h = parseHeight(el.value);
    if (h === undefined) {
      // Do not complain while the user is still typing "17…".
      if (el.value.trim().length >= 3) fail('Enter your height in centimetres, from 50 to 250.');
      return true;
    }
    P.heightCm = h;
  } else if (key === 'dob') {
    if (el.value && (!isValidDate(el.value) || el.value > todayIso())) { fail('Enter a valid date in the past.'); return true; }
    P.dob = el.value;
  } else {
    P[key] = el.value;
  }
  queue();
  return true;
}
