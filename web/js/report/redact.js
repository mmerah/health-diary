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
import { fold } from '../core/format.js';
import { isBuiltInDocType } from '../core/schema.js';
import { findDates, relDay } from './dates-text.js';

// ---------- Text folding for name matching: no accents, no case, normal-width letters (core fold),
// plus: hyphens, underscores, dots and spaces are all separators ("dupont_helene_bilan.pdf"), ligatures are spelled out.

const LIGATURES = { 'œ': 'oe', 'Œ': 'oe', 'æ': 'ae', 'Æ': 'ae', 'ø': 'o', 'Ø': 'o', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'ß': 'ss', 'ı': 'i' };

function foldChar(ch) {
  if (LIGATURES[ch]) return LIGATURES[ch];
  if (/[\p{Pd}\s_.]/u.test(ch)) return ' ';
  if (/['’ʼ`]/u.test(ch)) return "'";
  return fold(ch);
}
const foldName = s => [...String(s || '')].map(foldChar).join('').replace(/ +/g, ' ').trim();

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
  + 'cardiology cardiologie cardiologist cardiologue cardiologique radiology radiologie imaging imagerie biology biologie analyses '
  + 'analysis pharmacy pharmacie general generale gp practice surgery chirurgie university universitaire chu chr ch '
  + 'nhs trust foundation private privee polyclinique dental dentaire nursing infirmier ltd inc sas sarl selarl scm').split(' '));

// Common words that are also surnames or place names. Alone they are not hidden: "Petit épanchement",
// "Ventricule Gauche". The full name ("Laurent Petit") is still hidden.
const COMMON_WORDS = new Set(('gauche droite droit petit petite grand grande gros blanc blanche noir noire rouge vert verte bleu brun '
  + 'roux blond nord sud est ouest rive haut haute bas basse long longue court courte fort forte moyen moyenne bon bonne beau belle '
  + 'jeune vieux neuf nouveau nouvelle centre central centrale cardiologique medical clinique cabinet saint sainte mont pont port '
  + 'ville bois lac vallee plaine champ champs mer france paris lyon '
  + 'white black green brown young long short little small big great north south east west hill wood park king new old '
  + 'left right normal mild major minor rose may april june august will hope grace joy faith').split(' '));

// An organisation, not a person: only its full name is hidden.
const ORG_RE = /\b(?:laboratoire|laboratory|labo|lab|cabinet|centre|center|clinique|clinic|hopital|hospital|chu|chr|ch|institut|institute|polyclinique|groupe|group|service|pharmacie|pharmacy|imagerie|imaging|radiologie|radiology|scm|selarl|sarl|sas|ltd|inc|practice|surgery|trust)\b/;
const PERSON_TITLE_RE = /^\s*(?:dr|docteur|doctor|pr|prof|professeur|professor|mr|mrs|ms|mme|mlle|m|madame|monsieur)\b\.?/i;

/** Name parts worth hiding alone: 2+ letters, not generic. */
function nameParts(s) {
  return foldName(s).split(/[ ]+/).map(w => w.replace(/^'+|'+$/g, '').replace(/^[dl]'/, ''))
    .filter(w => w.length >= 2 && /^\p{L}[\p{L}']*$/u.test(w) && !GENERIC_PARTS.has(w));
}

// ---------- Medical words (used to tell a heading from a name line)

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

/** AI mode shows only the app's built-in document types. Own types can contain names: "Medical document". */
export const safeCategory = c => (isBuiltInDocType(String(c || '').trim()) ? String(c).trim() : 'Medical document');

// ---------- Patterns

const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}])`;

// A name token: a capitalised or all-caps word (with inner hyphens), an initial "L.", or an already hidden name.
const TOK = String.raw`(?:\[name\]|\p{Lu}[\p{L}'’]*(?:-\p{Lu}[\p{L}'’]*)*\.?)`;
const PART = String.raw`(?:de|du|des|la|le|van|von|der|den|di|da|del|della|dos|das|el|al|ben|bin|De|Du|Van|Von|Le|La|Del|Da|Di)`;
const GLUED = String.raw`(?:[dDlL]['’])`;
const NAME = String.raw`(?:${PART}[ \t]+){0,2}${GLUED}?${TOK}(?:(?:[ \t]+(?:${PART}[ \t]+){0,2}|[ \t]*${GLUED}|[ \t]+${GLUED})${TOK}){0,3}`;

const TITLES = ['Professeur', 'Professor', 'Docteur', 'Doctor', 'Monsieur', 'Madame', 'Mademoiselle', 'Mlle', 'Mme', 'Mrs', 'Mr', 'Ms', 'Miss', 'Prof', 'Dr', 'Pr', 'Drs'];
const TITLE_WORDS = [...TITLES, ...['DOCTEUR', 'DOCTOR', 'PROFESSEUR', 'PROFESSOR', 'MONSIEUR', 'MADAME', 'MME', 'MLLE', 'MRS', 'MR', 'DR', 'Herr', 'Frau']]
  .sort((a, b) => b.length - a.length).join('|');
// German and Swiss degrees after a title: "Dr. med.", "Dr. med. dent.", "Prof. Dr. med.", "Dr. rer. nat.".
const DEGREE = String.raw`(?:med|dent|vet|phil|rer|nat|pharm|habil|univ|h\.c|sc|jur|oec|biol|chem|psych)\.?`;
const TITLE_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}(${TITLE_WORDS}|M)(\.?)((?:[ \t]+(?:${TITLE_WORDS})\.?|[ \t]+${DEGREE})*)[ \t]+(${NAME})`, 'gu');

// Words after which a name follows, with or without a colon: "Signé par : Marie Lefebvre", "Re: John Smith".
const CUES = String.raw`(?:(?:[Vv]alidated|[Ss]igned|[Ww]ritten|[Rr]eported|[Pp]rescribed|[Rr]eferred|[Ss]een|[Ee]xamined|[Rr]equested|[Dd]ictated|[Rr]eviewed|[Aa]pproved|[Ii]nterpreted|[Rr]ead|[Cc]opy\s+to)\s+by|(?:[Vv]alidé|[Ss]igné|[Rr]édigé|[Pp]rescrit|[Dd]emandé|[Aa]dressé|[Ii]nterprété|[Vv]u|[Ee]xaminé|[Cc]opie\s+à)e?s?(?:\s+électroniquement)?\s+par|Signed|SIGNED|Signé|Re|RE|Pt|Patient|Dear|Cher|Chère|Attn|Cc|To|From|De|À|Pour|Médecin(?:\s+traitant)?|Doctor|GP|Physician|Prescripteur|Biologiste|Interne|Externe|Infirmi[eè]re?|Nurse|Resident|épouse|[ÉEée]p\.|née|nee|born|NÉE)`;
const CUE_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}(${CUES})([ \t]*:?[ \t]*)(${NAME})`, 'gu');
const CREDENTIAL_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}(${TOK}(?:[ \t]+(?:${PART}[ \t]+){0,2}${TOK}){1,3})(,?[ \t]+(?:MD|M\.D\.|PhD|Ph\.D\.|DO|RN|NP|PA-C|FRCP|MRCP|MBBS|DDS|PharmD))${NOT_WORD_AFTER}`, 'gu');
// A short line made only of name tokens, with a capitalised word and an all-caps word: "Marie LEFEBVRE".
const NAME_LINE_RE = new RegExp(String.raw`^([ \t]*)(${TOK}(?:[ \t]+(?:${PART}[ \t]+){0,2}${TOK}){1,3})([ \t]*)$`, 'gmu');

// Header labels: the name tokens after them are hidden (not the rest of the line: "Patient: 35 y/o male …" stays).
const HEADER_NAME_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}((?:Patient(?:e)?(?:\s+name)?|PATIENT|Nom(?:\s+de\s+naissance|\s+d'usage|\s+et\s+prénom|\s+de\s+jeune\s+fille)?|NOM|Prénom|PRENOM|PRÉNOM|Name|NAME|Full\s+name|Surname|First\s+name|Last\s+name|Given\s+name|Assuré(?:e)?|Insured|Bénéficiaire)[ \t]*:[ \t]*)(${NAME}(?:[ \t]*,[ \t]*${NAME}(?=[ \t]*(?:$|[,;(\n–-]|)|[ \t]+(?:\p{Lu}[\p{Lu}.]+|Date|Born|Age|Sex|Geb\.?)[ \t]*[:.]))?)`, 'gmu');
const ADDRESS_LABEL_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}((?:Adresse|ADRESSE|Address|ADDRESS|Domicile)[ \t]*:)[^\n]*`, 'gu');
const BIRTH_LABEL = String.raw`(?:born|Born|BORN|n[ée]e?(?:\(e\))?\s+le|N[ée]e?(?:\(e\))?\s+le|NÉ(?:\(E\))?\s+LE|DOB|D\.O\.B\.?|[Dd]ate\s+of\s+birth|[Dd]ate\s+de\s+naissance|DATE\s+DE\s+NAISSANCE|[Bb]irth\s*date|[Bb]irthday|[Aa]nniversaire|[Gg]eboren)`;
const BIRTH_BEFORE_RE = new RegExp(String.raw`${BIRTH_LABEL}\s*(?:on|in|le|en|:)?\s*$`, 'u');
const BIRTH_RAW_RE = new RegExp(String.raw`(${BIRTH_LABEL}\s*(?:on|le|:)?\s*)[\d][\d./\- ]{4,9}\d`, 'gu');
const BIRTH_YEAR_RE = /((?:born|Born)\s+in|[Nn][ée]e?(?:\(e\))?\s+en|[Yy]ear\s+of\s+birth\s*:?|[Aa]nnée\s+de\s+naissance\s*:?)(\s*)(?:19|20)\d{2}(?!\d)/gu;
const PHONE_LABEL_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}((?:[Tt][ée]l[ée]phone|TEL|[Tt][ée]l|[Pp]hone|PHONE|[Mm]obile|[Pp]ortable|[Ff]ax|FAX|[Tt]elephone|Ph|[Cc]ell)\.?[ \t]*[:.]?[ \t]*)\+?[\d(][\d \t.()\-/]{4,}\d`, 'gu');

const EMAIL_RE = /[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}\-]+(?:\.[\p{L}\p{N}\-]+)+/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']+[^\s<>()"'.,;:!?]/giu;
const DOMAIN_RE = /(?<![\p{L}\p{N}@.\-])[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9\-]+)*\.(?:fr|com|org|net|uk|de|be|ch|eu|io|nl|es|it|us|ca|lu|info|health|care|clinic|doctor|gouv\.fr|co\.uk)(?![\p{L}\p{N}\-])/giu;
const IBAN_RE = /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/gu;

// Hospitals and clinics with their name: "CHU de Nantes", "Hôpital Saint-Louis", "Massachusetts General Hospital".
const HOSP_WORD = String.raw`(?:CHU|CHR|CHRU|CH|Hôpital|Hopital|HÔPITAL|HOPITAL|Clinique|CLINIQUE|Centre\s+[Hh]ospitalier(?:\s+[Uu]niversitaire)?|CENTRE\s+HOSPITALIER|Centre\s+m[ée]dical|Cabinet(?:\s+m[ée]dical)?|Hospital|HOSPITAL|Medical\s+Cent(?:er|re)|Klinikum|Klinik|Krankenhaus|Spital|Praxis|Polyclinique|POLYCLINIQUE|Infirmary|Groupe\s+[Hh]ospitalier|\p{Lu}\p{Ll}+(?:spital|klinikum|klinik|krankenhaus))`;
// German nouns are capitalised: "im Spital Behandlung" is not a hospital name.
const NOT_A_NAME = String.raw`(?!(?:Aufenthalt|Behandlung|Eintritt|Austritt|Aufnahme|Entlassung|Fieber|Schmerzen|Bericht|Besuch|Termin|Kontrolle|Notfall|Station|Abteilung|Operation|Untersuchung)\b)`;
const HOSP_NAME = String.raw`(?:(?:de|du|des|d'|d’|la|le|les|of|the|der|die|das|am|an|im|St\.?|Ste)[ \t]+)*${NOT_A_NAME}\p{Lu}[\p{L}'’\-]*\.?`;
const HOSPITAL_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}${HOSP_WORD}[ \t]+${HOSP_NAME}(?:[ \t\-]+${HOSP_NAME})*`, 'gu');
const HOSPITAL_AFTER_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}(?:\p{Lu}[\p{L}'’\-]*[ \t]+){1,3}(?:General[ \t]+|Memorial[ \t]+|University[ \t]+|Children's[ \t]+)?(?:Hospital|Medical Center|Medical Centre|Infirmary|Clinic)${NOT_WORD_AFTER}`, 'gu');

// Addresses: street number + street type, a street type + name, postcode + city, PO boxes.
const STREET = String.raw`(?:rue|Rue|RUE|avenue|Avenue|AVENUE|av\.|Av\.|boulevard|Boulevard|BOULEVARD|bd|Bd|BD|blvd|Blvd|chemin|Chemin|allée|Allée|impasse|Impasse|Place|quai|Quai|Route|Cours|Square|faubourg|Faubourg|Street|STREET|St\.?|Road|ROAD|Rd\.?|Lane|Ln\.?|Drive|Way|Court|Ct\.?|Terrace|Close|Crescent|Ave\.?|Parkway|Highway)`;
const ADDRESS_NUM_RE = new RegExp(String.raw`(?<![\p{L}\p{N}.,])\d{1,4}(?:[ \t]?(?:bis|ter|[A-Za-z]))?,?[ \t]+(?:\p{L}[\p{L}'’\-]*[ \t]+){0,3}?${STREET}(?![\p{L}])[^\n,;]*`, 'gu');
// Lower-case street words count only before a capitalised name: "1 place Alexis Ricordeau", not "3 cours de yoga".
const ADDRESS_LOWER_RE = /(?<![\p{L}\p{N}.,])\d{1,4}(?:[ \t]?(?:bis|ter))?,?[ \t]+(?:place|route|cours|square|passage|voie|esplanade|rond-point|lieu-dit|hameau|résidence|lotissement|street|road|lane|drive|way|court|close)[ \t]+(?:(?:de|du|des|de la|d'|l'|la|le|of|the)[ \t]*)?\p{Lu}[^\n,;]*/gu;
const ADDRESS_STREET_RE = new RegExp(String.raw`${NOT_WORD_BEFORE}(?:rue|Rue|RUE|avenue|Avenue|boulevard|Boulevard|allée|Allée|impasse|Impasse|chemin|Chemin|quai|Quai|faubourg|Faubourg)[ \t]+(?:(?:de|du|des|de la|d'|l'|la|le)[ \t]*)?\p{Lu}[^\n,;]*`, 'gu');
// German and Swiss streets: "Bahnhofstrasse 12", "Hauptstraße 5", "Lindenweg 3a". The ending must close the word,
// and a house number must follow (not a unit: "Seeufer 3 km", "Monitoring 48 Stunden" stay).
const STREET_DE_RE = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\-]*(?:strasse|straße|str\.|gasse|weg|platz|allee)[ \t]+\d{1,4}[a-zA-Z]?(?![\p{L}\p{N}]|[.,]\p{N}|[ \t]*(?:km|m|cm|mm|h|min|mg|g|kg|ml|mL|l|L|%|x|×|Std|Stunden|Tage|Mal)\b)/gu;
const PO_BOX_RE = /(?<![\p{L}\p{N}])(?:P\.?[ \t]?O\.?[ \t]?Box|PO[ \t]?BOX|Bo[îi]te[ \t]+postale|B\.P\.|CS|TSA)[ \t]*\d+/gu;
// A postcode (4 or 5 digits) with its city. It counts only in an address context (see postcodeOk below).
const CITY = String.raw`\p{Lu}[\p{L}'’\-]+(?:[ \t\-]+(?:CEDEX(?:[ \t]+\d{1,2})?|Cedex(?:[ \t]+\d{1,2})?|sur|sous|en|lès|les|de|du|la|le|am|an|bei|im|\p{Lu}[\p{L}'’\-]*)){0,3}`;
const POSTCODE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}.,\-])((?:F|FR|D|DE|A|AT|CH)-)?(\d{4,5})[ \t]+(${CITY})`, 'gu');
// Words after a number that make it a count, not a postcode.
const NOT_A_CITY = new Set(('schritte steps step pas liter litre litres liters meter metre metres meters mètres kalorien calories kcal kj einheiten units unites unités '
  + 'mal times fois tage days jours stunden hours heures minuten minutes euro euros chf eur usd franken patienten patients personen people '
  + 'tabletten tablets comprimés gramm grams grammes ml mg ui iu').split(' '));
// UK postcode, with the city just before it ("London NW1 6XE", "Leeds, LS1 4AP").
const POSTCODE_UK_RE = /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}'’\-]+,?[ \t]+)?[A-Z]{1,2}\d[A-Z\d]?[ \t]*\d[A-Z]{2}(?![\p{L}\p{N}])/gu;
const ZIP_US_RE = /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}.\-]*(?:[ \t]\p{Lu}[\p{L}.\-]*)*,[ \t]*)?[A-Z]{2}[ \t]+\d{5}(?:-\d{4})?(?![\p{N}])/gu;

// IDs
const ID_LABEL_RE = /(?<![\p{L}\p{N}])((?:IPP|NIP|NIR|MRN|NHS(?:\s+(?:number|no\.?))?|N°\s*SS|S[ée]curit[ée]\s+sociale|Dossier|File|Fichier|Patient\s+ID|ID|Identifiant|R[ée]f\.?|R[ée]f[ée]rence|Reference|Sample(?:\s+(?:no\.?|number|n°))?|[ÉE]chantillon|Specimen|Accession|Order(?:\s+(?:no\.?|number|n°))?|Commande|Demande(?:\s+n°)?|Pr[ée]l[èe]vement(?:\s+n°)?|N°|Nº|No\.|Num[ée]ro|Number|Account|Compte|Policy|Contrat|Invoice|Facture|Visit|Encounter|Episode|S[ée]jour)\s*[:#]?\s*(?:n°|no\.?|#)?\s*)([A-Za-z0-9][A-Za-z0-9/\-.]*[A-Za-z0-9])(?![\p{L}\p{N}])/giu;
// National numbers written with spaces: NIR "1 91 03 75 123 456 78", NHS "943 476 5919", SSN "123-45-6789".
// Swiss social insurance number (AVS/AHV): "756.1234.5678.97".
const AVS_RE = /(?<![\p{N}.])756[. ]?\d{4}[. ]?\d{4}[. ]?\d{2}(?![\p{N}])/gu;
const SPACED_ID_RE = /(?<![\p{L}\p{N}])((?:NIR|N°\s*SS|S[ée]curit[ée]\s+[Ss]ociale|NHS(?:\s+(?:number|no\.?))?|SSN|Social\s+[Ss]ecurity(?:\s+(?:number|no\.?))?|Carte\s+[Vv]itale)\s*[:#]?\s*(?:n°|no\.?)?\s*)[\dAB][\dAB \-]{7,24}\d/gu;
const HASH_ID_RE = /#[ \t]?[A-Za-z0-9][A-Za-z0-9/\-.]*\d[A-Za-z0-9/\-]*/gu;
const ID_ALNUM_RE = /(?<![\p{L}\p{N}\-])[A-Z]{1,5}[\- ]?\d{5,}(?![\p{L}\p{N}])/gu;
const ID_MIXED_RE = /(?<![\p{L}\p{N}])(?=[A-Z0-9]*\d{4})(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}(?![\p{L}\p{N}])/gu;
const ID_GROUPS_RE = /(?<![\p{N}.,\-/])\d{2,}(?:[\-/]\d{2,}){1,5}(?![\p{N}]|[.,]\p{N})/gu;

// Phones: a phone needs a + country code, a leading 0 (national) or the US shape. Value series are not phones.
const PHONE_INTL_RE = /(?<![\p{N}\w])\+\d{1,3}(?:[ .\-]?\(0\))?(?:[ .\-]?\d{1,4}){2,6}(?![\p{N}])/gu;
const PHONE_US_RE = /(?<![\p{N}.,])(?:\(\d{3}\)[ .\-]?|\d{3}[ .\-])\d{3}[ .\-]\d{4}(?![\p{N}]|[.,]\p{N})/gu;
const PHONE_NATIONAL_RE = /(?<![\p{N}.,])0\d(?:[ .\-]?\d){8,9}(?![\p{N}]|[.,]\p{N})/gu;
const UNIT_AFTER = /^\s*(?:mmol|µmol|umol|mg|g\/|g\b|%|bpm|ms|kg|mmHg|\/|steps|pas|days|jours|cells|UI|IU|U\/|mL|ml|L\b)/;
const DIGITS_RE = /(?<![.,]\p{N}*)\d{7,}/gu;

const digits = s => s.replace(/\D/g, '').length;

// A line with an address or a name already found: a letterhead block.
const ADDRESS_LINE = /\[address\]|\[name\]|\uE000|(?:^|[ \t])\d{1,4}[a-z]?,?[ \t]+\p{L}|\p{L}[ \t]+\d{1,4}[a-z]?(?:,|$)/u;

/**
 * Is "75002 Paris" / "1204 Genève" a postcode? Only with a country prefix, CEDEX, an address before it on the
 * same line, or on a line of its own next to an address or name line. Never before a unit or a common noun
 * ("10000 Schritte"), and a year (1900–2100) only after an address on the same line.
 */
function postcodeOk(str, at, m, prefix, code, city) {
  if (NOT_A_CITY.has(fold(city.split(/[ \t\-]/)[0]))) return false;
  if (prefix || /cedex/i.test(city)) return true;
  const lineStart = str.lastIndexOf('\n', at - 1) + 1;
  let lineEnd = str.indexOf('\n', at);
  if (lineEnd < 0) lineEnd = str.length;
  const before = str.slice(lineStart, at);
  if (/\[address\],?[ \t]*$/.test(before)) return true;
  const year = code.length === 4 && Number(code) >= 1900 && Number(code) <= 2100;
  if (year) return false;
  const alone = !before.trim() && !str.slice(at + m.length, lineEnd).trim();
  if (!alone) return false;
  const prev = str.slice(str.lastIndexOf('\n', lineStart - 2) + 1, Math.max(lineStart - 1, 0));
  const nextEnd = str.indexOf('\n', lineEnd + 1);
  const next = lineEnd < str.length ? str.slice(lineEnd + 1, nextEnd < 0 ? str.length : nextEnd) : '';
  return (lineStart > 0 && ADDRESS_LINE.test(prev)) || ADDRESS_LINE.test(next);
}

/**
 * profile: { name, dob }       words: extra words to hide (settings.redactWords)
 * correspondents: document correspondents (all documents, also excluded ones)
 * relativeTo: ISO date of D0, or null to keep dates as written.
 * text(input, { ref }): ref is the date of the text (a document or a diary day). It gives the year of dates
 * written without one, and chooses between 03/04 = 3 April or 4 March.
 */
export function makeRedactor({ profile = {}, words = [], correspondents = [], relativeTo = null, nowYear } = {}) {
  const dob = profile.dob || '';
  const [dy, dm, dd] = dob ? dob.split('-').map(Number) : [];

  // Terms: [folded, capOnly].
  const terms = new Map();
  const addTerm = (t, capOnly) => {
    const f = foldName(t).replace(/^'+|'+$/g, '');
    if (f.length < 2 || /^\d+$/.test(f)) return;
    if (!terms.has(f) || !capOnly) terms.set(f, capOnly);
  };
  // The user: every part in any case (3+ letters; 2 letters only when capitalised).
  const userName = String(profile.name || '').trim();
  if (userName) {
    addTerm(userName, false);
    for (const p of nameParts(userName)) addTerm(p, p.length < 3);
  }
  // Correspondents: an organisation by its full name only; a person by the full name and the parts
  // that are not common words (only when capitalised).
  for (const c of correspondents) {
    const v = String(c || '').trim();
    if (!v) continue;
    const clean = v.replace(/\s+[–—|(].*$/u, '').replace(/,.*$/, '').trim();
    for (const x of [v, clean, clean.replace(PERSON_TITLE_RE, '').trim()]) if (foldName(x).includes(' ')) addTerm(x, false);
    const isOrg = ORG_RE.test(foldName(clean)) && !PERSON_TITLE_RE.test(clean);
    if (isOrg) continue;
    for (const p of nameParts(clean)) if (!COMMON_WORDS.has(p)) addTerm(p, true);
  }
  // The user's words: as written, in any case; their parts only when capitalised.
  for (const w of words) {
    const v = String(w || '').trim();
    if (!v) continue;
    addTerm(v, false);
    if (!ORG_RE.test(foldName(v))) for (const p of nameParts(v)) if (!COMMON_WORDS.has(p)) addTerm(p, true);
    for (const h of v.match(/\p{L}+(?:-\p{L}+)+/gu) || []) addTerm(h, false);
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

  const isDob = (y, m, d) => !!dob && m === dm && (d == null ? y === dy : d === dd && (y == null || y === dy));
  const altParts = iso => iso && iso.split('-').map(Number);

  /** Hide personal details in free text. */
  function text(input, { ref } = {}) {
    if (input == null || input === '') return '';
    let t = String(input);
    const docRef = ref || relativeTo || null;
    const keep = [];
    // Placeholders: private-use characters with no digits, so later rules cannot break them.
    const hold = v => { keep.push(v); return `${String.fromCharCode(0xE100 + keep.length - 1)}`; };

    // 1. Dates
    let out = '', at = 0;
    for (const f of findDates(t, { nowYear, ref: docRef })) {
      const birth = BIRTH_BEFORE_RE.test(t.slice(Math.max(0, f.start - 30), f.start));
      const a = altParts(f.alt);
      let rep;
      if (birth || isDob(f.y, f.m, f.d) || (a && isDob(a[0], a[1], a[2]))) rep = '[date of birth]';
      else if (!relativeTo) rep = f.text;
      else if (f.kind === 'month') rep = `${relDay(`${f.y}-${String(f.m).padStart(2, '0')}-01`, relativeTo)} (month)`;
      else if (f.iso) rep = relDay(f.iso, relativeTo);
      else rep = '[date]'; // a date that cannot be placed never stays absolute in AI mode
      out += t.slice(at, f.start) + hold(rep);
      at = f.end;
    }
    t = out + t.slice(at);
    t = t.replace(BIRTH_RAW_RE, (m, label) => `${label}[date of birth]`);
    t = t.replace(BIRTH_YEAR_RE, (m, label, sp) => `${label}${sp || ' '}[year of birth]`);

    // 2. Links, emails, IBAN, header values, hospitals
    t = t.replace(EMAIL_RE, () => hold('[email]'));
    t = t.replace(URL_RE, () => hold('[link]'));
    t = t.replace(DOMAIN_RE, () => hold('[link]'));
    t = t.replace(IBAN_RE, m => (m.replace(/ /g, '').length >= 15 ? '[iban]' : m));
    t = t.replace(ADDRESS_LABEL_RE, (m, label) => `${label} [address]`);
    t = t.replace(PHONE_LABEL_RE, (m, label) => (digits(m) >= 6 ? `${label}[phone]` : m));
    t = t.replace(HOSPITAL_RE, () => hold('[hospital]'));
    t = t.replace(HOSPITAL_AFTER_RE, () => hold('[hospital]'));

    // 3. Known names
    t = hideTerms(t);

    // 4. Names found by their context
    t = t.replace(HEADER_NAME_RE, (m, label) => `${label}[name]`);
    // The titles stay, the degrees and the name go: "Prof. Dr. med. Thomas Müller" → "Prof. Dr. [name]".
    t = t.replace(TITLE_RE, (m, title, dot, more) => (title === 'M' && !dot && !more ? m
      : `${title}${dot}${(more.match(new RegExp(String.raw`[ \t]+(?:${TITLE_WORDS})\.?`, 'gu')) || []).join('')} [name]`));
    t = t.replace(CUE_RE, (m, cue, sp, name, at, str) => (/^\[name\]/.test(name) && /^[ \t]*:/.test(str.slice(at + m.length)) ? m // "[name]   DOB:" — a label, not a name
      : /^(?:Re|RE|Pt|To|From|De|À|Pour|Cc|GP|Patient)$/.test(cue) && !/:/.test(sp) && !/^\[name\]/.test(name) && !/[ \t]/.test(name.trim())
      ? m : `${cue}${sp || ' '}[name]`));
    t = t.replace(CREDENTIAL_RE, (m, name, cred) => `[name]${cred}`);
    t = t.replace(NAME_LINE_RE, (m, lead, name, trail) => {
      const toks = name.split(/[ \t]+/).filter(x => !/^(?:de|du|des|la|le|van|von|der|den|di|da)$/i.test(x));
      const caps = toks.filter(x => /^\p{Lu}{2,}[\p{Lu}'’\-]*$/u.test(x));
      const mixed = toks.filter(x => /^\p{Lu}\p{Ll}/u.test(x));
      const generic = toks.some(x => GENERIC_PARTS.has(foldName(x)) || COMMON_WORDS.has(foldName(x)) || GENERIC_CATEGORY.has(foldName(x)));
      return caps.length && mixed.length && !generic ? `${lead}[name]${trail}` : m;
    });
    t = t.replace(/\[name\](?:[ \t]+\[name\])+/g, '[name]');

    // 5. Addresses, IDs, phones, numbers
    t = t.replace(ADDRESS_NUM_RE, '[address]');
    t = t.replace(ADDRESS_LOWER_RE, '[address]');
    t = t.replace(ADDRESS_STREET_RE, '[address]');
    t = t.replace(STREET_DE_RE, '[address]');
    t = t.replace(PO_BOX_RE, '[address]');
    t = t.replace(POSTCODE_RE, (m, prefix, code, city, at, str) => (postcodeOk(str, at, m, prefix, code, city) ? '[address]' : m));
    t = t.replace(POSTCODE_UK_RE, '[address]');
    t = t.replace(AVS_RE, '[id]');
    t = t.replace(SPACED_ID_RE, (m, label) => `${label}[id]`);
    t = t.replace(ID_LABEL_RE, (m, label, value) => {
      const n = digits(value);
      return n >= 4 || (n >= 3 && /[A-Za-z]/.test(value)) ? `${label.replace(/\s*#\s*$/, ' ')}[id]` : m;
    });
    t = t.replace(HASH_ID_RE, m => (digits(m) >= 3 ? '[id]' : m));
    t = t.replace(ZIP_US_RE, '[address]');
    t = t.replace(ID_ALNUM_RE, '[id]');
    t = t.replace(ID_MIXED_RE, '[id]');
    // Number groups are an ID when one group has 5+ digits ("2026-88412-07"), or 3+ groups with a 4-digit one
    // and 8+ digits. "142/91/78" (BP), "28-30-32" (cycle) and "2024-2025" stay.
    t = t.replace(ID_GROUPS_RE, m => {
      const groups = m.split(/[\-/]/);
      return groups.some(g => g.length >= 5) || (groups.length >= 3 && groups.some(g => g.length >= 4) && digits(m) >= 8) ? '[id]' : m;
    });
    // A phone is never followed by a unit ("140 138 141 mmol/L") and has digit groups of 2 or more.
    const groupsOk = m => m.split(/[ .\-()]+/).filter(Boolean).every(g => g.length >= 2);
    const phone = (re, ok) => { t = t.replace(re, (m, ...rest) => {
      const at = rest[rest.length - 2], str = rest[rest.length - 1];
      return ok(m) && !UNIT_AFTER.test(str.slice(at + m.length, at + m.length + 12)) ? '[phone]' : m;
    }); };
    phone(PHONE_INTL_RE, m => digits(m) >= 8 && digits(m) <= 15);
    phone(PHONE_US_RE, groupsOk);
    phone(PHONE_NATIONAL_RE, m => digits(m) >= 10 && digits(m) <= 11 && groupsOk(m));
    t = t.replace(DIGITS_RE, '[number]');

    // Restore the dates, links and hospitals.
    return t.replace(/(.)/gu, (m, c) => keep[c.charCodeAt(0) - 0xE100]);
  }

  return {
    text,
    category: safeCategory,
    /** Report dates: D-n, or the ISO date when dates are kept. */
    date: iso => (relativeTo ? relDay(iso, relativeTo) : iso),
  };
}
