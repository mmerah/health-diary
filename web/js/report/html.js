// The report as formatted HTML for a doctor: on screen, printed or saved as PDF.
// Every value is escaped. No inline styles or handlers (strict CSP); classes are in css/report.css and css/print.css.
import { fullLabel, today as todayIso } from '../core/dates.js';
import { esc } from '../core/format.js';
import { safeCategory } from './redact.js';
import { dayLines, writers } from './markdown.js';
import {
  drinkText, drinksShort, flagText, LEVEL_WORD, labValue, measurementText, medName,
  one, pct, plural, severityText, severityWords, sevShort, sleepText, stepsText, TREND, whenText,
} from './words.js';

const PILL = { high: 'high', caution: 'caution', info: 'info' };

function table(head, rows, { numeric = [], caption = '', cls = '' } = {}) {
  const th = head.map((x, i) => `<th scope="col"${numeric.includes(i) ? ' class="num"' : ''}>${esc(x)}</th>`).join('');
  const body = rows.map(r => `<tr${r.cls ? ` class="${esc(r.cls)}"` : ''}>${(r.cells || r).map((c, i) => {
    const v = c && typeof c === 'object' ? c : { text: c };
    const cl = [numeric.includes(i) ? 'num' : '', v.cls || ''].filter(Boolean).join(' ');
    return `<td${cl ? ` class="${cl}"` : ''}>${v.html != null ? v.html : esc(v.text ?? '')}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="table rp-table ${esc(cls)}">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ''}<thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const section = (id, title, body, note = '') => (body ? `<section class="rp-sec" aria-labelledby="rp-${id}"><h2 id="rp-${id}">${esc(title)}</h2>${note ? `<p class="rp-note">${esc(note)}</p>` : ''}${body}</section>` : '');
const list = items => (items.length ? `<ul class="rp-list">${items.map(x => `<li>${x}</li>`).join('')}</ul>` : '');
const flagCell = flag => (flag ? `<span class="rp-lab-flag is-${flag === 'low' ? 'low' : 'high'}">${esc(flag === 'flagged' ? 'Flagged' : flag === 'high' ? 'High' : 'Low')}</span>` : '');

/** opts: { redactor, relative } as for toMarkdown; the doctor report uses none. */
export function toHtml(model, opts = {}) {
  const h = writers(model, opts);
  const { D, Dday, T, ai } = h;
  const inc = model.include;
  const p = model.period;
  const pr = model.profile;
  const out = [];

  // Header
  const who = [!ai && pr.name ? `<strong>${esc(pr.name)}</strong>` : '', !ai && pr.dob ? `Born ${esc(fullLabel(pr.dob))}` : '',
    pr.age != null ? `Age ${esc(pr.age)}` : '', pr.sex ? esc(T(pr.sex)) : ''].filter(Boolean).join(' · ');
  out.push(`<header class="rp-head">
    <p class="rp-kicker">Health report${ai ? ' (anonymized)' : ''}</p>
    <h1>${esc(h.rel || ai ? `${D(p.from)} – ${D(p.to)}` : `${fullLabel(p.from)} – ${fullLabel(p.to)}`)}</h1>
    <p class="rp-meta">${who ? `${who}<br>` : ''}${esc(plural(p.days, 'day'))} · diary entries on ${esc(plural(model.coverage.diaryDays, 'day'))} · wearable data on ${esc(plural(model.coverage.healthDays, 'day'))}${ai ? '' : ` · made on ${esc(fullLabel(todayIso()))}`}</p>
  </header>`);

  if (model.question) out.push(`<aside class="rp-question" aria-label="Question"><span class="rp-q-label">Question</span><p>${esc(T(model.question))}</p></aside>`);

  // Key points
  const flags = model.flags.map(f => {
    const t = flagText(f, h);
    return `<li class="rp-flag"><span class="pill ${PILL[f.level]}">${esc(LEVEL_WORD[f.level])}</span><div><strong>${esc(t.area)}</strong> ${esc(t.text)}</div></li>`;
  });
  out.push(section('flags', 'Key points', flags.length ? `<ul class="rp-flags">${flags.join('')}</ul>`
    : '<p>Nothing stands out in the measurements, symptoms, medication and lab values of this period.</p>',
  p.partial ? `The last day (${D(p.partial)}) is today and not complete. It is in the daily log but not in averages.` : ''));

  if (inc.profile) out.push(profileHtml());
  if (inc.meds) out.push(medsHtml());
  if (inc.symptoms) out.push(symptomsHtml());
  if (inc.measurements) out.push(measurementsHtml());
  if (inc.labs && model.labs.rows.length) out.push(labsHtml());
  if (inc.wearable && model.wearable) out.push(wearableHtml());
  if (inc.drinks && model.drinks.length) {
    out.push(section('drinks', 'Drinks', list(model.drinks.map(d => `<strong>${esc(d.label)}</strong>: ${esc(drinkText(d))}.`)),
      'Days where a drink was not recorded are left out.'));
  }
  if (inc.associations && model.associations.length) out.push(associationsHtml());
  if (inc.documents) out.push(documentsHtml());
  if (inc.daily && model.daily.rows.length) out.push(dailyHtml());

  out.push(`<footer class="rp-foot"><p>Self-reported diary data with gaps. Sleep, steps and heart data are estimates from a consumer wearable.
    Lab values are read from the documents by the app: check them against the originals.</p></footer>`);
  return `<article class="rp-doc" aria-label="Report preview">${out.join('\n')}</article>`;

  // ---------- Sections

  function profileHtml() {
    const rows = [];
    const add = (k, v) => { if (v) rows.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`); };
    add('Ethnicity', esc(T(pr.ethnicity)));
    add('Body', esc([pr.heightCm && `${pr.heightCm} cm`, pr.weight && `${one(pr.weight.value)} kg (${D(pr.weight.date)})`, pr.bmi && `BMI ${pr.bmi}`].filter(Boolean).join(' · ')));
    for (const [k, l] of [['Conditions', pr.conditions], ['Allergies', pr.allergies], ['Surgeries', pr.surgeries], ['Family history', pr.familyHistory], ['Lifestyle', pr.lifestyle]]) {
      if (l.length) add(k, l.map(x => esc(T(x))).join('<br>'));
    }
    const meds = pr.medications.filter(x => x.status !== 'stopped');
    if (meds.length) {
      add('Medication', meds.map(x => `${esc(T(medName(x)))}${x.asNeeded ? ' <span class="rp-muted">(as needed)</span>' : ''}${x.since ? ` <span class="rp-muted">since ${esc(D(x.since))}</span>` : ''}${x.until ? ` <span class="rp-muted">until ${esc(D(x.until))}</span>` : ''}`).join('<br>'));
    }
    return section('profile', 'Profile', rows.length ? `<dl class="rp-dl">${rows.join('')}</dl>` : '');
  }

  function medsHtml() {
    const { scheduled, asNeeded, timeline } = model.meds;
    if (!scheduled.length && !asNeeded.length && !timeline.length) return '';
    const rows = [
      ...scheduled.map(x => ({ cls: x.rate != null && x.rate < 0.8 && x.eligible >= 5 ? 'is-flag' : '',
        cells: [{ html: `${esc(T(medName(x)))}<span class="rp-muted rp-block">Scheduled</span>` },
          x.eligible ? `${x.taken} of ${x.eligible} days (${pct(x.rate)})` : 'No diary days', x.usualTime || '–'] })),
      ...asNeeded.map(x => [{ html: `${esc(T(x.name))}<span class="rp-muted rp-block">${x.profile ? 'As needed' : 'Not in the list'}</span>` },
        x.uses ? `${plural(x.uses, 'time')} on ${plural(x.days, 'day')}` : 'Not used', x.usualTime || '–']),
    ];
    const tl = timeline.length ? `<p class="rp-sub">Start and stop dates</p>${list(timeline.map(e => `${esc(D(e.date))}: ${esc(e.type)} ${esc(T(e.name))}`))}` : '';
    return section('meds', 'Medication taken', `${table(['Medication', 'Taken', 'Usual time'], rows, { numeric: [2], caption: 'Medication taken' })}${tl}`,
      'Scheduled medication: days with a diary entry while it was active. A day with an entry and no tick counts as not taken.');
  }

  function symptomsHtml() {
    if (!model.symptoms.length) return section('symptoms', 'Symptoms', `<p>No symptoms on the ${esc(plural(model.coverage.diaryDays, 'day'))} with a diary entry.</p>`);
    const items = model.symptoms.map(s => {
      const flagged = ['new', 'more', 'worse'].includes(s.trend);
      return `<li class="rp-symrow${flagged ? ' is-flag' : ''}">
        <div class="rp-symhead"><strong>${esc(T(s.name))}</strong><span class="rp-symdays">${esc(plural(s.days, 'day'))}</span>
          <span class="pill ${flagged ? 'caution' : s.trend === 'less' ? 'ok' : ''}">${esc(TREND[s.trend])}</span></div>
        <p>Severity: ${esc(severityText(s))}. Median: ${esc(severityWords(s.median))}.</p>
        <p>When: ${esc(whenText(s))}.</p>
        ${s.weekly.reduce((a, b) => a + b, 0) > 1 ? `<p class="rp-weekly"><span class="rp-muted">Per week</span> ${spark(s.weekly)} <span class="rp-muted rp-mono">${esc(s.weekly.join(' '))}</span></p>` : ''}
      </li>`;
    });
    return section('symptoms', 'Symptoms', `<ul class="rp-syms">${items.join('')}</ul>`,
      `Counted on ${plural(model.coverage.diaryDays, 'day')} with a diary entry. "Per week": days with the symptom in each week, oldest first.`);
  }

  function spark(weekly) {
    const max = Math.max(1, ...weekly);
    const bars = weekly.map(v => `<span class="rp-sb rp-h${Math.round((v / max) * 4)}" title="${esc(v)}"></span>`).join('');
    return `<span class="rp-spark" aria-label="${esc(`Days per week: ${weekly.join(', ')}`)}" role="img">${bars}</span>`;
  }

  function measurementsHtml() {
    const types = ['weight', 'bp', 'temp'].map(t => model.measurements[t]).filter(x => x.rows.length || x.before);
    if (!types.length) return '';
    const blocks = types.map(x => {
      const rows = [];
      const at = r => ({ html: `${esc(D(r.date))}${r.time ? ` <span class="rp-muted">${esc(r.time)}</span>` : ''}`, cls: 'rp-nowrap' });
      if (x.before) rows.push({ cls: 'is-before', cells: [at(x.before), measurementText(x.before), 'Before the period'] });
      for (const r of x.rows) {
        const flag = { weight: () => null, bp: v => (v.sys >= 140 || v.dia >= 90 ? 'High' : v.sys < 90 || v.dia < 60 ? 'Low' : null), temp: v => (v >= 38 ? 'Fever' : null) }[x.type](r.value);
        rows.push({ cls: flag ? 'is-flag' : '', cells: [at(r), measurementText(r), { html: flag ? `<span class="pill high">${esc(flag)}</span>` : '' }] });
      }
      const change = x.change ? `<p class="rp-note">Change in the period: ${esc(`${x.change.kg > 0 ? '+' : ''}${one(x.change.kg)} kg (${x.change.pct > 0 ? '+' : ''}${one(x.change.pct)}%)`)}.</p>` : '';
      return `<div class="rp-meas-block"><h3>${esc(x.label)}</h3>${table(['Date', 'Value', ''], rows, { caption: `${x.label} readings` })}${change}</div>`;
    }).join('');
    return section('measurements', 'Measurements', `<div class="rp-meas">${blocks}</div>`);
  }

  function labsHtml() {
    const { dates, rows } = model.labs;
    const body = rows.map(r => ({ cls: r.latest.flag ? 'is-flag' : '', cells: [
      { html: `<strong>${esc(T(r.test))}</strong>` },
      ...dates.map(d => (r.cells[d] ? { html: `<span class="rp-nowrap">${esc(labValue(r.cells[d]))}</span> ${flagCell(r.cells[d].flag)}` } : '–')),
      r.rangeText || '–'] }));
    return section('labs', 'Lab results', table(['Test', ...dates.map(D), 'Range'], body, { numeric: dates.map((_, i) => i + 1), caption: 'Lab results' }),
      'Read from the documents by the app. Check against the original documents.');
  }

  function wearableHtml() {
    const w = model.wearable, o = w.overall;
    const hm = v => (v == null ? '–' : `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:${String(Math.round(v % 60)).padStart(2, '0')}`);
    const r = (x, f) => (x ? `${f(x.median)} (${f(x.min)}–${f(x.max)})` : '–');
    const stats = [
      ['Sleep', r(o.sleep, sleepText), `${w.shortNights} nights under 6 h`],
      ['Bedtime', r(o.bed, hm), ''],
      ['Steps', r(o.steps, v => stepsText(v, false)), ''],
      ['Resting heart rate', o.restingHr ? `${r(o.restingHr, Math.round)} bpm` : '–', ''],
      ['HRV', o.hrv ? `${r(o.hrv, Math.round)} ms` : '–', ''],
    ];
    let cmp = '';
    if (w.compare) {
      const c = w.compare;
      const f = (k, fn) => (c.first[k] && c.last[k] ? [fn(c.first[k].median), fn(c.last[k].median)] : ['–', '–']);
      cmp = table(['', 'First 4 weeks', 'Last 4 weeks'], [['Sleep', ...f('sleep', sleepText)], ['Bedtime', ...f('bed', hm)],
        ['Steps', ...f('steps', v => stepsText(v, false))], ['Resting HR (bpm)', ...f('restingHr', Math.round)], ['HRV (ms)', ...f('hrv', Math.round)]],
      { numeric: [1, 2], caption: 'First and last 4 weeks' });
    }
    const weeks = table(['Week from', 'Sleep', 'Bedtime', 'Steps', 'Rest HR', 'HRV'], w.weeks.map(x => [D(x.start), sleepText(x.sleep), hm(x.bed),
      stepsText(x.steps, false), x.restingHr == null ? '–' : Math.round(x.restingHr), x.hrv == null ? '–' : Math.round(x.hrv)]),
    { numeric: [1, 2, 3, 4, 5], caption: 'Weekly medians', cls: 'rp-compact' });
    const workouts = w.workouts.length ? `<p class="rp-note">Workouts: ${esc(w.workouts.map(x => `${x.type} ${x.count}× (${x.minutes} min)`).join(', '))}.</p>` : '';
    return section('wearable', 'Sleep, steps and heart rate', `<dl class="rp-stats">${stats.map(([k, v, s]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}${s ? `<span>${esc(s)}</span>` : ''}</dd></div>`).join('')}</dl>
      ${cmp}${workouts}<h3>Weekly medians</h3>${weeks}`,
    `Wearable data on ${plural(w.days, 'day')}. Medians with the lowest and highest values. Sleep is the night before the date.`);
  }

  function associationsHtml() {
    const groups = new Map();
    for (const a of model.associations) groups.set(a.symptom, [...(groups.get(a.symptom) || []), a]);
    const share = (x, label) => `${pct(x.with / x.days)} of days with ${label} (${x.with} of ${x.days})`;
    const items = [...groups].map(([name, list]) => {
      const small = list.some(a => a.small);
      return `<li><p><strong>${esc(T(name))}</strong>${small ? ' <span class="rp-muted">· few days: read with care</span>' : ''}</p><ul class="rp-list">${list.map(a => {
        const lab = a.factor === 'coffee' ? [`${a.aLabel} of coffee`, a.bLabel] : a.factor === 'sleep' ? [`${a.aLabel} of sleep`, a.bLabel] : [a.aLabel, a.bLabel];
        return `<li><span class="rp-k">${esc(a.label[0].toUpperCase() + a.label.slice(1))}:</span> ${esc(share(a.a, lab[0]))}; ${esc(share(a.b, lab[1]))}.</li>`;
      }).join('')}</ul></li>`;
    });
    return section('patterns', 'Patterns (not causes)', `<ul class="rp-assoc">${items.join('')}</ul>`,
      'Share of diary days with the symptom, in two groups of days. This shows what happened together, not a cause.');
  }

  function documentsHtml() {
    const d = model.documents;
    if (!d.available) return section('docs', 'Medical documents', `<p class="rp-note">Documents were left out: they could not be loaded${d.error ? ` (${esc(d.error)})` : ''}.</p>`);
    if (!d.list.length) return section('docs', 'Medical documents', '<p class="rp-note">No documents for this period.</p>');
    const items = d.list.map(doc => {
      const type = ai ? safeCategory(doc.category) : doc.category;
      const meta = [type, !ai && doc.correspondent].filter(Boolean).map(x => esc(T(x))).join(' · ');
      let body = '';
      if (doc.content) body = `<pre class="rp-text">${esc(T(doc.content))}</pre>`;
      else {
        if (doc.conclusion) body += `<blockquote class="rp-conclusion">${doc.conclusion.map(l => esc(T(l))).join('<br>')}</blockquote>`;
        if (doc.hasLabs) body += '<p class="rp-note">Lab values: see "Lab results".</p>';
        if (doc.excerpt) body += `<pre class="rp-text">${esc(T(doc.excerpt.text))}${doc.excerpt.cut ? '\n…' : ''}</pre>`;
      }
      return `<li class="rp-docitem"><p class="rp-doc-title"><span class="rp-date">${esc(D(doc.date))}</span> <strong>${esc(T(doc.title))}</strong></p>${meta ? `<p class="rp-muted">${meta}</p>` : ''}${body}</li>`;
    });
    return section('docs', 'Medical documents', `<ul class="rp-docs">${items.join('')}</ul>`,
      model.options.docScope === 'all' ? '' : 'Documents of the period, and the latest document of each type from before the period.');
  }

  function dailyHtml() {
    const dl = model.daily;
    const rows = dl.rows.map(r => ({ cls: r.symptoms.length ? 'is-symptom' : '', cells: [
      `${Dday(r.date)}${r.partial ? ' (today)' : ''}`, r.sleep == null ? '' : sleepText(r.sleep), r.steps == null ? '' : stepsText(r.steps, false),
      r.meals == null ? '' : r.meals, drinksShort(r.drinks),
      { html: r.symptoms.map(s => `<span class="rp-sym sev-${s.severity || 0}">${esc(T(s.name))} <span class="rp-muted">${esc(s.severity ? sevShort(s.severity) : 'no severity')}</span></span>`).join('') },
      r.notes ? 'Yes' : ''] }));
    // A doctor reads symptom days only (all days with "Full daily details" or a short period).
    const details = dl.details.filter(d => dl.detailMode === 'all' || d.symptomDay).map(d => {
      const ls = dayLines(d, h, { short: true });
      if (!ls.length) return '';
      return `<li class="rp-day${d.symptomDay ? ' is-symptom' : ''}"><p class="rp-day-date">${esc(Dday(d.date))}${d.partial ? ' (today, partial)' : ''}</p><ul>${ls.map(l => {
        const i = l.indexOf(': ');
        return `<li><span class="rp-k">${esc(l.slice(0, i))}</span> ${esc(l.slice(i + 2))}</li>`;
      }).join('')}</ul></li>`;
    }).join('');
    return section('daily', 'Daily log', `${table(['Day', 'Sleep', 'Steps', 'Meals', 'Drinks', 'Symptoms', 'Notes'], rows, { numeric: [1, 2, 3], caption: 'Daily log', cls: 'rp-compact rp-daily' })}
      ${details ? `<h3>${esc(dl.detailMode === 'all' ? 'Details of each day' : 'Symptom days')}</h3><ul class="rp-days">${details}</ul>` : ''}`,
    'Drinks: water/coffee/alcohol ("–" = not recorded). Sleep is the night before.');
  }
}

