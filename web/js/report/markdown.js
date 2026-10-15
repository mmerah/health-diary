// The report as markdown: for an AI assistant (anonymized, relative dates) or as plain text for a doctor.
// toMarkdown(model, { redactor, relative })
//   redactor: from makeRedactor(), or null (no redaction: the doctor's text copy)
//   relative: dates as D-n (D0 = the last day of the period).
import { fullLabel, label, minToHm, weekday } from '../core/dates.js';
import { describeWhen, drinkSummary, MEALS } from '../core/schema.js';
import { relDay } from './dates-text.js';
import { safeCategory } from './redact.js';
import {
  adherenceText, asNeededText, drinkText, drinksShort, duration, flagText, LEVEL_WORD,
  labValue, measurementText, pct, medName, one, plural, severityText, severityWords, sevShort, sleepText, stepsText, TREND, whenText,
} from './words.js';

/** Helpers shared with html.js: how dates and user text are written. */
export function writers(model, { redactor = null, relative = false } = {}) {
  const ref = model.period.to;
  const ai = model.audience === 'ai';
  const rel = !!(redactor && relative);
  const year = ref.slice(0, 4);
  // Doctor: "9 Oct", with the year only when it is not the year of the report ("23 Mar 2025").
  const D = iso => (!iso ? '' : rel ? relDay(iso, ref) : ai ? iso
    : iso.slice(0, 4) === year ? label(iso, { day: 'numeric', month: 'short' }) : fullLabel(iso));
  // Daily rows: "D-12 Mon" / "Tue 14 Oct". Weekday names help to see weekend patterns and do not identify anyone.
  const Dday = iso => (rel ? `${relDay(iso, ref)} ${weekday(iso)}` : ai ? `${iso} ${weekday(iso)}` : label(iso));
  // User text. `at` is the date the text belongs to (a document or a diary day): it places dates written without a year.
  const T = (s, at) => (redactor ? redactor.text(s, { ref: typeof at === 'string' ? at : ref }) : String(s ?? ''));
  return { D, Dday, T, ai, rel };
}

const cell = (s, empty = '–') => String(s ?? '').replace(/\|/g, '/').replace(/\s*\n\s*/g, ' / ').trim() || empty;
const inline = s => String(s ?? '').replace(/\s*\n\s*/g, ' / ').trim();
const table = (head, rows, empty = '–') => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`,
  ...rows.map(r => `|${r.map(c => cell(c, empty)).join('|')}|`)];

export function toMarkdown(model, opts = {}) {
  const h = writers(model, opts);
  const { D, Dday, T, ai, rel } = h;
  const inc = model.include;
  const p = model.period;
  const out = [];
  const push = (...l) => out.push(...l);

  push(ai ? '# Health report (anonymized)' : '# Health report', '');
  push(`Period: ${D(p.from)} to ${D(p.to)} (${plural(p.days, 'day')}).`);

  if (ai) {
    push('', '## Read this first', '',
      '- This is a personal health diary. The data is self-reported and has gaps. A day without an entry is unknown, not a day without symptoms.',
      '- Sleep, steps, heart rate and HRV come from a consumer wearable. They are estimates.',
      rel ? `- Dates are day numbers. D0 is the last day of the period. D-7 is 7 days before D0.` : '- Dates are written YYYY-MM-DD.',
      '- Names, addresses, ID numbers, contact details and the date of birth are removed and shown as [name], [address], [id] and so on.',
      '- Please: refer to the day numbers when you point to data. Say how certain you are. Do not give a diagnosis. Suggest questions that I can ask a clinician.');
  }
  if (model.question) push('', '## My question', '', T(model.question));

  // Key points
  push('', '## Key points', '');
  if (model.flags.length) {
    for (const f of model.flags) {
      const t = flagText(f, h);
      push(`- ${LEVEL_WORD[f.level]}: ${t.area}. ${t.text}`);
    }
  }
  if (model.lowData) push(`- Not enough diary days to spot changes (${plural(model.coverage.diaryDays, 'day')}).`);
  else if (!model.flags.length) push('- Nothing stands out in the measurements, symptoms, medication and lab values of this period.');
  push('', `Data: diary entries on ${plural(model.coverage.diaryDays, 'day')} of ${p.days}, wearable data on ${plural(model.coverage.healthDays, 'day')}.`);
  if (p.partial) push(`The last day (${D(p.partial)}) is today and not complete. It is in the daily log but not in averages.`);

  if (inc.profile) profileSection(model, h, push);
  if (inc.meds) medsSection(model, h, push);
  if (inc.symptoms) symptomsSection(model, h, push);
  if (inc.measurements) measurementsSection(model, h, push);
  if (inc.labs && model.labs.rows.length) labsSection(model, h, push);
  if (inc.wearable && model.wearable) wearableSection(model, h, push);
  if (inc.drinks && model.drinks.length) {
    push('', '## Drinks', '', 'Days where a drink was not recorded are left out.', '');
    for (const d of model.drinks) push(`- ${d.label}: ${drinkText(d)}.`);
  }
  if (inc.associations && model.associations.length) associationsSection(model, h, push);
  if (model.monthly && model.monthly.length) monthlySection(model);
  if (inc.documents) documentsSection(model, h, push);
  if (inc.daily && model.daily.rows.length) dailySection(model, h, push);

  if (model.question) push('', '## My question (again)', '', T(model.question));
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;

  // ---------- Sections (closures over h)

  function profileSection(m) {
    const pr = m.profile;
    const start = out.length;
    push('', '## Profile', '');
    if (!ai && pr.name) push(`- Name: ${pr.name}`);
    if (pr.age != null) push(ai || !pr.dob ? `- Age: ${pr.age}` : `- Date of birth: ${fullLabel(pr.dob)} (age ${pr.age})`);
    if (pr.sex) push(`- Sex: ${T(pr.sex)}`);
    if (pr.ethnicity) push(`- Ethnicity: ${T(pr.ethnicity)}`);
    const body = [pr.heightCm && `height ${pr.heightCm} cm`, pr.weight && `weight ${one(pr.weight.value)} kg (${D(pr.weight.date)})`, pr.bmi && `BMI ${pr.bmi}`].filter(Boolean);
    if (body.length) push(`- Body: ${body.join(', ')}`);
    for (const [title, list] of [['Conditions', pr.conditions], ['Allergies', pr.allergies], ['Surgeries and hospital stays', pr.surgeries],
      ['Family history', pr.familyHistory], ['Lifestyle', pr.lifestyle]]) {
      if (list.length) push(`- ${title}: ${list.map(T).join('; ')}`);
    }
    const meds = pr.medications.filter(x => x.status !== 'stopped');
    if (meds.length) {
      push('- Medication:');
      for (const x of meds) {
        const when = [x.since && `since ${D(x.since)}`, x.until && `until ${D(x.until)}`].filter(Boolean).join(', ');
        push(`  - ${T(medName(x))}${x.asNeeded ? ' (as needed)' : ''}${when ? `, ${when}` : ''}`);
      }
    }
    if (out.length === start + 3) out.length = start; // nothing under the heading
  }

  function medsSection(m) {
    const { scheduled, asNeeded, timeline } = m.meds;
    if (!scheduled.length && !asNeeded.length && !timeline.length) return;
    push('', '## Medication taken', '');
    if (scheduled.length) push(ADHERENCE_RULE, '');
    for (const x of scheduled) push(`- ${T(medName(x))}: ${adherenceText(x)}.`);
    for (const x of asNeeded) push(`- ${T(x.name)}${x.profile ? ' (as needed)' : ' (not in the medication list)'}: ${asNeededText(x)}.`);
    if (timeline.length) {
      push('', 'Start and stop dates:');
      for (const e of timeline) push(`- ${D(e.date)}: ${e.type} ${T(e.name)}`);
    }
  }

  function symptomsSection(m) {
    push('', '## Symptoms', '');
    if (!m.symptoms.length) { push(`No symptoms on the ${plural(m.coverage.diaryDays, 'day')} with a diary entry.`); return; }
    push(`Counted on ${plural(m.coverage.diaryDays, 'day')} with a diary entry. "Weekly" is the number of days for each week, oldest first ("–": no diary entry that week).`, '');
    for (const s of m.symptoms) {
      push(`- ${T(s.name)}: ${plural(s.days, 'day')}. Severity: ${severityText(s)}; median ${severityWords(s.median)}. When: ${whenText(s)}. Trend: ${TREND[s.trend]}. Weekly: ${weeklyText(s.weekly)}.`);
    }
  }

  function measurementsSection(m) {
    const types = ['weight', 'bp', 'temp'].map(t => m.measurements[t]).filter(x => x.rows.length || x.before);
    if (!types.length) return;
    push('', '## Measurements', '');
    const at = r => `${D(r.date)}${r.time ? ` ${r.time}` : ''}`;
    for (const x of types) {
      const parts = x.rows.map(r => `${measurementText(r)} (${at(r)})`);
      if (!x.rows.length) parts.push('none in the period');
      const before = x.before ? ` Before the period: ${measurementText(x.before)} (${at(x.before)}).` : '';
      const change = x.change ? ` Change: ${x.change.kg > 0 ? '+' : ''}${one(x.change.kg)} kg (${x.change.pct > 0 ? '+' : ''}${one(x.change.pct)}%).` : '';
      const avg = x.mean ? ` Mean: ${x.mean.sys}/${x.mean.dia} mmHg over ${plural(x.mean.n, 'reading')}.` : '';
      push(`- ${x.label}: ${parts.join('; ')}.${avg}${before}${change}`);
    }
  }

  function labsSection(m) {
    const { dates, rows } = m.labs;
    push('', '## Lab results', '', 'Read from the documents by the app. Check against the original documents.', '');
    push(...table(['Test', ...dates.map(D), 'Range'], rows.map(r => [T(r.test),
      ...dates.map(d => (r.cells[d] ? `${labValue(r.cells[d])}${r.cells[d].flag ? ` ${r.cells[d].flag.toUpperCase()}` : ''}` : '')),
      r.rangeText])));
  }

  function wearableSection(m) {
    const w = m.wearable;
    push('', '## Sleep, steps and heart rate', '', `Wearable data on ${plural(w.days, 'day')}. Sleep is the night before the date. Values are medians.`, '');
    const o = w.overall;
    const range = (x, f) => (x ? `${f(x.median)} (${f(x.min)} to ${f(x.max)})` : '–');
    push(`- Sleep: ${range(o.sleep, sleepText)}; ${plural(w.shortNights, 'night')} under 6 h`);
    if (o.bed) push(`- Bedtime: ${hm(o.bed.median)} (${hm(o.bed.min)} to ${hm(o.bed.max)})`);
    push(`- Steps: ${range(o.steps, v => stepsText(v, ai))}`);
    if (o.restingHr) push(`- Resting heart rate: ${range(o.restingHr, v => `${Math.round(v)}`)} bpm`);
    if (o.hrv) push(`- HRV: ${range(o.hrv, v => `${Math.round(v)}`)} ms`);
    if (w.workouts.length) push(`- Workouts: ${w.workouts.map(x => `${T(x.type)} ${x.count}× (${x.minutes} min)`).join(', ')}`);
    if (w.compare) {
      const c = w.compare;
      const cmp = (k, f) => (c.first[k] && c.last[k] ? `${f(c.first[k].median)} → ${f(c.last[k].median)}` : null);
      const parts = [['sleep', cmp('sleep', sleepText)], ['bedtime', cmp('bed', hm)], ['steps', cmp('steps', v => stepsText(v, ai))],
        ['resting HR', cmp('restingHr', v => Math.round(v))], ['HRV', cmp('hrv', v => Math.round(v))]].filter(x => x[1]);
      push(`- First 4 weeks → last 4 weeks: ${parts.map(x => `${x[0]} ${x[1]}`).join('; ')}`);
    }
    push('', 'Weekly medians:', '');
    push(...table(['Week', 'Sleep', 'Bedtime', 'Steps', 'Rest HR', 'HRV'], w.weeks.map(x => [
      `${D(x.start)} to ${D(x.end)}`, sleepText(x.sleep), hm(x.bed), stepsText(x.steps, ai),
      x.restingHr == null ? '–' : Math.round(x.restingHr), x.hrv == null ? '–' : Math.round(x.hrv)])));
  }

  function associationsSection(m) {
    push('', '## Patterns (not causes)', '', 'Days with the symptom out of diary days, in two groups of days. This shows what happened together, not a cause. * = few days: read with care.', '');
    push(...table(['Symptom', 'Compared', 'Group 1', 'Group 2'], m.associations.map(a => [
      `${T(a.symptom)}${a.small ? ' *' : ''}`, a.label,
      `${a.aLabel}: ${a.a.with}/${a.a.days} (${pct(a.rateA)})`, `${a.bLabel}: ${a.b.with}/${a.b.days} (${pct(a.rateB)})`])));
  }

  function monthlySection(m) {
    push('', '## Month by month', '', 'Diary and wearable data for each calendar month (medians for sleep and steps).', '');
    push(...table(['Month', 'Diary days', 'Symptom days', 'Main symptoms', 'Sleep', 'Steps', 'Coffee/day', 'Alcohol days'], m.monthly.map(x => [
      // In AI mode with day numbers, a month is its range of days: a month name would be an absolute date.
      rel ? `${D(x.start)} to ${D(x.end)}` : monthName(x.month), `${x.diaryDays} of ${x.days}`, x.symptomDays, x.symptoms.map(y => `${T(y.name)} ${y.days}`).join(', '),
      sleepText(x.sleep), stepsText(x.steps, ai), x.coffee == null ? '–' : one(x.coffee), x.alcoholDays == null ? '–' : x.alcoholDays])));
  }

  function documentsSection(m) {
    const d = m.documents;
    push('', '## Medical documents', '');
    if (!d.available) { push(`Documents were left out: they could not be loaded${d.error ? ` (${inline(d.error)})` : ''}.`); return; }
    if (!d.list.length) { push('No documents for this period.'); return; }
    push(m.options.docScope === 'all' ? 'All documents.' : DOC_SCOPE_TEXT, '');
    for (const doc of d.list) {
      const type = ai ? safeCategory(doc.category) : doc.category;
      push(`### ${D(doc.date)}: ${T(doc.title, doc.date)}${type && type !== doc.title ? ` (${T(type)})` : ''}`, '');
      if (!ai && doc.correspondent) push(`From: ${doc.correspondent}`, '');
      if (doc.content) { push('```text', T(doc.content, doc.date).replace(/```/g, "'''"), '```', ''); continue; }
      if (doc.conclusion) push(...doc.conclusion.map(l => `> ${T(l, doc.date)}`), '');
      if (doc.hasLabs) push('Lab values: see "Lab results".', '');
      if (doc.excerpt) push(doc.hasLabs ? 'Other text:' : 'Start of the text:', '', '```text', T(doc.excerpt.text, doc.date).replace(/```/g, "'''") + (doc.excerpt.cut ? '\n…' : ''), '```', '');
    }
  }

  function dailySection(m) {
    const dl = m.daily;
    push('', '## Daily log', '');
    push(`${TABLE_TEXT[dl.tableMode]} Drinks: water/coffee/alcohol ("–" = not recorded). Symptoms with severity.`, '');
    push(...table(['Day', 'Sleep', 'Steps', 'Meals', 'Drinks', 'Symptoms', 'Notes'], dl.rows.map(r => [
      `${Dday(r.date)}${r.partial ? ' (today, partial)' : ''}`, r.sleep == null ? '' : sleepText(r.sleep), r.steps == null ? '' : stepsText(r.steps, ai),
      r.meals == null ? '' : r.meals, drinksShort(r.drinks),
      r.symptoms.map(s => `${T(s.name, r.date)} ${s.severity ? sevShort(s.severity) : '(severity not set)'}`).join(', '),
      r.notes ? (ai ? 'yes' : truncate(r.notes, 80)) : '']), ''));
    if (!dl.details.length) return;
    const brief = dl.detailMode !== 'all';
    const { lines, level, dropped } = fitDetails(dl.details, h, brief ? DETAIL_BUDGET : Infinity);
    push('', !brief ? '### Details of each day' : dl.tableMode === 'symptom-days' ? '### Details of symptom days' : '### Details: symptom days and the day before and after', '');
    const notes = [];
    if (brief && level === 0) notes.push('Food and sleep times are shown for symptom days only.');
    if (level >= 1) notes.push('Food is left out to keep the report short.');
    if (level >= 2) notes.push('Days around a symptom day are shown only when they have notes or extra medication.');
    if (dropped) notes.push(`The ${plural(dropped, 'oldest day')} are left out.`);
    if (level >= 1) notes.push('Turn on "Full daily details" for everything.');
    if (notes.length) push(notes.join(' '), '');
    push(...lines);
  }

  function hm(v) { return v == null ? '–' : minToHm(v); }
}

export const ADHERENCE_RULE = 'Scheduled medication, while it was active. Only days where the medication part of the diary was filled in count. On those days, no tick counts as not taken.';
export const DOC_SCOPE_TEXT = 'Documents of the period and of the 2 years before it, the latest document of each type, and older documents that ask for a follow-up.';
export const TABLE_TEXT = {
  all: 'One row per day with data.',
  around: 'Symptom days and the day before and after. Turn on "All days" for every day.',
  'symptom-days': 'Symptom days only (long period). See "Month by month" for the other days.',
};
/** "1 0 2 – 3": days with the symptom per week; "–" when there was no diary entry that week. */
export const weeklyText = w => w.map(v => (v == null ? '–' : v)).join(' ');
export const monthName = ym => label(`${ym}-01`, { month: 'short', year: 'numeric' });
export const truncate = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// Characters for the day details when "All days" is off: keeps a 90-day AI report under about 2,500 words.
const DETAIL_BUDGET = 4300;

/**
 * Day details that fit the budget. Levels: 0 all, 1 no food, 2 also quiet days around symptom days left out,
 * 3 also the oldest days left out.
 */
function fitDetails(details, h, budget) {
  const render = (list, level) => list.map(d => {
    const ls = dayLines(d, h, { brief: !d.symptomDay && budget !== Infinity, short: true, food: level === 0 || budget === Infinity });
    return ls.length ? `- ${h.Dday(d.date)}${d.partial ? ' (today, partial)' : ''}: ${ls.join('. ')}.` : null;
  }).filter(Boolean);
  const size = ls => ls.reduce((n, l) => n + l.length + 1, 0);
  let lines = render(details, 0);
  if (size(lines) <= budget) return { lines, level: 0, dropped: 0 };
  lines = render(details, 1);
  if (size(lines) <= budget) return { lines, level: 1, dropped: 0 };
  const kept = details.filter(d => d.symptomDay || (d.log && (d.log.notes || d.log.meds.extra.length)));
  lines = render(kept, 2);
  if (size(lines) <= budget) return { lines, level: 2, dropped: 0 };
  let n = 0;
  while (size(lines) > budget && lines.length > 1) { lines.shift(); n++; }
  return { lines, level: 3, dropped: n };
}

/**
 * The lines of one day in the details. Shared by both renderers.
 * brief: only activity, notes and medication exceptions (days around a symptom day).
 * short: medication lists only what is not usual (not ticked, extra), drinks are left out (they are in the table).
 */
export function dayLines(d, { T }, { brief = false, short = false, food = true } = {}) {
  const out = [];
  const hh = d.health;
  const l = d.log;
  if (l && l.symptoms.length) out.push(`Symptoms: ${l.symptoms.map(s => `${T(s.name, d.date)} (${[sevShort(s.severity), describeWhen(s)].filter(Boolean).join(', ')})`).join('; ')}`);
  if (!brief && hh && hh.sleep && hh.sleep.bed && hh.sleep.wake) out.push(`Sleep: ${hh.sleep.bed} to ${hh.sleep.wake}${short ? '' : ` (${duration(hh.sleep.total)})`}`);
  if (hh && hh.workouts && hh.workouts.length) out.push(`Workout: ${hh.workouts.map(w => `${T(w.type, d.date)} ${w.minutes} min${w.start ? ` at ${w.start}` : ''}`).join(', ')}`);
  if (l) {
    if (!brief && food) {
      const meals = [...MEALS.map(m => ({ label: m.label, time: l.meals[m.key].time, text: l.meals[m.key].text, sort: l.meals[m.key].time || m.typical })),
        ...l.snacks.map(s => ({ label: 'Snack', time: s.time, text: s.text, sort: s.time || '16:00' }))]
        .filter(x => x.text).sort((a, b) => a.sort.localeCompare(b.sort));
      if (meals.length) out.push(`Food: ${meals.map(x => `${x.time ? `${x.time} ` : ''}${x.label.toLowerCase()}: ${inline(T(x.text, d.date)).replace(/[.;]+$/, '')}`).join('; ')}`);
    }
    if (!short) { const dr = drinkSummary(l.drinks); if (dr) out.push(`Drinks: ${dr}`); }
    const meds = [...d.meds.filter(x => !short || !x.done).map(x => `${T(x.name, d.date)} ${x.done ? `taken${x.time ? ` ${x.time}` : ''}` : 'not ticked'}`),
      ...l.meds.extra.filter(x => x.name).map(x => `${T(x.name, d.date)}${x.time ? ` at ${x.time}` : ''}`)];
    if (meds.length) out.push(`Medication: ${meds.join('; ')}`);
    if (l.activities) out.push(`Activity: ${inline(T(l.activities, d.date)).replace(/[.]+$/, '')}`);
    if (l.notes) out.push(`Notes: ${inline(T(l.notes, d.date)).replace(/[.]+$/, '')}`);
  }
  if (d.measured && d.measured.length) out.push(`Measured: ${d.measured.map(x => `${measurementText(x)}${x.time ? ` at ${x.time}` : ''}`).join('; ')}`);
  return out;
}
