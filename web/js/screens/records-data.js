// Pure helpers for the Records screen. No DOM.
import { fold } from '../core/format.js';

/** Categories in the documents, sorted by name. */
export const categoriesOf = docs => [...new Set(docs.map(d => d.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Documents that match the search words (title, correspondent or text) and the category; newest first. */
export function filterDocs(docs, { query = '', category = '' } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return docs
    .filter(d => !category || d.category === category)
    .filter(d => {
      if (!words.length) return true;
      const hay = fold(`${d.title} ${d.correspondent} ${d.content}`);
      return words.every(w => hay.includes(w));
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}
