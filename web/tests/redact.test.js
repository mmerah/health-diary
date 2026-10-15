// Anonymizer and date-in-text parser. Leak cases must be hidden; lab values must survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDates, relDay, replaceDates } from '../js/report/dates-text.js';
import { makeRedactor, safeCategory } from '../js/report/redact.js';

const NOW = 2026;
const profile = { name: 'Jean-Pierre Hélène Lefèvre', dob: '1991-03-14' };
const r = makeRedactor({
  profile, words: ['Clinique Saint-Roch', 'Springfield'], correspondents: ['Dr. Laurent Petit – Cardiology', 'Laboratoire BioCentre'],
  relativeTo: '2026-10-14', nowYear: NOW,
});
const R = s => r.text(s);
const hidden = (input, ...secrets) => {
  const out = R(input);
  for (const s of secrets) assert.ok(!out.includes(s), `"${s}" leaked in: ${out}`);
  return out;
};
const kept = (input) => assert.equal(R(input), input);

// ---------- Dates in text

test('findDates: all written forms, day first', () => {
  const iso = s => findDates(s, { nowYear: NOW }).map(d => d.iso);
  assert.deepEqual(iso('born 14 March 1991'), ['1991-03-14']);
  assert.deepEqual(iso('March 14, 1991'), ['1991-03-14']);
  assert.deepEqual(iso('Mar 14 1991'), ['1991-03-14']);
  assert.deepEqual(iso('1991/03/14 and 1991-03-14 and 1991.03.14'), ['1991-03-14', '1991-03-14', '1991-03-14']);
  assert.deepEqual(iso('14.3.1991'), ['1991-03-14']);
  assert.deepEqual(iso('14-03-1991'), ['1991-03-14']);
  assert.deepEqual(iso('14/03/91'), ['1991-03-14']);
  assert.deepEqual(iso('03/04/26'), ['2026-04-03'], 'slash dates are day first');
  assert.deepEqual(iso('03/14/1991'), ['1991-03-14'], 'month first only when the day cannot be a month');
  assert.deepEqual(iso('14 mars 1991'), ['1991-03-14']);
  assert.deepEqual(iso('3 février 2026'), ['2026-02-03']);
  assert.deepEqual(iso('1er déc. 2025'), ['2025-12-01']);
  assert.deepEqual(iso('14th Sept 2026'), ['2026-09-14']);
  assert.deepEqual(iso('14-Mar-1991'), ['1991-03-14']);
  assert.deepEqual(iso('le 14 mars'), [null], 'a date without a year is found, with no ISO date');
});

test('findDates: not dates', () => {
  for (const s of ['PSA 0.84 0.00 - 4.00', '1.98 g/L (< 2.00)', '2024-2025', 'BP 128/82', 'sample 2026-88412-07', '31/02/2026', '10/10 vision', 'v1.2.3', '08:10']) {
    assert.deepEqual(findDates(s, { nowYear: NOW }).filter(d => d.iso), [], s);
  }
});

test('findDates: a weekday before the date is part of it', () => {
  const [d] = findDates('Seen on Monday 2 March 2026.', { nowYear: NOW });
  assert.equal(d.text, 'Monday 2 March 2026');
  assert.equal(replaceDates('lundi 2 mars 2026', x => relDay(x.iso, '2026-03-12')), 'D-10');
});

test('relDay: D0, D-n and D+n', () => {
  assert.equal(relDay('2026-10-14', '2026-10-14'), 'D0');
  assert.equal(relDay('2026-10-02', '2026-10-14'), 'D-12');
  assert.equal(relDay('2026-10-17', '2026-10-14'), 'D+3');
  assert.equal(relDay('2026-03-29', '2026-03-30'), 'D-1', 'clock change does not matter');
});

// ---------- Date of birth

test('date of birth: every spelling is hidden', () => {
  for (const s of ['born 14 March 1991', 'March 14, 1991', '1991/03/14', '14.3.1991', '14/03/91', '14 mars 1991', 'Né(e) le 14/03/1991',
    'DOB: 1991-03-14', 'Date de naissance : 14.03.1991', '14-Mar-1991', 'birthday on 14 March']) {
    const out = hidden(s, '1991', '14', 'March', 'mars', 'Mar');
    assert.match(out, /\[date of birth\]/, s);
  }
});

test('date of birth: any date after a birth label is hidden, also when it is not the profile date', () => {
  assert.match(R('DOB 02/05/1980'), /DOB \[date of birth\]/);
  assert.match(R('née le 2 mai 1980'), /\[date of birth\]/);
  assert.equal(R('born in 1991'), 'born in [year of birth]');
});

test('other dates become day numbers, after D0 too', () => {
  assert.equal(R('Collected: 12/09/2026 08:10'), 'Collected: D-32 08:10');
  assert.equal(R('Follow-up on 17 octobre 2026'), 'Follow-up on D+3');
  assert.equal(R('RDV le 3 février 2026'), 'RDV le D-253');
  const keep = makeRedactor({ profile, relativeTo: null, nowYear: NOW });
  assert.equal(keep.text('Collected: 12/09/2026'), 'Collected: 12/09/2026');
  assert.equal(keep.text('born 14/03/1991'), 'born [date of birth]');
});

// ---------- Names

test('the user name: all parts, any accents, capitalised or all caps', () => {
  hidden('HELENE LEFEVRE came', 'HELENE', 'LEFEVRE');
  hidden('Hélène and Helene', 'Hélène', 'Helene');
  hidden('Jean-Pierre, Jean, Pierre', 'Jean', 'Pierre');
  hidden('JEAN-PIERRE LEFÈVRE', 'JEAN', 'PIERRE', 'LEF');
  hidden('jean-pierre hélène lefèvre', 'jean', 'pierre', 'lef');
  // The user's own name is hidden in any case, also in file names.
  hidden('helene lefevre came', 'helene', 'lefevre');
  hidden('lefevre_helene_bilan.pdf', 'lefevre', 'helene');
  hidden('Lefevre-Helene.2026.pdf', 'Lefevre', 'Helene');
});

test('document correspondents and extra words are hidden', () => {
  hidden('LABORATOIRE BIOCENTRE – Lyon', 'BIOCENTRE');
  hidden('Report by Laurent PETIT', 'Laurent', 'PETIT');
  hidden('Clinique Saint-Roch, Saint Roch, SAINT-ROCH', 'Roch', 'ROCH');
  hidden('Patient lives in springfield', 'springfield');
  // Generic words of a correspondent are not hidden alone.
  assert.match(R('Cardiology review'), /Cardiology/);
});

test('names after a title, a cue, or before a credential', () => {
  for (const [s, secret] of [['Dr. Claire Martin, biologist', 'Martin'], ['Dr Claire Martin', 'Claire'], ['Docteur Dupont', 'Dupont'],
    ['Doctor Who', 'Who'], ['Pr Bernard', 'Bernard'], ['Prof. A. Smith', 'Smith'], ['Professeur Durand', 'Durand'],
    ['Mr John Smith', 'John'], ['Mrs Smith', 'Smith'], ['Ms Jones', 'Jones'], ['Mme Ｄupont', 'upont'], ['M. Durand', 'Durand'],
    ['Mlle Garnier', 'Garnier'], ['Madame Élodie Brûlé', 'Brûlé'], ['Monsieur Jean de la Fontaine', 'Fontaine'],
    ['Dr de la Fontaine', 'Fontaine'], ["Dr Jeanne d'Arc", 'Arc'], ['DR MARTIN', 'MARTIN'], ['Dr. L. Petit', 'Petit'],
    ['Claire Martin, MD', 'Martin'], ['Validated by Claire Martin', 'Martin'], ['Validé par Sophie Roux', 'Roux'],
    ['Dear Paul Simon,', 'Simon'], ['Médecin traitant : Marc Lebrun', 'Lebrun']]) {
    const out = hidden(s, secret);
    assert.match(out, /\[name\]/, s);
  }
  assert.equal(R('Dr. Claire Martin, biologist.'), 'Dr. [name], biologist.');
});

test('header values: the name is removed', () => {
  assert.equal(R('Patient: Alex Example, file 123'), 'Patient: [name], file 123');
  assert.equal(R('Nom : DUPONT Marie'), 'Nom : [name]');
  assert.equal(R('Name: Bob Stone'), 'Name: [name]');
  assert.equal(R('Prénom: Marie'), 'Prénom: [name]');
  // Only the name is removed, not the clinical text on the same line.
  assert.equal(R('Patient: 35 y/o male referred for palpitations after 3 cups of coffee'), 'Patient: 35 y/o male referred for palpitations after 3 cups of coffee');
  assert.equal(R('Patient: Bob Stone, 35 y/o male, referred'), 'Patient: [name], 35 y/o male, referred');
  assert.equal(R('Patient diary: palpitations at 15:20'), 'Patient diary: palpitations at 15:20');
});

// ---------- Contact details, addresses, IDs

test('addresses', () => {
  for (const s of ['12 rue de la Paix', '3 bis avenue Jean Jaurès', '221B Baker Street', '10 Downing Street', '1600 Pennsylvania Ave',
    '75002 Paris', '69003 LYON CEDEX 03', 'London NW1 6XE', 'Springfield, IL 62704', 'Adresse : chez Mme X, bâtiment B']) {
    const out = R(s);
    assert.match(out, /\[address\]|\[name\]/, `${s} → ${out}`);
    assert.ok(!/\d{3,}/.test(out.replace(/\[\w+\]/g, '')), `${s} → ${out}`);
  }
  assert.equal(R('rue de la Paix, 75002 Paris'), '[address], [address]');
});

test('links and emails', () => {
  assert.equal(R('see https://clinique-saint-roch.fr/rdv?id=4 now'), 'see [link] now');
  assert.equal(R('www.biocentre.fr'), '[link]');
  assert.equal(R('clinique-saint-roch.fr'), '[link]');
  assert.equal(R('l.petit@clinique-saint-roch.fr'), '[email]');
  assert.equal(R('Écrire à hélène.lefèvre@exemple.fr.'), 'Écrire à [email].');
});

test('phone numbers by shape', () => {
  for (const s of ['01 23 45 67 89', '01.23.45.67.89', '01-23-45-67-89', '0123456789', '+33 1 23 45 67 89', '+33 (0)1 23 45 67 89',
    '+44 20 7946 0958', '+1 555 123 4567', '(555) 123-4567', 'tel. 06 12 34 56 78', 'Tél : 04.72.00.00.00', 'Phone: 555-123-4567']) {
    const out = R(s);
    assert.ok(!/\d{2}/.test(out.replace(/\[\w+\]/g, '')), `${s} → ${out}`);
  }
});

test('IDs, IBAN and long numbers', () => {
  assert.equal(R('AB-1234567'), '[id]');
  assert.equal(R('IPP 1234567'), 'IPP [id]');
  assert.equal(R('Dossier 2024/123456'), 'Dossier [id]');
  assert.equal(R('Sample no. 2026-88412-07'), 'Sample no. [id]');
  assert.equal(R('2026-88412-07'), '[id]');
  assert.equal(R('file 4481920377'), 'file [id]');
  assert.equal(R('IBAN FR76 3000 6000 0112 3456 7890 189'), 'IBAN [iban]');
  assert.equal(R('GB82 WEST 1234 5698 7654 32'), '[iban]');
  assert.equal(R('code 12345678'), 'code [number]');
  assert.ok(!/\d{2}/.test(R('NIR 1 91 03 75 123 456 78')), 'French social security number');
});

test('lab values, ranges and clinical numbers survive', () => {
  for (const s of ['PSA 0.84 0.00 - 4.00', 'Total cholesterol   1.98 g/L    (< 2.00)', 'Vitamin D (25-OH)   18 ng/mL    (30 – 100)  LOW',
    'Season 2024-2025', 'Mean HR 72 bpm, min 48 bpm, max 141 bpm', '312 isolated PVCs (< 1% of beats)', 'LVEF 62% (Simpson biplane)',
    'BP 128/82 mmHg', 'Platelets 250 G/L', 'Leucocytes 7 500 /mm3', 'HbA1c 5.3 % (< 5.7)', 'Creatinine 9.8 mg/L (7 – 12), eGFR > 90',
    'Hémoglobine : 12,1 g/dL (13,0 - 17,0)', 'TSH 2.1 mIU/L (0.4 – 4.0)', 'Glucose 5.5 mmol/L 3.9-6.1', 'Follow-up echo in 2 years',
    'Paracetamol 1 g at 16:30', 'Walked 20 min, 2 × 25 min', 'a 10 minute drive to the place', 'Appendectomy (2009)', 'Ferritin 38 µg/L (30 – 400)',
    'No pauses > 2 s.', 'Steps 12 345']) {
    kept(s);
  }
});

test('categories: only generic medical types are shown', () => {
  assert.equal(safeCategory('Blood test'), 'Blood test');
  assert.equal(safeCategory('Cardiology'), 'Cardiology');
  assert.equal(safeCategory('Imaging / MRI'), 'Imaging / MRI');
  assert.equal(safeCategory('Dr Petit'), 'Medical document');
  assert.equal(safeCategory('Clinique Saint-Roch'), 'Medical document');
  assert.equal(safeCategory(''), 'Medical document');
});

test('redactor without a profile still hides contact details', () => {
  const x = makeRedactor({});
  assert.equal(x.text('Call 01 23 45 67 89 or a@b.fr'), 'Call [phone] or [email]');
  assert.equal(x.text(''), '');
  assert.equal(x.text(null), '');
});

// ---------- Round 2: confirmed leaks and over-redaction

const r2 = makeRedactor({
  profile: { name: 'Hélène Dupont', dob: '1991-03-14' },
  correspondents: ['Cabinet de Radiologie Rive Gauche', 'Dr. Laurent Petit', 'Centre Cardiologique du Nord', 'Laboratoire BioCentre'],
  relativeTo: '2026-10-15', nowYear: 2026,
});
const R2 = (s, ref) => r2.text(s, { ref });
const noAbsoluteDate = s => !/\b\d{1,2}[/.]\d{1,2}\b|\b(?:January|February|March|April|June|July|August|September|October|November|December|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\b/i.test(s);

test('date of birth: "of", month-day without a year, birth year', () => {
  assert.equal(R2('Born: 14th of March 1991'), 'Born: [date of birth]');
  assert.equal(R2('birthday March 14'), 'birthday [date of birth]');
  assert.equal(R2('né en 1991'), 'né en [year of birth]');
  assert.equal(R2('née en 1985, mère de deux enfants'), 'née en [year of birth], mère de deux enfants');
  assert.equal(R2('born in 1988'), 'born in [year of birth]');
  assert.equal(R2('the 14th of March'), 'the [date of birth]');
});

test('names after cues, with or without a colon, and name-only lines', () => {
  for (const [s, secret] of [['Re: John Smith (DOB 01/02/1980)', 'Smith'], ['Signé électroniquement par Marie Lefebvre', 'Lefebvre'],
    ['Signé par : Marie Lefebvre', 'Lefebvre'], ['Seen by: Sarah Jones', 'Jones'], ["Signed: Sarah O'Connor", "O'Connor"],
    ['Interne : Paul Durand', 'Durand'], ['Marie LEFEBVRE', 'LEFEBVRE'], ['Madame Anne Roux épouse BERNARD', 'BERNARD'],
    ['Mme Roux ép. Bernard', 'Bernard'], ['Mme Anne Martin née Garnier', 'Garnier'], ['Pt: Joe Bloggs', 'Bloggs']]) {
    assert.ok(!R2(s).includes(secret), `${s} → ${R2(s)}`);
  }
  assert.ok(!R2('Re: John Smith (DOB 01/02/1980)').includes('1980'));
  // Headings in capitals are not names.
  for (const s of ['COMPTE RENDU', 'TRANSTHORACIC ECHOCARDIOGRAM', 'Echographie Cardiaque', 'Total Cholesterol', 'Patient diary: palpitations']) assert.equal(R2(s), s);
});

test('the user name in any case and in file names', () => {
  for (const s of ['helene dupont', 'HÉLÈNE DUPONT', 'dupont_helene_bilan.pdf', 'Dupont-Helene.pdf', 'compte rendu dupont.pdf']) {
    const out = R2(s);
    assert.ok(!/dupont|helene|hélène/i.test(out), `${s} → ${out}`);
  }
});

test('dates without a year take the year of the document and become day numbers', () => {
  const ref = '2026-10-14';
  assert.equal(R2('Monday 12 October', ref), 'D-3');
  assert.equal(R2('le 3/10', ref), 'le D-12');
  assert.equal(R2('arrêt du 05/10 to 09/10', ref), 'arrêt du D-10 to D-6');
  assert.equal(R2('du 1er au 3 octobre', ref), 'du D-14 au D-12');
  assert.equal(R2('the 3rd of October', ref), 'the D-12');
  assert.equal(R2('vu le 20 décembre', ref), 'vu le D-299', 'the nearest past date: last December');
  assert.equal(R2('en octobre 2026'), 'en D-14 (month)');
  for (const s of ['Monday 12 October', 'le 3/10', 'du 1er au 3 octobre', 'octobre 2026', 'March 2024']) assert.ok(noAbsoluteDate(R2(s, ref)), `${s} → ${R2(s, ref)}`);
  // Without a document date, a date that cannot be placed is hidden, not left absolute.
  const noRef = makeRedactor({ relativeTo: null });
  assert.equal(noRef.text('le 3/10'), 'le 3/10', 'dates are kept as written when relative dates are off');
  assert.equal(R2('pain 3/10, vision 10/10'), 'pain 3/10, vision 10/10', 'scores are not dates');
});

test('ambiguous slash dates: the reading nearest the document date', () => {
  assert.equal(R2('Visit on 03/04/2026', '2026-03-06'), 'Visit on D-225', 'US letter: 4 March');
  assert.equal(R2('Visit on 03/04/2026', '2026-04-05'), 'Visit on D-195', 'European: 3 April');
  assert.equal(R2('DOB 03/14/1991'), 'DOB [date of birth]');
  const us = makeRedactor({ profile: { dob: '1991-03-04' }, relativeTo: '2026-10-15' });
  assert.equal(us.text('04/03/1991'), '[date of birth]');
  assert.equal(us.text('03/04/1991'), '[date of birth]', 'either reading of the date of birth is hidden');
});

test('smaller leaks: phones, order numbers, addresses, PO boxes, hospitals', () => {
  for (const s of ['617.726.2000', '07700 900123', '020 7946 0958', '(617) 726-2000']) assert.equal(R2(s), '[phone]', s);
  assert.equal(R2('Order #A-2026-88412-07'), 'Order [id]');
  assert.equal(R2('ref #88412'), 'ref [id]');
  assert.equal(R2('1 place Alexis Ricordeau'), '[address]');
  assert.equal(R2('PO Box 1234'), '[address]');
  assert.equal(R2('BP 1234'), 'BP 1234', 'BP is blood pressure, not a French PO box');
  for (const s of ['CHU de Nantes', 'CH de Cholet', 'Hôpital Saint-Louis', 'Clinique du Parc', 'Centre Hospitalier de Versailles',
    'Massachusetts General Hospital', 'Hospital of St. Mary', 'Klinik Hirslanden', 'Polyclinique Bordeaux Nord']) {
    assert.equal(R2(s), '[hospital]', s);
  }
  assert.equal(R2('Admitted to CHU de Nantes on 3/10', '2026-10-14'), 'Admitted to [hospital] on D-12');
});

test('correspondent words that are ordinary words stay', () => {
  assert.equal(R2('Ventricule Gauche dilaté'), 'Ventricule Gauche dilaté');
  assert.equal(R2('Petit épanchement péricardique'), 'Petit épanchement péricardique');
  assert.equal(R2('Centre: RAS. Nord: RAS.'), 'Centre: RAS. Nord: RAS.');
  assert.equal(R2('Cardiologique: normal'), 'Cardiologique: normal');
  // The full names are still hidden.
  assert.ok(!R2('CABINET DE RADIOLOGIE RIVE GAUCHE').includes('RIVE'));
  assert.ok(!R2('Centre Cardiologique du Nord – compte rendu').includes('Nord'));
  assert.ok(!R2('Report by Laurent Petit').includes('Petit'));
  assert.ok(!R2('Laurent wrote').includes('Laurent'));
});

test('value series are not phones or IDs', () => {
  for (const s of ['Sodium 140 138 141 mmol/L', 'BP 142/91/78', 'Cycle 28-30-32 days', 'Steps 8 432 9 120 10 005', 'Glycémies 1.02 0.98 1.10 1.05 g/L',
    'HR 72 75 78 81 bpm', 'Potassium 4.2 4.0 3.9 mmol/L', 'K 4.1 – Na 139 – Cl 101']) {
    assert.equal(R2(s), s, s);
  }
});
