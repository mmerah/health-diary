// Trends → Compare: 2 to 4 things on the same days. For example a measurement and a symptom,
// sleep and coffee, or a food and how you feel. The numbers and words come from compare-data.js.
import { addDays, fullLabel, label as dateLabel, today as todayIso } from '../core/dates.js';
import { esc, plural } from '../core/format.js';
import { closeSheet, ICON, openSheet, store } from '../core/ui.js';
import { compareChart, tableToggle } from './chart.js';
import {
  availableItems, COMPARE_RANGES, compareRange, defaultKeys, foodKey, isYes, itemOf, MAX_ITEMS, pairSummaries, prepare, rangeDates,
  seriesOf, valueWords,
} from './compare-data.js';

let state = null; // { prep, dates, range, available }
let chart = null;

const rangeKey = () => compareRange(store.get('compare-range', '90')).key;

/** The picked items: saved per device. The first visit picks sleep (or a measurement) and the top symptom. */
function pickedKeys() {
  const saved = store.get('compare-items', null);
  const keys = Array.isArray(saved) ? saved : defaultKeys(state.available);
  return [...new Set(keys)].filter(k => itemOf(k)).slice(0, MAX_ITEMS);
}
const savePicked = keys => store.set('compare-items', keys);

/** Picked items with their values. Number lanes get a color each (lane-1 … lane-4);
    symptoms use the severity colors, food uses ink. */
function lanes() {
  let n = 0;
  return pickedKeys().map(key => {
    const item = itemOf(key);
    const cls = item.kind === 'num' ? `lane-${++n}` : item.group === 'Food' ? 'lane-food' : 'lane-symptom';
    return { item, s: seriesOf(item, state.prep, state.dates), cls };
  });
}

const cellClass = (l, v) => (v == null ? 'cell-empty' : v === 0 ? 'cell-none'
  : l.item.group === 'Food' ? `cell-yes ${l.cls}` : v === -1 ? 'cell-unset' : `cell-sev-${v}`);

// ---------- Pieces

function pickedList(ls) {
  const chip = l => `<li class="cmp-pick ${l.cls}">
      <i class="cmp-swatch" aria-hidden="true"></i><span>${esc(l.item.label)}</span>
      <button type="button" class="icon-btn" data-act="cmp-remove" data-key="${esc(l.item.key)}" aria-label="Remove ${esc(l.item.label)}">${ICON.x}</button></li>`;
  const add = ls.length < MAX_ITEMS
    ? `<li><button type="button" class="btn small" data-act="cmp-add">${ICON.plus}${ls.length ? 'Add' : 'Choose what to compare'}</button></li>` : '';
  return `<ul class="cmp-picked" aria-label="Compared">${ls.map(chip).join('')}${add}</ul>`;
}

function rangeSeg() {
  const key = rangeKey();
  return `<div class="seg cmp-range" role="group" aria-label="Period">${COMPARE_RANGES.map(r =>
    `<button type="button" data-act="cmp-range" data-value="${r.key}" aria-pressed="${r.key === key}">${esc(r.short)}</button>`).join('')}</div>`;
}

/** The first event lane shades its days in all lanes: you see what the numbers did on those days. */
const shadeLane = ls => (ls.length > 1 ? ls.find(l => l.item.kind === 'event') : null);

function legend(ls) {
  const sh = shadeLane(ls);
  const items = [];
  if (ls.some(l => l.item.style === 'severity')) {
    items.push('<li><i class="chart-key cell-sev-1" aria-hidden="true"></i>Mild</li>', '<li><i class="chart-key cell-sev-2" aria-hidden="true"></i>Moderate</li>',
      '<li><i class="chart-key cell-sev-3" aria-hidden="true"></i>Severe</li>');
  }
  if (ls.some(l => l.item.key === 'm:bp')) items.push('<li><i class="chart-key is-dashed" aria-hidden="true"></i>Blood pressure: bottom number</li>');
  if (ls.some(l => l.item.kind === 'event')) items.push('<li><i class="chart-key cell-empty" aria-hidden="true"></i>Not written</li>');
  if (sh) items.push(`<li><i class="chart-key key-shade" aria-hidden="true"></i>Shaded: days with ${esc(sh.item.label.toLowerCase())}</li>`);
  return items.length ? `<ul class="chart-legend heat-legend cmp-legend" aria-label="Legend">${items.join('')}</ul>` : '';
}

function tableHtml(ls) {
  const rows = state.dates.map((d, j) => ({ d, j })).reverse().filter(({ j }) => ls.some(l => l.s.values[j] != null));
  return `<div class="table-wrap" id="cmp-chart-table" hidden>
    <table class="table"><caption class="sr-only">${esc(ls.map(l => l.item.label).join(', '))}, per day</caption>
    <thead><tr><th scope="col">Date</th>${ls.map(l => `<th scope="col">${esc(l.item.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(({ d, j }) => `<tr><th scope="row">${esc(fullLabel(d))}</th>${ls.map(l => `<td>${esc(valueWords(l.item, l.s, j))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

function wordsHtml(ls) {
  if (ls.length < 2) return '';
  const pairs = pairSummaries(ls.map(l => l.item), ls.map(l => l.s));
  return `<div class="cmp-words">
    <h3 class="cmp-words-title">In words</h3>
    <ul>${pairs.map(p => `<li>${esc(p.text)}${p.small && p.type !== 'few' ? ' <span class="pill caution">Few days</span>' : ''}</li>`).join('')}</ul>
    <p class="hint">This shows what happened on the same days. It does not show that one thing causes the other.</p>
  </div>`;
}

function cardHtml() {
  const ls = lanes();
  const range = compareRange(rangeKey());
  const withData = ls.some(l => l.s.values.some(v => v != null));
  let body;
  if (!ls.length) {
    body = `<div class="empty trend-empty">${ICON.activity}<p><strong>Nothing to compare yet.</strong></p>
      <p>${state.available.groups.length ? 'Choose 2 things, for example your sleep and a symptom.' : 'Write in your diary for some days, or add measurements. Then come back here.'}</p></div>`;
  } else if (!withData) {
    body = `<p class="hint chart-none">No values in the last ${esc(range.short)}. Choose a longer period.</p>`;
  } else {
    body = `${legend(ls)}
      <div class="chart-box" id="cmp-chart"></div>
      ${tableHtml(ls)}
      <div class="trend-tools">${tableToggle('cmp-chart')}</div>
      ${ls.length === 1 ? '<p class="hint">Add one more thing to see them together.</p>' : ''}
      ${wordsHtml(ls)}`;
  }
  return `<section class="card trend-card cmp-card" id="cmp-card" aria-labelledby="cmp-title">
    <div class="card-head"><h2 id="cmp-title" class="trend-title" tabindex="-1">${ICON.activity}Compare</h2></div>
    <p class="hint">See 2 to 4 things on the same days: a measurement and a symptom, your sleep and coffee, a food and how you feel.</p>
    ${pickedList(ls)}
    ${ls.length ? rangeSeg() : ''}
    ${body}
  </section>`;
}

/** Values as the chart draws them (sleep: minutes → hours). */
const scaled = (item, vals) => (item.scale ? vals.map(v => (v == null ? null : v * item.scale)) : vals);

function mount() {
  if (chart) chart.destroy();
  chart = null;
  const host = document.getElementById('cmp-chart');
  if (!host) return;
  const ls = lanes();
  const sh = shadeLane(ls);
  chart = compareChart(host, {
    label: `${ls.map(l => l.item.label).join(', ')}, last ${compareRange(rangeKey()).short}`,
    dates: state.dates,
    lanes: ls.map(l => ({
      name: l.item.label, kind: l.item.kind, style: l.item.style, values: scaled(l.item, l.s.values), values2: l.s.values2,
      cls: l.cls, axis: l.item.axis, minSpan: l.item.minSpan, sparse: l.item.sparse, cellClass: v => cellClass(l, v),
    })),
    shade: sh ? sh.s.values.map(isYes) : null,
    tip: j => ({
      title: dateLabel(state.dates[j]),
      lines: ls.map(l => ({ text: `${l.item.label}: ${valueWords(l.item, l.s, j)}`, key: l.item.kind === 'num' ? l.cls : '' })),
    }),
  });
}

function redraw(focusSel) {
  const card = document.getElementById('cmp-card');
  if (!card) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = cardHtml();
  card.replaceWith(tmp.firstElementChild);
  mount();
  if (focusSel) (document.querySelector(focusSel) || document.getElementById('cmp-title')).focus();
}

// ---------- Picker (bottom sheet)

function pickerHtml() {
  const keys = pickedKeys();
  const full = keys.length >= MAX_ITEMS;
  // Picked items stay in the list, also when they have no value in this period.
  const groups = state.available.groups.map(g => ({ ...g, items: [...g.items] }));
  for (const k of keys) {
    if (groups.some(g => g.items.some(i => i.key === k))) continue;
    const it = itemOf(k);
    let g = groups.find(x => x.name === it.group);
    if (!g) { g = { name: it.group, items: [] }; groups.push(g); }
    g.items.push({ ...it, days: seriesOf(it, state.prep, state.dates).values.filter(it.kind === 'num' ? v => v != null : isYes).length });
  }
  const chip = i => {
    const on = keys.includes(i.key);
    return `<button type="button" class="chip" data-act="cmp-toggle" data-key="${esc(i.key)}" aria-pressed="${on}"${full && !on ? ' disabled' : ''}>
      ${on ? ICON.check : ''}${esc(i.label)}<span class="cmp-days">${esc(plural(i.days, 'day'))}</span></button>`;
  };
  return `<p class="hint" id="cmp-pick-hint">${full ? `You compare ${MAX_ITEMS} things. Remove one to add another.` : `Choose up to ${MAX_ITEMS}. The number is the days with a value in the last ${esc(compareRange(rangeKey()).short)}.`}</p>
    ${groups.map(g => `<h3 class="cmp-group">${esc(g.name)}</h3><div class="chips">${g.items.map(chip).join('')}</div>`).join('')}
    ${groups.some(g => g.name === 'Food') ? '' : '<h3 class="cmp-group">Food</h3>'}
    <form class="cmp-food" data-form="cmp-food" autocomplete="off">
      <label class="field"><span>A food or drink in your meals</span>
        <input name="word" type="text" maxlength="40" placeholder="For example: pizza, cheese, wine" enterkeyhint="done"${full ? ' disabled' : ''}></label>
      <button type="submit" class="btn small"${full ? ' disabled' : ''}>${ICON.plus}Add</button>
    </form>
    <div class="btn-row cmp-done"><button type="button" class="btn primary wide" data-sheet-close>Done</button></div>`;
}

function openPicker() {
  const refresh = (body, focusKey) => {
    body.innerHTML = pickerHtml();
    if (focusKey) body.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  };
  const body = openSheet({
    title: 'Compare',
    html: pickerHtml(),
    onAction(act, el) {
      if (act !== 'cmp-toggle') return;
      const k = el.dataset.key;
      const keys = pickedKeys();
      savePicked(keys.includes(k) ? keys.filter(x => x !== k) : [...keys, k].slice(0, MAX_ITEMS));
      refresh(body, k);
    },
    onSubmit(form) {
      const w = foodKey(form.elements.word.value);
      if (w.length < 2) { form.elements.word.focus(); return; }
      const keys = pickedKeys();
      if (keys.length < MAX_ITEMS && !keys.includes(`f:${w}`)) savePicked([...keys, `f:${w}`]);
      refresh(body, `f:${w}`);
    },
    onClose() { setTimeout(() => redraw('[data-act="cmp-add"]'), 0); },
  });
}

// ---------- Screen (Trends shows it when the address is #trends/compare)

export default {
  async render(ctx) {
    const today = todayIso();
    const range = compareRange(rangeKey());
    const [measurements, days] = await Promise.all([
      ctx.api.listMeasurements(null, addDays(today, -(range.days - 1)), today),
      ctx.api.listDays(addDays(today, -(range.days - 1)), today),
    ]);
    const dates = rangeDates(today, range.days);
    const prep = prepare(days, measurements, today);
    state = { prep, dates, range, available: availableItems(prep, dates) };
    return cardHtml();
  },

  mounted() { mount(); },

  leave() {
    closeSheet();
    if (chart) chart.destroy();
    chart = null;
  },

  actions: {
    'cmp-add'() { openPicker(); },
    'cmp-remove'(el) {
      const keys = pickedKeys().filter(k => k !== el.dataset.key);
      savePicked(keys);
      redraw(keys.length ? '.cmp-pick button' : '[data-act="cmp-add"]');
    },
    async 'cmp-range'(el, e, ctx) {
      store.set('compare-range', el.dataset.value);
      await ctx.refresh();
      document.querySelector(`[data-act="cmp-range"][data-value="${CSS.escape(el.dataset.value)}"]`)?.focus();
    },
  },
};
