// Pure helpers for the Records screen. No DOM. Unit-tested in tests/profile.test.js (records part).
import { fold } from '../core/format.js';

export const MAX_UPLOAD_MB = 25;
export const MAX_PAGES = 50;

/** Categories in the documents, sorted by name. */
export const categoriesOf = docs => [...new Set(docs.map(d => d.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** The sources present: ['diary'], ['paperless'] or both. Documents without a source come from Paperless. */
export const sourcesOf = docs => [...new Set(docs.map(d => d.source || 'paperless'))].sort();

/**
 * Documents that match the search words (title, correspondent or text), the category and the source;
 * newest first (date, then time added).
 */
export function filterDocs(docs, { query = '', category = '', source = '' } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return docs
    .filter(d => !category || (category === NO_TYPE ? !d.category : d.category === category))
    .filter(d => !source || (d.source || 'paperless') === source)
    .filter(d => {
      if (!words.length) return true;
      const hay = fold(`${d.title} ${d.correspondent} ${d.content}`);
      return words.every(w => hay.includes(w));
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
      || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** Category filter value for documents without a type. */
export const NO_TYPE = '__none__';

/**
 * Suggestions read from the text to check: [{ key, value }] in the order category, date, title.
 * A field is offered when the suggestion differs from the value and the user has not set that field
 * (doc.edited lists the fields set by the user; Paperless documents have it).
 */
export function suggestionDiff(doc) {
  const s = doc && (!doc.status || doc.status === 'ready') && doc.suggested;
  if (!s) return [];
  const edited = new Set(doc.edited || []);
  return ['category', 'date', 'title']
    .filter(k => s[k] && String(s[k]) !== String(doc[k] || '') && !edited.has(k))
    .map(k => ({ key: k, value: s[k] }));
}

/** Only the fields that change: { date, title, category } → the ones that differ from doc. */
export function changedFields(doc, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (String(v ?? '') !== String(doc[k] ?? '')) out[k] = v;
  return out;
}

/** Number of documents without a type (ready ones only: the others may still get one). */
export const untypedCount = docs => docs.filter(d => !d.category && (!d.status || d.status === 'ready')).length;

/** Excluded ids are numbers (Paperless) or strings (diary): compare as strings, save in the original form. */
export const excludedSet = list => new Set((list || []).map(String));
export const excludedList = set => [...set].map(id => (/^\d+$/.test(id) ? Number(id) : id));

/** Checks a file before upload. Returns '' or an error in plain words. */
export function uploadError(file) {
  if (!file) return 'Choose a file first.';
  const okType = file.type === 'application/pdf' || /^image\//.test(file.type) || /\.(pdf|jpe?g|png|heic|heif|webp)$/i.test(file.name || '');
  if (!okType) return 'Choose a PDF or a photo.';
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `This file is too large. The limit is ${MAX_UPLOAD_MB} MB.`;
  if (!file.size) return 'This file is empty.';
  return '';
}
