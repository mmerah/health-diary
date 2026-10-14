// The app: five screens rendered into #view. One set of event listeners on #view handles all of them.
(function () {
  const { Dates, esc, fmtMin, num, pad, emptyLog } = U;
  const api = window.Api;
  const view = document.getElementById('view');
  const statusEl = document.getElementById('save-status');

  const SYMPTOMS = ['Fatigue', 'Headache', 'Palpitations', 'Dizziness', 'Short of breath', 'Chest tightness',
    'Bloating', 'Nausea', 'Back pain', 'Joint pain'];
  const SEV = ['', 'Mild', 'Moderate', 'Severe'];
  const DRINKS = [['water', 'Water', 'glasses'], ['coffee', 'Coffee', 'cups'], ['alcohol', 'Alcohol', 'drinks']];
  const TABS = ['today', 'body', 'docs', 'report', 'profile'];
  // The iPhone shortcut that reads Apple Health and sends it to the server.
  const SHORTCUT_URL = 'shortcuts://run-shortcut?name=Health%20Diary';
  // Apple Health data can only come from the iPhone. Other devices show the data but cannot sync.
  const IS_IPHONE = /iPhone/.test(navigator.userAgent);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('hd-ui-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('hd-ui-' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };

  const state = {
    tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get('tab', 'today'),
    date: Dates.today(),
    log: null,
    regularMeds: [],
    profile: null,
    bodyRange: store.get('bodyRange', 90),
    armed: null, // id of a delete button waiting for its second tap
    user: null, // the logged-in user (server mode)
    report: Object.assign({ period: 90, from: null, to: null, mode: 'llm', relativeDates: true, question: '',
      include: { profile: true, body: true, health: true, log: true, docs: true } }, store.get('report', {})),
  };

  // ---------- Small UI helpers

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }
  function setStatus(msg) { statusEl.textContent = msg; }
  const nowHm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  // Current time for a new entry on today's page, empty on other days.
  const defaultTime = () => (state.date === Dates.today() ? nowHm() : '');
  const lines = s => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  async function guard(fn) {
    try { await fn(); } catch (e) { console.error(e); toast(`Could not save. ${e.message}`); setStatus('Not saved'); }
  }
  function relDay(date) {
    const n = Dates.diff(Dates.today(), date);
    return n === 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days ago`;
  }
  const longDate = s => Dates.label(s, { day: 'numeric', month: 'short', year: 'numeric' });

  // ---------- Navigation

  function setTab(tab) {
    state.tab = tab;
    store.set('tab', tab);
    document.querySelectorAll('.tabbar button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
    render();
    window.scrollTo(0, 0);
  }
  document.querySelector('.tabbar').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });

  async function render() {
    state.armed = null;
    setStatus('');
    try { await VIEWS[state.tab](); } catch (e) {
      console.error(e);
      view.innerHTML = `<div class="notice error">Could not load this screen. ${esc(e.message)}</div>`;
    }
  }

  // =====================================================================
  // TODAY
  // =====================================================================

  async function renderToday() {
    const d = state.date, today = Dates.today();
    const stripEnd = Dates.diff(today, d) < 14 ? today : Dates.add(d, 3);
    const [{ log, health }, strip, profile, measurements] = await Promise.all([
      api.getDay(d), api.listDays(Dates.add(stripEnd, -13), stripEnd), api.getProfile(), api.listMeasurements()]);
    const base = emptyLog();
    state.log = { ...base, ...(log || {}), drinks: { ...base.drinks, ...((log && log.drinks) || {}) }, meds: { ...base.meds, ...((log && log.meds) || {}) } };
    state.regularMeds = lines(profile.medications);
    const logged = new Set(strip.filter(x => x.log && Report.hasContent(x.log)).map(x => x.date));
    const L = state.log;

    const stripHtml = Array.from({ length: 14 }, (_, i) => {
      const x = Dates.add(stripEnd, i - 13);
      const dt = Dates.parse(x);
      return `<button class="strip-day${x === d ? ' is-current' : ''}" data-act="goto" data-date="${x}" aria-label="${Dates.label(x)}${logged.has(x) ? ', logged' : ''}">
        <span class="strip-wd">${dt.toLocaleDateString('en-GB', { weekday: 'narrow' })}</span>
        <span class="strip-n">${dt.getDate()}</span>
        <span class="strip-dot${logged.has(x) ? ' on' : ''}"></span></button>`;
    }).join('');

    view.innerHTML = `
      <div class="day-head">
        <button class="icon-btn" data-act="prev" aria-label="Previous day">${ICON.left}</button>
        <div class="day-title">
          <h1>${Dates.label(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h1>
          <span class="muted">${relDay(d)}</span>
        </div>
        <button class="icon-btn" data-act="next" aria-label="Next day" ${d >= today ? 'disabled' : ''}>${ICON.right}</button>
      </div>
      <div class="strip" role="group" aria-label="Last 14 days">${stripHtml}</div>

      <!-- Phone: one column in the order o1..o8. Desktop: writing on the left, numbers on the right. -->
      <div class="cols">
      <div class="col">
      <section class="block o2">
        <h2>Meals</h2>
        ${mealRow('breakfast', 'Breakfast', L.meals.breakfast)}
        ${mealRow('lunch', 'Lunch', L.meals.lunch)}
        <div class="meal">
          <div class="meal-head"><span class="label">Snacks</span>
            <button class="btn small" data-act="add-snack">${ICON.plus} Add snack</button></div>
          <div id="snacks">${snacksHtml(L.snacks)}</div>
        </div>
        ${mealRow('dinner', 'Dinner', L.meals.dinner)}
      </section>


      <section class="block o5">
        <h2><label for="activities">What I did</label></h2>
        <textarea id="activities" rows="3" data-field="activities" placeholder="Work, sport, walks, travel, rest…">${esc(L.activities)}</textarea>
        <p class="hint">Workouts recorded by your iPhone or watch come in automatically with Apple Health.</p>
      </section>


      <section class="block o6">
        <h2>Symptoms</h2>
        <div id="sym-list">${symptomsHtml(L.symptoms)}</div>
        <span class="label">Tap to add</span>
        <div class="chips">${SYMPTOMS.map(s => `<button class="chip" data-act="add-sym" data-s="${esc(s)}">${ICON.plus}${esc(s)}</button>`).join('')}</div>
        <form class="inline-form" data-form="symptom">
          <input id="symptom-new" type="text" placeholder="Other symptom" autocomplete="off" aria-label="Other symptom">
          <button class="btn small" type="submit">Add</button>
        </form>
      </section>


      <section class="block o7">
        <h2><label for="notes">Notes</label></h2>
        <textarea id="notes" rows="3" data-field="notes" placeholder="Anything else: stress, travel, what helped…">${esc(L.notes)}</textarea>
      </section>

      </div>
      <div class="col">
      ${healthCard(health, d)}

      <section class="block o3">
        <h2>Drinks</h2>
        <div class="counters">${DRINKS.map(([k, label, unit]) => `
          <div class="counter">
            <span class="label">${label}</span>
            <div class="stepper">
              <button data-act="dec" data-k="${k}" aria-label="One less ${label.toLowerCase()}">${ICON.minus}</button>
              <output id="drink-${k}" aria-live="polite">${L.drinks[k] || 0}</output>
              <button data-act="inc" data-k="${k}" aria-label="One more ${label.toLowerCase()}">${ICON.plus}</button>
            </div>
            <span class="unit">${unit}</span>
          </div>`).join('')}
        </div>
      </section>


      <section class="block o4">
        <div class="block-head"><h2>Medication</h2>
          <button class="btn small" data-act="add-med">${ICON.plus} Other</button></div>
        ${state.regularMeds.length
          ? `<div class="checks">${state.regularMeds.map((m, i) => `<label class="check"><input type="checkbox" id="med-${i}" data-med="${i}" ${L.meds.taken[m] ? 'checked' : ''}> ${esc(m)}</label>`).join('')}</div>`
          : '<p class="hint">Add your regular medication in Profile. It then shows here as a checklist.</p>'}
        <div id="xmeds">${xmedsHtml(L.meds.extra)}</div>
      </section>


      <section class="block o8">
        <h2>Measurements <span class="muted opt">optional</span></h2>
        <ul class="rows" id="day-m">${dayMeasurementsHtml(measurements.filter(m => m.date === d))}</ul>
        <div class="btn-row">
          <button class="btn small" data-act="m-open" data-t="weight">${ICON.plus} Weight</button>
          <button class="btn small" data-act="m-open" data-t="bp">${ICON.plus} Blood pressure</button>
          <button class="btn small" data-act="m-open" data-t="temp">${ICON.plus} Temperature</button>
        </div>
        ${measureForms()}
      </section>
      </div>
      </div>`;
    view.querySelector('.strip-day.is-current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function mealRow(key, label, m) {
    return `<div class="meal">
      <div class="meal-head"><label class="label" for="meal-${key}">${label}</label>
        <input class="time" type="time" id="meal-${key}-time" value="${esc(m.time)}" data-field="meals.${key}.time" aria-label="${label} time"></div>
      <textarea id="meal-${key}" rows="2" data-field="meals.${key}.text" placeholder="What did you eat?">${esc(m.text)}</textarea>
    </div>`;
  }
  function snacksHtml(snacks) {
    if (!snacks.length) return '<p class="hint">No snacks logged.</p>';
    return snacks.map((s, i) => `<div class="snack">
      <input class="time" type="time" id="snack-${i}-time" value="${esc(s.time)}" data-list="snacks" data-i="${i}" data-sfield="time" aria-label="Snack ${i + 1} time">
      <input type="text" id="snack-${i}-text" value="${esc(s.text)}" data-list="snacks" data-i="${i}" data-sfield="text" placeholder="What?" aria-label="Snack ${i + 1}">
      <button class="icon-btn" data-act="del-row" data-list="snacks" data-i="${i}" aria-label="Remove snack ${i + 1}">${ICON.x}</button></div>`).join('');
  }
  function xmedsHtml(list) {
    return list.map((x, i) => `<div class="snack">
      <input class="time" type="time" id="xmed-${i}-time" value="${esc(x.time)}" data-list="xmeds" data-i="${i}" data-sfield="time" aria-label="Medication ${i + 1} time">
      <input type="text" id="xmed-${i}-name" value="${esc(x.name)}" data-list="xmeds" data-i="${i}" data-sfield="name" placeholder="Name and dose" aria-label="Medication ${i + 1}">
      <button class="icon-btn" data-act="del-row" data-list="xmeds" data-i="${i}" aria-label="Remove medication ${i + 1}">${ICON.x}</button></div>`).join('');
  }
  const WHEN = [['day', 'All day'], ['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening'], ['night', 'Night'], ['time', 'Time']];
  function symptomsHtml(list) {
    if (!list.length) return '<p class="hint">No symptoms logged.</p>';
    return list.map((s, i) => {
      const on = v => (v === 'day' || v === 'time' ? s.when === v : s.when === 'periods' && (s.periods || []).includes(v));
      return `<div class="sym">
      <div class="sym-top"><span class="sym-name">${esc(s.name)}</span>
        <button class="icon-btn" data-act="del-sym" data-i="${i}" aria-label="Remove ${esc(s.name)}">${ICON.x}</button></div>
      <div class="seg sev" role="radiogroup" aria-label="${esc(s.name)} severity">
        ${[1, 2, 3].map(v => `<button role="radio" data-act="sev" data-i="${i}" data-v="${v}" aria-checked="${s.severity === v}" class="sev-${v}">${SEV[v]}</button>`).join('')}
      </div>
      <div class="when" role="group" aria-label="When did you have ${esc(s.name)}?">
        ${WHEN.map(([v, l]) => `<button data-act="when" data-i="${i}" data-v="${v}" aria-pressed="${on(v)}">${l}</button>`).join('')}
      </div>
      ${s.when === 'time' ? `<div class="when-time">
        <label>From<input class="time" type="time" id="sym-${i}-from" value="${esc(s.from)}" data-sym="${i}" data-k="from"></label>
        <label>To<input class="time" type="time" id="sym-${i}-to" value="${esc(s.to)}" data-sym="${i}" data-k="to"></label>
        <span class="hint">“To” is optional.</span></div>` : ''}
    </div>`;
    }).join('');
  }

  function dayMeasurementsHtml(list) {
    if (!list.length) return '';
    return list.map(m => `<li>
      <span>${esc(Report.MLABEL[m.type](m.value))}</span>
      <span class="mono">${m.time || ''}</span>
      ${m.source === 'apple' ? '<span class="pill ok">Apple Health</span>' : '<span></span>'}
      ${delBtn(m.id)}</li>`).join('');
  }
  function measureForms() {
    const time = id => `<input class="time" type="time" id="${id}" value="${defaultTime()}" aria-label="Time">`;
    return `
      <form class="inline-form mform" data-form="m-weight" hidden>
        ${time('mw-time')}
        <input id="mw-kg" type="number" inputmode="decimal" step="0.1" min="20" max="300" placeholder="kg" aria-label="Weight in kg" required>
        <button class="btn primary" type="submit">Save</button>
      </form>
      <form class="inline-form mform wrap" data-form="m-bp" hidden>
        ${time('mb-time')}
        <input id="mb-sys" type="number" inputmode="numeric" min="60" max="260" placeholder="Sys" aria-label="Systolic" required>
        <input id="mb-dia" type="number" inputmode="numeric" min="30" max="160" placeholder="Dia" aria-label="Diastolic" required>
        <input id="mb-pulse" type="number" inputmode="numeric" min="20" max="220" placeholder="Pulse" aria-label="Pulse">
        <button class="btn primary" type="submit">Save</button>
      </form>
      <form class="inline-form mform" data-form="m-temp" hidden>
        ${time('mt-time')}
        <input id="mt-c" type="number" inputmode="decimal" step="0.1" min="34" max="43" placeholder="°C" aria-label="Temperature in °C" required>
        <button class="btn primary" type="submit">Save</button>
      </form>`;
  }

  function healthCard(h, d) {
    const today = Dates.today();
    const canSync = d === today && (api.isMock || IS_IPHONE);
    const syncBtn = canSync ? `<button class="btn primary" data-act="sync">${ICON.sync} ${h ? 'Sync again' : 'Sync now'}</button>` : '';
    const manual = manualForm(h);
    if (!h) {
      return `<section class="card health o1">
        <div class="card-head"><h2>Apple Health</h2><span class="pill">Nothing received</span></div>
        <p class="hint">${canSync
          ? 'Sync to get last night’s sleep and today’s steps. You can sync again later in the day.'
          : d === today ? 'Nothing received yet. Sync from your iPhone, or enter the data by hand.' : 'No data for this day. You can enter it by hand.'}</p>
        <div class="btn-row">${syncBtn}<button class="btn" data-act="manual">Enter by hand</button></div>
        ${manual}
      </section>`;
    }
    const s = h.sleep || {};
    const edited = h.edited || [];
    const synced = h.syncedAt ? `${h.syncedAt.slice(0, 10) === today ? '' : `${Dates.label(h.syncedAt.slice(0, 10), { day: 'numeric', month: 'short' })} `}${h.syncedAt.slice(11, 16)}` : '';
    const src = h.source === 'manual' ? 'Entered by hand' : `Synced ${synced}`;
    const mark = k => (edited.includes(k) ? '<span class="edited" title="Corrected by hand">✎</span>' : '');
    return `<section class="card health o1">
      <div class="card-head"><h2>Apple Health</h2><span class="pill ${h.source === 'manual' ? '' : 'ok'}">${esc(src)}</span></div>
      <div class="metrics">
        <div class="metric wide">
          <span class="m-label">Sleep, night before ${mark('sleep')}</span>
          <span class="m-value">${fmtMin(s.total)}</span>
          <span class="m-sub">${s.bed && s.wake ? `${s.bed} → ${s.wake}` : ''}${s.deep != null ? ` · deep ${fmtMin(s.deep)} · REM ${fmtMin(s.rem)} · awake ${Math.round(s.awake || 0)} min` : ''}</span>
        </div>
        <div class="metric"><span class="m-label">Steps ${mark('steps')}</span><span class="m-value">${h.steps ? num(h.steps) : '–'}</span>${d === today ? '<span class="m-sub">so far</span>' : ''}</div>
        <div class="metric"><span class="m-label">Resting HR ${mark('restingHr')}</span><span class="m-value">${h.restingHr ?? '–'}<small> bpm</small></span></div>
        <div class="metric"><span class="m-label">HRV</span><span class="m-value">${h.hrv ?? '–'}<small> ms</small></span></div>
        ${h.workouts && h.workouts.length ? `<div class="metric wide workouts"><span class="m-label">Workouts</span>
          ${h.workouts.map(w => `<span class="m-sub">${esc(w.type)} · ${w.minutes} min${w.start ? ` · ${w.start}` : ''}</span>`).join('')}</div>` : ''}
      </div>
      ${edited.length ? '<p class="hint">✎ Corrected by hand. A new sync keeps your corrections.</p>' : ''}
      <div class="btn-row">${syncBtn}<button class="btn${canSync ? ' small' : ''}" data-act="manual">Correct by hand</button></div>
      ${manual}
    </section>`;
  }

  function manualForm(h) {
    const s = (h && h.sleep) || {};
    const v = x => (x == null ? '' : x);
    return `<form class="manual" data-form="health" hidden>
      <div class="grid2">
        <label>Sleep hours<input id="mh-sh" type="number" inputmode="numeric" min="0" max="16" value="${s.total != null ? Math.floor(s.total / 60) : ''}"></label>
        <label>Minutes<input id="mh-sm" type="number" inputmode="numeric" min="0" max="59" value="${s.total != null ? Math.round(s.total % 60) : ''}"></label>
        <label>Bedtime<input id="mh-bed" type="time" value="${v(s.bed)}"></label>
        <label>Woke up<input id="mh-wake" type="time" value="${v(s.wake)}"></label>
        <label>Steps<input id="mh-steps" type="number" inputmode="numeric" min="0" value="${v(h && h.steps)}"></label>
        <label>Resting HR (bpm)<input id="mh-hr" type="number" inputmode="numeric" min="20" max="220" value="${v(h && h.restingHr)}"></label>
      </div>
      <div class="btn-row"><button class="btn primary" type="submit">Save</button>
        <button class="btn" type="button" data-act="manual">Cancel</button></div>
    </form>`;
  }

  const saveLog = debounce(() => guard(async () => {
    await api.saveLog(state.date, state.log);
    setStatus(`Saved ${nowHm()}`);
    const dot = view.querySelector('.strip-day.is-current .strip-dot');
    if (dot) dot.classList.toggle('on', Report.hasContent(state.log));
  }), 500);
  function changed() { setStatus('Saving…'); saveLog(); }

  async function refreshDayMeasurements() {
    const all = await api.listMeasurements();
    document.getElementById('day-m').innerHTML = dayMeasurementsHtml(all.filter(m => m.date === state.date));
  }

  // =====================================================================
  // BODY (history only, new values are added on the Today screen)
  // =====================================================================

  async function renderBody() {
    const [all, profile] = await Promise.all([api.listMeasurements(), api.getProfile()]);
    const weights = all.filter(m => m.type === 'weight'), bps = all.filter(m => m.type === 'bp'), temps = all.filter(m => m.type === 'temp');
    const today = Dates.today();
    const last = weights[weights.length - 1];
    const range = state.bodyRange;
    const shown = range === 'all' ? weights : weights.filter(w => Dates.diff(today, w.date) <= range);
    const first = shown[0];
    const delta = last && first && first !== last ? Math.round((last.value - first.value) * 10) / 10 : null;
    const bmi = last ? Report.bmiOf(last.value, profile.heightCm) : null;
    const row = (m, val, extra) => `<li>
      <span class="mono">${longDate(m.date)}${m.time ? ` · ${m.time}` : ''}</span>
      <span class="val">${val}</span>${extra || '<span></span>'}${delBtn(m.id)}</li>`;

    view.innerHTML = `
      <h1 class="screen-title">Body</h1>
      <p class="lead">Add new values on the Today screen, under Measurements.</p>
      <div class="body-grid">
      <section class="card weight-card">
        <div class="card-head"><h2>Weight</h2>
          <div class="seg" role="group" aria-label="Chart period">
            ${[[90, '3M'], [180, '6M'], [365, '1Y'], ['all', 'All']].map(([v, l]) => `<button data-act="range" data-v="${v}" aria-pressed="${range === v}">${l}</button>`).join('')}
          </div></div>
        ${last ? `<div class="hero-num">
            <span class="big">${last.value}<small> kg</small></span>
            <span class="muted">${relDay(last.date)}${bmi ? ` · BMI ${bmi}` : ''}${delta != null ? ` · ${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)} kg since ${Dates.label(first.date, { day: 'numeric', month: 'short' })}` : ''}</span>
          </div>` : '<p class="hint">No weight yet.</p>'}
        <div class="chart" id="wchart">${shown.length >= 2 ? '' : '<p class="hint">At least two weights in this period are needed for a chart.</p>'}</div>
        <details><summary>All weights (${weights.length})</summary>
          <ul class="rows">${[...weights].reverse().map(w => row(w, `${w.value} kg`,
            `<span class="pill ${w.source === 'apple' ? 'ok' : ''}">${w.source === 'apple' ? 'Apple Health' : 'By hand'}</span>`)).join('')}</ul>
        </details>
      </section>

      <section class="card">
        <h2>Blood pressure</h2>
        <ul class="rows">${[...bps].reverse().map(b => row(b,
          `${b.value.sys}/${b.value.dia}<small> mmHg</small>${b.value.pulse ? `<small> · ${b.value.pulse} bpm</small>` : ''}`,
          b.value.sys >= 140 || b.value.dia >= 90 ? `<span class="pill warn">${ICON.alert} 140/90 or above</span>` : '')).join('')
          || '<li class="hint">No blood pressure yet.</li>'}</ul>
      </section>

      <section class="card">
        <h2>Temperature</h2>
        <ul class="rows">${[...temps].reverse().map(t => row(t, `${Number(t.value).toFixed(1)} °C`,
          t.value >= 38 ? `<span class="pill warn">${ICON.alert} Fever</span>` : '')).join('')
          || '<li class="hint">No temperature yet.</li>'}</ul>
      </section>
      </div>`;
    if (shown.length >= 2) drawWeightChart(document.getElementById('wchart'), shown);
  }

  function delBtn(id) {
    return `<button class="icon-btn del" data-act="del-m" data-id="${id}" aria-label="Delete">${ICON.trash}</button>`;
  }

  // Line chart, time on x. One series: no legend. Hover or tap shows the value.
  function drawWeightChart(el, pts) {
    const W = 340, H = 170, L = 34, R = 12, T = 14, B = 24;
    const t0 = Dates.parse(pts[0].date).getTime(), t1 = Dates.parse(pts[pts.length - 1].date).getTime();
    const vals = pts.map(p => p.value);
    let lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
    const step = hi - lo > 6 ? 2 : hi - lo > 3 ? 1 : 0.5;
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const x = t => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const P = pts.map(p => ({ ...p, cx: x(Dates.parse(p.date).getTime()), cy: y(p.value) }));
    const ticks = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 10) / 10);
    const fmtD = s => Dates.label(s, { day: 'numeric', month: 'short' });
    const lastP = P[P.length - 1];

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight from ${fmtD(pts[0].date)} to ${fmtD(pts[pts.length - 1].date)}">
      ${ticks.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      <text class="axis" x="${L}" y="${H - 6}" text-anchor="start">${fmtD(pts[0].date)}</text>
      <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${fmtD(pts[pts.length - 1].date)}</text>
      <path class="line" d="${P.map((p, i) => `${i ? 'L' : 'M'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join('')}"/>
      ${P.map(p => `<circle class="dot" cx="${p.cx}" cy="${p.cy}" r="4"/>`).join('')}
      <circle class="dot end" cx="${lastP.cx}" cy="${lastP.cy}" r="5"/>
      <line class="cross" id="wc-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>
    </svg><div class="tip" id="wc-tip" hidden></div>`;

    const svg = el.querySelector('svg'), tip = el.querySelector('#wc-tip'), cross = el.querySelector('#wc-cross');
    function show(ev) {
      const r = svg.getBoundingClientRect();
      const sx = ((ev.clientX - r.left) / r.width) * W;
      const p = P.reduce((a, b) => (Math.abs(b.cx - sx) < Math.abs(a.cx - sx) ? b : a));
      cross.setAttribute('x1', p.cx); cross.setAttribute('x2', p.cx); cross.setAttribute('visibility', 'visible');
      tip.innerHTML = `<strong>${p.value} kg</strong><span>${fmtD(p.date)}</span>`;
      tip.hidden = false;
      const px = (p.cx / W) * r.width, py = (p.cy / H) * r.height;
      tip.style.left = `${Math.min(Math.max(px, 44), r.width - 44)}px`;
      tip.style.top = `${py}px`;
    }
    function hide() { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  }

  // =====================================================================
  // DOCUMENTS
  // =====================================================================

  async function renderDocs() {
    const [docs, settings] = await Promise.all([api.listDocuments(), api.getSettings()]);
    const ex = new Set(settings.excludedDocs || []);
    docs.sort((a, b) => b.date.localeCompare(a.date));
    view.innerHTML = `
      <h1 class="screen-title">Documents</h1>
      <p class="lead">${api.isMock ? 'Sample documents. In the real app, this list' : 'This list'} comes from Paperless: every document with the tag <span class="tag">medical</span>. To add one, upload it to Paperless.</p>
      <div class="docs">${docs.map(doc => `<article class="card doc">
        <div class="doc-top"><span class="mono">${longDate(doc.date)}</span>
          <span class="pill">${esc(doc.category)}</span></div>
        <h2>${esc(doc.title)}</h2>
        <p class="muted">${esc(doc.correspondent)}</p>
        <label class="check"><input type="checkbox" id="doc-inc-${doc.id}" data-act="doc-include" data-id="${doc.id}" ${ex.has(doc.id) ? '' : 'checked'}> Include in reports</label>
        <details><summary>Show text (${num(doc.content.length)} characters)</summary><pre class="doc-text">${esc(doc.content)}</pre></details>
        ${!api.isMock && doc.url ? `<a class="link" href="${esc(doc.url)}" target="_blank" rel="noopener">Open in Paperless</a>` : ''}
      </article>`).join('') || '<p class="hint">No documents with the tag “medical” in Paperless.</p>'}</div>`;
  }

  // =====================================================================
  // REPORT
  // =====================================================================

  let reportData = null;

  function periodDates(r) {
    const today = Dates.today();
    if (r.period === 'custom' && r.from && r.to) return { from: r.from, to: r.to };
    if (r.period === 'all') return { from: null, to: today };
    return { from: Dates.add(today, -(Number(r.period) - 1)), to: today };
  }

  async function renderReport() {
    const r = state.report;
    const settings = await api.getSettings();
    view.innerHTML = `
      <h1 class="screen-title">Report</h1>
      <div class="report-layout">
      <section class="card form-card">
        <span class="label">Period</span>
        <div class="seg" role="group" aria-label="Period">
          ${[[30, '30 days'], [90, '90 days'], [365, '1 year'], ['all', 'All'], ['custom', 'Dates']].map(([v, l]) =>
            `<button data-act="period" data-v="${v}" aria-pressed="${String(r.period) === String(v)}">${l}</button>`).join('')}
        </div>
        <div class="grid2" id="custom-dates" ${r.period === 'custom' ? '' : 'hidden'}>
          <label>From<input type="date" id="r-from" value="${esc(r.from || Dates.add(Dates.today(), -89))}"></label>
          <label>To<input type="date" id="r-to" value="${esc(r.to || Dates.today())}"></label>
        </div>

        <span class="label">Who is it for?</span>
        <div class="seg" role="group" aria-label="Report mode">
          <button data-act="mode" data-v="doctor" aria-pressed="${r.mode === 'doctor'}">My doctor</button>
          <button data-act="mode" data-v="llm" aria-pressed="${r.mode === 'llm'}">An AI (anonymized)</button>
        </div>
        <div id="llm-opts" ${r.mode === 'llm' ? '' : 'hidden'}>
          <label class="check"><input type="checkbox" id="r-rel" ${r.relativeDates ? 'checked' : ''}> Replace dates with day numbers (D-12)</label>
          <label class="label" for="r-words">Other words to hide, one per line</label>
          <textarea id="r-words" rows="3" placeholder="Hospital, lab or town names">${esc((settings.redactWords || []).join('\n'))}</textarea>
          <p class="hint">Your name, date of birth, doctor names, email addresses, phone numbers and long ID numbers are hidden automatically. Read the result before you share it.</p>
        </div>

        <span class="label">Include</span>
        <div class="checks">
          ${[['profile', 'Profile'], ['body', 'Measurements'], ['health', 'Apple Health data'], ['log', 'Daily diary'], ['docs', 'Medical documents']].map(([k, l]) =>
            `<label class="check"><input type="checkbox" id="r-inc-${k}" data-inc="${k}" ${r.include[k] ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>

        <label class="label" for="r-q">Question for the reader (optional)</label>
        <textarea id="r-q" rows="2" placeholder="Example: Is there a link between my coffee and my palpitations?">${esc(r.question)}</textarea>
      </section>

      <section class="card out-card">
        <div class="card-head"><h2>Result</h2><span class="muted mono" id="r-stats"></span></div>
        <div class="btn-row"><button class="btn primary" data-act="copy">${ICON.copy} Copy report</button></div>
        <pre class="report-out" id="r-out" tabindex="0"></pre>
      </section>
      </div>`;
    await loadReportData();
    updateReport();
  }

  async function loadReportData() {
    const { from, to } = periodDates(state.report);
    // Without Paperless, the report still works, without documents.
    const docsOrNone = api.listDocuments().catch(e => { toast(`Documents left out. ${e.message}`); return []; });
    const [profile, days, measurements, docs, settings] = await Promise.all([api.getProfile(), api.listDays(from, to),
      api.listMeasurements(), docsOrNone, api.getSettings()]);
    const ex = new Set(settings.excludedDocs || []);
    reportData = { profile, days, measurements, documents: docs.filter(d => !ex.has(d.id)), settings,
      from: from || (days[0] && days[0].date) || to, to };
  }

  function updateReport() {
    const r = state.report;
    const words = (document.getElementById('r-words')?.value || '').split('\n');
    const text = Report.buildReport(reportData, { from: reportData.from, to: reportData.to, mode: r.mode,
      relativeDates: r.relativeDates, include: r.include, question: r.question, redactWords: words });
    document.getElementById('r-out').textContent = text;
    const w = text.split(/\s+/).filter(Boolean).length;
    document.getElementById('r-stats').textContent = `${num(w)} words · ≈${num(Math.round(text.length / 4))} tokens`;
    store.set('report', r);
  }
  const saveWords = debounce(words => guard(() => api.saveSettings({ redactWords: words.filter(Boolean) })), 600);

  // =====================================================================
  // PROFILE (long-term information only)
  // =====================================================================

  async function renderProfile() {
    const [p, settings, pl, users] = await Promise.all([api.getProfile(), api.getSettings(),
      api.isMock ? null : api.getPaperless(),
      !api.isMock && state.user && state.user.isAdmin ? api.listUsers() : null]);
    state.profile = p;
    const u = state.user;
    const f = (id, label, type, extra = '') => `<label for="p-${id}">${label}<input id="p-${id}" type="${type}" data-pfield="${id}" value="${esc(p[id] ?? '')}" ${extra}></label>`;
    const t = (id, label, ph, hint = '') => `<label class="label" for="p-${id}">${label}</label>${hint ? `<p class="hint">${hint}</p>` : ''}<textarea id="p-${id}" rows="3" data-pfield="${id}" placeholder="${ph}">${esc(p[id] || '')}</textarea>`;
    view.innerHTML = `
      <h1 class="screen-title">Profile</h1>
      <p class="lead">Information that does not change from day to day. Weight and daily habits go on the Today screen.</p>
      <div class="profile-grid">
      <section class="card form-card">
        ${f('name', 'Name', 'text', 'autocomplete="name"')}
        <p class="hint">Your name appears in doctor reports only. AI reports never show it.</p>
        <div class="grid2">
          ${f('dob', 'Date of birth', 'date')}
          <label for="p-sex">Sex<select id="p-sex" data-pfield="sex">
            ${['', 'Male', 'Female', 'Intersex', 'Prefer not to say'].map(o => `<option ${p.sex === o ? 'selected' : ''} value="${o}">${o || '–'}</option>`).join('')}
          </select></label>
          ${f('heightCm', 'Height (cm)', 'number', 'inputmode="numeric" min="50" max="250"')}
          ${f('ethnicity', 'Ethnicity', 'text')}
        </div>
      </section>
      <section class="card form-card">
        <h2>Medical history</h2>
        <p class="hint">One item per line.</p>
        ${t('conditions', 'Conditions and diagnoses', 'Example: Asthma (since childhood)')}
        ${t('medications', 'Regular medication', 'Name, dose, when', 'Each line becomes a checkbox on the Today screen.')}
        ${t('allergies', 'Allergies', 'Example: Penicillin (rash)')}
        ${t('surgeries', 'Surgeries and hospital stays', 'What, year')}
        ${t('familyHistory', 'Family history', 'Example: Father: high blood pressure')}
        ${t('lifestyle', 'Lifestyle and other notes', 'Smoking, diet, work…')}
      </section>
      </div>

      <h2 class="section-title">Connections and account</h2>
      <div class="profile-grid">
      <section class="card form-card">
        <h2>Apple Health sync</h2>
        <p>Last data received: <strong>${settings.lastSync ? `${Dates.label(settings.lastSync.slice(0, 10))}, ${settings.lastSync.slice(11, 16)}` : 'never'}</strong></p>
        <p class="hint">The “Health Diary” shortcut on your iPhone reads Apple Health and sends the data here.</p>
        ${api.isMock ? '' : `
        <p class="hint">Shortcut address: <span class="tag">${esc(location.origin)}/api/ingest/health</span></p>
        <p>Shortcut key: <strong>${u.hasIngestToken ? 'active' : 'none yet'}</strong></p>
        <div class="btn-row">
          <button class="btn small" data-act="key-new">${u.hasIngestToken ? 'Replace key' : 'Create key'}</button>
          ${u.hasIngestToken ? '<button class="btn small" data-act="key-off">Turn off</button>' : ''}
        </div>
        <div id="key-show" class="secret" hidden>
          <p class="hint">Put this key in the shortcut now. It is shown only once.${u.hasIngestToken ? ' The old key no longer works.' : ''}</p>
          <code id="key-text"></code>
          <button class="btn small" data-act="key-copy">${ICON.copy} Copy key</button>
        </div>
        <h3>Import your history</h3>
        <p class="hint">In the Health app, tap your profile picture, then <strong>Export All Health Data</strong>. Choose the export.zip file here. The import only fills empty fields. It never changes data you already have.</p>
        <form class="inline-form" data-form="import">
          <input type="file" id="imp-file" accept=".zip,.xml" aria-label="Apple Health export file" required>
          <button class="btn primary" type="submit">Import</button>
        </form>
        <p class="hint" id="imp-status" aria-live="polite"></p>`}
      </section>
      ${api.isMock ? `<section class="card">
        <h2>Demo</h2>
        <p class="hint">All data on this page is sample data. It stays in this browser only.</p>
        <button class="btn" data-act="reset">Reset sample data</button>
      </section>` : `
      <section class="card form-card">
        <h2>Paperless</h2>
        ${pl.available ? `
        <p class="hint">Documents with your tag appear under Documents. Use your own Paperless token: in Paperless, open your profile, then <strong>API Auth Token</strong>.</p>
        <form class="stack" data-form="paperless">
          <label for="pl-token">API token<input id="pl-token" type="password" autocomplete="off" placeholder="${pl.hasToken ? (pl.tokenFromServer ? 'Set by the server. Type to replace.' : 'Saved. Type to replace.') : 'Paste your token'}"></label>
          <label for="pl-tag">Tag<input id="pl-tag" type="text" value="${esc(pl.tag)}" autocomplete="off"></label>
          <div class="btn-row"><button class="btn primary" type="submit">Save</button>
            <button class="btn" type="button" data-act="pl-test">Test connection</button></div>
        </form>
        <p class="hint" id="pl-status" aria-live="polite"></p>`
        : '<p class="hint">Not available. The administrator must set PAPERLESS_URL on the server.</p>'}
      </section>
      <section class="card form-card">
        <h2>Account</h2>
        <p>Logged in as <strong>${esc(u.username)}</strong>${u.isAdmin ? ' · administrator' : ''}</p>
        <form class="stack" data-form="password">
          <label for="pw-cur">Current password<input id="pw-cur" type="password" autocomplete="current-password" required></label>
          <label for="pw-new">New password<input id="pw-new" type="password" autocomplete="new-password" minlength="10" required></label>
          <label for="pw-new2">New password again<input id="pw-new2" type="password" autocomplete="new-password" minlength="10" required></label>
          <div class="btn-row"><button class="btn" type="submit">Change password</button></div>
        </form>
        <p class="hint">A new password logs out your other devices.</p>
        <div class="btn-row"><button class="btn" data-act="logout">Log out</button></div>
      </section>
      ${users ? usersCard(users) : ''}`}
      </div>`;
  }

  function usersCard(users) {
    return `<section class="card form-card" id="users-card">
      <h2>Users</h2>
      <p class="hint">Each user has their own diary. Nobody, not even an administrator, can see another user's data in the app.</p>
      <ul class="rows users">${users.map(x => `<li>
        <span><strong>${esc(x.username)}</strong>${x.id === state.user.id ? ' <span class="muted">(you)</span>' : ''}</span>
        ${x.isAdmin ? '<span class="pill">Admin</span>' : '<span></span>'}
        <button class="btn small" data-act="user-reset" data-id="${x.id}">New password</button>
        ${x.id === state.user.id ? '<span></span>' : `<button class="icon-btn del" data-act="user-del" data-id="${x.id}" aria-label="Delete ${esc(x.username)}">${ICON.trash}</button>`}
        <form class="inline-form reset-form" data-form="reset-pw" data-id="${x.id}" hidden>
          <input type="password" id="rp-${x.id}" autocomplete="new-password" minlength="10" placeholder="New password for ${esc(x.username)}" aria-label="New password" required>
          <button class="btn primary" type="submit">Save</button>
        </form></li>`).join('')}</ul>
      <h3>Add a user</h3>
      <form class="stack" data-form="new-user">
        <div class="grid2">
          <label for="nu-name">Username<input id="nu-name" type="text" autocomplete="off" required></label>
          <label for="nu-pw">Password<input id="nu-pw" type="password" autocomplete="new-password" minlength="10" required></label>
        </div>
        <label class="check"><input type="checkbox" id="nu-admin"> Administrator (can manage users)</label>
        <div class="btn-row"><button class="btn primary" type="submit">Add user</button></div>
      </form>
      <p class="hint">Give the new user their password. They can change it in Profile.</p>
    </section>`;
  }

  // =====================================================================
  // LOGIN AND FIRST SETUP
  // =====================================================================

  function renderAuth(mode, message) {
    document.body.classList.add('auth');
    setStatus('');
    const setup = mode === 'setup';
    view.innerHTML = `
      <section class="card auth-card">
        <img src="icon.png" alt="" width="56" height="56">
        <h1>${setup ? 'Welcome' : 'Log in'}</h1>
        <p class="hint">${setup
          ? 'Create the first account. It becomes the administrator. The setup code is in the server log: <span class="tag">docker logs health-diary</span>'
          : 'Your health diary is private. Log in to continue.'}</p>
        <form class="stack" data-form="${setup ? 'setup' : 'login'}">
          ${setup ? '<label for="au-code">Setup code<input id="au-code" type="text" autocomplete="off" autocapitalize="characters" required></label>' : ''}
          <label for="au-user">Username<input id="au-user" type="text" autocomplete="username" autocapitalize="none" required></label>
          <label for="au-pw">Password<input id="au-pw" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" ${setup ? 'minlength="10"' : ''} required></label>
          ${setup ? '<label for="au-pw2">Password again<input id="au-pw2" type="password" autocomplete="new-password" minlength="10" required></label>' : ''}
          <p class="form-error" id="au-error" role="alert">${esc(message || '')}</p>
          <button class="btn primary" type="submit">${setup ? 'Create account' : 'Log in'}</button>
        </form>
        ${setup ? '<p class="hint">Use at least 10 characters. A long sentence is easy to remember and hard to guess.</p>' : ''}
      </section>`;
    view.querySelector('input').focus();
  }

  function startApp() {
    document.body.classList.remove('auth');
    setTab(state.tab);
  }

  async function boot() {
    if (api.isMock) {
      document.getElementById('demo-badge').hidden = false;
      return startApp();
    }
    try {
      const s = await api.authStatus();
      if (s.user) { state.user = s.user; return startApp(); }
      renderAuth(s.setupNeeded ? 'setup' : 'login');
    } catch (e) {
      view.innerHTML = `<div class="notice error">Cannot reach the server. ${esc(e.message)}</div>`;
    }
  }
  window.addEventListener('diary:logged-out', () => {
    if (!state.user) return;
    state.user = null;
    renderAuth('login', 'Your session has ended. Please log in again.');
  });

  const saveProfile = debounce(() => guard(async () => { await api.saveProfile(state.profile); setStatus(`Saved ${nowHm()}`); }), 500);

  // =====================================================================
  // EVENTS
  // =====================================================================

  const listOf = name => (name === 'snacks' ? state.log.snacks : state.log.meds.extra);
  function redrawList(name) {
    if (name === 'snacks') document.getElementById('snacks').innerHTML = snacksHtml(state.log.snacks);
    else document.getElementById('xmeds').innerHTML = xmedsHtml(state.log.meds.extra);
  }

  view.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.act;
    const L = state.log;

    if (act === 'prev') { state.date = Dates.add(state.date, -1); return render(); }
    if (act === 'next') { if (state.date < Dates.today()) { state.date = Dates.add(state.date, 1); return render(); } return; }
    if (act === 'goto') { state.date = b.dataset.date; return render(); }
    if (act === 'sync') {
      if (!api.isMock) { location.href = SHORTCUT_URL; return; }
      await api.simulateSync(); toast('Health data updated'); return render();
    }
    if (act === 'manual') { const f = view.querySelector('form[data-form="health"]'); f.hidden = !f.hidden; return; }

    if (act === 'add-snack') {
      L.snacks.push({ time: defaultTime(), text: '' });
      redrawList('snacks');
      document.getElementById(`snack-${L.snacks.length - 1}-text`).focus();
      return changed();
    }
    if (act === 'add-med') {
      L.meds.extra.push({ time: defaultTime(), name: '' });
      redrawList('xmeds');
      document.getElementById(`xmed-${L.meds.extra.length - 1}-name`).focus();
      return changed();
    }
    if (act === 'del-row') { listOf(b.dataset.list).splice(Number(b.dataset.i), 1); redrawList(b.dataset.list); return changed(); }

    if (act === 'inc' || act === 'dec') {
      const k = b.dataset.k;
      L.drinks[k] = Math.max(0, (L.drinks[k] || 0) + (act === 'inc' ? 1 : -1));
      document.getElementById(`drink-${k}`).textContent = L.drinks[k];
      return changed();
    }

    if (act === 'add-sym') { addSymptom(b.dataset.s); return; }
    if (act === 'sev') {
      const s = L.symptoms[Number(b.dataset.i)];
      s.severity = Number(b.dataset.v);
      b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', String(x === b)));
      return changed();
    }
    if (act === 'when') {
      const s = L.symptoms[Number(b.dataset.i)], v = b.dataset.v;
      if (v === 'day' || v === 'time') {
        const off = s.when === v;
        s.when = off ? null : v; s.periods = [];
        if (v === 'time' && !off && !s.from) s.from = defaultTime();
      } else {
        // Periods can be combined, for example morning and evening.
        const cur = s.when === 'periods' ? (s.periods || []) : [];
        s.periods = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v];
        s.when = s.periods.length ? 'periods' : null;
      }
      document.getElementById('sym-list').innerHTML = symptomsHtml(L.symptoms);
      return changed();
    }
    if (act === 'del-sym') {
      L.symptoms.splice(Number(b.dataset.i), 1);
      document.getElementById('sym-list').innerHTML = symptomsHtml(L.symptoms);
      return changed();
    }

    if (act === 'm-open') {
      const target = view.querySelector(`form[data-form="m-${b.dataset.t}"]`);
      view.querySelectorAll('form.mform').forEach(f => { f.hidden = f !== target || !f.hidden; });
      if (!target.hidden) target.querySelector('input[type="number"]').focus();
      return;
    }

    if (act === 'range') { const v = b.dataset.v; state.bodyRange = v === 'all' ? 'all' : Number(v); store.set('bodyRange', state.bodyRange); return render(); }
    if (act === 'del-m') {
      const id = Number(b.dataset.id);
      if (state.armed !== id) {
        view.querySelectorAll('.del.armed').forEach(x => { x.classList.remove('armed'); x.innerHTML = ICON.trash; });
        state.armed = id; b.classList.add('armed'); b.textContent = 'Delete?';
        return;
      }
      state.armed = null;
      await guard(() => api.deleteMeasurement(id));
      toast('Deleted');
      return state.tab === 'today' ? refreshDayMeasurements() : render();
    }

    if (act === 'period') {
      state.report.period = b.dataset.v === 'all' || b.dataset.v === 'custom' ? b.dataset.v : Number(b.dataset.v);
      if (state.report.period === 'custom') {
        state.report.from = document.getElementById('r-from').value;
        state.report.to = document.getElementById('r-to').value;
      }
      view.querySelectorAll('[data-act="period"]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      document.getElementById('custom-dates').hidden = state.report.period !== 'custom';
      await loadReportData();
      return updateReport();
    }
    if (act === 'mode') {
      state.report.mode = b.dataset.v;
      view.querySelectorAll('[data-act="mode"]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      document.getElementById('llm-opts').hidden = b.dataset.v !== 'llm';
      return updateReport();
    }
    if (act === 'copy') {
      const text = document.getElementById('r-out').textContent;
      try { await navigator.clipboard.writeText(text); toast('Report copied'); } catch (err) {
        const sel = window.getSelection(), range = document.createRange();
        range.selectNodeContents(document.getElementById('r-out'));
        sel.removeAllRanges(); sel.addRange(range);
        toast('Text selected. Copy it with your device’s Copy command.');
      }
      return;
    }

    // ----- Account (server mode)
    if (act === 'logout') {
      await api.logout().catch(() => {});
      state.user = null;
      return renderAuth('login', 'You are logged out.');
    }
    if (act === 'key-new') {
      if (state.user.hasIngestToken && b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again: the old key stops working'; return; }
      const { token } = await api.createIngestToken();
      state.user.hasIngestToken = true;
      await renderProfile();
      document.getElementById('key-text').textContent = token;
      document.getElementById('key-show').hidden = false;
      return;
    }
    if (act === 'key-off') {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to turn off'; return; }
      await guard(() => api.revokeIngestToken());
      state.user.hasIngestToken = false;
      toast('Shortcut key turned off');
      return renderProfile();
    }
    if (act === 'key-copy') {
      const text = document.getElementById('key-text').textContent;
      try { await navigator.clipboard.writeText(text); toast('Key copied'); } catch (err) {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('key-text'));
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        toast('Key selected. Copy it with your device’s Copy command.');
      }
      return;
    }
    if (act === 'pl-test') {
      const st = document.getElementById('pl-status');
      st.textContent = 'Testing…';
      try {
        const docs = await api.refreshDocuments();
        st.textContent = `Connected. ${docs.length} document${docs.length === 1 ? '' : 's'} with your tag.`;
      } catch (err) { st.textContent = err.message; }
      return;
    }
    if (act === 'user-reset') {
      const f = view.querySelector(`form[data-form="reset-pw"][data-id="${b.dataset.id}"]`);
      f.hidden = !f.hidden;
      if (!f.hidden) f.querySelector('input').focus();
      return;
    }
    if (act === 'user-del') {
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1'; b.classList.add('armed'); b.textContent = 'Delete user and all data?';
        return;
      }
      await guard(() => api.deleteUser(Number(b.dataset.id)));
      toast('User deleted');
      return renderProfile();
    }

    if (act === 'reset') {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to reset'; return; }
      await api.resetDemo(); state.date = Dates.today(); toast('Sample data reset'); return render();
    }
  });

  function addSymptom(name) {
    // On today's page, start with the current period of the day. It is easy to change.
    const now = state.date === Dates.today() ? U.periodOf(nowHm()) : null;
    state.log.symptoms.push({ name, severity: 1, when: now ? 'periods' : null, periods: now ? [now] : [], from: '', to: '' });
    document.getElementById('sym-list').innerHTML = symptomsHtml(state.log.symptoms);
    toast(`${name} added. Set how bad it was and when.`);
    changed();
  }

  // Checkboxes also send 'change', for browsers that do not send 'input' for them.
  view.addEventListener('input', onInput);
  view.addEventListener('change', e => { if (e.target.type === 'checkbox' && !e.target.dataset.act) onInput(e); });
  function onInput(e) {
    const el = e.target;
    // Today
    if (state.tab === 'today') {
      if (el.dataset.field) {
        const path = el.dataset.field.split('.');
        let o = state.log;
        for (const k of path.slice(0, -1)) o = o[k];
        o[path[path.length - 1]] = el.value;
        return changed();
      }
      if (el.dataset.list) { listOf(el.dataset.list)[Number(el.dataset.i)][el.dataset.sfield] = el.value; return changed(); }
      if (el.dataset.sym != null) { state.log.symptoms[Number(el.dataset.sym)][el.dataset.k] = el.value; return changed(); }
      if (el.dataset.med != null) { state.log.meds.taken[state.regularMeds[Number(el.dataset.med)]] = el.checked; return changed(); }
      return;
    }
    // Profile
    if (el.dataset.pfield) {
      const k = el.dataset.pfield;
      state.profile[k] = k === 'heightCm' ? (el.value ? Number(el.value) : null) : el.value;
      setStatus('Saving…');
      return saveProfile();
    }
    // Report
    if (state.tab === 'report') {
      const r = state.report;
      if (el.id === 'r-q') r.question = el.value;
      if (el.id === 'r-words') saveWords(el.value.split('\n').map(w => w.trim()));
      if (el.id === 'r-rel') r.relativeDates = el.checked;
      if (el.dataset.inc) r.include[el.dataset.inc] = el.checked;
      if (el.id === 'r-from' || el.id === 'r-to') {
        r.from = document.getElementById('r-from').value; r.to = document.getElementById('r-to').value;
        if (r.from && r.to && r.from <= r.to) loadReportData().then(updateReport);
        return;
      }
      return updateReport();
    }
  }

  view.addEventListener('change', async e => {
    const el = e.target;
    if (el.dataset.act === 'doc-include') {
      const s = await api.getSettings();
      const id = Number(el.dataset.id);
      const ex = new Set(s.excludedDocs || []);
      el.checked ? ex.delete(id) : ex.add(id);
      await guard(() => api.saveSettings({ excludedDocs: [...ex] }));
      toast(el.checked ? 'Included in reports' : 'Left out of reports');
    }
  });

  view.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target.dataset.form;
    const val = id => document.getElementById(id).value;
    const addM = async (type, value, msg, time) => {
      await guard(() => api.addMeasurement({ type, date: state.date, time: time || null, value, source: 'manual' }));
      e.target.hidden = true;
      e.target.reset();
      toast(msg);
      refreshDayMeasurements();
    };

    // ----- Login and first setup
    if (form === 'login' || form === 'setup') {
      const err = document.getElementById('au-error');
      const btn = e.target.querySelector('button[type="submit"]');
      err.textContent = '';
      if (form === 'setup' && val('au-pw') !== val('au-pw2')) { err.textContent = 'The two passwords are not the same.'; return; }
      btn.disabled = true;
      try {
        state.user = form === 'setup'
          ? await api.setup(val('au-code'), val('au-user'), val('au-pw'))
          : await api.login(val('au-user'), val('au-pw'));
        return startApp();
      } catch (ex) {
        err.textContent = ex.message;
      } finally { btn.disabled = false; }
      return;
    }
    if (form === 'password') {
      if (val('pw-new') !== val('pw-new2')) return toast('The two new passwords are not the same.');
      try {
        await api.changePassword(val('pw-cur'), val('pw-new'));
        e.target.reset();
        toast('Password changed. Other devices are logged out.');
      } catch (ex) { toast(ex.message); }
      return;
    }
    if (form === 'paperless') {
      const token = val('pl-token');
      const cfg = await api.savePaperless({ tag: val('pl-tag'), ...(token ? { token } : {}) }).catch(ex => { toast(ex.message); return null; });
      if (!cfg) return;
      document.getElementById('pl-token').value = '';
      document.getElementById('pl-token').placeholder = cfg.hasToken ? 'Saved. Type to replace.' : 'Paste your token';
      toast('Paperless settings saved');
      return;
    }
    if (form === 'new-user') {
      try {
        await api.createUser({ username: val('nu-name'), password: val('nu-pw'), isAdmin: document.getElementById('nu-admin').checked });
        toast('User added');
        return renderProfile();
      } catch (ex) { return toast(ex.message); }
    }
    if (form === 'reset-pw') {
      const id = Number(e.target.dataset.id);
      try {
        await api.resetPassword(id, val(`rp-${id}`));
        e.target.hidden = true; e.target.reset();
        toast('Password changed. This user must log in again.');
      } catch (ex) { toast(ex.message); }
      return;
    }

    if (form === 'import') {
      const file = document.getElementById('imp-file').files[0];
      if (!file) return;
      const status = document.getElementById('imp-status');
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      status.textContent = `Uploading and reading ${num(Math.round(file.size / 1e6))} MB. This can take a few minutes. Keep this page open.`;
      try {
        const r = await api.importAppleHealth(file);
        const m = Object.entries(r.measurements || {}).map(([k, n]) => `${n} ${{ weight: 'weights', bp: 'blood pressures', temp: 'temperatures' }[k] || k}`);
        status.textContent = r.days
          ? `Done. ${num(r.days)} days, from ${longDate(r.first)} to ${longDate(r.last)}${m.length ? `, and ${m.join(', ')}` : ''}.`
          : 'Done, but the file had no sleep, steps or heart data.';
      } catch (err) {
        status.textContent = `Import failed. ${err.message}`;
      } finally { btn.disabled = false; }
      return;
    }
    if (form === 'symptom') {
      const s = val('symptom-new').trim();
      if (!s) return;
      document.getElementById('symptom-new').value = '';
      return addSymptom(s);
    }
    if (form === 'health') {
      const sh = val('mh-sh'), sm = val('mh-sm');
      const total = sh || sm ? Number(sh || 0) * 60 + Number(sm || 0) : null;
      const n = id => (val(id) ? Number(val(id)) : null);
      const old = (await api.getDay(state.date)).health || {};
      const os = old.sleep || {};
      const next = { ...old,
        sleep: { ...os, total, bed: val('mh-bed') || null, wake: val('mh-wake') || null },
        steps: n('mh-steps'), restingHr: n('mh-hr'), source: old.source || 'manual' };
      // Remember what was changed by hand, so a new sync does not overwrite it.
      const edited = new Set(old.edited || []);
      if (total !== (os.total ?? null) || next.sleep.bed !== (os.bed ?? null) || next.sleep.wake !== (os.wake ?? null)) edited.add('sleep');
      if (next.steps !== (old.steps ?? null)) edited.add('steps');
      if (next.restingHr !== (old.restingHr ?? null)) edited.add('restingHr');
      next.edited = [...edited];
      await guard(() => api.saveHealth(state.date, next));
      toast('Health data saved');
      return render();
    }
    if (form === 'm-weight') {
      const kg = Number(val('mw-kg'));
      if (!(kg >= 20 && kg <= 300)) return toast('Enter a weight between 20 and 300 kg.');
      return addM('weight', Math.round(kg * 10) / 10, 'Weight saved', val('mw-time'));
    }
    if (form === 'm-bp') {
      const sys = Number(val('mb-sys')), dia = Number(val('mb-dia')), pulse = val('mb-pulse') ? Number(val('mb-pulse')) : null;
      if (!sys || !dia || sys <= dia) return toast('Check the values. The first number must be higher than the second.');
      return addM('bp', { sys, dia, pulse }, 'Blood pressure saved', val('mb-time'));
    }
    if (form === 'm-temp') {
      const c = Number(val('mt-c'));
      if (!(c >= 34 && c <= 43)) return toast('Enter a temperature between 34 and 43 °C.');
      return addM('temp', Math.round(c * 10) / 10, 'Temperature saved', val('mt-time'));
    }
  });

  // ---------- Icons (24px, stroke)
  const svg = d => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    left: svg('<path d="M15 18l-6-6 6-6"/>'),
    right: svg('<path d="M9 18l6-6-6-6"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    x: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
    trash: svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
    alert: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
    sync: svg('<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/>'),
  };

  const VIEWS = { today: renderToday, body: renderBody, docs: renderDocs, report: renderReport, profile: renderProfile };

  boot();
})();
