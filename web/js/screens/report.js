// Report screen: a summary for a doctor (formatted, printable) or an anonymized text for an AI assistant.
// The screen only loads data, holds the options and draws. The report itself is built by js/report/*:
// model.js (numbers) → html.js (doctor) or markdown.js + redact.js (AI and plain text).
import { addDays, diffDays, fullLabel, isValidDate, today } from '../core/dates.js';
import { esc, num } from '../core/format.js';
import { copyText, debounce, ICON, store, toast } from '../core/ui.js';
import { buildReportModel, DEFAULT_OPTIONS, SECTIONS, selectDocuments } from '../report/model.js';
import { toHtml } from '../report/html.js';
import { toMarkdown } from '../report/markdown.js';
import { makeRedactor } from '../report/redact.js';

const PERIODS = [[30, '30 days'], [90, '90 days'], [365, '1 year'], ['custom', 'Dates']];
const PREVIEW_LINES = 25;

const S = {
  opts: null, settings: { redactWords: [], excludedDocs: [] },
  profile: null, docs: null, docsError: null, data: null, dataKey: '', loadError: null,
  showFull: false, text: '', ctx: null,
};

function loadOptions() {
  const saved = store.get('report-options', {}) || {};
  const o = { ...DEFAULT_OPTIONS, ...saved, include: { ...DEFAULT_OPTIONS.include, ...(saved.include || {}) } };
  if (!PERIODS.some(p => String(p[0]) === String(o.period))) o.period = 90;
  return o;
}
const saveOptions = () => store.set('report-options', S.opts);

function range() {
  const o = S.opts, t = today();
  if (o.period === 'custom') {
    const from = o.from, to = o.to;
    if (!isValidDate(from) || !isValidDate(to)) return { error: 'Enter a start date and an end date.' };
    if (from > to) return { error: 'The start date must be before the end date.' };
    if (diffDays(to, from) > 3 * 366) return { error: 'Choose a period of 3 years or less.' };
    return { from, to };
  }
  return { from: addDays(t, -(Number(o.period) - 1)), to: t };
}

// ---------- Data: profile, settings and documents once per visit; days and measurements once per period.

async function loadBase(api) {
  const [profile, settings] = await Promise.all([api.getProfile(), api.getSettings()]);
  S.profile = profile || {};
  S.settings = { redactWords: [], excludedDocs: [], ...(settings || {}) };
  try {
    S.docs = await api.listDocuments();
    S.docsError = null;
  } catch (e) {
    // Without Paperless the report still works, without documents.
    S.docs = null;
    S.docsError = e.message || 'Documents are not available.';
  }
}

async function loadPeriod(api) {
  const r = range();
  if (r.error) { S.data = null; S.loadError = null; return; }
  const key = `${r.from}|${r.to}`;
  if (S.dataKey === key && S.data) return;
  const [days, measurements] = await Promise.all([api.listDays(r.from, r.to), api.listMeasurements(null, null, r.to)]);
  S.data = { days: days || [], measurements: measurements || [] };
  S.dataKey = key;
  S.loadError = null;
}

// ---------- Building the report

function build() {
  const r = range();
  if (r.error || !S.data) return null;
  const o = S.opts;
  const ai = o.audience === 'ai';
  const model = buildReportModel(
    { profile: S.profile, days: S.data.days, measurements: S.data.measurements, documents: S.docs, documentsError: S.docsError, today: today() },
    { ...o, from: r.from, to: r.to, excludedDocs: S.settings.excludedDocs || [] });
  if (!ai) {
    return { model, html: toHtml(model), text: toMarkdown(model) };
  }
  const redactor = makeRedactor({
    profile: S.profile, words: S.settings.redactWords || [],
    correspondents: (S.docs || []).map(d => d.correspondent).filter(Boolean),
    relativeTo: o.relativeDates ? r.to : null,
  });
  return { model, text: toMarkdown(model, { redactor, relative: o.relativeDates }) };
}

const tokens = text => Math.max(100, Math.round(text.length / 3.7 / 100) * 100);

// ---------- Drawing

const seg = (act, items, current, label) => `<div class="seg" role="radiogroup" aria-label="${esc(label)}">${items.map(([v, l]) =>
  `<button type="button" role="radio" data-act="${act}" data-value="${esc(v)}" aria-checked="${String(String(current) === String(v))}">${esc(l)}</button>`).join('')}</div>`;

function docsList() {
  if (S.docs == null) return `<p class="hint">Documents are not available${S.docsError ? `: ${esc(S.docsError)}` : ''}. The report is made without them.</p>`;
  if (!S.docs.length) return '<p class="hint">No medical documents.</p>';
  const ex = new Set((S.settings.excludedDocs || []).map(String));
  const docs = [...S.docs].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return `<ul class="rp-doclist">${docs.map(d => `<li><label class="check"><input type="checkbox" data-doc="${esc(d.id)}" ${ex.has(String(d.id)) ? '' : 'checked'}>
    <span><span class="rp-doclist-title">${esc(d.title || 'Document')}</span><span class="sub">${esc([d.date ? fullLabel(d.date) : '', d.category].filter(Boolean).join(' · '))}<span class="rp-doc-scope" data-doc-scope="${esc(d.id)}"></span></span></span></label></li>`).join('')}</ul>`;
}

function settingsHtml() {
  const o = S.opts;
  const ai = o.audience === 'ai';
  const r = range();
  return `<form class="card rp-settings" data-form="report" aria-label="Report settings" novalidate>
    <div class="field">
      <span class="label" id="rp-who">Who is it for?</span>
      ${seg('audience', [['doctor', 'My doctor'], ['ai', 'An AI (anonymized)']], o.audience, 'Who is it for?')}
      <p class="hint" id="rp-who-hint">${ai ? 'A text for an AI assistant. Names, dates of birth, addresses, ID numbers and contact details are removed.' : 'A short formatted report. You can print it, save it as a PDF or share it.'}</p>
    </div>
    <div class="field">
      <span class="label">Period</span>
      ${seg('period', PERIODS, o.period, 'Period')}
      <div class="grid2" id="rp-custom" ${o.period === 'custom' ? '' : 'hidden'}>
        <label class="field"><span>From</span><input type="date" data-field="from" value="${esc(o.from || addDays(today(), -89))}" max="${esc(today())}"></label>
        <label class="field"><span>To</span><input type="date" data-field="to" value="${esc(o.to || today())}" max="${esc(today())}"></label>
      </div>
      <p class="field-error" id="rp-range-error" role="alert">${esc(r.error || '')}</p>
    </div>
    <div class="field">
      <label class="label" for="rp-question">Your question <span class="muted">(optional)</span></label>
      <textarea id="rp-question" data-field="question" rows="2" placeholder="Example: Is there a link between my coffee and my palpitations?">${esc(o.question || '')}</textarea>
      <p class="hint">It goes at the top of the report.</p>
    </div>
    <details class="rp-include" id="rp-include">
      <summary>Include <span class="muted rp-include-sum" id="rp-include-sum">${esc(includeSummary())}</span></summary>
      <div class="rp-include-body">
        <fieldset class="rp-fs"><legend class="label">Sections</legend>
          ${SECTIONS.map(s => `<label class="check"><input type="checkbox" data-inc="${esc(s.key)}" ${o.include[s.key] ? 'checked' : ''}> ${esc(s.label)}</label>`).join('')}
        </fieldset>
        <fieldset class="rp-fs"><legend class="label">Options</legend>
          <label class="check"><input type="checkbox" data-field="fullDaily" ${o.fullDaily ? 'checked' : ''}> Full daily details (every day, with food)</label>
          <label class="check rp-ai-only" ${ai ? '' : 'hidden'}><input type="checkbox" data-field="relativeDates" ${o.relativeDates ? 'checked' : ''}> Replace dates with day numbers (D-12)</label>
        </fieldset>
        <fieldset class="rp-fs"><legend class="label">Documents</legend>
          ${seg('docScope', [['period', 'This period + latest of each type'], ['all', 'All']], o.docScope, 'Which documents')}
          <label class="check"><input type="checkbox" data-field="docFull" ${o.docFull ? 'checked' : ''}> Full text of documents</label>
          <p class="hint">Untick a document to leave it out of all reports.</p>
          ${docsList()}
        </fieldset>
      </div>
    </details>
    <div class="field rp-ai-only" ${ai ? '' : 'hidden'}>
      <label class="label" for="rp-words">Other words to hide, one per line</label>
      <textarea id="rp-words" data-field="words" rows="3" placeholder="Hospital, lab or town names">${esc((S.settings.redactWords || []).join('\n'))}</textarea>
      <p class="hint">Hidden already: your name, the names of your doctors and labs from the documents, your date of birth, addresses, phone numbers, emails, links and ID numbers. Read the report before you share it.</p>
    </div>
  </form>`;
}

function includeSummary() {
  const o = S.opts;
  const n = SECTIONS.filter(s => o.include[s.key]).length;
  return `${n} of ${SECTIONS.length} sections`;
}

function previewHtml(built) {
  const r = range();
  if (r.error) return `<div class="empty">${ICON.calendar}<p>${esc(r.error)}</p></div>`;
  if (S.loadError) return `<div class="notice is-error" role="alert">${ICON.alert}<div><strong>The data could not load.</strong><p>${esc(S.loadError)}</p><button class="btn" type="button" data-act="retry">Try again</button></div></div>`;
  if (!built) return '<p class="hint rp-loading">Loading…</p>';
  const docsNote = S.opts.include.documents && S.docs == null
    ? `<div class="notice is-caution">${ICON.info}<div><p>Documents are left out: they could not be loaded.</p></div></div>` : '';
  if (S.opts.audience !== 'ai') return `${docsNote}${built.html}`;
  const lines = built.text.split('\n').length;
  const long = lines > PREVIEW_LINES;
  return `${docsNote}<div class="rp-md-wrap${long && !S.showFull ? ' is-collapsed' : ''}">
    <pre class="rp-md" id="rp-md" tabindex="0" aria-label="Report text">${esc(built.text)}</pre></div>
    ${long ? `<button type="button" class="btn ghost rp-more-btn" data-act="toggle-full" aria-expanded="${S.showFull}">${S.showFull ? 'Show less' : `Show full report (${num(lines)} lines)`}</button>` : ''}`;
}

function barHtml(built) {
  const disabled = built ? '' : ' disabled';
  if (S.opts.audience === 'ai') {
    return `<button type="button" class="btn primary" data-act="copy"${disabled}>${ICON.copy} Copy report</button>
      <span class="rp-tokens" aria-live="polite">${built ? `≈${esc(num(tokens(built.text)))} tokens` : ''}</span>`;
  }
  const canShare = typeof navigator !== 'undefined' && !!navigator.share;
  return `<button type="button" class="btn primary" data-act="print"${disabled}>${ICON.print} Print / Save as PDF</button>
    ${canShare ? `<button type="button" class="btn" data-act="share"${disabled}>${ICON.share} Share</button>` : ''}
    <button type="button" class="btn" data-act="copy-text"${disabled}>${ICON.copy} Copy as text</button>`;
}

/** Draws the preview and the action bar again, and updates the controls in place (keeps focus). */
function paint() {
  const view = S.ctx && S.ctx.view;
  if (!view || !view.querySelector('.rp')) return;
  let built = null;
  try { built = build(); } catch (e) { console.error(e); S.loadError = `The report could not be made: ${e.message}`; }
  S.text = built ? built.text : '';
  const ai = S.opts.audience === 'ai';
  view.querySelector('.rp').classList.toggle('is-ai', ai);
  view.querySelector('#rp-preview').innerHTML = previewHtml(built);
  view.querySelector('#rp-bar').innerHTML = barHtml(built);
  view.querySelector('#rp-out-title').textContent = ai ? 'Text for the AI' : 'Report for your doctor';
  view.querySelectorAll('.rp-ai-only').forEach(x => { x.hidden = !ai; });
  view.querySelector('#rp-custom').hidden = S.opts.period !== 'custom';
  view.querySelector('#rp-range-error').textContent = range().error || '';
  view.querySelector('#rp-include-sum').textContent = includeSummary();
  view.querySelector('#rp-who-hint').textContent = ai
    ? 'A text for an AI assistant. Names, dates of birth, addresses, ID numbers and contact details are removed.'
    : 'A short formatted report. You can print it, save it as a PDF or share it.';
  view.querySelectorAll('[role="radio"][data-act]').forEach(b => {
    const key = { audience: 'audience', period: 'period', docScope: 'docScope' }[b.dataset.act];
    b.setAttribute('aria-checked', String(String(S.opts[key]) === b.dataset.value));
  });
  // Which documents are in this report (period and scope)
  const r = range();
  if (S.docs && !r.error) {
    const inReport = new Set(selectDocuments(S.docs, { from: r.from, to: r.to, scope: S.opts.docScope, excluded: [] }).map(d => String(d.id)));
    view.querySelectorAll('[data-doc-scope]').forEach(x => { x.textContent = inReport.has(x.dataset.docScope) ? '' : ' · not in this period'; });
  }
}

const paintSoon = debounce(paint, 200);

async function reload() {
  const view = S.ctx.view;
  const prev = view.querySelector('#rp-preview');
  if (prev && !range().error) { prev.innerHTML = '<p class="hint rp-loading">Loading…</p>'; }
  try {
    await loadPeriod(S.ctx.api);
  } catch (e) {
    S.loadError = e.message;
  }
  paint();
}

const saveWords = debounce(words => S.ctx.api.saveSettings({ redactWords: words })
  .catch(e => toast(`The words to hide were not saved. ${e.message}`, { tone: 'error' })), 800);
const saveExcluded = debounce(list => S.ctx.api.saveSettings({ excludedDocs: list })
  .catch(e => toast(`The document choice was not saved. ${e.message}`, { tone: 'error' })), 400);

export default {
  async render(ctx) {
    S.ctx = ctx;
    S.opts = loadOptions();
    S.showFull = false;
    S.dataKey = '';
    S.data = null;
    S.loadError = null;
    await loadBase(ctx.api);
    try { await loadPeriod(ctx.api); } catch (e) { S.loadError = e.message; }
    return `<div class="rp${S.opts.audience === 'ai' ? ' is-ai' : ''}">
      <div class="screen-head"><h1 class="screen-title">Report</h1></div>
      <p class="hint rp-intro">A summary of your diary for your doctor, or an anonymized text to ask an AI assistant.</p>
      <div class="rp-layout">
        ${settingsHtml()}
        <section class="rp-out" aria-labelledby="rp-out-title">
          <h2 class="sr-only" id="rp-out-title">Report</h2>
          <div class="rp-preview" id="rp-preview" aria-live="off"></div>
        </section>
        <div class="rp-bar" id="rp-bar" role="toolbar" aria-label="Report actions"></div>
      </div>
    </div>`;
  },

  mounted() { paint(); },

  async leave() {
    paintSoon.cancel();
    await Promise.all([saveWords.flush(), saveExcluded.flush()]);
  },

  actions: {
    audience(el) {
      if (S.opts.audience === el.dataset.value) return;
      S.opts.audience = el.dataset.value;
      S.showFull = false;
      saveOptions();
      paint();
    },
    async period(el) {
      const v = el.dataset.value === 'custom' ? 'custom' : Number(el.dataset.value);
      if (S.opts.period === v) return;
      S.opts.period = v;
      if (v === 'custom') {
        S.opts.from = S.opts.from || addDays(today(), -89);
        S.opts.to = S.opts.to || today();
      }
      saveOptions();
      await reload();
    },
    docScope(el) {
      S.opts.docScope = el.dataset.value;
      saveOptions();
      paint();
    },
    'toggle-full'() {
      S.showFull = !S.showFull;
      paint();
      if (!S.showFull) S.ctx.view.querySelector('#rp-out-title').scrollIntoView({ block: 'nearest' });
    },
    retry() { S.dataKey = ''; return reload(); },
    async copy() {
      paintSoon.flush();
      const ok = await copyText(S.text, S.ctx.view.querySelector('#rp-md'));
      toast(ok ? 'Report copied. Read it before you share it.' : 'Copy did not work. The text is selected: copy it by hand.');
    },
    async 'copy-text'() {
      paintSoon.flush();
      const ok = await copyText(S.text, S.ctx.view.querySelector('.rp-doc'));
      toast(ok ? 'Report copied as text.' : 'Copy did not work. The report is selected: copy it by hand.');
    },
    print() {
      paintSoon.flush();
      window.print();
    },
    async share() {
      paintSoon.flush();
      try {
        await navigator.share({ title: 'Health report', text: S.text });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // the user closed the share sheet
        const ok = await copyText(S.text);
        toast(ok ? 'Sharing is not available. The report is copied as text.' : 'Sharing is not available.');
      }
    },
  },

  forms: { report() { /* Enter in a field: nothing to submit, the report updates by itself. */ } },

  async input(el) {
    if (el.dataset.inc) {
      S.opts.include[el.dataset.inc] = el.checked;
      saveOptions();
      return paint();
    }
    if (el.dataset.doc) {
      const id = el.dataset.doc;
      const ex = (S.settings.excludedDocs || []).filter(x => String(x) !== id);
      // Keep the id type of the documents (numbers from Paperless).
      const doc = (S.docs || []).find(d => String(d.id) === id);
      if (!el.checked) ex.push(doc ? doc.id : id);
      S.settings.excludedDocs = ex;
      saveExcluded(ex);
      return paint();
    }
    const f = el.dataset.field;
    if (!f) return undefined;
    if (f === 'question') { S.opts.question = el.value; saveOptions(); return paintSoon(); }
    if (f === 'words') {
      const words = el.value.split('\n').map(w => w.trim()).filter(Boolean);
      S.settings.redactWords = words;
      saveWords(words);
      return paintSoon();
    }
    if (f === 'from' || f === 'to') {
      S.opts[f] = el.value;
      saveOptions();
      if (range().error) return paint();
      return reload();
    }
    if (['fullDaily', 'docFull', 'relativeDates'].includes(f)) {
      S.opts[f] = el.checked;
      saveOptions();
      return paint();
    }
    return undefined;
  },
};
