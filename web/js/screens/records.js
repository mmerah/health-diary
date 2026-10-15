// Records tab: medical documents in one list, from two sources:
//   - the diary's own store (source 'diary'): the user adds a PDF or photo, the server reads the text;
//   - Paperless (source 'paperless'), when it is connected.
// The list loads after the screen shows. Documents being read are polled until they are ready.
import { fullLabel, isValidDate, today as todayIso } from '../core/dates.js';
import { esc, num, plural } from '../core/format.js';
import { DOC_CATEGORIES } from '../core/schema.js';
import { closeSheet, confirmTwice, ICON, openSheet, toast } from '../core/ui.js';
import {
  categoriesOf, changedFields, excludedList, excludedSet, filterDocs, MAX_PAGES, MAX_UPLOAD_MB, NO_TYPE, sourcesOf, suggestionDiff,
  untypedCount, uploadError,
} from './records-data.js';

let st = null; // { docs, excluded: Set<string>, query, category, source, paperlessError, paperless }
let loadSeq = 0;
const polls = new Map(); // id → timer
const POLL_MS = 2000, POLL_MAX = 300; // about 10 minutes

const $ = id => document.getElementById(id);
const isDiary = d => d.source === 'diary';
const docById = id => st && st.docs.find(d => String(d.id) === String(id));
const FIELD_WORDS = { category: 'Type', date: 'Date', title: 'Title' };
const fieldText = (k, v) => (k === 'date' && isValidDate(v) ? fullLabel(v) : String(v));

// ---------- States

function setBody(html, busy = false) {
  const el = $('records-body');
  if (!el) return;
  el.setAttribute('aria-busy', String(busy));
  el.innerHTML = html;
}

const loadingHtml = `<div class="empty records-loading" role="status">${ICON.sync}<p>Loading your documents…</p></div>`;

function errorHtml(message) {
  return `<div class="notice is-error" role="alert">${ICON.alert}<div><strong>Could not load your documents.</strong>
    <p>${esc(message)}</p>
    <div class="btn-row"><button type="button" class="btn" data-act="retry">Try again</button></div></div></div>`;
}

function emptyHtml(ctx) {
  const can = ctx.api.can;
  const pl = st.paperless;
  const plOn = pl && pl.available && pl.hasToken;
  return `<div class="card records-empty">
    <div class="empty">${ICON.doc}<p><strong>No documents yet.</strong></p>
      <p>Keep your medical documents here: blood tests, letters, scans. You can add them to reports for your doctor.</p></div>
    <ul class="records-ways">
      ${can.upload ? `<li><strong>Add a document.</strong> Choose a PDF or take a photo. The diary reads the text for you.</li>` : ''}
      ${plOn ? `<li><strong>Paperless is connected.</strong> Add the tag <span class="tag">${esc(pl.tag || 'medical')}</span> to your medical documents in Paperless. Then tap Refresh.</li>`
    : can.paperless && pl && pl.available ? '<li><strong>Do you use Paperless?</strong> Connect it in Profile → Settings. Its medical documents then show here too.</li>' : ''}
    </ul>
    <div class="btn-row records-empty-actions">
      ${can.paperless && pl && pl.available && !plOn ? '<button type="button" class="btn" data-act="settings">Paperless settings</button>' : ''}
    </div></div>`;
}

// ---------- One document

function statusHtml(d) {
  if (d.status === 'processing') {
    return `<p class="doc-status" role="status">${ICON.sync}<span>Reading the text…${d.pages ? ` ${esc(plural(d.pages, 'page'))}.` : ''}</span></p>`;
  }
  if (d.status === 'failed') {
    return `<div class="doc-failed" role="alert">${ICON.alert}<div><p><strong>The diary could not read this document.</strong>${d.error ? ` ${esc(d.error)}` : ''}</p>
      <div class="btn-row"><button type="button" class="btn small" data-act="doc-retry" data-id="${esc(d.id)}">Try again</button></div></div></div>`;
  }
  return '';
}

function checkHtml(d) {
  const diff = suggestionDiff(d);
  if (!diff.length) return '';
  return `<div class="doc-check" role="group" aria-labelledby="doc-${esc(d.id)}-check">
    <p id="doc-${esc(d.id)}-check"><strong>Check the details.</strong> The diary read these from the text. They are suggestions only.</p>
    <p class="doc-check-values">${diff.map(x => `<span>${esc(FIELD_WORDS[x.key])}: <strong>${esc(fieldText(x.key, x.value))}</strong></span>`).join('<span aria-hidden="true"> · </span>')}</p>
    <div class="btn-row"><button type="button" class="btn small primary" data-act="doc-confirm" data-id="${esc(d.id)}">Confirm</button>
      <button type="button" class="btn small" data-act="doc-edit" data-id="${esc(d.id)}">Change</button></div>
  </div>`;
}

function docCard(d) {
  const sid = String(d.id);
  const included = !st.excluded.has(sid);
  const date = isValidDate(d.date) ? fullLabel(d.date) : 'No date';
  const id = `doc-${esc(sid)}`;
  const diary = isDiary(d);
  const ready = !d.status || d.status === 'ready';
  const plUrl = !diary && typeof d.url === 'string' && /^https?:\/\//i.test(d.url) ? d.url : '';
  const fileUrl = diary && d.status !== 'failed' ? ctxApi.documentFileUrl(d.id) : '';
  const name = d.title || 'Untitled document';
  return `<article class="card doc${included ? '' : ' is-excluded'}" id="${id}" aria-labelledby="${id}-title">
    <div class="doc-meta"><span class="doc-date num">${esc(date)}</span>
      <span class="doc-tags">${d.category ? `<span class="pill info">${esc(d.category)}</span>` : ready ? '<span class="pill caution">Type not set</span>' : ''}<span class="pill doc-source">${diary ? 'In diary' : 'Paperless'}</span></span></div>
    <h2 class="doc-title" id="${id}-title">${esc(name)}</h2>
    ${d.correspondent ? `<p class="doc-from">${esc(d.correspondent)}</p>` : ''}
    ${statusHtml(d)}
    ${checkHtml(d)}
    <div class="doc-actions">
      ${ready ? `<label class="check"><input type="checkbox" data-act="include" data-id="${esc(sid)}"${included ? ' checked' : ''}> Include in reports</label>` : '<span></span>'}
      <span class="doc-buttons">
        ${plUrl ? `<a class="btn small" href="${esc(plUrl)}" target="_blank" rel="noopener noreferrer">${ICON.share}Open in Paperless<span class="sr-only"> (opens in a new tab)</span></a>` : ''}
        ${fileUrl ? `<a class="btn small" href="${esc(fileUrl)}" target="_blank" rel="noopener noreferrer">${ICON.share}Open<span class="sr-only"> ${esc(name)} (opens in a new tab)</span></a>` : ''}
        ${d.status !== 'processing' ? `<button type="button" class="icon-btn" data-act="doc-edit" data-id="${esc(sid)}" aria-label="Edit details of ${esc(name)}">${ICON.edit}</button>` : ''}
        ${diary ? `<button type="button" class="icon-btn" data-act="doc-delete" data-id="${esc(sid)}" aria-label="Delete ${esc(name)}">${ICON.trash}</button>` : ''}
      </span>
    </div>
    ${d.content ? `<details class="doc-text-box"><summary>Show text</summary><pre class="doc-text" tabindex="0">${esc(d.content)}</pre></details>` : ''}
  </article>`;
}
let ctxApi = null; // the api, for file addresses in docCard

// ---------- The list

function renderList() {
  const list = $('docs-list');
  if (!list) return;
  const shown = filterDocs(st.docs, { query: st.query, category: st.category, source: st.source });
  $('docs-count').textContent = shown.length === st.docs.length
    ? plural(st.docs.length, 'document')
    : `${num(shown.length)} of ${plural(st.docs.length, 'document')}`;
  list.innerHTML = shown.length ? shown.map(docCard).join('')
    : `<div class="empty">${ICON.doc}<p><strong>No document matches.</strong></p><p>Try other words or choose All.</p>
       <button type="button" class="btn" data-act="clear">Clear search</button></div>`;
}

/** Draws one document again (after a poll or an edit), keeping the open "Show text". */
function redrawDoc(d) {
  const el = $(`doc-${d.id}`);
  if (!el) return renderList();
  const open = el.querySelector('details[open]');
  const tmp = document.createElement('div');
  tmp.innerHTML = docCard(d);
  const fresh = tmp.firstElementChild;
  if (open) fresh.querySelector('details')?.setAttribute('open', '');
  el.replaceWith(fresh);
}

function filtersHtml() {
  const cats = categoriesOf(st.docs);
  const sources = sourcesOf(st.docs);
  const chips = (label, act, values, current, words = v => v) => `<div class="filter-row"><span class="filter-label" id="filter-${act}">${esc(label)}</span>
    <div class="chips" role="group" aria-labelledby="filter-${act}">${values.map(v =>
    `<button type="button" class="chip" data-act="${act}" data-value="${esc(v)}" aria-pressed="${current === v}">${esc(v ? words(v) : 'All')}</button>`).join('')}</div></div>`;
  return `${sources.length > 1 ? chips('Source', 'src', ['', 'diary', 'paperless'], st.source, v => (v === 'diary' ? 'In diary' : 'Paperless')) : ''}
    ${cats.length + (untypedCount(st.docs) ? 1 : 0) > 1 ? chips('Type', 'cat', ['', ...cats, ...(untypedCount(st.docs) ? [NO_TYPE] : [])], st.category, v => (v === NO_TYPE ? 'Type not set' : v)) : ''}`;
}

function listHtml(ctx) {
  const notes = [];
  if (ctx.api.isDemo) {
    notes.push(`<div class="notice is-caution">${ICON.info}<div><p>These are sample documents. Adding documents needs your own server. There, you can add PDFs and photos, and connect Paperless.</p></div></div>`);
  }
  if (st.paperlessError) {
    notes.push(`<div class="notice is-caution" role="status">${ICON.alert}<div><p><strong>Paperless could not be reached.</strong> ${esc(st.paperlessError)} Your documents in the diary still show.</p>
      <div class="btn-row"><button type="button" class="btn small" data-act="retry">Try again</button></div></div></div>`);
  }
  const untyped = untypedCount(st.docs);
  if (untyped) {
    notes.push(`<div class="notice records-untyped" id="records-untyped">${ICON.info}<div><p>${esc(plural(untyped, 'document'))} without a type. A type helps you and your doctor find them.</p>
      <div class="btn-row"><button type="button" class="btn small" data-act="cat" data-value="${NO_TYPE}">Check them</button></div></div></div>`);
  }
  return `${notes.join('')}
    <div class="records-tools">
      <label class="field records-search"><span class="sr-only">Search documents</span>
        <input type="search" id="doc-search" placeholder="Search title, sender or text" autocomplete="off" value="${esc(st.query)}"></label>
      <div class="records-filters" id="records-filters">${filtersHtml()}</div>
      <p class="hint records-count" id="docs-count" aria-live="polite"></p>
    </div>
    <div class="docs" id="docs-list"></div>
    <p class="hint">Documents you leave out do not appear in reports. They are not deleted.</p>`;
}

function headActions(ctx) {
  const el = $('records-actions');
  if (!el) return;
  const none = !st || !st.docs.length;
  el.innerHTML = `${ctx.api.can.upload ? `<button type="button" class="btn small${none ? ' primary' : ''}" data-act="add">${ICON.plus}Add document</button>` : ''}
    <button type="button" class="btn small" data-act="refresh">${ICON.sync}Refresh</button>`;
}

/** Shows the list (or the empty state) from st. */
function show(ctx) {
  headActions(ctx);
  if (!st.docs.length && !st.paperlessError) { setBody(emptyHtml(ctx)); return; }
  setBody(listHtml(ctx));
  renderList();
}

async function load(ctx, { refresh = false } = {}) {
  const seq = ++loadSeq;
  const api = ctx.api;
  ctxApi = api;
  stopPolls();
  setBody(loadingHtml, true);
  try {
    const [docs, settings, paperless] = await Promise.all([
      refresh ? api.refreshDocuments() : api.listDocuments(),
      api.getSettings(),
      api.can.paperless && !api.isDemo ? api.getPaperless().catch(() => null) : null,
    ]);
    if (seq !== loadSeq) return false;
    st = {
      docs: [...(docs || [])], excluded: excludedSet(settings.excludedDocs),
      query: st ? st.query : '', category: '', source: '', paperlessError: (docs && docs.paperlessError) || null, paperless,
    };
    show(ctx);
    st.docs.filter(d => d.status === 'processing').forEach(d => poll(ctx, d.id));
    return !st.paperlessError;
  } catch (e) {
    if (seq !== loadSeq) return false;
    setBody(errorHtml(e.message || 'The server did not answer.'));
    return false;
  }
}

// ---------- Polling while the server reads a document

function stopPolls() { polls.forEach(t => clearTimeout(t)); polls.clear(); }

function poll(ctx, id, n = 0, errors = 0) {
  clearTimeout(polls.get(String(id)));
  if (n >= POLL_MAX) { polls.delete(String(id)); return; }
  const seq = loadSeq;
  polls.set(String(id), setTimeout(async () => {
    let fresh = null;
    try { fresh = await ctx.api.getDocument(id); } catch (e) {
      if (seq !== loadSeq) return;
      if (errors < 5) poll(ctx, id, n + 1, errors + 1); else polls.delete(String(id));
      return;
    }
    if (seq !== loadSeq || !st) return; // left the screen or loaded again
    const i = st.docs.findIndex(d => String(d.id) === String(id));
    if (i < 0 || !fresh) { polls.delete(String(id)); return; }
    const old = st.docs[i];
    st.docs[i] = fresh;
    if (fresh.status !== old.status || fresh.pages !== old.pages) redrawDoc(fresh);
    if (fresh.status === 'processing') poll(ctx, id, n + 1, 0);
    else {
      polls.delete(String(id));
      const el = $('records-filters');
      if (el) el.innerHTML = filtersHtml();
      toast(fresh.status === 'ready' ? `${fresh.title || 'Document'}: the text is ready` : 'The diary could not read a document', fresh.status === 'ready' ? {} : { tone: 'error' });
    }
  }, POLL_MS));
}

// ---------- Sheets: add and edit

function detailFields(d = {}) {
  const cats = d.category && !DOC_CATEGORIES.includes(d.category) ? [...DOC_CATEGORIES, d.category] : DOC_CATEGORIES;
  return `<div class="grid2">
      <div class="field"><label class="label" for="doc-f-date">Date</label>
        <input id="doc-f-date" name="date" type="date" max="${todayIso()}" value="${esc(d.date || '')}"></div>
      <div class="field"><label class="label" for="doc-f-cat">Type</label>
        <select id="doc-f-cat" name="category"><option value="">${d.id ? 'Not set' : 'Find from the text'}</option>
          ${cats.map(c => `<option value="${esc(c)}"${d.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label class="label" for="doc-f-title">Title</label>
      <input id="doc-f-title" name="title" type="text" maxlength="200" autocomplete="off" value="${esc(d.title || '')}"
        placeholder="${d.id ? '' : 'Example: Blood test, October'}"></div>`;
}

const formFields = form => ({ date: form.date.value, title: form.title.value.trim(), category: form.category.value });

function openAddSheet(ctx) {
  openSheet({
    title: 'Add document',
    html: `<form class="stack doc-form" novalidate>
      <div class="field"><label class="label" for="doc-f-file">PDF or photo</label>
        <input id="doc-f-file" name="file" type="file" accept="application/pdf,image/*" required aria-describedby="doc-f-file-hint" autofocus>
        <p class="hint" id="doc-f-file-hint">A PDF of up to ${MAX_PAGES} pages, or a photo. The file can be up to ${MAX_UPLOAD_MB} MB. On a phone, you can take a photo now.</p></div>
      <p class="hint">The details below are optional. The diary reads the text and suggests them. You check them before they are used.</p>
      ${detailFields()}
      <p class="field-error" id="doc-f-error" role="alert"></p>
      <p class="hint" id="doc-f-status" aria-live="polite"></p>
      <div class="btn-row"><button type="submit" class="btn primary">Upload</button>
        <button type="button" class="btn ghost" data-sheet-close>Cancel</button></div>
    </form>`,
    async onSubmit(form) {
      const file = form.file.files[0];
      const err = uploadError(file);
      const errEl = form.querySelector('#doc-f-error');
      errEl.textContent = '';
      if (err) { errEl.textContent = err; form.file.focus(); return; }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      form.querySelector('#doc-f-status').textContent = `Uploading ${num(Math.max(0.1, file.size / 1e6), 1)} MB. Keep this page open.`;
      let doc;
      try { doc = await ctx.api.uploadDocument(file, formFields(form)); } catch (e) {
        btn.disabled = false;
        form.querySelector('#doc-f-status').textContent = '';
        errEl.textContent = `Not uploaded. ${e.message}`;
        return;
      }
      closeSheet();
      if (!st) return;
      st.docs.push(doc);
      show(ctx);
      if (doc.status === 'processing') poll(ctx, doc.id);
      toast('Document added. The diary reads the text now.');
      $(`doc-${doc.id}`)?.scrollIntoView({ block: 'center' });
    },
  });
}

function openEditSheet(ctx, d) {
  const paperless = !isDiary(d);
  const edited = (d.edited || []).filter(k => ['category', 'date', 'title'].includes(k));
  const words = { category: 'type', date: 'date', title: 'title' };
  const fromPaperless = paperless ? `<div class="doc-origin">
      <p class="hint">Saved in your diary only. Paperless does not change.</p>
      ${edited.length ? `<p class="hint">Paperless type: <strong>${esc(d.paperlessType || 'not set')}</strong>. You changed the ${esc(edited.map(k => words[k]).join(', '))}.</p>
        <div class="btn-row"><button type="button" class="btn small" data-act="doc-reset">Use Paperless values</button></div>` : ''}
    </div>` : '';
  openSheet({
    title: 'Edit details',
    html: `<form class="stack doc-form" novalidate>
      ${detailFields(d)}
      ${fromPaperless}
      <p class="field-error" id="doc-f-error" role="alert"></p>
      <div class="btn-row"><button type="submit" class="btn primary">Save</button>
        <button type="button" class="btn ghost" data-sheet-close>Cancel</button></div>
    </form>`,
    async onAction(act, el) {
      if (act !== 'doc-reset') return;
      el.disabled = true;
      try {
        // null removes the diary's own value: the Paperless value shows again.
        await saveDetails(ctx, d, Object.fromEntries(edited.map(k => [k, null])));
      } catch (e) {
        el.disabled = false;
        document.getElementById('doc-f-error').textContent = `Not saved. ${e.message}`;
        return;
      }
      closeSheet();
      toast('Paperless values are used again');
    },
    async onSubmit(form) {
      const fields = formFields(form);
      if (!fields.title) { form.querySelector('#doc-f-error').textContent = 'Enter a title.'; form.title.focus(); return; }
      const changed = changedFields(d, fields);
      if (!Object.keys(changed).length) { closeSheet(); return; }
      try { await saveDetails(ctx, d, changed); } catch (e) {
        form.querySelector('#doc-f-error').textContent = `Not saved. ${e.message}`;
        return;
      }
      closeSheet();
      toast('Details saved');
    },
  });
}

/** Saves date, title or type (only the fields given). The server answers with the updated document. */
async function saveDetails(ctx, d, fields) {
  let updated = await ctx.api.updateDocument(d.id, fields);
  if (!(updated && typeof updated === 'object' && updated.id != null)) {
    updated = await ctx.api.getDocument(d.id).catch(() => null);
  }
  const i = st.docs.findIndex(x => String(x.id) === String(d.id));
  if (i < 0) return;
  st.docs[i] = updated && updated.id != null ? updated
    : { ...st.docs[i], ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null)), suggested: null };
  redrawDoc(st.docs[i]);
  const f = $('records-filters');
  if (f) f.innerHTML = filtersHtml();
  const n = $('records-untyped');
  if (n && !untypedCount(st.docs)) n.remove();
}

// ---------- Screen

export default {
  render() {
    st = null;
    return `<div class="screen-head"><h1 class="screen-title">Records</h1>
        <div class="btn-row records-head-actions" id="records-actions"></div></div>
      <p class="hint records-lead">Your medical documents. Choose which ones go into reports.</p>
      <div id="records-body" class="records-body" aria-busy="true">${loadingHtml}</div>`;
  },

  mounted(ctx) { headActions(ctx); load(ctx); },

  async leave() { loadSeq++; stopPolls(); },

  actions: {
    async refresh(el, e, ctx) {
      el.disabled = true;
      try {
        const ok = await load(ctx, { refresh: true });
        if (ok) toast('Documents refreshed');
      } finally {
        if (el.isConnected) el.disabled = false;
      }
    },
    retry(el, e, ctx) { return load(ctx, { refresh: true }); },
    settings(el, e, ctx) { return ctx.go('profile', { view: 'settings' }); },
    add(el, e, ctx) {
      if (!ctx.api.can.upload) throw new Error('Adding documents needs your own server.');
      openAddSheet(ctx);
    },
    'doc-edit'(el, e, ctx) {
      const d = docById(el.dataset.id);
      if (!d) throw new Error('This document is no longer in the list.');
      openEditSheet(ctx, d);
    },
    async 'doc-confirm'(el, e, ctx) {
      const d = docById(el.dataset.id);
      if (!d) throw new Error('This document is no longer in the list.');
      const fields = Object.fromEntries(suggestionDiff(d).map(x => [x.key, x.value]));
      el.disabled = true;
      try { await saveDetails(ctx, d, fields); } finally { if (el.isConnected) el.disabled = false; }
      toast('Details confirmed');
      $(`doc-${d.id}-title`)?.closest('article')?.querySelector('[data-act="include"]')?.focus();
    },
    async 'doc-delete'(el, e, ctx) {
      const d = docById(el.dataset.id);
      if (!d) throw new Error('This document is no longer in the list.');
      if (!confirmTwice(el, 'Tap again: delete the file for good')) return;
      await ctx.api.deleteDocument(d.id);
      clearTimeout(polls.get(String(d.id)));
      polls.delete(String(d.id));
      st.docs = st.docs.filter(x => x !== d);
      show(ctx);
      toast('Document deleted. The file is gone for good.');
      ($('doc-search') || $('records-actions')?.querySelector('button'))?.focus();
    },
    async 'doc-retry'(el, e, ctx) {
      const d = docById(el.dataset.id);
      if (!d) throw new Error('This document is no longer in the list.');
      el.disabled = true;
      const fresh = await ctx.api.retryDocument(d.id);
      const i = st.docs.indexOf(d);
      st.docs[i] = fresh && fresh.id != null ? fresh : { ...d, status: 'processing', error: null };
      redrawDoc(st.docs[i]);
      poll(ctx, d.id);
    },
    src(el) {
      st.source = el.dataset.value;
      document.querySelectorAll('#records-body [data-act="src"]').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
      renderList();
    },
    cat(el) {
      st.category = el.dataset.value;
      document.querySelectorAll('#records-body .chip[data-act="cat"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === st.category)));
      renderList();
      // From the "without a type" notice: go to the list.
      if (!el.classList.contains('chip')) document.querySelector('#docs-list .doc h2')?.closest('article')?.querySelector('[data-act="doc-edit"]')?.focus();
    },
    clear() {
      st.query = '';
      st.category = '';
      st.source = '';
      const s = $('doc-search');
      if (s) { s.value = ''; s.focus(); }
      document.querySelectorAll('#records-body .chip[data-act="cat"], #records-body .chip[data-act="src"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === '')));
      renderList();
    },
  },

  async input(el, e, ctx) {
    if (el.id === 'doc-search') {
      st.query = el.value;
      renderList();
      return;
    }
    if (el.dataset.act === 'include') {
      const id = String(el.dataset.id);
      const include = el.checked;
      const before = new Set(st.excluded);
      if (include) st.excluded.delete(id); else st.excluded.add(id);
      el.closest('.doc')?.classList.toggle('is-excluded', !include);
      try {
        // The server merges the keys it gets: other settings stay as they are.
        await ctx.api.saveSettings({ excludedDocs: excludedList(st.excluded) });
      } catch (err) {
        st.excluded = before;
        el.checked = !include;
        el.closest('.doc')?.classList.toggle('is-excluded', include);
        throw new Error(`Not saved. ${err.message}`);
      }
      toast(include ? 'Included in reports' : 'Left out of reports');
    }
  },
};
