// Finds calendar dates written in free text (documents, notes, the question).
// One parser for the whole report: the anonymizer uses it to hide the date of birth,
// and to replace dates with day numbers (D-12, D+3).
//
// Forms that are found:
//   ISO and year first: 2026-03-14, 2026/03/14, 2026.03.14
//   Numbers, day first: 14/03/1991, 14.3.1991, 14-03-1991, 14/03/91
//   Month names (English and French, full or short): 14 March 1991, 14th of March 1991, 1er mars 2026,
//     3 février 2026, 14-Mar-1991, March 14, 1991, Mar 14 1991
//   Without a year: "14 March", "the 3rd of October", "March 14", "le 3/10", "05/10 to 09/10",
//     "du 1er au 3 octobre". The year comes from the reference date (the date of the document):
//     the nearest date on or before it. `inferred` is true for these.
//   Month and year only: "octobre 2026", "March 2024" (kind 'month').
//   A weekday name just before the date is part of the match ("Monday 3 March 2026", "lundi 3 mars").
import { pad } from '../core/dates.js';
import { fold } from '../core/format.js';

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
// Month words that are also common words: without a year they count only when capitalised ("May 3", not "may 3").
const AMBIGUOUS = new Set(['may', 'mar']);

const monthOf = w => MONTHS[fold(w).replace(/\.$/, '')] || null;

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

const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dayNum = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };

/** The year for a day and month without a year: the nearest date on or before the reference date. */
function inferYear(m, d, ref) {
  const [ry] = ref.split('-').map(Number);
  for (const y of [ry, ry - 1, ry - 2]) if (valid(y, m, d) && isoOf(y, m, d) <= ref) return y;
  return null;
}

// No digit, decimal point or date separator next to a numeric date: "0.84 0.00" or "2026-88412-07" are not dates.
const NB = String.raw`(?<![\p{N}.,/\-])`;
const NA = String.raw`(?![\p{N}]|[.,/\-]\p{N})`;
const MONTH_WORD = String.raw`(\p{L}{3,9})\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th|er|re|e)?`;
const OF = String.raw`(?:\s+of)?`;
const TO = String.raw`\s*(?:au|à|to|until|till|-|–|—|and|et)\s*`;
// Words that show that a day/month pair without a year is a date ("le 3/10"), not a score ("pain 3/10").
const DATE_CUE = /\b(?:le|du|au|on|from|to|until|since|depuis|jusqu'au|dated?|the|between|and|et|entre)\s*$/i;

const PATTERNS = [
  // Year first: 2026-03-14, 2026/03/14, 2026.03.14
  { re: new RegExp(String.raw`${NB}(\d{4})([\-/.])(\d{1,2})\2(\d{1,2})${NA}`, 'gu'), parts: m => [m[1], m[3], m[4]], kind: 'ymd' },
  // Numbers, day first. 2-digit years are allowed.
  { re: new RegExp(String.raw`${NB}(\d{1,2})([\-/.])(\d{1,2})\2(\d{4}|\d{2})${NA}`, 'gu'), parts: m => [m[4], m[3], m[1]], kind: 'dmy' },
  // Day and month in numbers, no year: "le 3/10", "05/10". Only with a date word before it or a leading zero.
  { re: new RegExp(String.raw`${NB}(\d{1,2})/(\d{1,2})${NA}`, 'gu'), parts: m => [null, m[2], m[1]], kind: 'dm' },
  // A range of days in one month: "du 1er au 3 octobre 2026", "1-3 March" → two dates.
  { re: new RegExp(String.raw`(?<![\p{L}\p{N}])${DAY}${TO}${DAY}${OF}[\s\-]+${MONTH_WORD}(?:[\s,\-]+(\d{4}))?(?![\p{L}\p{N}])`, 'giud'), kind: 'range' },
  // 14 March 1991, 14th of March 1991, 14-Mar-1991, 1er mars 2026, 14 March (no year)
  { re: new RegExp(String.raw`(?<![\p{L}\p{N}])${DAY}${OF}[\s\-]+${MONTH_WORD}(?:[\s,\-]+(\d{4}))?(?![\p{L}\p{N}])`, 'giu'), parts: m => [m[3], m[2], m[1]], kind: 'text' },
  // March 14, 1991 / Mar 14 1991 / March 14 (no year: capitalised month only)
  { re: new RegExp(String.raw`(?<![\p{L}\p{N}])${MONTH_WORD}\s+(?:the\s+)?${DAY}(?:,?\s+(\d{4}))?(?![\p{L}\p{N}]|\s*(?:mg|g|ml|mL|%|x|×|h|min|times|fois)\b)`, 'gu'), parts: m => [m[3], m[1], m[2]], kind: 'text-md' },
  // Month and year: "octobre 2026", "March 2024"
  { re: new RegExp(String.raw`(?<![\p{L}\p{N}])${MONTH_WORD}\s+(\d{4})(?![\p{L}\p{N}])`, 'giu'), parts: m => [m[2], m[1], null], kind: 'month' },
];

/**
 * All dates in a text, in order, without overlaps.
 * opts: { nowYear, ref } — ref (ISO) is the date of the document: it gives the year to dates without one,
 * and chooses between day/month and month/day when both are possible.
 * Returns [{ start, end, text, y, m, d, iso, alt, inferred, kind }]:
 *   iso is null when the date cannot be placed; alt is the other reading of an ambiguous date;
 *   kind 'month' is a month (d = null).
 */
export function findDates(text, { nowYear, ref = null } = {}) {
  const s = String(text || '');
  const year = nowYear || (ref ? Number(ref.slice(0, 4)) : new Date().getFullYear());
  const found = [];
  const add = (start, end, y, m, d, extra = {}) => {
    // A weekday name just before the date belongs to it.
    const before = /(\p{L}+)\.?,?\s+$/u.exec(s.slice(Math.max(0, start - 14), start));
    if (before && WEEKDAYS.has(fold(before[1]))) start -= before[0].length;
    let iso = y && d ? isoOf(y, m, d) : null, inferred = false;
    if (!y && d && ref) { const iy = inferYear(m, d, ref); if (iy) { iso = isoOf(iy, m, d); inferred = true; } }
    found.push({ start, end, y: y || null, m, d, iso, inferred, ...extra });
  };
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(s))) {
      if (p.kind === 'range') {
        const mo = monthOf(m[3]);
        const y = m[4] ? Number(m[4]) : null;
        const d1 = Number(m[1]), d2 = Number(m[2]);
        if (!mo || d1 >= d2 || !valid(y, mo, d1) || !valid(y, mo, d2)) continue;
        if (!y && AMBIGUOUS.has(fold(m[3])) && !/^\p{Lu}/u.test(m[3])) continue;
        // Two dates: the first day alone ("1er"), then "3 octobre 2026".
        const end1 = m.indices[1][1] + (/^(?:st|nd|rd|th|er|re|e)?/i.exec(s.slice(m.indices[1][1]))[0].length);
        add(m.index, end1, y, mo, d1, { kind: 'text' });
        add(m.indices[2][0], m.index + m[0].length, y, mo, d2, { kind: 'text' });
        continue;
      }
      let [y, mo, d] = p.parts(m);
      const word = p.kind === 'text' || p.kind === 'text-md' || p.kind === 'month' ? mo : null;
      if (word) {
        mo = monthOf(word);
        if (!mo) continue;
        // Without a year, "may" and "mar" are words, not months, unless capitalised.
        if (!y && AMBIGUOUS.has(fold(word)) && !/^\p{Lu}/u.test(word)) continue;
        if (p.kind === 'text-md' && !y && !/^\p{Lu}/u.test(word)) continue;
        if (p.kind === 'text-md' && !y && fold(word) === 'may') continue; // "May 2 tablets"
      } else {
        mo = Number(mo);
      }
      if (p.kind === 'month') {
        const yy = Number(y);
        if (yy < 1900 || yy > 2100) continue;
        found.push({ start: m.index, end: m.index + m[0].length, y: yy, m: mo, d: null, iso: null, kind: 'month' });
        continue;
      }
      d = Number(d);
      if (p.kind === 'dm') {
        const cue = DATE_CUE.test(s.slice(Math.max(0, m.index - 12), m.index));
        const padded = /^0\d$/.test(m[1]) || /^0\d$/.test(m[2]);
        // A day/month pair right after another one: "05/10 to 09/10".
        const afterDate = found.some(f => f.kind === 'dm' && /^\s*(?:au|à|to|until|-|–|and|et)\s*$/i.test(s.slice(f.end, m.index)));
        if (!cue && !padded && !afterDate) continue;
      }
      let alt = null;
      if (p.kind === 'dmy' || p.kind === 'dm') {
        // Slash and dot dates are read day first (European order), as in most documents this app reads.
        // When the first number cannot be a month and the second can (03/14/1991), it is month first.
        // When both readings are valid, the one nearest the document date wins (US letters), and the other is kept in `alt`.
        if (mo > 12 && d <= 12) [mo, d] = [d, mo];
        else if (mo <= 12 && d <= 12 && mo !== d) {
          const yy = y ? fullYear(y, year) : null;
          if (valid(yy, d, mo)) {
            const a = yy ? isoOf(yy, mo, d) : ref && inferYear(mo, d, ref) ? isoOf(inferYear(mo, d, ref), mo, d) : null;
            const b = yy ? isoOf(yy, d, mo) : ref && inferYear(d, mo, ref) ? isoOf(inferYear(d, mo, ref), d, mo) : null;
            if (ref && a && b && Math.abs(dayNum(b) - dayNum(ref)) < Math.abs(dayNum(a) - dayNum(ref))) { [mo, d] = [d, mo]; alt = a; } else alt = b;
          }
        }
      }
      const yy = y ? fullYear(y, year) : null;
      if (!valid(yy, mo, d)) continue;
      add(m.index, m.index + m[0].length, yy, mo, d, { kind: p.kind === 'dm' ? 'dm' : p.kind, alt });
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
  const n = Math.round(dayNum(iso) - dayNum(ref));
  return n === 0 ? 'D0' : n > 0 ? `D+${n}` : `D${n}`;
}
