// Form pieces shared by the login screen (auth.js) and Profile → Settings (profile-settings.js):
// password fields with a show/hide button and a live hint, inline errors, and a busy submit button.
import { esc } from '../core/format.js';
import { ICON } from '../core/ui.js';
import { MIN_PASSWORD, passwordHint } from './profile-account.js';

/**
 * A labelled password field. autocomplete 'new-password' adds minlength; hint: true adds the live
 * strength hint (call updatePwHint on input). The show/hide button has data-act="pw-show".
 */
export function pwField(id, label, autocomplete, { hint = false, name = id } = {}) {
  const fresh = autocomplete === 'new-password';
  return `<div class="field"><label class="label" for="${esc(id)}">${esc(label)}</label>
    <div class="pw-wrap"><input id="${esc(id)}" name="${esc(name)}" type="password" autocomplete="${esc(autocomplete)}" required spellcheck="false"
      ${fresh ? `minlength="${MIN_PASSWORD}"` : ''}${hint ? ` aria-describedby="${esc(id)}-hint"` : ''}>
      <button type="button" class="pw-toggle" data-act="pw-show" data-show="${esc(id)}" aria-controls="${esc(id)}" aria-pressed="false" aria-label="Show password">Show</button></div>
    ${hint ? `<p class="hint pw-hint" id="${esc(id)}-hint" data-level="empty">${esc(passwordHint('').text)}</p>` : ''}</div>`;
}

/** Show or hide the password of a pwField. btn: its data-act="pw-show" button. */
export function togglePassword(btn) {
  const input = document.getElementById(btn.dataset.show);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}

/** Updates the strength hint under a pwField that has hint: true. */
export function updatePwHint(input, username = '') {
  const el = document.getElementById(`${input.id}-hint`);
  if (!el) return;
  const h = passwordHint(input.value, username);
  el.textContent = h.text;
  el.dataset.level = h.level;
}

/** An empty inline error box. It is announced when it gets text. */
export const errorBox = (id, cls = 'field-error') => `<p class="${esc(cls)}" id="${esc(id)}" role="alert"></p>`;

/** Shows an error in an errorBox, and marks and focuses the field (optional). */
export function showError(id, message, field) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `${ICON.alert}<span>${esc(message)}</span>`;
  if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
}

/** Clears the error boxes and invalid marks of a form. */
export function clearErrors(form) {
  form.querySelectorAll('[role="alert"]').forEach(x => { x.innerHTML = ''; });
  form.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
}

/** Runs fn with the submit button disabled (and an optional busy label). */
export async function busy(form, fn, label) {
  const btn = form.querySelector('[type="submit"]');
  const text = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; if (label) btn.textContent = label; }
  try { return await fn(); } finally {
    if (btn && btn.isConnected) { btn.disabled = false; if (label) btn.innerHTML = text; }
  }
}
