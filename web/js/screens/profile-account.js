// Pure helpers for Profile and Login: passwords, setup code, medications. No DOM.
// Unit-tested in tests/profile.test.js.
import { isValidDate } from '../core/dates.js';

export const MIN_PASSWORD = 10;

const COMMON = ['password', 'motdepasse', '123456', 'qwerty', 'azerty', 'letmein', 'welcome', 'healthdiary', 'iloveyou', 'admin'];

/**
 * A short hint about a new password. level: 'empty' | 'short' | 'weak' | 'ok' | 'strong'.
 * Only 'short' blocks the form (the server checks the same minimum).
 */
export function passwordHint(pw, username = '') {
  const p = String(pw || '');
  if (!p) return { level: 'empty', text: `Use at least ${MIN_PASSWORD} characters. A short sentence is easy to remember and hard to guess.` };
  if (p.length < MIN_PASSWORD) {
    const n = MIN_PASSWORD - p.length;
    return { level: 'short', text: `Too short. Add ${n} more ${n === 1 ? 'character' : 'characters'}.` };
  }
  const low = p.toLowerCase();
  if ((username && low.includes(String(username).toLowerCase())) || COMMON.some(w => low.includes(w))
    || /^(.)\1+$/.test(p) || /^(0123456789|1234567890|abcdefghij)/i.test(p)) {
    return { level: 'weak', text: 'Easy to guess. Use some words that do not belong together.' };
  }
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(p)).length;
  if (p.length >= 16 || (p.length >= 12 && kinds >= 3)) return { level: 'strong', text: 'Strong password.' };
  return { level: 'ok', text: 'Good. A longer password is even safer.' };
}

/** Error text for a new password and its repeat, or '' when they are good. */
export function newPasswordError(pw, again, username = '') {
  if (String(pw || '').length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the password.`;
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'The password must not be the same as the username.';
  if (again != null && pw !== again) return 'The two passwords are not the same.';
  return '';
}

/** "abcd efgh-ijkl" → "ABCD-EFGH-IJKL". Accepts the code with or without dashes or spaces, any case. */
export function formatSetupCode(s) {
  const raw = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.match(/.{1,4}/g)?.join('-') || '';
}

// ---------- Medications

/** 'active', 'planned' (starts later) or 'stopped' (has an end date of today or earlier). */
export function medStatus(m, today) {
  if (m.until && m.until <= today) return 'stopped';
  if (m.since && m.since > today) return 'planned';
  return 'active';
}

/** Current and planned medications by name, then stopped ones (most recently stopped first). */
export function sortMeds(meds, today) {
  const current = meds.filter(m => medStatus(m, today) !== 'stopped').sort((a, b) => a.name.localeCompare(b.name));
  const stopped = meds.filter(m => medStatus(m, today) === 'stopped').sort((a, b) => b.until.localeCompare(a.until));
  return { current, stopped };
}

/** Checks the medication form. Returns { value } or { error, field }. */
export function parseMedForm(f) {
  const name = String(f.name || '').trim();
  const dose = String(f.dose || '').trim();
  const since = String(f.since || '');
  const until = String(f.until || '');
  if (!name) return { error: 'Enter the name of the medication.', field: 'name' };
  if (name.length > 200) return { error: 'The name is too long. Use at most 200 characters.', field: 'name' };
  if (dose.length > 100) return { error: 'The dose text is too long. Use at most 100 characters.', field: 'dose' };
  if (since && !isValidDate(since)) return { error: 'Enter a valid start date.', field: 'since' };
  if (until && !isValidDate(until)) return { error: 'Enter a valid end date.', field: 'until' };
  if (since && until && until < since) return { error: 'The end date must be on or after the start date.', field: 'until' };
  return { value: { name, dose, since, until, asNeeded: !!f.asNeeded } };
}

/** Height field → number, null (empty) or undefined (not valid). */
export function parseHeight(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Math.round(Number(s.replace(',', '.')));
  return n >= 50 && n <= 250 ? n : undefined;
}

/** "2026-10-12T08:14…" → "12 Oct 2026, 08:14" (local time). Empty or bad input → ''. */
export function dateTimeLabel(s) {
  if (!s) return '';
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s); // no zone: already local
  const d = local ? new Date(`${s.length === 16 ? `${s}:00` : s}`) : new Date(s);
  if (isNaN(d)) return '';
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}
