// The report end to end: model, markdown (AI and text), HTML (doctor), on the sample data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, today } from '../js/core/dates.js';
import { seed } from '../js/api/sample.js';
import { setCatalog } from '../js/core/schema.js';
import { buildReportModel, docConclusion, excerpt, selectDocuments, SECTIONS } from '../js/report/model.js';
import { toMarkdown } from '../js/report/markdown.js';
import { toHtml } from '../js/report/html.js';
import { makeRedactor } from '../js/report/redact.js';

const db = seed();
setCatalog(db.catalog); // the demo's own Tea counter and Back pain measurement
const TO = today();
const allDays = () => [...new Set([...Object.keys(db.days), ...Object.keys(db.health)])].sort()
  .map(d => ({ date: d, log: db.days[d] || null, health: db.health[d] || null }));
const data = (extra = {}) => ({ profile: db.profile, days: allDays(), measurements: db.measurements, documents: db.documents, today: TO, ...extra });
const QUESTION = 'Is there a link between my coffee and my palpitations?';

function aiReport(opts = {}, d = data()) {
  const from = opts.from || addDays(TO, -89);
  const model = buildReportModel(d, { from, to: TO, audience: 'ai', question: QUESTION, excludedDocs: [], ...opts });
  const redactor = makeRedactor({ profile: db.profile, words: db.settings.redactWords, correspondents: db.documents.map(x => x.correspondent), relativeTo: TO });
  return { model, md: toMarkdown(model, { redactor, relative: true }) };
}

test('AI report on the sample data: no personal detail leaks', () => {
  for (const opts of [{}, { fullDaily: true, docFull: true, docScope: 'all' }, { from: addDays(TO, -364) }]) {
    const { md } = aiReport(opts);
    for (const secret of ['Alex', 'Example', 'Petit', 'Martin', 'Claire', 'Laurent', 'BioCentre', 'BIOCENTRE', 'Saint-Roch', 'SAINT-ROCH',
      '1991', '14/03', '4481920377', '01 23 45 67 89', 'clinique-saint-roch', '88412', '31877', '@']) {
      assert.ok(!md.includes(secret), `"${secret}" leaked with ${JSON.stringify(opts)}`);
    }
    assert.ok(!/\b\d{4}-\d{2}-\d{2}\b/.test(md), 'no absolute ISO dates in relative mode');
  }
});

test('long periods: monthly summaries without absolute dates in AI mode, symptom days only in the table', () => {
  const { md, model } = aiReport({ from: addDays(TO, -364) });
  assert.ok(model.monthly.length >= 3);
  assert.match(md, /## Month by month/);
  assert.match(md, /\|D-\d+ to D-?\d+\|\d+ of \d+\|/);
  assert.ok(!/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) 20\d\d\b/.test(md), 'no month names with a year');
  assert.equal(model.daily.tableMode, 'symptom-days');
  assert.ok(model.daily.rows.every(r => r.symptomDay || r.partial));
});

test('AI report: framing, question first and last, relative dates with weekday names', () => {
  const { md } = aiReport();
  assert.match(md, /^# Health report \(anonymized\)/);
  assert.match(md, /self-reported/);
  assert.match(md, /consumer wearable/);
  assert.match(md, /D0 is the last day/);
  assert.match(md, /Do not give a diagnosis/);
  assert.match(md, /questions that I can ask a clinician/);
  const first = md.indexOf(QUESTION), last = md.lastIndexOf(QUESTION);
  assert.ok(first > 0 && first < md.indexOf('## Key points'), 'question at the top');
  assert.ok(last > md.indexOf('## Daily log'), 'question repeated at the end');
  // Weekday names are allowed: they show weekend patterns and do not identify anyone.
  assert.match(md, /\|D-1 (Mon|Tue|Wed|Thu|Fri|Sat|Sun)\|/);
  assert.match(md, /D0 \w{3} \(today, partial\)/);
});

test('AI report: 90 days of sample data stay short by default', () => {
  const { md } = aiReport();
  const words = md.match(/\S+/g).length;
  assert.ok(words < 3000, `${words} words`);
  const full = aiReport({ fullDaily: true }).md;
  assert.ok(full.length > md.length * 1.5, 'full daily details add the food and every day');
  assert.match(full, /breakfast:/);
});

test('flags come first and cover the sample events', () => {
  const { model, md } = aiReport();
  const kinds = model.flags.map(f => f.kind);
  assert.ok(kinds.includes('bp-high'), 'BP 142/91');
  assert.ok(kinds.includes('fever'), 'temperature 38.3');
  assert.ok(kinds.includes('lab-resolved'), 'vitamin D was low');
  assert.equal(model.flags[0].level === 'info', false);
  assert.ok(md.indexOf('## Key points') < md.indexOf('## Profile'));
  assert.match(md, /1 of 3 readings at 140\/90 mmHg or above/);
});

test('partial today: not in averages, said in the report', () => {
  const { model, md } = aiReport();
  assert.equal(model.period.partial, TO);
  const coffee = model.drinks.find(d => d.key === 'coffee');
  const recorded = allDays().filter(d => d.date >= addDays(TO, -89) && d.date < TO && d.log && d.log.drinks.coffee != null).length;
  assert.equal(coffee.recorded, recorded);
  assert.match(md, /today and not complete/);
  const notToday = buildReportModel(data(), { from: addDays(TO, -30), to: addDays(TO, -1), audience: 'ai' });
  assert.equal(notToday.period.partial, null);
});

test('measurements: in the period, with a labelled baseline; no "Measured" lines in the log when the table is in', () => {
  const { md } = aiReport({ fullDaily: true });
  assert.match(md, /Before the period: /);
  assert.ok(!md.includes('Measured:'));
  const noTable = aiReport({ fullDaily: true, include: { measurements: false } }).md;
  assert.match(noTable, /Measured: /);
  assert.ok(!noTable.includes('## Measurements'));
});

test('sections can be switched off', () => {
  const include = Object.fromEntries(SECTIONS.map(s => [s.key, false]));
  const { md } = aiReport({ include });
  for (const h of ['## Profile', '## Medication taken', '## Symptoms', '## Daily log', '## Lab results', '## Medical documents']) assert.ok(!md.includes(h), h);
  assert.match(md, /## Key points/);
});

test('documents: period plus the latest per category, excluded ones out, unavailable said', () => {
  const from = addDays(TO, -89);
  const sel = selectDocuments(db.documents, { from, to: TO });
  assert.deepEqual(sel.map(d => d.id), [101, 102, 103, 104], 'documents of the 2 years before the period are in');
  const old = [{ id: 1, date: '2019-01-01', category: 'Cardiology', content: 'Normal.' }, { id: 2, date: '2018-01-01', category: 'Cardiology', content: 'Contrôle dans 10 ans.' },
    { id: 3, date: '2017-01-01', category: 'Cardiology', content: 'Normal.' }];
  assert.deepEqual(selectDocuments(old, { from, to: TO }).map(d => d.id), [1, 2], 'the latest of a category, and older ones with a follow-up');
  assert.deepEqual(selectDocuments(db.documents, { from, to: TO, scope: 'all' }).map(d => d.id), [101, 102, 103, 104]);
  assert.deepEqual(selectDocuments(db.documents, { from, to: TO, excluded: [102] }).map(d => d.id), [101, 103, 104]);
  const { md } = aiReport({}, data({ documents: null, documentsError: 'Paperless is down' }));
  assert.match(md, /Documents were left out: they could not be loaded \(Paperless is down\)/);
  assert.ok(!md.includes('## Lab results'));
});

test('documents: conclusion or the start of the text', () => {
  assert.deepEqual(docConclusion('Text\n\nConclusion: benign PVCs.\nNo treatment.\nDr. X'), ['Conclusion: benign PVCs.', 'No treatment.']);
  assert.equal(docConclusion('No summary here'), null);
  const e = excerpt('word '.repeat(300));
  assert.ok(e.cut && e.text.length <= 600);
});

test('labs table is labelled as read from documents', () => {
  const { md } = aiReport();
  assert.match(md, /## Lab results\n\nRead from the documents by the app\. Check against the original documents\./);
  assert.match(md, /\|Vitamin D \(25-OH\)\|18 ng\/mL LOW\|31 ng\/mL\|30 – 100\|/);
});

test('doctor HTML: name and date of birth, flags as pills, tables, escaped text', () => {
  const d = data();
  d.profile = { ...db.profile, conditions: '<img src=x onerror=alert(1)>' };
  const days = d.days.map(x => ({ ...x }));
  const last = days.findIndex(x => x.date === addDays(TO, -1));
  days[last] = { ...days[last], log: { ...days[last].log, notes: '<script>alert(1)</script>', symptoms: [{ name: '<b>x</b>', severity: 3 }] } };
  d.days = days;
  const model = buildReportModel(d, { from: addDays(TO, -89), to: TO, audience: 'doctor', question: 'Why <tired>?' });
  const html = toHtml(model);
  assert.match(html, /Alex Example/);
  assert.match(html, /Born 14 Mar 1991/);
  assert.match(html, /<span class="pill (high|caution)">(High|Check)<\/span>/);
  assert.match(html, /<table class="table rp-table/);
  assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('<b>x'), 'user text is escaped');
  assert.match(html, /Why &lt;tired&gt;\?/);
  assert.ok(!/<[^>]*\s(style|on\w+)=/.test(html), 'no inline styles or handlers in tags');
  assert.ok(!html.includes('```') && !html.includes('## '), 'no raw markdown');
});

test('doctor text copy: not redacted, real dates', () => {
  const model = buildReportModel(data(), { from: addDays(TO, -89), to: TO, audience: 'doctor' });
  const md = toMarkdown(model);
  assert.match(md, /- Name: Alex Example/);
  assert.ok(!/\bD-\d+\b/.test(md));
});

test('AI mode with dates kept: ISO dates, date of birth still hidden', () => {
  const model = buildReportModel(data(), { from: addDays(TO, -89), to: TO, audience: 'ai', docFull: true });
  const redactor = makeRedactor({ profile: db.profile, correspondents: db.documents.map(x => x.correspondent), relativeTo: null });
  const md = toMarkdown(model, { redactor, relative: false });
  assert.match(md, new RegExp(`Period: ${addDays(TO, -89)} to ${TO}`));
  assert.ok(!md.includes('1991') && !md.includes('Alex'));
});

test('empty data: the report still renders', () => {
  const model = buildReportModel({ profile: {}, days: [], measurements: [], documents: [], today: TO }, { from: addDays(TO, -29), to: TO, audience: 'ai' });
  const md = toMarkdown(model, { redactor: makeRedactor({}), relative: true });
  assert.match(md, /Not enough diary days to spot changes \(0 days\)/);
  assert.ok(!md.includes('Nothing stands out'), 'no false reassurance with little data');
  assert.ok(!md.includes('## Profile'), 'no empty heading');
  assert.match(toHtml(model), /rp-doc/);
});

test('documents with lab values keep their other lines', () => {
  const d = data({ documents: [{ id: 9, date: addDays(TO, -3), title: 'Bilan', category: 'Blood test', correspondent: '',
    content: 'Glucose 0.95 g/L (0.70-1.10)\nAntigène HBs : POSITIF\nCommentaire : hémolyse légère' }] });
  const model = buildReportModel(d, { from: addDays(TO, -89), to: TO, audience: 'doctor' });
  const doc = model.documents.list[0];
  assert.ok(doc.hasLabs);
  assert.match(doc.excerpt.text, /Antigène HBs : POSITIF/);
  assert.match(toHtml(model), /Antigène HBs : POSITIF/);
});

test('little data: no false reassurance, correct plurals', () => {
  const d = data({ days: allDays().filter(x => x.date === addDays(TO, -2)) });
  const model = buildReportModel(d, { from: addDays(TO, -29), to: TO, audience: 'doctor' });
  const md = toMarkdown(model);
  assert.match(md, /Not enough diary days to spot changes \(1 day\)/);
  assert.ok(!/\b1 days\b/.test(md) && !/\b1 days\b/.test(toHtml(model)), 'no "1 days"');
});

test('doctor daily log: symptom days and the days around them, notes text, drinks in words', () => {
  const model = buildReportModel(data(), { from: addDays(TO, -89), to: TO, audience: 'doctor' });
  assert.equal(model.daily.tableMode, 'around');
  const sym = new Set(model.daily.rows.filter(r => r.symptomDay).map(r => r.date));
  for (const r of model.daily.rows) {
    assert.ok(r.symptomDay || r.partial || sym.has(addDays(r.date, 1)) || sym.has(addDays(r.date, -1)), r.date);
  }
  const html = toHtml(model);
  assert.match(html, /\d water · \d coffee · \d alcohol/);
  assert.ok(!/<td[^>]*>\d\/\d\/\d<\/td>/.test(html), 'no "7/2/0"');
  assert.match(html, /class="rp-notes">Palpitations for about 10 min/);
  const all = buildReportModel(data(), { from: addDays(TO, -89), to: TO, audience: 'doctor', fullDaily: true });
  assert.equal(all.daily.tableMode, 'all');
  assert.ok(all.daily.rows.length > model.daily.rows.length);
});

test('key points: mean home BP and the strongest pattern when there are enough days', () => {
  const { model, md } = aiReport();
  assert.match(md, /Mean: \d+\/\d+ mmHg over 3 readings/);
  const assoc = model.flags.filter(f => f.kind === 'association');
  assert.ok(assoc.length >= 1 && assoc.length <= 2);
  assert.ok(assoc.every(f => !f.assoc.small));
  assert.match(md, /This is a pattern, not a cause\./);
});

// ---------- Own items (catalog) and new Apple Health values

test('own measurements: listed like built-ins, own range in key points, unknown types as "Other measurement"', () => {
  const ms = [...db.measurements, { id: 999, type: 'c_gone', date: addDays(TO, -4), time: '', value: 12 }];
  const { model, md } = aiReport({}, data({ measurements: ms }));
  assert.match(md, /- Back pain: \d+\/10 \(D-\d+/);
  const f = model.flags.find(x => x.kind === 'custom-range');
  assert.ok(f && f.above >= 1, 'readings above the own range');
  assert.match(md, new RegExp(`Check: Back pain\\. Above your range on ${f.above} of ${f.total} readings`));
  assert.match(md, /- Other measurement: 12 \(D-4\)/);
  const html = toHtml(buildReportModel(data({ measurements: ms }), { from: addDays(TO, -89), to: TO, audience: 'doctor' }));
  assert.match(html, /<strong>Back pain<\/strong>/);
  assert.match(html, /Above your range<\/span>/);
});

test('own counters: stats, daily table, drinks in words, associations when there are enough days', () => {
  const { model, md } = aiReport();
  const tea = model.drinks.find(d => d.key === 'c_tea');
  assert.ok(tea && tea.recorded > 0 && tea.average != null && tea.max != null);
  assert.match(md, /- Tea: recorded on \d+ days, average [\d.]+ cups a day/);
  assert.match(md, /Drinks: water\/coffee\/alcohol\/tea/);
  assert.match(md, /\|\d+\/\d+\/\d+\/\d+\|/, 'four counters in the compact table');
  assert.ok(model.associations.some(a => a.factor === 'c_tea'), 'Tea is in the pattern scan');
  const html = toHtml(buildReportModel(data(), { from: addDays(TO, -89), to: TO, audience: 'doctor' }));
  assert.match(html, /\d water · \d coffee · \d alcohol · \d tea/);
});

test('own counter names are hidden like other user words in AI mode', () => {
  setCatalog({ ...db.catalog, counters: [{ id: 'c_tea', name: 'Tea with Martine', one: 'cup', many: 'cups' }] });
  try {
    const model = buildReportModel(data(), { from: addDays(TO, -89), to: TO, audience: 'ai' });
    const redactor = makeRedactor({ profile: db.profile, words: ['Martine'], relativeTo: TO });
    assert.ok(!toMarkdown(model, { redactor, relative: true }).includes('Martine'));
  } finally { setCatalog(db.catalog); }
});

test('own document types: shown to the doctor, "Medical document" for the AI', () => {
  const docs = [{ id: 7, date: addDays(TO, -5), title: 'Letter', category: 'Suivi Dr Dupont', correspondent: '', content: 'Conclusion: all normal.' }];
  const d = data({ documents: docs });
  const html = toHtml(buildReportModel(d, { from: addDays(TO, -89), to: TO, audience: 'doctor' }));
  assert.match(html, /Suivi Dr Dupont/);
  const { md } = aiReport({}, d);
  assert.match(md, /### D-5: Letter \(Medical document\)/);
  assert.ok(!md.includes('Dupont'));
});

test('blood oxygen and respiratory rate: weekly medians, first and last 4 weeks, plain key points', () => {
  const { md, model } = aiReport();
  assert.ok(model.wearable.overall.spo2 && model.wearable.overall.respiratoryRate);
  assert.match(md, /\| SpO2 % \| SpO2 low \| Resp\/min \|/);
  assert.match(md, /blood oxygen [\d.]+ % → [\d.]+ %/);
  assert.ok(!model.flags.some(f => f.kind.startsWith('oxygen') || f.kind === 'respiratory-high'), 'normal sample values: no flag');
  // Low nights, a low average and a high respiratory rate.
  const days = allDays().map(x => (x.health ? { ...x, health: { ...x.health, spo2: 93.2, spo2Min: x.date === addDays(TO, -3) || x.date === addDays(TO, -10) ? 87 : 91, respiratoryRate: 21.4 } } : x));
  const r = aiReport({}, data({ days }));
  assert.match(r.md, /Check: Blood oxygen\. Lowest value under 90 % on 2 days: D-10 \(87 %\), D-3 \(87 %\)\. Wearable estimate\./);
  assert.match(r.md, /Check: Blood oxygen\. Average 93\.2 % over the period \(under 94 %\)/);
  assert.match(r.md, /Check: Respiratory rate\. Average 21\.4 breaths a minute over the period \(above 20\)/);
  const html = toHtml(buildReportModel(data({ days }), { from: addDays(TO, -89), to: TO, audience: 'doctor' }));
  assert.match(html, /Lowest value under 90 % on 2 days: \d+ \w+ \(87 %\)/, 'real dates for the doctor');
  assert.ok(!/diagnos|apnoea|apnea/i.test(r.md.split('## Key points')[1].split('##')[0]), 'no diagnosis words');
});

test('few diary days: no symptom key points, no "0 of 0 diary days"', () => {
  const keep = allDays().filter(x => x.log && x.log.symptoms && x.log.symptoms.length).slice(-6).map(x => x.date);
  const d = data({ days: allDays().filter(x => keep.includes(x.date)) });
  const model = buildReportModel(d, { from: addDays(TO, -89), to: TO, audience: 'ai' });
  assert.ok(model.lowData);
  assert.ok(!model.flags.some(f => f.kind.startsWith('symptom-')));
  const md = toMarkdown(model, { redactor: makeRedactor({ profile: db.profile, relativeTo: TO }), relative: true });
  assert.ok(!md.includes('0 of 0') && !md.includes('New in the second half'));
  assert.match(md, /Trend: too few diary days to compare/);
});

test('the AI text says that most personal details are removed, not all', () => {
  const { md } = aiReport();
  assert.match(md, /Most personal details are removed/);
});
