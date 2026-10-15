import test from 'node:test';
import assert from 'node:assert/strict';
import { dateTimeLabel, formatSetupCode, medStatus, newPasswordError, parseHeight, parseMedForm, passwordHint, sortMeds } from '../js/screens/profile-account.js';
import { categoriesOf, changedFields, excludedList, excludedSet, filterDocs, NO_TYPE, sourcesOf, suggestionDiff, untypedCount, uploadError } from '../js/screens/records-data.js';
import { mergeProfile } from '../js/screens/profile-merge.js';

const TODAY = '2026-10-14';

test('passwordHint levels', () => {
  assert.equal(passwordHint('').level, 'empty');
  assert.equal(passwordHint('abc').level, 'short');
  assert.match(passwordHint('abcdefghi').text, /1 more character\./);
  assert.equal(passwordHint('password123').level, 'weak');
  assert.equal(passwordHint('alexalex2026', 'alex').level, 'weak');
  assert.equal(passwordHint('blue river kettle').level, 'strong');
  assert.equal(passwordHint('Bluerivr7k').level, 'ok');
});

test('newPasswordError', () => {
  assert.match(newPasswordError('short', 'short'), /at least 10/);
  assert.match(newPasswordError('longenough1', 'longenough2'), /not the same/);
  assert.match(newPasswordError('alexander1', 'alexander1', 'Alexander1'), /same as the username/);
  assert.equal(newPasswordError('longenough1', 'longenough1', 'alex'), '');
  assert.equal(newPasswordError('longenough1', null), '');
});

test('formatSetupCode accepts any case, spaces and dashes', () => {
  assert.equal(formatSetupCode('abcd efgh-ijkl'), 'ABCD-EFGH-IJKL');
  assert.equal(formatSetupCode('ABCDEFGHIJ'), 'ABCD-EFGH-IJ');
  assert.equal(formatSetupCode(' - '), '');
});

test('medication status and sorting', () => {
  const meds = [
    { id: 'a', name: 'Zinc', since: '', until: '' },
    { id: 'b', name: 'Aspirin', since: '2026-11-01', until: '' },
    { id: 'c', name: 'Old', since: '', until: '2026-01-01' },
    { id: 'd', name: 'Today', since: '', until: TODAY },
  ];
  assert.equal(medStatus(meds[0], TODAY), 'active');
  assert.equal(medStatus(meds[1], TODAY), 'planned');
  assert.equal(medStatus(meds[2], TODAY), 'stopped');
  assert.equal(medStatus(meds[3], TODAY), 'stopped');
  const s = sortMeds(meds, TODAY);
  assert.deepEqual(s.current.map(m => m.id), ['b', 'a']);
  assert.deepEqual(s.stopped.map(m => m.id), ['d', 'c']);
});

test('parseMedForm validates', () => {
  assert.equal(parseMedForm({ name: ' ' }).field, 'name');
  assert.equal(parseMedForm({ name: 'X', since: '2026-02-30' }).field, 'since');
  assert.equal(parseMedForm({ name: 'X', since: '2026-05-01', until: '2026-04-01' }).field, 'until');
  assert.deepEqual(parseMedForm({ name: ' Magnesium ', dose: '300 mg', since: '', until: '', asNeeded: true }).value,
    { name: 'Magnesium', dose: '300 mg', since: '', until: '', asNeeded: true });
});

test('parseHeight', () => {
  assert.equal(parseHeight('178'), 178);
  assert.equal(parseHeight(''), null);
  assert.equal(parseHeight('17'), undefined);
  assert.equal(parseHeight('300'), undefined);
});

test('dateTimeLabel', () => {
  assert.equal(dateTimeLabel(''), '');
  assert.equal(dateTimeLabel('nonsense'), '');
  assert.equal(dateTimeLabel('2026-10-12T08:14'), '12 Oct 2026, 08:14');
});

test('records: filterDocs searches title, sender and text; newest first', () => {
  const docs = [
    { id: 1, date: '2026-01-01', title: 'Blood test', correspondent: 'Lab', category: 'Blood test', content: 'Cholestérol 2.1' },
    { id: 2, date: '2026-06-01', title: 'Echo', correspondent: 'Dr. Petit', category: 'Cardiology', content: 'mitral' },
  ];
  assert.deepEqual(filterDocs(docs).map(d => d.id), [2, 1]);
  assert.deepEqual(filterDocs(docs, { query: 'cholesterol' }).map(d => d.id), [1]);
  assert.deepEqual(filterDocs(docs, { query: 'petit mitral' }).map(d => d.id), [2]);
  assert.deepEqual(filterDocs(docs, { category: 'Cardiology' }).map(d => d.id), [2]);
  assert.deepEqual(categoriesOf(docs), ['Blood test', 'Cardiology']);
});

test('mergeProfile: server copy plus only the fields changed here', () => {
  const med = (id, name, extra = {}) => ({ id, name, dose: '', since: '', until: '', asNeeded: false, ...extra });
  const base = { name: 'Alex', allergies: 'None', heightCm: 178, medications: [med('a', 'Mag'), med('b', 'Vit D'), med('c', 'Iron')] };
  const mine = { name: 'Alex', allergies: 'Penicillin', heightCm: 178,
    medications: [med('a', 'Mag', { until: '2026-10-14' }), med('b', 'Vit D'), med('n', 'New here')] }; // stopped a, deleted c, added n
  const theirs = { name: 'Alex E.', allergies: 'None', heightCm: 179,
    medications: [med('a', 'Mag'), med('b', 'Vit D', { dose: '2000 IU' }), med('c', 'Iron'), med('t', 'New there')] };
  const out = mergeProfile(base, mine, theirs);
  assert.equal(out.name, 'Alex E.');          // changed there only
  assert.equal(out.heightCm, 179);
  assert.equal(out.allergies, 'Penicillin');  // changed here
  const byId = Object.fromEntries(out.medications.map(m => [m.id, m]));
  assert.equal(byId.a.until, '2026-10-14');   // my change
  assert.equal(byId.b.dose, '2000 IU');       // their change
  assert.equal(byId.c, undefined);            // my delete
  assert.ok(byId.t && byId.n);                // both additions
});

test('mergeProfile: a delete there wins over no change here; a change here survives a delete there', () => {
  const med = (id, dose = '') => ({ id, name: id, dose, since: '', until: '', asNeeded: false });
  const base = { medications: [med('x'), med('y')] };
  const mine = { medications: [med('x'), med('y', '5 mg')] };
  const theirs = { medications: [] };
  assert.deepEqual(mergeProfile(base, mine, theirs).medications.map(m => m.id), ['y']);
});

test('mergeProfile without a base keeps the local copy', () => {
  assert.equal(mergeProfile(null, { name: 'A', medications: [] }, { name: 'B', medications: [] }).name, 'A');
});

test('records: source filter, sources, newest first with createdAt as tie-break', () => {
  const docs = [
    { id: 'd1', source: 'diary', date: '2026-06-01', createdAt: '2026-10-01T10:00', title: 'A' },
    { id: 'd2', source: 'diary', date: '2026-06-01', createdAt: '2026-10-02T10:00', title: 'B' },
    { id: 7, date: '2026-01-01', title: 'C' },
  ];
  assert.deepEqual(filterDocs(docs).map(d => d.id), ['d2', 'd1', 7]);
  assert.deepEqual(filterDocs(docs, { source: 'paperless' }).map(d => d.id), [7]);
  assert.deepEqual(sourcesOf(docs), ['diary', 'paperless']);
});

test('records: suggestions only when ready and different', () => {
  const d = { status: 'ready', category: '', date: '2026-10-03', title: 'scan_001', suggested: { category: 'Blood test', date: '2026-10-03', title: 'Blood test – lipids' } };
  assert.deepEqual(suggestionDiff(d), [{ key: 'category', value: 'Blood test' }, { key: 'title', value: 'Blood test – lipids' }]);
  assert.deepEqual(suggestionDiff({ ...d, status: 'processing' }), []);
  assert.deepEqual(suggestionDiff({ ...d, suggested: null }), []);
});

test('records: excluded ids keep their type', () => {
  const set = excludedSet([3, 'd12']);
  assert.ok(set.has('3') && set.has('d12'));
  assert.deepEqual(excludedList(set), [3, 'd12']);
});

test('records: upload checks', () => {
  assert.match(uploadError(null), /Choose a file/);
  assert.match(uploadError({ name: 'a.docx', type: 'application/msword', size: 10 }), /PDF or a photo/);
  assert.match(uploadError({ name: 'a.pdf', type: 'application/pdf', size: 26 * 1024 * 1024 }), /25 MB/);
  assert.equal(uploadError({ name: 'IMG_1.HEIC', type: '', size: 1000 }), '');
});

test('records: documents without a type, edited fields and changed fields', () => {
  const docs = [
    { id: 5, source: 'paperless', category: '', status: 'ready', title: 'Scan', date: '2026-01-02', edited: ['title'],
      suggested: { category: 'Imaging', title: 'MRI knee', date: '2026-01-02' } },
    { id: 'd1', source: 'diary', category: 'Blood test', status: 'ready', title: 'Lipids', date: '2026-02-01' },
    { id: 'd2', source: 'diary', category: '', status: 'processing', title: 'x', date: '2026-02-02' },
  ];
  assert.equal(untypedCount(docs), 1);
  assert.deepEqual(filterDocs(docs, { category: NO_TYPE }).map(d => d.id), ['d2', 5]);
  assert.deepEqual(suggestionDiff(docs[0]), [{ key: 'category', value: 'Imaging' }]); // the title was set by the user
  assert.deepEqual(changedFields(docs[1], { date: '2026-02-01', title: 'Lipids, fasting', category: 'Blood test' }), { title: 'Lipids, fasting' });
});
