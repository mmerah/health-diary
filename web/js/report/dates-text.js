// Finds calendar dates written in free text (documents, notes, the question).
// One parser for the whole report: the anonymizer uses it to hide the date of birth,
// and to replace dates with day numbers (D-12, D+3).
//
// Forms that are found:
//   ISO and year first: 2026-03-14, 2026/03/14, 2026.03.14
//   Numbers, day first: 14/03/1991, 14.3.1991, 14-03-1991, 14/03/91
//   Month names (English and French, full or short): 14 March 1991, 14th Mar 1991, 1er mars 2026,
//     3 février 2026, 14-Mar-1991, March 14, 1991, Mar 14 1991. Without a year: "14 March" (year = null).
//   A weekday name just before the date is part of the match ("Monday 3 March 2026", "lundi 3 mars").
import { pad } from '../core/dates.js';

const MONTHS = {
  jan: 1, january: 1, janv: 1, janvier: 1,
  feb: 2, february: 2, fev: 2, fevr: 2, fevrier: 2,
  mar: 3, march: 3, mars: 3,
  apr: 4, april: 4, avr: 4, avril: 4,
  may: 5, mai: 5,
  jun: 6, june: 6, juin: 6,
  jul: 7, july: 7, juil: 7, juillet: 7,
  aug: 8, august: 8, aou: 8, aout: 8,
  sep: 9, sept: 9, september: 9, septembre: 9,
  oct: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11,
  dec: 12, december: 12, decembre: 12,
};
const WEEKDAYS = new Set(['mon', 'monday', 'tue', 'tues', 'tuesday', 'wed', 'wednesday', 'thu', 'thur', 'thurs', 'thursday',
  'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday', 'lun', 'lundi', 'mardi', 'mer', 'mercredi', 'jeu', 'jeudi',
  'ven', 'vendredi', 'sam', 'samedi', 'dim', 'dimanche']);

const plain = w => w.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const monthOf = w => MONTHS[plain(w).replace(/\.$/, '')] || null;

/** Two-digit years: up to next year → 20yy, else 19yy ("91" → 1991, "26" → 2026). */
function fullYear(y, nowYear) {
  if (y.length === 4) return Number(y);
  const n = Number(y);
  return 2000 + n <= nowYear + 1 ? 2000 + n : 1900 + n;
}

function valid(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  if (y == null) return d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (y < 1900 || y > 2100) return false;
  const t = new Date(y, m - 1, d);
  return t.getMonth() === m - 1 && t.getDate() === d;
}

// No digit, decimal point or date separator next to a numeric date: "0.84 0.00" or "2026-88412-07" are not dates.
const NB = String.raw`(?<![\p{N}.,/\-])`;
const NA = String.raw`(?![\p{N}]|[.,/\-]\p{N})`;
const MONTH_WORD = String.raw`(\p{L}{3,9})\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th|er|re|e)?`;

const PATTERNS = [
  // Year first: 2026-03-14, 2026/03/14, 2026.03.14
  { re: new RegExp(String.raw`${NB}(\d{4})([\-/.])(\d{1,2})\2(\d{1,2})${NA}`, 'gu'), parts: m => [m[1], m[3], m[4]], kind: 'ymd' },
  // Numbers, day first. 2-digit years are allowed.
  { re: new RegExp(String.raw`${NB}(\d{1,2})([\-/.])(\d{1,2})\2(\d{4}|\d{2})${NA}`, 'gu'), parts: m => [m[4], m[3], m[1]], kind: 'dmy' },
  // 14 March 1991, 14-Mar-1991, 1er mars 2026, 14 March (no year)
  { re: new RegExp(String.raw`(?<![\p{L}\p{N}])${DAY}[\s\-]+${MONTH_WORD}(?:[\s,\-]+(\d{4}))?(?![\p{L}\p{N}])`, 'giu'), parts: m => [m[3], m[2], m[1]], kind: 'text' },
  // March 14, 1991 / Mar 14 1991 (a year is needed in this form)
  { re: new RegExp(String.raw`(?<![\p{L}\p{N}])${MONTH_WORD}\s+${DAY},?\s+(\d{4})(?![\p{L}\p{N}])`, 'giu'), parts: m => [m[3], m[1], m[2]], kind: 'text' },
];

/**
 * All dates in a text, in order, without overlaps.
 * Returns [{ start, end, text, y (null when not written), m, d, iso (null without a year) }].
 */
export function findDates(text, { nowYear = new Date().getFullYear() } = {}) {
  const s = String(text || '');
  const found = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(s))) {
      let [y, mo, d] = p.parts(m);
      if (p.kind === 'text') {
        mo = monthOf(mo);
        if (!mo) continue;
      } else {
        mo = Number(mo);
      }
      d = Number(d);
      // Slash and dot dates are read day first (European order), as in the documents this app reads.
      // Only when the first number cannot be a month and the second can (03/14/1991) is it read month first.
      if (p.kind === 'dmy' && mo > 12 && d <= 12) [mo, d] = [d, mo];
      const year = y ? fullYear(y, nowYear) : null;
      if (!valid(year, mo, d)) continue;
      let start = m.index;
      const end = m.index + m[0].length;
      // A weekday name just before the date belongs to it.
      const before = /(\p{L}+)\.?,?\s+$/u.exec(s.slice(Math.max(0, start - 14), start));
      if (before && WEEKDAYS.has(plain(before[1]))) start -= before[0].length;
      found.push({ start, end, y: year, m: mo, d, iso: year ? `${year}-${pad(mo)}-${pad(d)}` : null });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const f of found) {
    if (out.length && f.start < out[out.length - 1].end) continue;
    out.push({ ...f, text: s.slice(f.start, f.end) });
  }
  return out;
}

/** Replaces every date: fn(date) returns the new text (return date.text to keep it). */
export function replaceDates(text, fn, opts) {
  const s = String(text || '');
  let out = '', at = 0;
  for (const f of findDates(s, opts)) {
    out += s.slice(at, f.start) + fn(f);
    at = f.end;
  }
  return out + s.slice(at);
}

/** "D0", "D-12", "D+3": days from the reference day (the last day of the report). */
export function relDay(iso, ref) {
  const [y1, m1, d1] = iso.split('-').map(Number), [y2, m2, d2] = ref.split('-').map(Number);
  const n = Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
  return n === 0 ? 'D0' : n > 0 ? `D+${n}` : `D${n}`;
}
