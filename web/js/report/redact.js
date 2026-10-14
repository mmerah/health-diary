// The anonymizer for the "AI" report. Privacy first: when a rule is not sure, it hides the text.
// It must never break lab values ("PSA 0.84 0.00 - 4.00", "1.98 g/L (< 2.00)", "2024-2025").
//
// const r = makeRedactor({ profile, words, correspondents, relativeTo: '2026-10-14' });
// r.text('Patient: Alex Example, born 14/03/1991')  → 'Patient: [removed]'
// r.category('Blood test') → 'Blood test'; r.category('Dr Petit') → 'Medical document'
//
// Order of the rules matters:
//  1. Dates become placeholders (the date of birth → [date of birth]; others → D-n or kept).
//     Placeholders have no digits, so the number rules below cannot break them.
//  2. Links, emails, IBAN, header values (Patient:, Nom:, DOB…), phone labels.
//  3. Known names (the user, document correspondents, the user's words), matched without accents and case.
//  4. Names after a title (Dr, Mme…), after "validated by"…, before ", MD".
//  5. Addresses, IDs, phone numbers, long digit runs.
import { findDates, relDay } from './dates-text.js';

// ---------- Text folding: compare names without accents, case or full-width forms.

const SPECIAL = { 'œ': 'oe', 'Œ': 'oe', 'æ': 'ae', 'Æ': 'ae', 'ø': 'o', 'Ø': 'o', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'ß': 'ss', 'ı': 'i' };

function foldChar(ch) {
  if (SPECIAL[ch]) return SPECIAL[ch];
  if (/[\p{Pd}\s]/u.test(ch)) return ' '; // hyphens and spaces match each other: "Saint-Roch" = "Saint Roch"
  if (/['’ʼ`]/u.test(ch)) return "'";
  return ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** "Hélène" → "helene", "Ｄupont" → "dupont". */
export const fold = s => [...String(s || '')].map(foldChar).join('').replace(/ +/g, ' ').trim();

/** Folded text plus, for each folded character, where it comes from in the original. */
function foldMap(s) {
  let out = '';
  const from = [], to = [];
  let i = 0;
  for (const ch of s) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) { from.push(i); to.push(i + ch.length); }
    out += f;
    i += ch.length;
  }
  return { s: out, from, to };
}

const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isUpperStart = s => { const c = [...s.normalize('NFKD')].find(x => /\p{L}/u.test(x)); return !!c && /\p{Lu}/u.test(c); };

// Words that are part of a correspondent name but are not names themselves.
const GENERIC_PARTS = new Set(('dr doctor docteur pr prof professeur professor mr mrs ms mme mlle m madame monsieur '
  + 'laboratoire laboratory laboratories labo lab labs clinique clinic hopital hospital centre center cabinet medical medicale '
  + 'medicaux sante health care service services groupe group pole institut institute department dept unite unit '
  + 'saint sainte st ste the of and et de du des la le les l d da di van von der den '
  + 'cardiology cardiologie cardiologist cardiologue radiology radiologie imaging imagerie biology biologie analyses '
  + 'analysis pharmacy pharmacie general generale gp practice surgery chirurgie university universitaire chu chr ch '
  + 'nhs trust foundation private privee polyclinique dental dentaire nursing infirmier ltd inc sas sarl selarl scm').split(' '));

/** Name parts worth hiding alone: 2+ letters, not generic. */
function nameParts(s) {
  return fold(s).split(/[ ]+/).map(w => w.replace(/^'+|'+$/g, '').replace(/^[dl]'/, ''))
    .filter(w => w.length >= 2 && /^\p{L}[\p{L}']*$/u.test(w) && !GENERIC_PARTS.has(w));
}

// ---------- Document categories: only generic medical types are shown in AI mode.

const GENERIC_CATEGORY = new Set(('blood test tests lab labs laboratory results result analysis analyses biology biologie '
  + 'bilan sanguin prise de sang cardiology cardiologie imaging imagerie radiology radiologie x-ray xray x ray radio mri irm '
  + 'ct scan scanner ultrasound echography echographie echocardiogram ecg ekg holter prescription prescriptions ordonnance '
  + 'letter letters courrier report reports compte rendu discharge summary consultation consultations note notes '
  + 'vaccination vaccinations vaccine vaccines dermatology dermatologie neurology neurologie gastroenterology '
  + 'gastro-enterologie endocrinology endocrinologie ophthalmology ophtalmologie dentist dental dentaire gynecology '
  + 'gynecologie urology urologie pneumology pneumologie pulmonology psychiatry psychiatrie psychology physiotherapy '
  + 'kinesitherapie kine orthopedics orthopedie surgery chirurgie operation hospital hospitalisation hospitalization '
  + 'emergency urgences pathology anatomopathologie allergy allergologie sleep study medical medicale document documents '
  + 'certificate certificat insurance invoice facture other autre general medecine medicine gp family doctor eye exam '
  + 'genetics genetique nutrition oncology oncologie hematology hematologie rheumatology rheumatologie nephrology '
  + 'nephrologie ent orl and et of').split(' '));

export function safeCategory(c) {
  const words = fold(c).split(/[ /,&+]+/).filter(Boolean);
  return words.length && words.every(w => GENERIC_CATEGORY.has(w)) ? String(c).trim() : 'Medical document';
}

// ---------- Patterns

const L = String.raw`\p{L}`;
const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}])`;

// A name token: a capitalised or all-caps word (with inner hyphens), an initial "L.", or an already hidden name.
const TOK = String.raw`(?:\[name\]|\p{Lu}[\p{L}'’]*(?:-\p{Lu}[\p{L}'’]*)*\.?)`;
const PART = String.raw`(?:de|du|des|la|le|van|von|der|den|di|da|del|della|dos|das|el|al|ben|bin|De|Du|Van|Von|Le|La|Del|Da|Di)`;
const GLUED = String.raw`(?:[dDlL]['’])`;
const NAME = String.raw`(?:${PART}[ \t]+){0,2}${GLUED}?${TOK}(?:(?:[ \t]+(?:${PART}[ \t]+){0,2}|[ \t]*${GLUED}|[ \t]+${GLUED})${TOK}){0,3}`;

const TITLES = ['Professeur', 'Professor', 'Docteur', 'Doctor', 'Monsieur', 'Madame', 'Mademoiselle', 'Mlle', 'Mme', 'Mrs', 'Mr', 'Ms', 'Miss', 'Prof', 'Dr', 'Pr', 'Drs'];
const TITLE_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}(${[...TITLES, ...['DOCTEUR', 'DOCTOR', 'PROFESSEUR', 'PROFESSOR', 'MONSIEUR', 'MADAME', 'MME', 'MLLE', 'MRS', 'MR', 'DR'],
  ].sort((a, b) => b.length - a.length).join('|')}|M)(\.?)[ \t]+(${NAME})`, 'gu');

const CUES = String.raw`(?:(?:[Vv]alidated|[Ss]igned|[Ww]ritten|[Rr]eported|[Pp]rescribed|[Rr]eferred|[Ss]een|[Ee]xamined|[Rr]equested|[Dd]ictated|[Rr]eviewed|[Aa]pproved|[Ii]nterpreted|[Rr]ead)\s+by|(?:[Vv]alidé|[Ss]igné|[Rr]édigé|[Pp]rescrit|[Dd]emandé|[Aa]dressé|[Ii]nterprété|[Vv]u)e?s?\s+par|Dear|Cher|Chère|Attn:?|Cc\s*:|To\s*:|From\s*:|De\s*:|À\s*:|Pour\s*:|Médecin(?:\s+traitant)?\s*:|Doctor\s*:|GP\s*:|Physician\s*:|Prescripteur\s*:|Biologiste\s*:)`;
const CUE_RE = new RegExp(String.raw`(${CUES})([ \t]+)(${NAME})`, 'gu');
const CREDENTIAL_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}(${TOK}(?:[ \t]+(?:${PART}[ \t]+){0,2}${TOK}){1,3})(,?[ \t]+(?:MD|M\.D\.|PhD|Ph\.D\.|DO|RN|NP|PA-C|FRCP|MRCP|MBBS|DDS|PharmD))${NOT_WORD_AFTER}`, 'gu');

// Header values: everything after the label on that line is personal.
const HEADER_NAME_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}((?:Patient(?:e)?(?:\s+name)?|PATIENT|Nom(?:\s+de\s+naissance|\s+d'usage|\s+et\s+prénom)?|NOM|Prénom|PRENOM|PRÉNOM|Name|NAME|Full\s+name|Surname|First\s+name|Last\s+name|Assuré(?:e)?|Insured|Bénéficiaire)[ \t]*:)[^\n]*`, 'gu');
const ADDRESS_LABEL_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}((?:Adresse|ADRESSE|Address|ADDRESS|Domicile)[ \t]*:)[^\n]*`, 'gu');
const BIRTH_LABEL = String.raw`(?:born|Born|BORN|n[ée]e?\(?e?\)?\s+le|N[ée]e?\(?e?\)?\s+le|NÉ\(?E?\)?\s+LE|DOB|D\.O\.B\.?|[Dd]ate\s+of\s+birth|[Dd]ate\s+de\s+naissance|DATE\s+DE\s+NAISSANCE|[Bb]irth\s*date|[Gg]eboren)`;
const BIRTH_BEFORE_RE = new RegExp(String.raw`${BIRTH_LABEL}\s*(?:on|le|:)?\s*$`, 'u');
const BIRTH_RAW_RE = new RegExp(String.raw`(${BIRTH_LABEL}\s*(?:on|le|:)?\s*)[\d][\d./\- ]{4,9}\d`, 'gu');
const PHONE_LABEL_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}((?:[Tt][ée]l[ée]phone|TEL|[Tt][ée]l|[Pp]hone|PHONE|[Mm]obile|[Pp]ortable|[Ff]ax|FAX|[Tt]elephone|Ph)\.?[ \t]*[:.]?[ \t]*)\+?[\d(][\d \t.()\-/]{4,}\d`, 'gu');

const EMAIL_RE = /[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}\-]+(?:\.[\p{L}\p{N}\-]+)+/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']+[^\s<>()"'.,;:!?]/giu;
const DOMAIN_RE = /(?<![\p{L}\p{N}@.\-])[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9\-]+)*\.(?:fr|com|org|net|uk|de|be|ch|eu|io|nl|es|it|us|ca|lu|info|health|care|clinic|doctor|gouv\.fr|co\.uk)(?![\p{L}\p{N}\-])/giu;
const IBAN_RE = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/gu;

// Addresses: street number + street type, a street type + name, postcode + city.
const STREET = String.raw`(?:rue|Rue|RUE|avenue|Avenue|AVENUE|av\.|Av\.|boulevard|Boulevard|BOULEVARD|bd|Bd|BD|blvd|Blvd|chemin|Chemin|allée|Allée|impasse|Impasse|Place|quai|Quai|Route|Cours|Square|faubourg|Faubourg|Street|STREET|St\.?|Road|ROAD|Rd\.?|Lane|Ln\.?|Drive|Way|Court|Ct\.?|Terrace|Close|Crescent|Ave\.?|Parkway|Highway)`;
const ADDRESS_NUM_RE = new RegExp(String.raw`(?<![\p{L}\p{N}.,])\d{1,4}(?:[ \t]?(?:bis|ter|[A-Za-z]))?,?[ \t]+(?:${L}[\p{L}'’\-]*[ \t]+){0,3}?${STREET}(?![\p{L}])[^\n,;]*`, 'gu');
const ADDRESS_STREET_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}(?:rue|Rue|RUE|avenue|Avenue|boulevard|Boulevard|allée|Allée|impasse|Impasse|chemin|Chemin|quai|Quai|faubourg|Faubourg)[ \t]+(?:(?:de|du|des|de la|d'|l'|la|le)[ \t]*)?\p{Lu}[^\n,;]*`, 'gu');
const POSTCODE_FR_RE = new RegExp(String.raw`(?<![\p{L}\p{N}.,])(?:F-|FR-)?\d{5}[ \t]+\p{Lu}[\p{L}'’\-]+(?:[ \t\-]+(?:CEDEX(?:[ \t]+\d{1,2})?|sur|sous|en|lès|les|de|du|la|le|\p{Lu}[\p{L}'’\-]*))*`, 'gu');
const POSTCODE_UK_RE = /(?<![\p{L}\p{N}])[A-Z]{1,2}\d[A-Z\d]?[ \t]*\d[A-Z]{2}(?![\p{L}\p{N}])/gu;
const ZIP_US_RE = /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}.\-]*(?:[ \t]\p{Lu}[\p{L}.\-]*)*,[ \t]*)?[A-Z]{2}[ \t]+\d{5}(?:-\d{4})?(?![\p{N}])/gu;

// IDs
const ID_LABEL_RE = /(?<![\p{L}\p{N}])((?:IPP|NIP|NIR|MRN|NHS(?:\s+(?:number|no\.?))?|N°\s*SS|S[ée]curit[ée]\s+sociale|Dossier|File|Fichier|Patient\s+ID|ID|Identifiant|R[ée]f\.?|R[ée]f[ée]rence|Reference|Sample(?:\s+(?:no\.?|number|n°))?|[ÉE]chantillon|Specimen|Accession|Order\s+no\.?|Demande(?:\s+n°)?|Pr[ée]l[èe]vement(?:\s+n°)?|N°|Nº|No\.|Num[ée]ro|Number|Account|Compte|Policy|Contrat)\s*[:#]?\s*(?:n°|no\.?)?\s*)([A-Za-z0-9][A-Za-z0-9/\-.]*[A-Za-z0-9])(?![\p{L}\p{N}])/giu;
const ID_ALNUM_RE = /(?<![\p{L}\p{N}\-])[A-Z]{1,5}[\- ]?\d{5,}(?![\p{L}\p{N}])/gu;
const ID_MIXED_RE = /(?<![\p{L}\p{N}])(?=[A-Z0-9]*\d{4})(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}(?![\p{L}\p{N}])/gu;
const ID_GROUPS_RE = /(?<![\p{N}.,\-/])\d{2,}(?:[\-/]\d{2,}){1,5}(?![\p{N}]|[.,]\p{N})/gu;

// Phones: with a country code, French 10 digits, US (555) 123-4567, or groups of 2–4 digits with one separator.
const PHONE_INTL_RE = /(?<![\p{N}\w])\+\d{1,3}(?:[ .\-]?\(0\))?(?:[ .\-]?\d{1,4}){2,6}(?![\p{N}])/gu;
const PHONE_US_RE = /\(\d{3}\)[ .\-]?\d{3}[ .\-]\d{4}(?![\p{N}])/gu;
const PHONE_GROUPS_RE = /(?<![\p{N}.,])\d{2,4}(?:([ .\-])\d{2,4})(?:\1\d{2,4}){1,5}(?![\p{N}]|[.,]\p{N})/gu;
const DIGITS_RE = /(?<![.,]\p{N}*)\d{7,}/gu;

const digits = s => s.replace(/\D/g, '').length;

/**
 * profile: { name, dob }       words: extra words to hide (settings.redactWords)
 * correspondents: document correspondents (all documents, also excluded ones)
 * relativeTo: ISO date of D0, or null to keep dates as written.
 */
export function makeRedactor({ profile = {}, words = [], correspondents = [], relativeTo = null, nowYear } = {}) {
  const dob = profile.dob || '';
  const [dy, dm, dd] = dob ? dob.split('-').map(Number) : [];

  // Terms: [folded, capOnly]. Full strings match in any case; single name parts only when capitalised or all caps.
  const terms = new Map();
  const addTerm = (t, capOnly) => {
    const f = fold(t).replace(/^'+|'+$/g, '');
    if (f.length < 2 || /^\d+$/.test(f)) return;
    if (!terms.has(f) || !capOnly) terms.set(f, capOnly);
  };
  const addName = (s, { whole = true } = {}) => {
    const v = String(s || '').trim();
    if (!v) return;
    // "Dr. Laurent Petit – Cardiology": the part before a dash or comma is the name.
    const clean = v.replace(/\s+[–—|(].*$/u, '').replace(/,.*$/, '');
    for (const x of [v, clean]) if (whole && fold(x).includes(' ')) addTerm(x, false);
    for (const p of nameParts(clean)) addTerm(p, true);
    // Hyphenated compounds stay together too: "Saint-Roch".
    for (const h of clean.match(/\p{L}+(?:-\p{L}+)+/gu) || []) addTerm(h, false);
  };
  addName(profile.name);
  for (const c of correspondents) addName(c);
  for (const w of words) {
    const v = String(w || '').trim();
    if (!v) continue;
    addTerm(v, false);
    addName(v, { whole: false });
  }
  const termList = [...terms].sort((a, b) => b[0].length - a[0].length).map(([f, capOnly]) => ({
    capOnly, re: new RegExp(`(?<![\\p{L}\\p{N}])${reEscape(f).replace(/ /g, ' +')}(?![\\p{L}\\p{N}])`, 'gu'),
  }));

  function hideTerms(t) {
    for (const term of termList) {
      const m = foldMap(t);
      const hits = [];
      term.re.lastIndex = 0;
      let x;
      while ((x = term.re.exec(m.s))) {
        const a = m.from[x.index], b = m.to[x.index + x[0].length - 1];
        if (term.capOnly && !isUpperStart(t.slice(a, b))) continue;
        hits.push([a, b]);
      }
      for (const [a, b] of hits.reverse()) t = `${t.slice(0, a)}[name]${t.slice(b)}`;
    }
    return t;
  }

  const isDob = f => !!dob && f.m === dm && f.d === dd && (f.y == null || f.y === dy);

  /** Hide personal details in free text. */
  function text(input) {
    if (input == null || input === '') return '';
    let t = String(input);
    const keep = [];
    const hold = s => { keep.push(s); return `${String.fromCharCode(0xE100 + keep.length - 1)}`; };

    // 1. Dates
    let out = '', at = 0;
    for (const f of findDates(t, { nowYear })) {
      const birth = BIRTH_BEFORE_RE.test(t.slice(Math.max(0, f.start - 30), f.start));
      const rep = isDob(f) || birth ? '[date of birth]'
        : relativeTo && f.iso ? relDay(f.iso, relativeTo) : f.text;
      out += t.slice(at, f.start) + hold(rep);
      at = f.end;
    }
    t = out + t.slice(at);
    t = t.replace(BIRTH_RAW_RE, (m, label) => `${label}[date of birth]`);
    if (dy) t = t.replace(new RegExp(`(${BIRTH_LABEL}\\s*(?:on|in|en|le|:)?\\s*)${dy}(?!\\d)`, 'gu'), '$1[year of birth]');

    // 2. Links, emails, IBAN, header values
    t = t.replace(EMAIL_RE, () => hold('[email]'));
    t = t.replace(URL_RE, () => hold('[link]'));
    t = t.replace(DOMAIN_RE, () => hold('[link]'));
    t = t.replace(IBAN_RE, m => (m.replace(/ /g, '').length >= 15 ? '[iban]' : m));
    t = t.replace(HEADER_NAME_RE, (m, label) => `${label} [removed]`);
    t = t.replace(ADDRESS_LABEL_RE, (m, label) => `${label} [address]`);
    t = t.replace(PHONE_LABEL_RE, (m, label) => (digits(m) >= 6 ? `${label}[phone]` : m));

    // 3. Known names
    t = hideTerms(t);

    // 4. Names found by their context
    t = t.replace(TITLE_RE, (m, title, dot, name) => (title === 'M' && !dot ? m : `${title}${dot} [name]`));
    t = t.replace(CUE_RE, (m, cue, sp) => `${cue}${sp}[name]`);
    t = t.replace(CREDENTIAL_RE, (m, name, cred) => `[name]${cred}`);
    t = t.replace(/\[name\](?:[ \t]+\[name\])+/g, '[name]');

    // 5. Addresses, IDs, phones, numbers
    t = t.replace(ADDRESS_NUM_RE, '[address]');
    t = t.replace(ADDRESS_STREET_RE, '[address]');
    t = t.replace(POSTCODE_FR_RE, '[address]');
    t = t.replace(POSTCODE_UK_RE, '[address]');
    t = t.replace(ID_LABEL_RE, (m, label, value) => {
      const n = digits(value);
      return n >= 4 || (n >= 3 && /[A-Za-z]/.test(value)) ? `${label}[id]` : m;
    });
    t = t.replace(ZIP_US_RE, '[address]');
    t = t.replace(ID_ALNUM_RE, '[id]');
    t = t.replace(ID_MIXED_RE, '[id]');
    t = t.replace(ID_GROUPS_RE, m => {
      const groups = m.split(/[\-/]/);
      return groups.length >= 3 || groups.some(g => g.length >= 5) ? '[id]' : m;
    });
    t = t.replace(PHONE_INTL_RE, m => (digits(m) >= 8 && digits(m) <= 15 ? '[phone]' : m));
    t = t.replace(PHONE_US_RE, '[phone]');
    t = t.replace(PHONE_GROUPS_RE, (m, sep) => {
      const n = digits(m);
      // With dots, only 2-digit groups (01.23.45.67.89): "1.98 2.00" style values are never phones.
      if (sep === '.' && !/^\d{2}(?:\.\d{2})+$/.test(m)) return m;
      return n >= 8 && n <= 15 ? '[phone]' : m;
    });
    t = t.replace(DIGITS_RE, '[number]');

    // Restore the dates and links.
    return t.replace(/(.)/gu, (m, c) => keep[c.charCodeAt(0) - 0xE100]);
  }

  return {
    text,
    category: safeCategory,
    /** Report dates: D-n, or the ISO date when dates are kept. */
    date: iso => (relativeTo ? relDay(iso, relativeTo) : iso),
  };
}
