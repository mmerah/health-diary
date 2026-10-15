// Shared UI pieces: toast, save indicator, two-tap confirm, copy, bottom sheet, icons, local storage.
import { esc } from './format.js';

// ---------- Per-device storage: UI preferences, plus edits that are not saved yet
// (see autosave.js). clearLocalData() removes it all at logout.

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`hd-ui-${key}`); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`hd-ui-${key}`, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
  },
};

/** At logout: remove this user's unsaved edits and the device's UI preferences.
    Unsaved edits of other users on this device (keys ending in -<their id>) stay. */
export function clearLocalData(uid) {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('hd-ui-') && (!k.startsWith('hd-ui-pending-') || k.endsWith(`-${uid}`)))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { /* storage blocked */ }
}

/** debounce(fn, ms) with .flush() (run now if pending) and .cancel(). */
export function debounce(fn, ms) {
  let timer = null, args = null;
  const run = () => { timer = null; const a = args; args = null; return fn(...a); };
  const d = (...a) => { args = a; clearTimeout(timer); timer = setTimeout(run, ms); };
  d.flush = () => { if (timer) { clearTimeout(timer); return run(); } return undefined; };
  d.cancel = () => { clearTimeout(timer); timer = null; args = null; };
  return d;
}

// ---------- Toast: short confirmations, errors, and "Undo"

let toastTimer;
/**
 * toast('Weight saved')
 * toast('Symptom removed', { action: { label: 'Undo', run: () => … } })
 * toast('Could not save. …', { tone: 'error' })
 */
export function toast(message, { action, tone, ms } = {}) {
  const el = document.getElementById('toast');
  el.className = `toast${tone === 'error' ? ' is-error' : ''}`;
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms || (action ? 5000 : tone === 'error' ? 6000 : 2200));
}

// ---------- Save indicator in the top bar

let saveTimer;
/** state: 'saving' | 'saved' | 'error' | 'offline' | '' */
export function setSaveState(state, { retry } = {}) {
  const el = document.getElementById('save-status');
  clearTimeout(saveTimer);
  el.dataset.state = state;
  const text = { saving: 'Saving…', saved: 'Saved', error: 'Not saved', offline: 'Offline · will retry' }[state] || '';
  el.innerHTML = state === 'saved' ? `${ICON.check}<span>${text}</span>`
    : state === 'error' || state === 'offline' ? `${ICON.alert}<span>${text}</span>${retry ? '<button type="button">Retry</button>' : ''}`
      : `<span>${text}</span>`;
  if (retry) el.querySelector('button').onclick = retry;
  // Screen readers hear the result, not every "Saving…".
  el.setAttribute('aria-live', state === 'saving' ? 'off' : 'polite');
  if (state === 'saved') saveTimer = setTimeout(() => { el.dataset.state = ''; el.innerHTML = ''; }, 2500);
}

// ---------- Two-tap confirmation for destructive buttons

/**
 * First tap arms the button and changes its label; a second tap within 4 s returns true.
 * if (!confirmTwice(btn, 'Delete user and all data?')) return;
 */
export function confirmTwice(btn, armedLabel) {
  if (btn.dataset.armed === '1') return true;
  const original = btn.innerHTML;
  btn.dataset.armed = '1';
  btn.classList.add('is-armed');
  btn.textContent = armedLabel;
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.dataset.armed = '';
    btn.classList.remove('is-armed');
    btn.innerHTML = original;
  }, 4000);
  return false;
}

// ---------- Copy to clipboard, with a fallback that selects the text

export async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    if (fallbackEl) {
      const range = document.createRange();
      range.selectNodeContents(fallbackEl);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
    return false;
  }
}

// ---------- Bottom sheet (a dialog that slides up on phones, centered on desktop)

let sheetCleanup = null;
/**
 * openSheet({ title, html, onAction(act, el, event), onSubmit(form, event), onInput(el, event) })
 * Returns the sheet body element. Closes on Escape, backdrop tap, or closeSheet().
 */
export function openSheet({ title, html, onAction, onSubmit, onInput, onClose }) {
  closeSheet();
  const root = document.getElementById('sheet-root');
  const opener = document.activeElement;
  root.innerHTML = `
    <div class="sheet-backdrop" data-sheet-close></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div class="sheet-head">
        <h2 id="sheet-title">${esc(title)}</h2>
        <button type="button" class="icon-btn" data-sheet-close aria-label="Close">${ICON.x}</button>
      </div>
      <div class="sheet-body">${html}</div>
    </div>`;
  const sheet = root.querySelector('.sheet');
  const body = root.querySelector('.sheet-body');
  document.body.classList.add('has-sheet');

  const onClick = e => {
    if (e.target.closest('[data-sheet-close]')) return closeSheet();
    const b = e.target.closest('[data-act]');
    if (b && onAction && b.tagName !== 'INPUT') onAction(b.dataset.act, b, e);
  };
  const onKey = e => {
    if (e.key === 'Escape') closeSheet();
    if (e.key === 'Tab') { // keep focus inside the sheet
      const f = [...sheet.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  const submit = e => { e.preventDefault(); if (onSubmit) onSubmit(e.target, e); };
  const input = e => { if (onInput) onInput(e.target, e); };
  root.addEventListener('click', onClick);
  root.addEventListener('submit', submit);
  root.addEventListener('input', input);
  document.addEventListener('keydown', onKey);
  sheetCleanup = () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', submit);
    root.removeEventListener('input', input);
    document.removeEventListener('keydown', onKey);
    root.innerHTML = '';
    document.body.classList.remove('has-sheet');
    if (onClose) onClose();
    if (opener && opener.isConnected) opener.focus();
  };
  (body.querySelector('[autofocus]') || body.querySelector('button, input, select, textarea') || sheet).focus();
  return body;
}

export function closeSheet() {
  if (sheetCleanup) { const c = sheetCleanup; sheetCleanup = null; c(); }
}

// ---------- Icons (24px grid, stroke). Decorative: aria-hidden.

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${d}</svg>`;

export const ICON = {
  left: svg('<path d="M15 18l-6-6 6-6"/>'),
  right: svg('<path d="M9 18l6-6-6-6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  x: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  share: svg('<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
  print: svg('<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>'),
  download: svg('<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>'),
  alert: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>'),
  sync: svg('<path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/>'),
  calendar: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  meal: svg('<path d="M6 3v8a2 2 0 0 0 2 2v8M10 3v8a2 2 0 0 1-2 2M8 3v7"/><path d="M17 21V3c-2 1-3 4-3 7h3"/>'),
  snack: svg('<path d="M12 7c-3-3-8-1-8 4 0 5 4 10 8 10s8-5 8-10c0-5-5-7-8-4z"/><path d="M12 7c0-2 1-4 3-4"/>'),
  drink: svg('<path d="M6 3h12l-1.5 17a1.5 1.5 0 0 1-1.5 1.4H9a1.5 1.5 0 0 1-1.5-1.4z"/><path d="M6.5 8h11"/>'),
  pill: svg('<rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-45 12 12)"/><path d="M9.5 9.5l5 5"/>'),
  symptom: svg('<path d="M3 12h4l2-5 3 10 2.5-7 1.5 2h5"/>'),
  scale: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 9.5a5.5 5.5 0 0 1 8 0M12 9.5l1.5-2"/>'),
  heart: svg('<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.5 4.5 4.5 0 0 1 19.5 10C19.5 15.4 12 20 12 20z"/>'),
  thermo: svg('<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>'),
  note: svg('<path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 16h5"/>'),
  moon: svg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'),
  steps: svg('<path d="M8 20c-2 0-3-1.5-3-3.5S6 13 8 13s2.5 2 2 3.5S10 20 8 20zM16 11c-2 0-3-1.5-3-3.5S14 4 16 4s2.5 2 2 3.5S18 11 16 11z"/>'),
  activity: svg('<circle cx="13" cy="4.5" r="1.8"/><path d="M7 21l3-6 3 2v5M10 15l1.5-6L16 12l3 1M11.5 9L8 10.5 6.5 14"/>'),
  doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  'theme-auto': svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>'),
  'theme-light': svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
  'theme-dark': svg('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'),
};
