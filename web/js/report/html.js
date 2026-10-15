// The report as formatted HTML for a doctor: on screen, printed or saved as PDF.
// Every value is escaped. No inline styles or handlers (strict CSP); classes are in css/report.css and css/print.css.
import { fullLabel, minToHm, today as todayIso } from '../core/dates.js';
import { esc } from '../core/format.js';
import { describeWhen, drinkSummary } from '../core/schema.js';
import { safeCategory } from './redact.js';
import { ADHERENCE_RULE, dayLines, DOC_SCOPE_TEXT, monthName, TABLE_TEXT, truncate, weeklyText, writers } from './markdown.js';
import {
  drinkText, flagText, LEVEL_WORD, labValue, measurementText, medName,
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
  if (model.lowData) {
    flags.push(`<li class="rp-flag"><span class="pill">Note</span><div><strong>Not enough diary days to spot changes</strong> (${esc(plural(model.coverage.diaryDays, 'day'))}).</div></li>`);
  }
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
  if (model.monthly && model.monthly.length) out.push(monthlyHtml());
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
    const items = [
      ...scheduled.map(x => `<li${x.rate != null && x.rate < 0.8 && x.eligible >= 5 ? ' class="is-flag"' : ''}><strong>${esc(T(medName(x)))}</strong>: ${esc(x.eligible ? `taken on ${x.taken} of ${plural(x.eligible, 'day')} (${pct(x.rate)})${x.usualTime ? `, usually at ${x.usualTime}` : ''}` : 'no diary days while it was active')}.</li>`),
      ...asNeeded.map(x => `<li><strong>${esc(T(x.name))}</strong> <span class="rp-muted">(${x.profile ? 'as needed' : 'not in the list'})</span>: ${esc(x.uses ? `${plural(x.uses, 'time')} on ${plural(x.days, 'day')}${x.usualTime ? `, usually at ${x.usualTime}` : ''}` : 'not used')}.</li>`),
    ];
    const tl = timeline.length ? `<p class="rp-note">Started or stopped: ${esc(timeline.map(e => `${T(e.name)} ${e.type} ${D(e.date)}`).join('; '))}.</p>` : '';
    return section('meds', 'Medication taken', `<ul class="rp-list rp-tight">${items.join('')}</ul>${tl}`, ADHERENCE_RULE);
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
        ${s.weekly.reduce((a, b) => a + (b || 0), 0) > 1 ? `<p class="rp-weekly"><span class="rp-muted">Per week</span> ${spark(s.weekly)} <span class="rp-muted rp-mono">${esc(weeklyText(s.weekly))}</span></p>` : ''}
      </li>`;
    });
    return section('symptoms', 'Symptoms', `<ul class="rp-syms">${items.join('')}</ul>`,
      `Counted on ${plural(model.coverage.diaryDays, 'day')} with a diary entry. "Per week": days with the symptom in each week, oldest first.`);
  }

  function spark(weekly) {
    const max = Math.max(1, ...weekly.map(v => v || 0));
    const bars = weekly.map(v => (v == null ? '<span class="rp-sb rp-none"></span>'
      : `<span class="rp-sb rp-h${Math.round((v / max) * 4)}"></span>`)).join('');
    return `<span class="rp-spark" aria-label="${esc(`Days per week: ${weeklyText(weekly).split(' ').join(', ')}`)}" role="img">${bars}</span>`;
  }

  function measurementsHtml() {
    const types = ['weight', 'bp', 'temp'].map(t => model.measurements[t]).filter(x => x.rows.length || x.before);
    if (!types.length) return '';
    const flagOf = { weight: () => null, bp: v => (v.sys >= 140 || v.dia >= 90 ? 'High' : v.sys < 90 || v.dia < 60 ? 'Low' : null), temp: v => (v >= 38 ? 'Fever' : null) };
    // One line per type: the values in time order; flagged values stand out with a word.
    const items = types.map(x => {
      const val = r => {
        const flag = flagOf[x.type](r.value);
        return `<span class="rp-val${flag ? ' is-flag' : ''}"><span class="rp-nowrap">${esc(measurementText(r).replace(/ · pulse \d+/, ''))}</span> <span class="rp-muted rp-nowrap">${esc(D(r.date))}${r.time && x.type === 'temp' ? ` ${esc(r.time)}` : ''}</span>${flag ? ` <span class="pill high">${esc(flag)}</span>` : ''}</span>`;
      };
      const extra = [
        x.mean && `mean ${x.mean.sys}/${x.mean.dia} mmHg over ${plural(x.mean.n, 'reading')}`,
        x.change && `change ${x.change.kg > 0 ? '+' : ''}${one(x.change.kg)} kg (${x.change.pct > 0 ? '+' : ''}${one(x.change.pct)}%)`,
        x.before && `before the period: ${measurementText(x.before).replace(/ · pulse \d+/, '')} (${D(x.before.date)})`,
      ].filter(Boolean);
      return `<li><strong>${esc(x.label)}</strong>: ${x.rows.length ? x.rows.map(val).join('<span class="rp-sep"> · </span>') : 'none in the period'}${extra.length ? `<span class="rp-muted rp-block">${esc(extra.join('; '))}</span>` : ''}</li>`;
    });
    return section('measurements', 'Measurements', `<ul class="rp-list rp-tight rp-meas">${items.join('')}</ul>`);
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
    const w = model.wearable, o = w.overall, c = w.compare;
    const hm = v => (v == null ? '–' : minToHm(v));
    const r = (x, f) => (x ? `${f(x.min)}–${f(x.max)}` : '–');
    const rows = [['Sleep', 'sleep', sleepText], ['Bedtime', 'bed', hm], ['Steps', 'steps', v => stepsText(v, false)],
      ['Resting heart rate (bpm)', 'restingHr', Math.round], ['HRV (ms)', 'hrv', Math.round]]
      .filter(([, k]) => o[k])
      .map(([label, k, f]) => [label, f(o[k].median), r(o[k], f), ...(c ? [c.first[k] ? f(c.first[k].median) : '–', c.last[k] ? f(c.last[k].median) : '–'] : [])]);
    const head = ['', 'Median', 'Range', ...(c ? ['First 4 weeks', 'Last 4 weeks'] : [])];
    const weeks = model.options.fullDaily ? `<h3>Weekly medians</h3>${table(['Week from', 'Sleep', 'Bedtime', 'Steps', 'Rest HR', 'HRV'], w.weeks.map(x => [D(x.start), sleepText(x.sleep), hm(x.bed),
      stepsText(x.steps, false), x.restingHr == null ? '–' : Math.round(x.restingHr), x.hrv == null ? '–' : Math.round(x.hrv)]),
    { numeric: [1, 2, 3, 4, 5], caption: 'Weekly medians', cls: 'rp-compact' })}` : '';
    const notes = [`${plural(w.shortNights, 'night')} under 6 h`, w.workouts.length && `workouts: ${w.workouts.map(x => `${x.type} ${x.count}×`).join(', ')}`].filter(Boolean);
    return section('wearable', 'Sleep, steps and heart rate', `${table(head, rows, { numeric: [1, 2, 3, 4], caption: 'Wearable data', cls: 'rp-compact' })}
      <p class="rp-note">${esc(notes.join('. '))}.</p>${weeks}`,
    `Wearable data on ${plural(w.days, 'day')}. Sleep is the night before the date.`);
  }

  function associationsHtml() {
    // One row per symptom, one column per factor: "8 of 30 (27%) vs 6 of 37 (16%)".
    const factors = [['coffee', 'Coffee: 3+ cups vs fewer'], ['alcohol', 'Alcohol: any vs none'], ['sleep', 'Sleep: under 6 h vs 6 h+']]
      .filter(([k]) => model.associations.some(a => a.factor === k));
    const names = [...new Set(model.associations.map(a => a.symptom))];
    const cellOf = a => (a ? `${a.a.with}/${a.a.days} (${pct(a.rateA)}) vs ${a.b.with}/${a.b.days} (${pct(a.rateB)})` : '–');
    const rows = names.map(n => {
      const list = model.associations.filter(a => a.symptom === n);
      return [{ html: `<strong>${esc(T(n))}</strong>${list.some(a => a.small) ? ' <span class="rp-muted">(few days)</span>' : ''}` },
        ...factors.map(([k]) => cellOf(list.find(a => a.factor === k)))];
    });
    return section('patterns', 'Patterns (not causes)', table(['Symptom', ...factors.map(f => f[1])], rows, { caption: 'Patterns', cls: 'rp-compact' }),
      'Days with the symptom out of diary days, in two groups of days. This shows what happened together, not a cause.');
  }

  function monthlyHtml() {
    const rows = model.monthly.map(x => [monthName(x.month), `${x.diaryDays} of ${x.days}`, x.symptomDays,
      x.symptoms.map(y => `${T(y.name)} ${y.days}`).join(', ') || '–', sleepText(x.sleep), stepsText(x.steps, false),
      x.coffee == null ? '–' : one(x.coffee), x.alcoholDays == null ? '–' : x.alcoholDays]);
    return section('monthly', 'Month by month', table(['Month', 'Diary days', 'Symptom days', 'Main symptoms', 'Sleep', 'Steps', 'Coffee a day', 'Alcohol days'], rows,
      { numeric: [2, 4, 5, 6, 7], caption: 'Month by month', cls: 'rp-compact' }), 'Medians for sleep and steps.');
  }

  function documentsHtml() {
    const d = model.documents;
    if (!d.available) return section('docs', 'Medical documents', `<p class="rp-note">Documents were left out: they could not be loaded${d.error ? ` (${esc(d.error)})` : ''}.</p>`);
    if (!d.list.length) return section('docs', 'Medical documents', '<p class="rp-note">No documents for this period.</p>');
    const items = d.list.map(doc => {
      const type = ai ? safeCategory(doc.category) : doc.category;
      const meta = [type, !ai && doc.correspondent].filter(Boolean).map(x => esc(T(x))).join(' · ');
      let body = '';
      if (doc.content) body = `<pre class="rp-text">${esc(T(doc.content, doc.date))}</pre>`;
      else {
        if (doc.conclusion) body += `<blockquote class="rp-conclusion">${doc.conclusion.map(l => esc(T(l, doc.date))).join('<br>')}</blockquote>`;
        if (doc.hasLabs) body += '<p class="rp-note">Lab values: see "Lab results".</p>';
        if (doc.excerpt) body += `<pre class="rp-text">${esc(T(doc.excerpt.text, doc.date))}${doc.excerpt.cut ? '\n…' : ''}</pre>`;
      }
      return `<li class="rp-docitem"><p class="rp-doc-title"><span class="rp-date">${esc(D(doc.date))}</span> <strong>${esc(T(doc.title, doc.date))}</strong></p>${meta ? `<p class="rp-muted">${meta}</p>` : ''}${body}</li>`;
    });
    return section('docs', 'Medical documents', `<ul class="rp-docs">${items.join('')}</ul>`,
      model.options.docScope === 'all' ? '' : DOC_SCOPE_TEXT);
  }

  function dailyHtml() {
    const dl = model.daily;
    const rows = dl.rows.map(r => ({ cls: r.symptoms.length ? 'is-symptom' : '', cells: [
      { text: `${Dday(r.date)}${r.partial ? ' (today)' : ''}`, cls: 'rp-nowrap' }, r.sleep == null ? '' : sleepText(r.sleep), r.steps == null ? '' : stepsText(r.steps, false),
      drinkSummary(r.drinks),
      { html: r.symptoms.map(x => `<span class="rp-sym sev-${x.severity || 0}">${esc(T(x.name, r.date))} <span class="rp-muted">${esc([x.severity ? sevShort(x.severity) : 'no severity', describeWhen(x)].filter(Boolean).join(', '))}</span></span>`).join('') },
      { text: truncate(T(r.notes, r.date), 80), cls: 'rp-notes' }] }));
    // Day details for a doctor only with "All days" (or a short period); the table has the notes.
    const details = dl.details.filter(d => dl.detailMode === 'all').map(d => {
      const ls = dayLines(d, h, { short: true });
      if (!ls.length) return '';
      return `<li class="rp-day${d.symptomDay ? ' is-symptom' : ''}"><p class="rp-day-date">${esc(Dday(d.date))}${d.partial ? ' (today, partial)' : ''}</p><ul>${ls.map(l => {
        const i = l.indexOf(': ');
        return `<li><span class="rp-k">${esc(l.slice(0, i))}</span> ${esc(l.slice(i + 2))}</li>`;
      }).join('')}</ul></li>`;
    }).join('');
    return section('daily', 'Daily log', `${table(['Day', 'Sleep', 'Steps', 'Drinks', 'Symptoms', 'Notes'], rows, { numeric: [1, 2], caption: 'Daily log', cls: 'rp-compact rp-daily' })}
      ${details ? `<h3>${esc(dl.detailMode === 'all' ? 'Details of each day' : 'Symptom days')}</h3><ul class="rp-days">${details}</ul>` : ''}`,
    `${TABLE_TEXT[dl.tableMode]} Sleep is the night before.`);
  }
}

