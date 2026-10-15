// Records tab: medical documents from Paperless (the documents with the user's tag).
// The list loads after the screen shows, so a slow Paperless shows a loading state, not a blank screen.
import { fullLabel, isValidDate } from '../core/dates.js';
import { esc, num, plural } from '../core/format.js';
import { ICON, toast } from '../core/ui.js';
import { categoriesOf, filterDocs } from './records-data.js';

let st = null; // { docs, excluded: Set, query, category, tag, seq }
let loadSeq = 0;

const body = () => document.getElementById('records-body');

// ---------- States

function setBody(html, busy = false) {
  const el = body();
  if (!el) return;
  el.setAttribute('aria-busy', String(busy));
  el.innerHTML = html;
}

const loadingHtml = `<div class="empty records-loading" role="status">${ICON.sync}<p>Loading documents from Paperless…</p></div>`;

function notConfigured(ctx, cfg) {
  if (!cfg.available) {
    return `<div class="notice">${ICON.info}<div><strong>Your documents cannot show here yet.</strong>
      <p>Paperless keeps your scanned medical documents. Paperless is not connected. Ask the person who installed Health Diary to connect it.</p></div></div>`;
  }
  return `<div class="notice">${ICON.info}<div><strong>Connect Paperless to see your documents.</strong>
    <p>This list shows your medical documents from Paperless: all documents with your tag. Add your Paperless token in Profile → Settings.</p>
    <div class="btn-row"><button type="button" class="btn primary" data-act="settings">Open Paperless settings</button></div></div></div>`;
}

function errorHtml(message) {
  return `<div class="notice is-error" role="alert">${ICON.alert}<div><strong>Could not load your documents.</strong>
    <p>${esc(message)}</p>
    <div class="btn-row"><button type="button" class="btn" data-act="retry">Try again</button>
    <button type="button" class="btn ghost" data-act="settings">Paperless settings</button></div></div></div>`;
}

function emptyHtml(tag) {
  return `<div class="empty">${ICON.doc}<p><strong>No documents with the tag <span class="tag">${esc(tag)}</span>.</strong></p>
    <p>In Paperless, add this tag to your medical documents. Then tap Refresh.</p></div>`;
}

// ---------- The list

function docCard(d) {
  const included = !st.excluded.has(d.id);
  const date = isValidDate(d.date) ? fullLabel(d.date) : 'No date';
  const id = `doc-${esc(d.id)}`;
  const url = typeof d.url === 'string' && /^https?:\/\//i.test(d.url) ? d.url : '';
  return `<article class="card doc${included ? '' : ' is-excluded'}" aria-labelledby="${id}-title">
    <div class="doc-meta"><span class="doc-date num">${esc(date)}</span>${d.category ? `<span class="pill info">${esc(d.category)}</span>` : ''}</div>
    <h2 class="doc-title" id="${id}-title">${esc(d.title || 'Untitled document')}</h2>
    ${d.correspondent ? `<p class="doc-from">${esc(d.correspondent)}</p>` : ''}
    <div class="doc-actions">
      <label class="check"><input type="checkbox" data-act="include" data-id="${esc(d.id)}"${included ? ' checked' : ''}> Include in reports</label>
      ${url ? `<a class="btn small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ICON.share}Open in Paperless<span class="sr-only"> (opens in a new tab)</span></a>` : ''}
    </div>
    ${d.content ? `<details class="doc-text-box"><summary>Show text</summary><pre class="doc-text" tabindex="0">${esc(d.content)}</pre></details>` : ''}
  </article>`;
}

function renderList() {
  const list = document.getElementById('docs-list');
  if (!list) return;
  const shown = filterDocs(st.docs, { query: st.query, category: st.category });
  document.getElementById('docs-count').textContent = shown.length === st.docs.length
    ? plural(st.docs.length, 'document')
    : `${num(shown.length)} of ${plural(st.docs.length, 'document')}`;
  list.innerHTML = shown.length ? shown.map(docCard).join('')
    : `<div class="empty">${ICON.doc}<p><strong>No document matches.</strong></p><p>Try other words or choose All.</p>
       <button type="button" class="btn" data-act="clear">Clear search</button></div>`;
}

function chipsHtml() {
  const cats = categoriesOf(st.docs);
  if (cats.length < 2) return '';
  return `<div class="chips" role="group" aria-label="Category">${['', ...cats].map(c =>
    `<button type="button" class="chip" data-act="cat" data-value="${esc(c)}" aria-pressed="${st.category === c}">${esc(c || 'All')}</button>`).join('')}</div>`;
}

function listHtml(ctx) {
  return `${ctx.api.isDemo ? `<div class="notice is-caution">${ICON.info}<div><p>These are sample documents. In your own install, this list comes from your Paperless. Each document then has an “Open in Paperless” button that opens the original file.</p></div></div>` : ''}
    <div class="records-tools">
      <label class="field records-search"><span class="sr-only">Search documents</span>
        <input type="search" id="doc-search" placeholder="Search title, sender or text" autocomplete="off" value="${esc(st.query)}"></label>
      ${chipsHtml()}
      <p class="hint records-count" id="docs-count" aria-live="polite"></p>
    </div>
    <div class="docs" id="docs-list"></div>
    <p class="hint">Documents you leave out do not appear in reports. They stay in Paperless.</p>`;
}

async function load(ctx, { refresh = false } = {}) {
  const seq = ++loadSeq;
  const api = ctx.api;
  setBody(loadingHtml, true);
  try {
    let tag = 'medical';
    if (!api.isDemo) {
      const cfg = await api.getPaperless();
      if (seq !== loadSeq) return false;
      tag = cfg.tag || tag;
      if (!cfg.available || !cfg.hasToken) { setBody(notConfigured(ctx, cfg)); return false; }
    }
    const [docs, settings] = await Promise.all([refresh ? api.refreshDocuments() : api.listDocuments(), api.getSettings()]);
    if (seq !== loadSeq) return false;
    st = { docs: docs || [], excluded: new Set(settings.excludedDocs || []), query: st ? st.query : '', category: '', tag };
    if (!st.docs.length) { setBody(emptyHtml(tag)); return true; }
    setBody(listHtml(ctx));
    renderList();
    return true;
  } catch (e) {
    if (seq !== loadSeq) return false;
    setBody(errorHtml(e.message || 'Paperless did not answer.'));
    return false;
  }
}

export default {
  render() {
    st = null;
    return `<div class="screen-head"><h1 class="screen-title">Records</h1>
        <button type="button" class="btn small" data-act="refresh">${ICON.sync}Refresh</button></div>
      <p class="hint records-lead">Your medical documents from Paperless. Choose which ones go into reports.</p>
      <div id="records-body" class="records-body" aria-busy="true">${loadingHtml}</div>`;
  },

  mounted(ctx) { load(ctx); },

  async leave() { loadSeq++; },

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
    retry(el, e, ctx) { return load(ctx); },
    settings(el, e, ctx) { return ctx.go('profile', { view: 'settings' }); },
    cat(el) {
      st.category = el.dataset.value;
      document.querySelectorAll('#records-body [data-act="cat"]').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
      renderList();
    },
    clear() {
      st.query = '';
      st.category = '';
      const s = document.getElementById('doc-search');
      if (s) { s.value = ''; s.focus(); }
      document.querySelectorAll('#records-body [data-act="cat"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === '')));
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
      const id = Number(el.dataset.id);
      const include = el.checked;
      const before = new Set(st.excluded);
      if (include) st.excluded.delete(id); else st.excluded.add(id);
      el.closest('.doc')?.classList.toggle('is-excluded', !include);
      try {
        // The server merges the keys it gets: other settings stay as they are.
        await ctx.api.saveSettings({ excludedDocs: [...st.excluded] });
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
