import test from 'node:test';
import assert from 'node:assert/strict';
import { dateTimeLabel, formatSetupCode, medStatus, newPasswordError, parseHeight, parseMedForm, passwordHint, sortMeds } from '../js/screens/profile-account.js';
import { filterDocs, categoriesOf } from '../js/screens/records-data.js';

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
