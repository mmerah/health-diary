// Calendar days are local dates written 'YYYY-MM-DD'. Times are 'HH:MM'.

export const pad = n => String(n).padStart(2, '0');

export const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => iso(new Date());
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
/** Days from b to a (a − b). Rounded, so clock changes do not matter. */
export const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);
export const isValidDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(parse(s)) === s;

export const label = (s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  parse(s).toLocaleDateString('en-GB', opts);
export const longLabel = s => label(s, { weekday: 'long', day: 'numeric', month: 'long' });
export const shortLabel = s => label(s, { day: 'numeric', month: 'short' });
export const fullLabel = s => label(s, { day: 'numeric', month: 'short', year: 'numeric' });
export const weekday = s => label(s, { weekday: 'short' });

/** "Today", "Yesterday", "3 days ago", or a date for older days. */
export function relativeDay(s) {
  const n = diffDays(today(), s);
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n > 1 && n < 7) return `${n} days ago`;
  return fullLabel(s);
}

export function ageOn(dob, at) {
  const b = parse(dob), t = parse(at);
  let a = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
  return a;
}

export const nowHm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const hmToMin = s => { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + m; };
export const minToHm = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
export const isValidTime = s => s === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
