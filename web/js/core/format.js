// Text helpers for templates and reports.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape for HTML text and attribute values. Use it for EVERY value put into a template. */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

/** 425 → "7h05". */
export function duration(min) {
  if (min == null || isNaN(min)) return '–';
  const m = Math.round(min);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

export const num = (n, digits) => (n == null || isNaN(n) ? '–'
  : Number(n).toLocaleString('en-US', digits == null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }));

/** plural(1, 'cup') → "1 cup"; plural(2, 'glass', 'glasses') → "2 glasses". */
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${Number(n) === 1 ? one : many}`;

/** Text lines without empty ones. */
export const lines = s => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);

/** "a, b and c". */
export function listJoin(items) {
  const a = items.filter(Boolean);
  return a.length < 2 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
