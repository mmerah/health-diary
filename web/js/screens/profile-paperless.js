// Pure helpers for the Paperless tags (Profile → Settings, Records). No DOM. Tested in tests/profile.test.js.
import { fold, listJoin } from '../core/format.js';

export const DEFAULT_TAGS = ['medical'];
export const TAG_SEARCH_FROM = 13; // a search box when there are more than 12 tags

/** The tags in use: the saved ones, or the default. */
export function tagsOf(cfg) {
  const list = cfg && Array.isArray(cfg.tags) ? cfg.tags : [];
  const clean = [...new Set(list.map(t => String(t).trim()).filter(Boolean))];
  return clean.length ? clean : [...DEFAULT_TAGS];
}

/** "tag medical" or "tags medical and health". */
export const tagsText = tags => `${tags.length === 1 ? 'tag' : 'tags'} ${listJoin(tags)}`;

/**
 * Rows for the checkbox list: the user's Paperless tags with their counts, ticked when included,
 * filtered by the search words, sorted by name.
 */
export function tagRows(available, selected, query = '') {
  const on = new Set(selected);
  const words = fold(query).split(/\s+/).filter(Boolean);
  return (available || [])
    .filter(t => t && t.name && words.every(w => fold(t.name).includes(w)))
    .map(t => ({ name: t.name, count: Number(t.documentCount) || 0, checked: on.has(t.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** The selection after ticking (on) or unticking a tag. Keeps the order; never adds twice. */
export function toggleTag(selected, name, on) {
  const rest = selected.filter(t => t !== name);
  return on ? [...rest, name] : rest;
}
