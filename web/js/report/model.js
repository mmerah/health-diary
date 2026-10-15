// The report model: all numbers and facts of the report as a plain object. No text formatting,
// no redaction. The renderers (markdown.js, html.js) turn it into a report for a doctor or an AI.
//
// const model = buildReportModel(
//   { profile, days: [{ date, log, health }], measurements, documents (null = not available), documentsError, today },
//   { from, to, audience: 'doctor' | 'ai', question, include: { profile: true, … }, fullDaily, docScope, docFull, excludedDocs });
import { addDays, ageOn, diffDays } from '../core/dates.js';
import { lines as textLines } from '../core/format.js';
import { bmi, hasContent, MEALS, normalizeLog, normalizeProfile } from '../core/schema.js';
import { labTable, nonLabText, parseLabs } from './labs.js';
import {
  adherence, asNeededUse, associations, drinkStats, measurementStats, medsTouched as medsTouchedLog, medTimeline, monthlyStats, symptomStats,
  wearableStats,
} from './stats.js';

/** Report sections the user can switch on and off (flags and the summary are always included). */
export const SECTIONS = [
  { key: 'profile', label: 'Profile and medication list' },
  { key: 'meds', label: 'Medication taken' },
  { key: 'symptoms', label: 'Symptoms' },
  { key: 'measurements', label: 'Weight, blood pressure, temperature' },
  { key: 'wearable', label: 'Sleep, steps and heart rate' },
  { key: 'drinks', label: 'Drinks' },
  { key: 'associations', label: 'Patterns with coffee, alcohol and sleep' },
  { key: 'labs', label: 'Lab results from documents' },
  { key: 'documents', label: 'Medical documents' },
  { key: 'daily', label: 'Daily log' },
];

export const DEFAULT_OPTIONS = {
  audience: 'doctor',
  period: 90, // 30 | 90 | 365 | 'custom'
  from: '', to: '',
  question: '',
  include: Object.fromEntries(SECTIONS.map(s => [s.key, true])),
  fullDaily: false,
  docScope: 'period', // 'period': in the period + the latest of each category before it | 'all'
  docFull: false,
  relativeDates: true,
};

// ---------- Documents

// Follow-up instructions make an old document still relevant: "Follow-up echo in 2 years", "contrôle dans 1 an".
const FOLLOW_UP_RE = /\b(?:follow[- ]?up|re-?check|repeat|control|contr[ôo]le|[àa] revoir|revoir|surveillance|dans\s+\d+\s+(?:ans?|mois|semaines?)|in\s+\d+\s+(?:years?|months?|weeks?))\b/i;

/**
 * Documents for the report, newest first. Excluded ones are out. Scope 'period' (the default):
 * the documents of the period, every document of the 2 years before it, the latest of each category before that,
 * and older documents that ask for a follow-up. Scope 'all': every document.
 */
export function selectDocuments(docs, { from, to, scope = 'period', excluded = [] } = {}) {
  const ex = new Set((excluded || []).map(String));
  const ok = (docs || []).filter(d => !ex.has(String(d.id)) && d.date && d.date <= to);
  if (scope === 'all') return ok.sort((a, b) => b.date.localeCompare(a.date));
  const recent = addDays(from, -730);
  const keep = new Set(ok.filter(d => d.date >= recent || FOLLOW_UP_RE.test(String(d.content || ''))));
  const latest = new Map();
  for (const d of ok.filter(x => x.date < from)) {
    const k = (d.category || 'Other').trim().toLowerCase();
    if (!latest.has(k) || latest.get(k).date < d.date) latest.set(k, d);
  }
  for (const d of latest.values()) keep.add(d);
  return [...keep].sort((a, b) => b.date.localeCompare(a.date));
}

// Letterhead and identity lines of a lab report: not worth repeating next to the lab table.
const HEADER_LINE_RE = /^\s*(?:patient|nom|name|pr[ée]nom|dob|n[ée]e?\b|born|sample|[ée]chantillon|validated|valid[ée]|sign|dr\.?\s|docteur|t[ée]l|phone|page|adresse|address|ipp|dossier|laboratoire|laboratory|clinique|h[ôo]pital|cabinet|centre)/i;

const CONCLUSION_RE = /^\s*(?:conclusions?|summary|impression|assessment|interpretation|synth[èe]se|r[ée]sum[ée]|interpr[ée]tation|diagnos(?:is|tic)|avis|recommendations?|plan)\b\s*[:.\-–]?\s*/i;

/** The conclusion lines of a document, or null. A conclusion runs until a blank line (at most 4 lines). */
export function docConclusion(content) {
  const ls = String(content || '').split('\n');
  const out = [];
  for (let i = 0; i < ls.length; i++) {
    if (!CONCLUSION_RE.test(ls[i])) continue;
    out.push(ls[i].trim());
    for (let j = i + 1; j < ls.length && ls[j].trim() && j <= i + 3; j++) {
      if (/^\s*(?:dr\.?|docteur|pr\.?|prof)\b/i.test(ls[j])) break; // the signature
      out.push(ls[j].trim());
    }
    break;
  }
  return out.length ? out : null;
}

/** About `max` characters from the start, cut at the end of a line or a word. */
export function excerpt(content, max = 600) {
  const s = String(content || '').trim();
  if (s.length <= max) return { text: s, cut: false };
  let cut = s.lastIndexOf('\n', max);
  if (cut < max * 0.6) cut = s.lastIndexOf(' ', max);
  return { text: s.slice(0, cut > 0 ? cut : max).trim(), cut: true };
}

// ---------- The model


export function buildReportModel(data, options) {
  const o = { ...DEFAULT_OPTIONS, ...options, include: { ...DEFAULT_OPTIONS.include, ...(options.include || {}) } };
  const inc = o.include;
  const { from, to } = o;
  const today = data.today || to;
  const profile = normalizeProfile(data.profile);
  const span = diffDays(to, from) + 1;
  // The last day is not finished when it is today: it stays in the log, not in averages.
  const partial = to === today ? today : null;

  const days = (data.days || []).filter(d => d.date >= from && d.date <= to).map(d => {
    const log = d.log ? normalizeLog(d.log) : null;
    return { date: d.date, log, health: d.health || null, logged: !!log && hasContent(log) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const loggedDays = days.filter(d => d.logged);
  const measurements = (data.measurements || []).filter(m => m.date <= to);

  const model = {
    audience: o.audience,
    question: String(o.question || '').trim(),
    period: { from, to, days: span, today, partial },
    coverage: {
      diaryDays: loggedDays.length,
      healthDays: days.filter(d => d.health).length,
      emptyDays: span - days.filter(d => d.logged || d.health).length,
    },
    include: inc,
    options: { fullDaily: o.fullDaily, docScope: o.docScope, docFull: o.docFull },
  };

  // Profile
  const weights = measurements.filter(m => m.type === 'weight').sort((a, b) => a.date.localeCompare(b.date));
  const lastW = weights[weights.length - 1] || null;
  model.profile = {
    name: profile.name || '', dob: profile.dob || '', age: profile.dob ? ageOn(profile.dob, to) : null,
    sex: profile.sex || '', ethnicity: profile.ethnicity || '', heightCm: profile.heightCm || null,
    weight: lastW, bmi: lastW ? bmi(lastW.value, profile.heightCm) : null,
    conditions: textLines(profile.conditions), allergies: textLines(profile.allergies), surgeries: textLines(profile.surgeries),
    familyHistory: textLines(profile.familyHistory), lifestyle: textLines(profile.lifestyle),
    medications: profile.medications.filter(m => m.name).map(m => ({
      ...m,
      status: m.until && m.until < from ? 'stopped' : m.since && m.since > to ? 'later' : (m.until && m.until <= to ? 'stopped in period' : 'current'),
    })),
  };

  // Medication
  model.meds = {
    scheduled: adherence(profile, days, { skip: partial }),
    asNeeded: asNeededUse(profile, days),
    timeline: medTimeline(profile, to),
  };

  // Symptoms, drinks, wearable, associations
  model.symptoms = symptomStats(days, { from, to });
  model.drinks = drinkStats(days, { skip: partial });
  model.wearable = wearableStats(days, { from, to, skip: partial });
  model.associations = associations(days, model.symptoms, { skip: partial });

  // Measurements
  model.measurements = Object.fromEntries(['weight', 'bp', 'temp'].map(t => [t, measurementStats(t, measurements, { from, to })]));

  // Documents and labs
  model.documents = { available: data.documents != null, error: data.documentsError || null, list: [], total: (data.documents || []).length };
  if (data.documents) {
    const selected = selectDocuments(data.documents, { from, to, scope: o.docScope, excluded: o.excludedDocs });
    const labs = labTable(selected);
    model.labs = labs;
    model.documents.list = selected.map(d => {
      const conclusion = docConclusion(d.content);
      const hasLabs = parseLabs(d.content).length > 0;
      // The lines that are not lab values are always kept: "Antigène HBs : POSITIF", comments, conclusions.
      const rest = hasLabs ? nonLabText(d.content).split('\n').filter(l => !HEADER_LINE_RE.test(l)).join('\n') : d.content;
      return {
        id: d.id, date: d.date, title: d.title || 'Document', category: d.category || '', correspondent: d.correspondent || '',
        inPeriod: d.date >= from, conclusion, hasLabs,
        excerpt: !conclusion && String(rest || '').trim() ? excerpt(rest, hasLabs ? 400 : 600) : null,
        content: o.docFull ? String(d.content || '').trim() : null,
      };
    });
    model.documents.excluded = (o.excludedDocs || []).length;
  } else {
    model.labs = { dates: [], rows: [] };
  }

  // Daily log. The table: every day with data (AI, up to 90 days); symptom days and the days around them (doctor);
  // symptom days only (beyond 90 days, with monthly summaries); every day with "Full daily details".
  // The details: symptom days and the days around them (AI); every day with "Full daily details" or up to 14 days.
  const withData = days.filter(d => d.logged || d.health);
  const symptomDates = new Set(loggedDays.filter(d => d.log.symptoms.length).map(d => d.date));
  const around = new Set();
  for (const x of symptomDates) for (const k of [-1, 0, 1]) around.add(addDays(x, k));
  const long = span > 90;
  const tableMode = o.fullDaily || span <= 14 ? 'all' : long ? 'symptom-days' : o.audience === 'doctor' ? 'around' : 'all';
  const tableRows = withData.filter(d => tableMode === 'all' || (tableMode === 'around' ? around.has(d.date) : symptomDates.has(d.date)) || d.date === partial);
  const detailAll = o.fullDaily || span <= 14;
  const detailDates = new Set(withData.filter(d => detailAll || (o.audience === 'ai' && !long && around.has(d.date)) || (o.audience === 'ai' && long && symptomDates.has(d.date))).map(d => d.date));
  const showMeasured = !inc.measurements;
  model.daily = {
    tableMode,
    detailMode: detailAll ? 'all' : 'symptom-days',
    hiddenDays: withData.length - tableRows.length,
    rows: tableRows.map(d => {
      const l = d.log;
      const sl = d.health && d.health.sleep;
      return {
        date: d.date, partial: d.date === partial, logged: d.logged,
        sleep: sl && sl.total && !sl.inBedOnly ? sl.total : null,
        steps: d.health && d.health.steps && d.date !== partial ? d.health.steps : null,
        meals: l ? MEALS.filter(m => l.meals[m.key].text).length + l.snacks.filter(x => x.text).length : null,
        drinks: l ? l.drinks : null,
        symptoms: l ? l.symptoms.map(x => ({ name: x.name, severity: x.severity, when: x.when, periods: x.periods, from: x.from, to: x.to })) : [],
        notes: l ? l.notes : '',
        symptomDay: symptomDates.has(d.date),
      };
    }),
    details: withData.filter(d => detailDates.has(d.date)).map(d => ({
      date: d.date, partial: d.date === partial, log: d.logged ? d.log : null, health: d.health,
      meds: d.logged && medsTouchedLog(d.log) ? (profile.medications || []).filter(m => !m.asNeeded && (!m.since || m.since <= d.date) && (!m.until || m.until >= d.date))
        .map(m => ({ name: m.name, dose: m.dose, done: !!(d.log.meds.taken[m.id] || {}).done, time: (d.log.meds.taken[m.id] || {}).time || '' })) : [],
      measured: showMeasured ? measurements.filter(m => m.date === d.date) : [],
      symptomDay: symptomDates.has(d.date),
    })),
  };
  model.monthly = long ? monthlyStats(days, { skip: partial }) : null;
  model.lowData = loggedDays.length < 14;

  model.flags = computeFlags(model);
  return model;
}

// ---------- Flags: what a doctor should see first. Each flag is data; the renderers write the words.

const LEVEL = { high: 0, caution: 1, info: 2 };

export function computeFlags(m) {
  const f = [];
  const inc = m.include || {};
  const { bp, temp, weight } = m.measurements;
  if (inc.measurements !== false) addMeasurementFlags(f, bp, temp, weight);
  if (inc.symptoms !== false) {
    for (const s of m.symptoms) {
      if (s.trend === 'new' || s.trend === 'more' || s.trend === 'worse') f.push({ kind: `symptom-${s.trend}`, level: 'caution', symptom: s });
      if (s.severeDates.length >= 2) f.push({ kind: 'symptom-severe', level: 'info', symptom: s });
    }
  }
  if (inc.meds !== false) {
    for (const med of m.meds.scheduled) {
      if (med.eligible >= 5 && med.rate < 0.8) f.push({ kind: 'missed-med', level: 'caution', med });
    }
  }
  if (inc.labs !== false) {
    for (const row of m.labs.rows) {
      if (row.latest.flag) f.push({ kind: 'lab', level: 'caution', row, date: latestDate(row) });
      else {
        const earlier = Object.entries(row.cells).filter(([, r]) => r.flag);
        if (earlier.length) f.push({ kind: 'lab-resolved', level: 'info', row, date: latestDate(row), earlier: earlier[earlier.length - 1] });
      }
    }
  }
  // The two strongest patterns with enough days (different symptoms): key points, never causes.
  if (inc.associations !== false) {
    const seen = new Set();
    const strong = (m.associations || []).filter(a => !a.small && Math.abs(a.diff) >= 0.15 && a.a.with + a.b.with >= 5)
      .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
      .filter(a => !seen.has(a.symptom) && seen.add(a.symptom)).slice(0, 2);
    for (const a of strong) f.push({ kind: 'association', level: 'info', assoc: a });
  }
  const c = inc.wearable !== false && m.wearable && m.wearable.compare;
  if (c && c.first.restingHr && c.last.restingHr && c.last.restingHr.median - c.first.restingHr.median >= 5) {
    f.push({ kind: 'hr-up', level: 'caution', first: c.first.restingHr.median, last: c.last.restingHr.median });
  }
  if (c && c.first.sleep && c.last.sleep && c.first.sleep.median - c.last.sleep.median >= 45) {
    f.push({ kind: 'sleep-down', level: 'info', first: c.first.sleep.median, last: c.last.sleep.median });
  }
  return f.sort((a, b) => LEVEL[a.level] - LEVEL[b.level]);
}

function addMeasurementFlags(f, bp, temp, weight) {
  if (bp.high.length) {
    const worst = bp.high.reduce((a, b) => (b.value.sys > a.value.sys ? b : a));
    f.push({ kind: 'bp-high', level: bp.high.length >= 2 || worst.value.sys >= 160 || worst.value.dia >= 100 ? 'high' : 'caution',
      count: bp.high.length, total: bp.rows.length, worst });
  }
  if (bp.low.length) f.push({ kind: 'bp-low', level: 'caution', count: bp.low.length, total: bp.rows.length, worst: bp.low[0] });
  if (temp.episodes && temp.episodes.length) f.push({ kind: 'fever', level: 'caution', episodes: temp.episodes });
  if (weight.change && Math.abs(weight.change.pct) >= 3) f.push({ kind: 'weight', level: 'caution', change: weight.change });
}
const latestDate = row => Object.keys(row.cells).sort().pop();
