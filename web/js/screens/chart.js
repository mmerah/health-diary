// Chart helpers shared by the Trends charts: scales, ticks, an SVG line chart, a strip heatmap,
// a tooltip with crosshair, and keyboard navigation.
//
// Charts are drawn in pixels from the width of their container (ResizeObserver), so text stays
// 12px at every size. Colors come from CSS tokens only: every mark has a class, body.css paints it.
// No inline style attributes (strict CSP): sizes and positions are set with SVG attributes or CSSOM.
import { esc } from '../core/format.js';

export const DAY_MS = 86400000;

// ---------- Pure helpers (unit-tested in tests/chart.test.js)

/** A "nice" step near raw: 1, 2, 2.5 or 5 × 10^n. */
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

const round6 = v => Math.round(v * 1e6) / 1e6;

/**
 * The y range for some values: at least minSpan wide, a little padding, snapped to nice ticks.
 * yDomain([77.1, 78.6], { minSpan: 4 }) → { lo: 74, hi: 80, step: 2, ticks: [74, 76, 78, 80] } (about)
 */
export function yDomain(values, { minSpan = 1, count = 4 } = {}) {
  const v = values.filter(Number.isFinite);
  let lo = v.length ? Math.min(...v) : 0;
  let hi = v.length ? Math.max(...v) : minSpan;
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  } else {
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
  }
  // Try a few tick counts and keep the tightest range: less empty space above and below the data.
  let best = null;
  for (let c = count; c <= count + 2; c++) {
    const step = niceStep((hi - lo) / (c - 1));
    const l = round6(Math.floor(lo / step) * step), h = round6(Math.ceil(hi / step) * step);
    if (Math.round((h - l) / step) + 1 > count + 2) continue;
    if (!best || h - l < best.hi - best.lo) best = { lo: l, hi: h, step };
  }
  const { step } = best;
  lo = best.lo; hi = best.hi;
  const ticks = [];
  for (let x = lo; x <= hi + step / 1e6; x += step) ticks.push(round6(x));
  return { lo, hi, step, ticks };
}

/** Linear scale from [d0, d1] to [r0, r1]. */
export const scale = (d0, d1, r0, r1) => v => r0 + ((v - d0) / ((d1 - d0) || 1)) * (r1 - r0);

/** Up to `max` date ticks (ms, local midnight) spread from t0 to t1, both ends included. */
export function timeTicks(t0, t1, max = 4) {
  const midnight = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((t1 - t0) / DAY_MS);
  if (days < 1) return [midnight(t0)];
  const n = Math.max(2, Math.min(max, days + 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = midnight(t0 + Math.round((i * (t1 - t0)) / (n - 1)));
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Tick text for a date: "12 Oct", or "Oct 26" when the chart spans most of a year or more. */
export function tickLabel(t, spanMs) {
  const d = new Date(t);
  return spanMs > 300 * DAY_MS
    ? d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Index of the value in xs (sorted) nearest to x. */
export function nearestIndex(xs, x) {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
  return best;
}

/** Index after a navigation key, or null for other keys. */
export function stepIndex(key, i, n) {
  if (!n) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return Math.min(n - 1, i < 0 ? n - 1 : i + 1);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return Math.max(0, i < 0 ? n - 1 : i - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return null;
}

/** SVG path through points; null values break the line. */
export function linePath(points) {
  let d = '', pen = false;
  for (const p of points) {
    if (p == null || !Number.isFinite(p[1])) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}

// ---------- Shared DOM pieces

const LABEL_PX = 7.2; // average width of a 12px digit in the data font, for the y-axis gutter

/** Tooltip HTML: a title and lines; each line can carry a series key (class) for its swatch. */
function tipHtml({ title, lines = [] }) {
  return `<strong>${esc(title)}</strong>${lines.map(l => `<span>${l.key ? `<i class="chart-key ${esc(l.key)}" aria-hidden="true"></i>` : ''}${esc(l.text)}</span>`).join('')}`;
}
const tipText = ({ title, lines = [] }) => `${lines.map(l => l.text).join(', ')}. ${title}.`;

/** Puts the tooltip above (or below, near the top) of point (x, y) inside host. */
function placeTip(tip, host, x, y) {
  tip.hidden = false;
  const w = tip.offsetWidth, W = host.clientWidth;
  tip.style.left = `${Math.round(Math.min(Math.max(x, w / 2 + 2), W - w / 2 - 2))}px`;
  tip.style.top = `${Math.round(y)}px`;
  tip.classList.toggle('is-below', y < tip.offsetHeight + 16);
}

/** Sets up the container: focusable group with a hidden live region. */
function frame(host, label) {
  host.classList.add('chart');
  host.tabIndex = 0;
  host.setAttribute('role', 'group');
  host.setAttribute('aria-roledescription', 'chart');
  host.setAttribute('aria-label', label);
  host.innerHTML = '<svg class="chart-svg" aria-hidden="true" focusable="false"></svg><div class="chart-tip" hidden></div><p class="sr-only" aria-live="polite"></p>';
  return { svg: host.querySelector('svg'), tip: host.querySelector('.chart-tip'), live: host.querySelector('p') };
}

/** Redraws on width change. Returns a function that stops it. */
function onWidth(host, draw) {
  let w = 0;
  const run = () => { const nw = Math.round(host.clientWidth); if (nw && nw !== w) { w = nw; draw(nw); } };
  run();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver(run);
  ro.observe(host);
  return () => ro.disconnect();
}

// ---------- Line chart

/**
 * lineChart(host, {
 *   label: 'Weight',                       // accessible name
 *   rows: [{ t: ms, v: [78.1], ... }],     // sorted by t; v has one value per series (null = no value)
 *   series: [{ key: 'series-weight', name: 'Weight', dashed: false }],
 *   domain: [t0, t1],                      // x range (default: first to last row)
 *   minSpan: 4, include: [145],            // y range: minimum span, values that must be visible
 *   yFormat: v => '78', area: true,        // area fill under the first series
 *   band: { from: 140, label: 'High', cls }, // shaded y band; open at the top (no `to`) or bottom (no `from`)
 *   refLines: [{ v: 90, label: '90' }],
 *   endLabels: true,                       // series names at the right end (multi-series)
 *   tip: row => ({ title, lines: [{ text, key }] }),
 *   height: 200,
 * }) → { destroy() }
 */
export function lineChart(host, o) {
  const rows = o.rows;
  const n = rows.length;
  const { svg, tip, live } = frame(host, `${o.label}. ${n} ${n === 1 ? 'value' : 'values'}. Use the arrow keys to read each value.`);
  const H = o.height || 200;
  let geo = null, active = -1;

  function draw(W) {
    const fmtY = o.yFormat || (v => String(v));
    const vals = rows.flatMap(r => r.v).concat(o.include || []);
    const y = yDomain(vals, { minSpan: o.minSpan || 1, count: o.ticks || 4 });
    const L = Math.ceil(Math.max(...y.ticks.map(t => fmtY(t).length)) * LABEL_PX) + 10;
    const R = o.endLabels ? 40 : 14, T = 10, B = 28;
    const [t0, t1] = o.domain || [rows[0].t, rows[n - 1].t];
    const sx = t1 > t0 ? scale(t0, t1, L + 6, W - R - 6) : () => (L + W - R) / 2;
    const sy = scale(y.lo, y.hi, H - B, T);
    let s = '';

    if (o.band) {
      // A band can be open on one side: from a value to the top, or from the bottom to a value.
      const from = o.band.from ?? -Infinity, to = o.band.to ?? Infinity, cls = o.band.cls ? ` ${esc(o.band.cls)}` : '';
      if (from < y.hi && to > y.lo) {
        const top = sy(Math.min(y.hi, to)), bot = sy(Math.max(y.lo, from));
        s += `<rect class="chart-band${cls}" x="${L}" y="${top.toFixed(1)}" width="${W - L - R}" height="${(bot - top).toFixed(1)}"/>`;
        if (o.band.label) s += `<text class="chart-band-label${cls}" x="${L + 8}" y="${(top + 15).toFixed(1)}">${esc(o.band.label)}</text>`;
      }
    }
    for (const v of y.ticks) {
      const py = sy(v).toFixed(1);
      s += `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${py}" y2="${py}"/>`;
      s += `<text class="chart-axis" x="${L - 8}" y="${py}" dy="4" text-anchor="end">${esc(fmtY(v))}</text>`;
    }
    for (const r of o.refLines || []) {
      if (r.v < y.lo || r.v > y.hi) continue;
      const py = sy(r.v).toFixed(1);
      s += `<line class="chart-ref" x1="${L}" x2="${W - R}" y1="${py}" y2="${py}"/>`;
      if (r.label) s += `<text class="chart-band-label" x="${L + 8}" y="${py}" dy="-6">${esc(r.label)}</text>`;
    }
    const ticks = timeTicks(t0, t1, W < 420 ? 3 : 4);
    ticks.forEach((t, i) => {
      const anchor = ticks.length === 1 ? 'middle' : i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle';
      const px = ticks.length === 1 ? sx(t) : i === 0 ? L : i === ticks.length - 1 ? W - R : sx(t);
      s += `<text class="chart-axis" x="${px.toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${esc(tickLabel(t, t1 - t0))}</text>`;
    });
    const xs = rows.map(r => sx(r.t));
    o.series.forEach((ser, k) => {
      const pts = rows.map((r, i) => (Number.isFinite(r.v[k]) ? [xs[i], sy(r.v[k])] : null));
      const d = linePath(pts);
      if (o.area && k === 0) {
        const real = pts.filter(Boolean);
        if (real.length > 1) {
          s += `<path class="chart-area ${esc(ser.key)}" d="${d}L${real[real.length - 1][0].toFixed(1)},${(H - B).toFixed(1)}L${real[0][0].toFixed(1)},${(H - B).toFixed(1)}Z"/>`;
        }
      }
      s += `<path class="chart-line ${esc(ser.key)}${ser.dashed ? ' is-dashed' : ''}" d="${d}"/>`;
    });
    s += `<line class="chart-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
    o.series.forEach((ser, k) => {
      rows.forEach((r, i) => {
        if (!Number.isFinite(r.v[k])) return;
        s += `<circle class="chart-dot ${esc(ser.key)}${ser.dashed ? ' is-hollow' : ''}" data-i="${i}" cx="${xs[i].toFixed(1)}" cy="${sy(r.v[k]).toFixed(1)}" r="4"/>`;
      });
      if (o.endLabels) {
        const last = [...rows].reverse().find(r => Number.isFinite(r.v[k]));
        if (last) s += `<text class="chart-end-label" x="${W - R + 6}" y="${sy(last.v[k]).toFixed(1)}" dy="4">${esc(ser.short || ser.name)}</text>`;
      }
    });
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = s;
    geo = { xs, top: i => Math.min(...rows[i].v.filter(Number.isFinite).map(sy)) };
    if (active >= 0) show(active, false);
  }

  function show(i, announce) {
    active = i;
    const cross = svg.querySelector('.chart-cross');
    cross.setAttribute('x1', geo.xs[i]);
    cross.setAttribute('x2', geo.xs[i]);
    cross.setAttribute('visibility', 'visible');
    svg.querySelectorAll('.chart-dot.is-active').forEach(c => c.classList.remove('is-active'));
    svg.querySelectorAll(`.chart-dot[data-i="${i}"]`).forEach(c => c.classList.add('is-active'));
    const t = o.tip(rows[i]);
    tip.innerHTML = tipHtml(t);
    placeTip(tip, host, geo.xs[i], geo.top(i));
    if (announce) live.textContent = tipText(t);
  }
  function hide() {
    active = -1;
    tip.hidden = true;
    const cross = svg.querySelector('.chart-cross');
    if (cross) cross.setAttribute('visibility', 'hidden');
    svg.querySelectorAll('.chart-dot.is-active').forEach(c => c.classList.remove('is-active'));
  }

  const point = e => {
    if (!geo) return;
    const x = e.clientX - svg.getBoundingClientRect().left;
    show(nearestIndex(geo.xs, x), false);
  };
  svg.addEventListener('pointermove', point);
  svg.addEventListener('pointerdown', point);
  svg.addEventListener('pointerleave', () => { if (document.activeElement !== host) hide(); });
  host.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hide(); return; }
    const i = stepIndex(e.key, active, n);
    if (i == null) return;
    e.preventDefault();
    show(i, true);
  });
  host.addEventListener('focus', () => { if (active < 0 && geo) show(n - 1, true); });
  host.addEventListener('blur', hide);

  const stop = onWidth(host, draw);
  return { destroy: stop };
}

// ---------- Strip heatmap: one row per item, one cell per day

/**
 * stripHeatmap(host, {
 *   label: 'Symptoms, last 8 weeks',
 *   dates: ['2026-08-20', …],              // one per column
 *   rows: [{ name: 'Headache', cells: [value per date] }],
 *   cellClass: value => 'cell-sev-2',
 *   tip: (row, j) => ({ title, lines }),
 * }) → { destroy() }
 * Keyboard: left and right move between days, up and down between rows.
 */
export function stripHeatmap(host, o) {
  const { svg, tip, live } = frame(host, `${o.label}. Use the arrow keys to read each day.`);
  const D = o.dates.length, N = o.rows.length;
  const NAME_H = 20, STRIP_H = 22, ROW_GAP = 10, AXIS_H = 22;
  const H = N * (NAME_H + STRIP_H + ROW_GAP) + AXIS_H;
  let geo = null, at = null; // at = [row, col]

  function draw(W) {
    const cw = W / D;
    const gap = cw >= 6 ? 1.5 : 0.75;
    let s = '';
    o.rows.forEach((row, r) => {
      const y0 = r * (NAME_H + STRIP_H + ROW_GAP);
      s += `<text class="chart-row-label" x="0" y="${y0 + 14}">${esc(row.name)}</text>`;
      row.cells.forEach((v, j) => {
        s += `<rect class="chart-cell ${esc(o.cellClass(v))}" data-r="${r}" data-j="${j}" x="${(j * cw + gap / 2).toFixed(2)}" y="${y0 + NAME_H}" width="${Math.max(0.5, cw - gap).toFixed(2)}" height="${STRIP_H}" rx="${cw >= 8 ? 2 : 0}"/>`;
      });
    });
    const t0 = o.dates[0], t1 = o.dates[D - 1];
    const toMs = s2 => { const [y, m, d] = s2.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
    const ticks = timeTicks(toMs(t0), toMs(t1), W < 420 ? 3 : 4);
    const sx = scale(toMs(t0), toMs(t1), cw / 2, W - cw / 2);
    ticks.forEach((t, i) => {
      const anchor = i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle';
      const px = i === 0 ? 0 : i === ticks.length - 1 ? W : sx(t);
      s += `<text class="chart-axis" x="${px.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${esc(tickLabel(t, toMs(t1) - toMs(t0)))}</text>`;
    });
    s += `<rect class="chart-cell-focus" x="0" y="0" width="0" height="${STRIP_H}" visibility="hidden"/>`;
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = s;
    geo = { cw };
    if (at) show(at[0], at[1], false);
  }

  function show(r, j, announce) {
    at = [r, j];
    const ring = svg.querySelector('.chart-cell-focus');
    const y0 = r * (NAME_H + STRIP_H + ROW_GAP) + NAME_H;
    ring.setAttribute('x', (j * geo.cw).toFixed(2));
    ring.setAttribute('y', y0);
    ring.setAttribute('width', Math.max(2, geo.cw).toFixed(2));
    ring.setAttribute('visibility', 'visible');
    const t = o.tip(o.rows[r], j);
    tip.innerHTML = tipHtml(t);
    placeTip(tip, host, (j + 0.5) * geo.cw, y0);
    if (announce) live.textContent = tipText(t);
  }
  function hide() {
    at = null;
    tip.hidden = true;
    const ring = svg.querySelector('.chart-cell-focus');
    if (ring) ring.setAttribute('visibility', 'hidden');
  }

  const point = e => {
    if (!geo) return;
    const box = svg.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const r = Math.floor(y / (NAME_H + STRIP_H + ROW_GAP));
    if (r < 0 || r >= N) return hide();
    show(r, Math.max(0, Math.min(D - 1, Math.floor(x / geo.cw))), false);
  };
  svg.addEventListener('pointermove', point);
  svg.addEventListener('pointerdown', point);
  svg.addEventListener('pointerleave', () => { if (document.activeElement !== host) hide(); });
  host.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hide(); return; }
    let [r, j] = at || [0, D - 1];
    if (!at) { /* first key shows the latest day of the first row */ }
    else if (e.key === 'ArrowUp') r = Math.max(0, r - 1);
    else if (e.key === 'ArrowDown') r = Math.min(N - 1, r + 1);
    else {
      const k = stepIndex(e.key, j, D);
      if (k == null) return;
      j = k;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    show(r, j, true);
  });
  host.addEventListener('focus', () => { if (!at && geo) show(0, D - 1, true); });
  host.addEventListener('blur', hide);

  const stop = onWidth(host, draw);
  return { destroy: stop };
}

// ---------- Compare: lanes on the same days

/**
 * compareChart(host, {
 *   label: 'Sleep and headache, last 90 days',
 *   dates: ['2026-08-20', …],                  // one column per day, oldest first
 *   lanes: [{ name, kind: 'num'|'event', style: 'line'|'bar'|'severity'|'mark', values, values2,
 *             cls: 'lane-1', axis: v => '7h', minSpan, sparse, cellClass: v => 'cell-sev-2' }],
 *   shade: [true, false, …] | null,            // days to shade in all lanes (the days of the first event)
 *   tip: j => ({ title, lines }),
 * }) → { destroy() }
 * One crosshair and one tooltip for all lanes. Keyboard: left and right move between days.
 */
export function compareChart(host, o) {
  const { svg, tip, live } = frame(host, `${o.label}. Use the arrow keys to read each day.`);
  const D = o.dates.length;
  const NAME_H = 20, NUM_H = 72, EVENT_H = 20, GAP = 16, AXIS_H = 22, R = 6, NUM_PAD = 8;
  const laneH = l => (l.kind === 'num' ? NUM_H : EVENT_H);
  const padOf = l => (l.kind === 'num' ? NUM_PAD : 0); // room between the lane name and the top tick
  const H = o.lanes.reduce((s, l) => s + NAME_H + padOf(l) + laneH(l) + GAP, 0) + AXIS_H - GAP;
  const toMs = s2 => { const [y, m, d] = s2.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  let geo = null, at = -1;

  /** The y range of a number lane. Bars start at 0. */
  function yOf(l) {
    const vals = l.values.concat(l.values2 || []).filter(Number.isFinite);
    if (l.style !== 'bar') return yDomain(vals, { minSpan: l.minSpan || 1, count: 3 });
    const step = niceStep(Math.max(l.minSpan || 1, ...vals) / 2);
    const hi = Math.max(step * 2, Math.ceil(Math.max(0, ...vals) / step) * step);
    const ticks = [];
    for (let x = 0; x <= hi + step / 1e6; x += step) ticks.push(round6(x));
    return { lo: 0, hi, ticks };
  }

  function draw(W) {
    const ys = o.lanes.map(l => (l.kind === 'num' ? yOf(l) : null));
    const L = Math.max(12, ...o.lanes.map((l, k) => (ys[k] ? Math.ceil(Math.max(...ys[k].ticks.map(t => l.axis(t).length)) * LABEL_PX) + 10 : 0)));
    const cw = (W - L - R) / D;
    const cx = j => L + (j + 0.5) * cw;
    const gap = cw >= 6 ? 1.5 : cw >= 3 ? 0.75 : 0;
    const bottom = H - AXIS_H;
    let s = '';
    if (o.shade) {
      o.shade.forEach((on, j) => { if (on) s += `<rect class="cmp-shade" x="${(L + j * cw).toFixed(2)}" y="0" width="${cw.toFixed(2)}" height="${bottom}"/>`; });
    }
    const tops = [];
    let y0 = 0;
    o.lanes.forEach((l, k) => {
      s += `<text class="chart-row-label" x="0" y="${y0 + 14}">${esc(l.name)}</text>`;
      const top = y0 + NAME_H + padOf(l), h = laneH(l);
      tops.push({ top, h });
      if (l.kind === 'num') {
        const y = ys[k], sy = scale(y.lo, y.hi, top + h, top);
        for (const t of y.ticks) {
          const py = sy(t).toFixed(1);
          s += `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${py}" y2="${py}"/>`;
          s += `<text class="chart-axis" x="${L - 8}" y="${py}" dy="4" text-anchor="end">${esc(l.axis(t))}</text>`;
        }
        if (l.style === 'bar') {
          const bw = Math.max(1, Math.min(cw - gap, 14));
          l.values.forEach((v, j) => {
            if (!Number.isFinite(v)) return;
            const py = sy(v);
            s += v === 0
              ? `<rect class="cmp-bar-zero ${l.cls}" x="${(cx(j) - bw / 2).toFixed(2)}" y="${(top + h - 1.5).toFixed(1)}" width="${bw.toFixed(2)}" height="1.5"/>`
              : `<rect class="cmp-bar ${l.cls}" x="${(cx(j) - bw / 2).toFixed(2)}" y="${py.toFixed(1)}" width="${bw.toFixed(2)}" height="${(top + h - py).toFixed(1)}" rx="${bw >= 6 ? 1.5 : 0}"/>`;
          });
        } else {
          for (const [vals, dashed] of [[l.values, false], [l.values2, true]]) {
            if (!vals) continue;
            let pts = vals.map((v, j) => (Number.isFinite(v) ? [cx(j), sy(v)] : null));
            if (l.sparse) pts = pts.filter(Boolean); // a few readings: join them across the empty days
            s += `<path class="chart-line ${l.cls}${dashed ? ' is-dashed' : ''}" d="${linePath(pts)}"/>`;
            if (l.sparse || D <= 31) {
              vals.forEach((v, j) => { if (Number.isFinite(v)) s += `<circle class="chart-dot ${l.cls}${dashed ? ' is-hollow' : ''}" cx="${cx(j).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="3"/>`; });
            }
          }
        }
        tops[k].sy = sy;
      } else {
        l.values.forEach((v, j) => {
          s += `<rect class="chart-cell ${esc(l.cellClass(v))}" x="${(L + j * cw + gap / 2).toFixed(2)}" y="${top}" width="${Math.max(0.5, cw - gap).toFixed(2)}" height="${h}" rx="${cw >= 8 ? 2 : 0}"/>`;
        });
      }
      y0 = top + h + GAP;
    });
    const t0 = toMs(o.dates[0]), t1 = toMs(o.dates[D - 1]);
    const sx = scale(t0, t1, cx(0), cx(D - 1));
    const ticks = timeTicks(t0, t1, W < 420 ? 3 : 4);
    ticks.forEach((t, i) => {
      const anchor = i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle';
      const px = i === 0 ? L : i === ticks.length - 1 ? W - R : sx(t);
      s += `<text class="chart-axis" x="${px.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${esc(tickLabel(t, t1 - t0))}</text>`;
    });
    s += `<line class="chart-cross" x1="0" x2="0" y1="0" y2="${bottom}" visibility="hidden"/><g class="cmp-active"></g>`;
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = s;
    geo = { L, cw, cx, tops };
    if (at >= 0) show(at, false);
  }

  function show(j, announce) {
    at = j;
    const x = geo.cx(j);
    const cross = svg.querySelector('.chart-cross');
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    // Bigger dots on the day, in the number lanes.
    let dots = '';
    o.lanes.forEach((l, k) => {
      if (l.kind !== 'num' || l.style === 'bar') return;
      for (const [vals, hollow] of [[l.values, false], [l.values2, true]]) {
        if (vals && Number.isFinite(vals[j])) dots += `<circle class="chart-dot is-active ${l.cls}${hollow ? ' is-hollow' : ''}" cx="${x.toFixed(1)}" cy="${geo.tops[k].sy(vals[j]).toFixed(1)}" r="5"/>`;
      }
    });
    svg.querySelector('.cmp-active').innerHTML = dots;
    const t = o.tip(j);
    tip.innerHTML = tipHtml(t);
    placeTip(tip, host, x, 0);
    if (announce) live.textContent = tipText(t);
  }
  function hide() {
    at = -1;
    tip.hidden = true;
    const cross = svg.querySelector('.chart-cross');
    if (cross) cross.setAttribute('visibility', 'hidden');
    const g = svg.querySelector('.cmp-active');
    if (g) g.innerHTML = '';
  }

  const point = e => {
    if (!geo) return;
    const x = e.clientX - svg.getBoundingClientRect().left;
    show(Math.max(0, Math.min(D - 1, Math.floor((x - geo.L) / geo.cw))), false);
  };
  svg.addEventListener('pointermove', point);
  svg.addEventListener('pointerdown', point);
  svg.addEventListener('pointerleave', () => { if (document.activeElement !== host) hide(); });
  host.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hide(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    show(stepIndex(e.key, at, D), true);
  });
  host.addEventListener('focus', () => { if (at < 0 && geo) show(D - 1, true); });
  host.addEventListener('blur', hide);

  const stop = onWidth(host, draw);
  return { destroy: stop };
}

// ---------- "Show as table" toggle

/** A button that swaps a chart and its table. The screen handles data-act="chart-table". */
export function tableToggle(id) {
  return `<button type="button" class="btn ghost small chart-toggle" data-act="chart-table" data-target="${esc(id)}" aria-expanded="false" aria-controls="${esc(id)}-table">Show as table</button>`;
}

/** Handles a click on a tableToggle button. */
export function toggleTable(btn, root) {
  const id = btn.dataset.target;
  const table = root.querySelector(`#${CSS.escape(id)}-table`);
  const chart = root.querySelector(`#${CSS.escape(id)}`);
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? 'Show as chart' : 'Show as table';
  if (table) table.hidden = !open;
  if (chart) chart.hidden = open;
}
