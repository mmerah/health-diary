// Profile → Settings → "My lists": the user's symptoms, document types, measurements and counters.
// Each change saves at once with ctx.saveCatalog (it also applies the change to the whole app).
import { esc, plural } from '../core/format.js';
import { COUNTER_PRESETS, DOC_CATEGORIES, getCatalog, MEASUREMENT_PRESETS } from '../core/schema.js';
import { closeSheet, confirmTwice, ICON, openSheet, toast } from '../core/ui.js';
import {
  docTypeError, docTypeUse, hasCounterPreset, hasMeasurementPreset, moveItem, parseCounterForm, parseMeasurementForm,
  presetToCounter, presetToMeasurement, symptomError,
} from './profile-catalog.js';

const SECTIONS = [['sym', 'Symptoms'], ['doc', 'Document types'], ['meas', 'Measurements'], ['cnt', 'Counters']];

const copy = () => structuredClone(getCatalog());
const unitText = u => (u ? (u.startsWith('/') ? u : ` ${u}`) : '');
const rangeText = m => (m.low != null && m.high != null ? `Normal ${m.low}–${m.high}${unitText(m.unit)}`
  : m.low != null ? `Normal from ${m.low}${unitText(m.unit)}` : m.high != null ? `Normal up to ${m.high}${unitText(m.unit)}` : 'No normal range');

// ---------- Sections

function symSection(c) {
  const n = c.symptoms.length;
  return `<p class="hint">These are the one-tap buttons on the Today screen, in this order. You can still write any other symptom there.</p>
    <ul class="rows list-edit">${c.symptoms.map((s, i) => `<li><span class="grow">${esc(s)}</span>
      <button type="button" class="icon-btn icon-up" data-act="sym-move" data-i="${i}" data-d="-1" aria-label="Move ${esc(s)} up"${i === 0 ? ' disabled' : ''}>${ICON.down}</button>
      <button type="button" class="icon-btn" data-act="sym-move" data-i="${i}" data-d="1" aria-label="Move ${esc(s)} down"${i === n - 1 ? ' disabled' : ''}>${ICON.down}</button>
      <button type="button" class="icon-btn" data-act="sym-remove" data-i="${i}" aria-label="Remove ${esc(s)}">${ICON.x}</button></li>`).join('')
      || '<li class="hint">No buttons. Add a symptom below.</li>'}</ul>
    <form class="inline-add" data-form="sym-add" novalidate>
      <label class="sr-only" for="sym-new">New symptom</label>
      <input id="sym-new" name="name" type="text" maxlength="100" placeholder="New symptom" autocomplete="off">
      <button type="submit" class="btn small">${ICON.plus}Add</button>
    </form>`;
}

function docSection(c) {
  const builtIn = DOC_CATEGORIES.map(t => {
    const hidden = c.docTypes.hidden.includes(t);
    return `<li><span class="grow">${esc(t)}<span class="sub">${t === 'Other' ? 'Always shown' : hidden ? 'Hidden' : 'Shown'}</span></span>
      ${t === 'Other' ? '' : `<button type="button" class="btn small" data-act="doc-type-toggle" data-name="${esc(t)}" aria-label="${hidden ? 'Show' : 'Hide'} ${esc(t)}">${hidden ? 'Show' : 'Hide'}</button>`}</li>`;
  }).join('');
  const own = c.docTypes.custom.map((t, i) => `<li><span class="grow">${esc(t)}<span class="sub">Your type</span></span>
      <button type="button" class="icon-btn" data-act="doc-type-rename" data-i="${i}" aria-label="Rename ${esc(t)}">${ICON.edit}</button>
      <button type="button" class="icon-btn" data-act="doc-type-remove" data-i="${i}" aria-label="Remove ${esc(t)}">${ICON.trash}</button></li>`).join('');
  return `<p class="hint">The types you can choose for a document. Hidden types are not offered. Documents keep the type they have.</p>
    <ul class="rows list-edit">${builtIn}${own}</ul>
    <form class="inline-add" data-form="doc-type-add" novalidate>
      <label class="sr-only" for="doc-type-new">New document type</label>
      <input id="doc-type-new" name="name" type="text" maxlength="60" placeholder="New type, for example Dentist" autocomplete="off">
      <button type="submit" class="btn small">${ICON.plus}Add</button>
    </form>`;
}

function hideDeleteButtons(kind, x) {
  return `<button type="button" class="btn small" data-act="${kind}-hide" data-id="${esc(x.id)}" aria-label="${x.hidden ? 'Show' : 'Hide'} ${esc(x.name)}">${x.hidden ? 'Show' : 'Hide'}</button>
    <button type="button" class="icon-btn" data-act="${kind}-edit" data-id="${esc(x.id)}" aria-label="Edit ${esc(x.name)}">${ICON.edit}</button>
    <button type="button" class="icon-btn" data-act="${kind}-delete" data-id="${esc(x.id)}" aria-label="Delete ${esc(x.name)}">${ICON.trash}</button>`;
}

function measSection(c) {
  const fixed = ['Weight', 'Blood pressure', 'Temperature'].map(n => `<li><span class="grow">${esc(n)}<span class="sub">Always shown</span></span></li>`).join('');
  const own = c.measurements.map(m => `<li class="${m.hidden ? 'is-hidden' : ''}"><span class="grow">${esc(m.name)}${m.unit ? ` <span class="muted">(${esc(m.unit)})</span>` : ''}
      <span class="sub">${esc(rangeText(m))}${m.hidden ? ' · Hidden' : ''}</span></span>
      <span class="list-btns">${hideDeleteButtons('meas', m)}</span></li>`).join('');
  const presets = MEASUREMENT_PRESETS.map((p, i) => {
    const added = hasMeasurementPreset(c, p);
    return `<button type="button" class="chip" data-act="meas-preset" data-i="${i}"${added ? ' disabled aria-label="' + esc(`${p.name} ${p.unit}`) + ', added"' : ''}>${added ? ICON.check : ICON.plus}${esc(p.name)}${p.unit ? ` <span class="muted">${esc(p.unit)}</span>` : ''}</button>`;
  }).join('');
  return `<p class="hint">Your own measurements appear in Quick add and in Trends. Values outside the normal range are marked. Hide keeps a measurement out of the way. Delete removes it from the lists: your values stay in your diary but are no longer shown.</p>
    <ul class="rows list-edit">${fixed}${own}</ul>
    <p class="label">Add in one tap</p>
    <div class="chips">${presets}</div>
    <div class="btn-row"><button type="button" class="btn small" data-act="meas-own">${ICON.plus}Own measurement…</button></div>`;
}

function cntSection(c) {
  const fixed = ['Water', 'Coffee', 'Alcohol'].map(n => `<li><span class="grow">${esc(n)}<span class="sub">Always shown</span></span></li>`).join('');
  const own = c.counters.map(x => `<li class="${x.hidden ? 'is-hidden' : ''}"><span class="grow">${esc(x.name)}
      <span class="sub">1 ${esc(x.one)}, 2 ${esc(x.many)}${x.hidden ? ' · Hidden' : ''}</span></span>
      <span class="list-btns">${hideDeleteButtons('cnt', x)}</span></li>`).join('');
  const presets = COUNTER_PRESETS.map((p, i) => {
    const added = hasCounterPreset(c, p);
    return `<button type="button" class="chip" data-act="cnt-preset" data-i="${i}"${added ? ' disabled' : ''}>${added ? ICON.check : ICON.plus}${esc(p.name)}</button>`;
  }).join('');
  return `<p class="hint">Counters are the plus and minus buttons on the Today screen, for example cups of tea. Delete removes a counter from the lists: your values stay in your diary but are no longer shown. Hide is often better.</p>
    <ul class="rows list-edit">${fixed}${own}</ul>
    <p class="label">Add in one tap</p>
    <div class="chips">${presets}</div>
    <div class="btn-row"><button type="button" class="btn small" data-act="cnt-own">${ICON.plus}Own counter…</button></div>`;
}

const BODY = { sym: symSection, doc: docSection, meas: measSection, cnt: cntSection };

function sectionSummary(key, c) {
  if (key === 'sym') return plural(c.symptoms.length, 'button');
  if (key === 'doc') return plural(DOC_CATEGORIES.length - c.docTypes.hidden.length + c.docTypes.custom.length, 'type');
  if (key === 'meas') return plural(3 + c.measurements.filter(m => !m.hidden).length, 'measurement');
  return plural(3 + c.counters.filter(x => !x.hidden).length, 'counter');
}

function sectionHtml(key, title, c) {
  return `<details class="settings-more list-section" data-section="${key}">
    <summary>${esc(title)} <span class="muted list-count">${esc(sectionSummary(key, c))}</span></summary>
    <div class="stack">${BODY[key](c)}<p class="field-error" id="lists-${key}-error" role="alert"></p></div>
  </details>`;
}

export function listsCard() {
  const c = getCatalog();
  return `<section class="card form-card settings-card" id="set-lists" aria-labelledby="set-lists-title">
    <h2 id="set-lists-title">My lists</h2>
    <p class="hint">Choose the symptoms, document types, measurements and counters that you use.</p>
    <div id="lists-body">${SECTIONS.map(([k, t]) => sectionHtml(k, t, c)).join('')}</div>
  </section>`;
}

/** Draws one section again after a change and keeps the focus near the same place. */
function redraw(key, focusSel) {
  const el = document.querySelector(`#lists-body [data-section="${key}"]`);
  if (!el) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = sectionHtml(key, SECTIONS.find(s => s[0] === key)[1], getCatalog());
  const fresh = tmp.firstElementChild;
  fresh.open = el.open;
  el.replaceWith(fresh);
  const target = focusSel && document.querySelector(`#lists-body [data-section="${key}"] ${focusSel}`);
  (target && !target.disabled ? target : document.querySelector(`#lists-body [data-section="${key}"] summary`))?.focus();
}

/** Saves the catalog; on error shows the server's message in the section and throws nothing more. */
async function save(ctx, key, next, focusSel) {
  const err = document.getElementById(`lists-${key}-error`);
  if (err) err.textContent = '';
  try { await ctx.saveCatalog(next); } catch (e) {
    if (err) err.textContent = `Not saved. ${e.message}`;
    return false;
  }
  redraw(key, focusSel);
  return true;
}

// ---------- Sheets for own measurements and counters

const numField = (name, label, v, hint = '') => `<div class="field"><label class="label" for="cat-${name}">${esc(label)}</label>
  <input id="cat-${name}" name="${name}" type="text" inputmode="decimal" autocomplete="off" value="${esc(v ?? '')}">${hint ? `<p class="hint">${esc(hint)}</p>` : ''}</div>`;

function measSheet(ctx, m) {
  const v = m || { name: '', unit: '', low: null, high: null, min: 0, max: 100, step: 1 };
  openSheet({
    title: m ? `Edit ${m.name}` : 'Own measurement',
    html: `<form class="stack" novalidate>
      <div class="grid2">
        <div class="field"><label class="label" for="cat-name">Name</label><input id="cat-name" name="name" type="text" maxlength="60" value="${esc(v.name)}" autocomplete="off" autofocus></div>
        <div class="field"><label class="label" for="cat-unit">Unit</label><input id="cat-unit" name="unit" type="text" maxlength="20" value="${esc(v.unit)}" placeholder="Example: mmol/L" autocomplete="off"></div>
      </div>
      <fieldset class="cat-group"><legend class="label">Normal range (optional)</legend>
        <p class="hint">Values outside this range are marked. Leave a box empty if there is no limit on that side.</p>
        <div class="grid2">${numField('low', 'From', v.low)}${numField('high', 'To', v.high)}</div></fieldset>
      <fieldset class="cat-group"><legend class="label">Values you can write</legend>
        <div class="grid2">${numField('min', 'Lowest', v.min)}${numField('max', 'Highest', v.max)}</div>
        ${numField('step', 'Step', v.step, 'Use 1 for whole numbers, or 0.1 for one decimal.')}</fieldset>
      <p class="field-error" id="cat-error" role="alert"></p>
      <div class="btn-row"><button type="submit" class="btn primary">${m ? 'Save' : 'Add measurement'}</button>
        <button type="button" class="btn ghost" data-sheet-close>Cancel</button></div>
    </form>`,
    async onSubmit(form) {
      const r = parseMeasurementForm(Object.fromEntries(new FormData(form)));
      const err = form.querySelector('#cat-error');
      form.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
      if (r.error) { err.textContent = r.error; const f = form[r.field]; if (f) { f.setAttribute('aria-invalid', 'true'); f.focus(); } return; }
      const next = copy();
      if (m) Object.assign(next.measurements.find(x => x.id === m.id), r.value);
      else next.measurements.push({ ...presetToMeasurement(r.value, next) });
      try { await ctx.saveCatalog(next); } catch (e) { err.textContent = `Not saved. ${e.message}`; return; }
      closeSheet();
      redraw('meas');
      toast(m ? 'Measurement saved' : `${r.value.name} added`);
    },
  });
}

function cntSheet(ctx, x) {
  const v = x || { name: '', one: '', many: '' };
  openSheet({
    title: x ? `Edit ${x.name}` : 'Own counter',
    html: `<form class="stack" novalidate>
      <div class="field"><label class="label" for="cat-name">Name</label><input id="cat-name" name="name" type="text" maxlength="40" value="${esc(v.name)}" placeholder="Example: Tea" autocomplete="off" autofocus></div>
      <div class="grid2">
        <div class="field"><label class="label" for="cat-one">Word for one</label><input id="cat-one" name="one" type="text" maxlength="20" value="${esc(v.one)}" placeholder="cup" autocomplete="off"></div>
        <div class="field"><label class="label" for="cat-many">Word for more</label><input id="cat-many" name="many" type="text" maxlength="20" value="${esc(v.many)}" placeholder="cups" autocomplete="off"></div>
      </div>
      <p class="hint">The Today screen then says “1 cup”, “2 cups”.</p>
      <p class="field-error" id="cat-error" role="alert"></p>
      <div class="btn-row"><button type="submit" class="btn primary">${x ? 'Save' : 'Add counter'}</button>
        <button type="button" class="btn ghost" data-sheet-close>Cancel</button></div>
    </form>`,
    async onSubmit(form) {
      const r = parseCounterForm(Object.fromEntries(new FormData(form)));
      const err = form.querySelector('#cat-error');
      if (r.error) { err.textContent = r.error; form[r.field]?.focus(); return; }
      const next = copy();
      if (x) Object.assign(next.counters.find(y => y.id === x.id), r.value);
      else next.counters.push(presetToCounter(r.value, next));
      try { await ctx.saveCatalog(next); } catch (e) { err.textContent = `Not saved. ${e.message}`; return; }
      closeSheet();
      redraw('cnt');
      toast(x ? 'Counter saved' : `${r.value.name} added`);
    },
  });
}

function renameSheet(ctx, i, count) {
  const old = getCatalog().docTypes.custom[i];
  openSheet({
    title: `Rename ${old}`,
    html: count
      ? `<p>${esc(plural(count, 'document'))} use this type. You cannot rename a type that is in use.</p>
        <p class="hint">Add a new type instead. Then change the type of these documents in Records.</p>
        <div class="btn-row"><button type="button" class="btn" data-sheet-close>OK</button></div>`
      : `<form class="stack" novalidate>
        <div class="field"><label class="label" for="cat-name">New name</label><input id="cat-name" name="name" type="text" maxlength="60" value="${esc(old)}" autocomplete="off" autofocus></div>
        <p class="field-error" id="cat-error" role="alert"></p>
        <div class="btn-row"><button type="submit" class="btn primary">Save</button><button type="button" class="btn ghost" data-sheet-close>Cancel</button></div>
      </form>`,
    async onSubmit(form) {
      const next = copy();
      const name = form.name.value.trim();
      const e = docTypeError(name, next, { except: old });
      const err = form.querySelector('#cat-error');
      if (e) { err.textContent = e; form.name.focus(); return; }
      next.docTypes.custom[i] = name;
      try { await ctx.saveCatalog(next); } catch (x) { err.textContent = `Not saved. ${x.message}`; return; }
      closeSheet();
      redraw('doc');
      toast('Type renamed');
    },
  });
}

// ---------- Handlers

const byId = (list, id) => list.find(x => x.id === id);

function hideToggle(kind, listKey) {
  return async (el, e, ctx) => {
    const next = copy();
    const x = byId(next[listKey], el.dataset.id);
    if (!x) throw new Error('This item is no longer in the list.');
    x.hidden = !x.hidden;
    if (await save(ctx, kind, next, `[data-act="${kind}-hide"][data-id="${CSS.escape(x.id)}"]`)) toast(x.hidden ? `${x.name} is hidden` : `${x.name} is shown`);
  };
}

function deleter(kind, listKey) {
  return async (el, e, ctx) => {
    const next = copy();
    const x = byId(next[listKey], el.dataset.id);
    if (!x) throw new Error('This item is no longer in the list.');
    if (!confirmTwice(el, 'Tap again to delete')) return;
    next[listKey] = next[listKey].filter(y => y.id !== x.id);
    if (await save(ctx, kind, next)) toast(`${x.name} deleted. Your values stay in your diary but are no longer shown.`, { ms: 6000 });
  };
}

export const listsActions = {
  async 'sym-move'(el, e, ctx) {
    const i = Number(el.dataset.i), d = Number(el.dataset.d);
    const next = copy();
    next.symptoms = moveItem(next.symptoms, i, d);
    await save(ctx, 'sym', next, `[data-act="sym-move"][data-i="${i + d}"][data-d="${d}"]`);
  },
  async 'sym-remove'(el, e, ctx) {
    const i = Number(el.dataset.i);
    const next = copy();
    const [gone] = next.symptoms.splice(i, 1);
    if (await save(ctx, 'sym', next, '#sym-new')) {
      toast(`${gone} removed`, { action: { label: 'Undo', run: async () => {
        const back = copy();
        back.symptoms.splice(i, 0, gone);
        try { await ctx.saveCatalog(back); redraw('sym'); } catch (x) { toast(`Not saved. ${x.message}`, { tone: 'error' }); }
      } } });
    }
  },
  async 'doc-type-toggle'(el, e, ctx) {
    const name = el.dataset.name;
    const next = copy();
    const h = new Set(next.docTypes.hidden);
    if (h.has(name)) h.delete(name); else h.add(name);
    next.docTypes.hidden = [...h];
    await save(ctx, 'doc', next, `[data-act="doc-type-toggle"][data-name="${CSS.escape(name)}"]`);
  },
  async 'doc-type-rename'(el, e, ctx) {
    const i = Number(el.dataset.i);
    const type = getCatalog().docTypes.custom[i];
    let count = 0;
    try { count = docTypeUse(await ctx.api.listDocuments(), type); } catch (x) {
      throw new Error(`Cannot check if documents use this type. ${x.message}`);
    }
    renameSheet(ctx, i, count);
  },
  async 'doc-type-remove'(el, e, ctx) {
    const i = Number(el.dataset.i);
    const next = copy();
    const name = next.docTypes.custom[i];
    if (!confirmTwice(el, 'Tap again to remove')) return;
    next.docTypes.custom.splice(i, 1);
    if (await save(ctx, 'doc', next, '#doc-type-new')) toast(`${name} removed. Documents with this type keep it.`);
  },
  async 'meas-preset'(el, e, ctx) {
    const p = MEASUREMENT_PRESETS[Number(el.dataset.i)];
    const next = copy();
    if (hasMeasurementPreset(next, p)) return;
    next.measurements.push(presetToMeasurement(p, next));
    if (await save(ctx, 'meas', next, '[data-act="meas-own"]')) toast(`${p.name} added. Add values with Quick add.`);
  },
  'meas-own'(el, e, ctx) { measSheet(ctx, null); },
  'meas-edit'(el, e, ctx) {
    const m = byId(getCatalog().measurements, el.dataset.id);
    if (!m) throw new Error('This measurement is no longer in the list.');
    measSheet(ctx, m);
  },
  'meas-hide': hideToggle('meas', 'measurements'),
  'meas-delete': deleter('meas', 'measurements'),
  async 'cnt-preset'(el, e, ctx) {
    const p = COUNTER_PRESETS[Number(el.dataset.i)];
    const next = copy();
    if (hasCounterPreset(next, p)) return;
    next.counters.push(presetToCounter(p, next));
    if (await save(ctx, 'cnt', next, '[data-act="cnt-own"]')) toast(`${p.name} added to the Today screen`);
  },
  'cnt-own'(el, e, ctx) { cntSheet(ctx, null); },
  'cnt-edit'(el, e, ctx) {
    const x = byId(getCatalog().counters, el.dataset.id);
    if (!x) throw new Error('This counter is no longer in the list.');
    cntSheet(ctx, x);
  },
  'cnt-hide': hideToggle('cnt', 'counters'),
  'cnt-delete': deleter('cnt', 'counters'),
};

export const listsForms = {
  async 'sym-add'(form, e, ctx) {
    const next = copy();
    const name = form.name.value.trim();
    const err = symptomError(name, next.symptoms);
    if (err) { document.getElementById('lists-sym-error').textContent = err; form.name.focus(); return; }
    next.symptoms.push(name);
    if (await save(ctx, 'sym', next, '#sym-new')) toast(`${name} added`);
  },
  async 'doc-type-add'(form, e, ctx) {
    const next = copy();
    const name = form.name.value.trim();
    const err = docTypeError(name, next);
    if (err) { document.getElementById('lists-doc-error').textContent = err; form.name.focus(); return; }
    next.docTypes.custom.push(name);
    if (await save(ctx, 'doc', next, '#doc-type-new')) toast(`${name} added`);
  },
};
