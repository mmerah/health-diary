// Login and first setup. Not a tab: main.js shows it when nobody is logged in.
//   render(ctx, { mode: 'login' | 'setup', message }) → HTML     mounted(ctx) → focus the first field
//   forms: { login, setup } → api.login / api.setup, then ctx.onLogin(user)
// Errors show inline in a role="alert" box. main.js does not send clicks to this screen,
// so mounted() adds the listeners for the show-password buttons and the password hint.
import { esc } from '../core/format.js';
import { ICON } from '../core/ui.js';
import { formatSetupCode, MIN_PASSWORD, newPasswordError, passwordHint } from './profile-account.js';

function pwField(id, label, autocomplete, { hint = false } = {}) {
  return `<div class="field"><label class="label" for="${id}">${esc(label)}</label>
    <div class="pw-wrap"><input id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" required
      ${autocomplete === 'new-password' ? `minlength="${MIN_PASSWORD}"` : ''}${hint ? ` aria-describedby="${id}-hint"` : ''}>
      <button type="button" class="pw-toggle" data-show="${id}" aria-controls="${id}" aria-pressed="false" aria-label="Show password">Show</button></div>
    ${hint ? `<p class="hint pw-hint" id="${id}-hint" data-level="empty">${esc(passwordHint('').text)}</p>` : ''}</div>`;
}

const errorBox = message => `<div class="auth-error" id="auth-error" role="alert">${message ? `${ICON.alert}<span>${esc(message)}</span>` : ''}</div>`;

function showError(message, field) {
  const box = document.getElementById('auth-error');
  if (box) box.innerHTML = `${ICON.alert}<span>${esc(message)}</span>`;
  if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
}

function clearError(form) {
  const box = document.getElementById('auth-error');
  if (box) box.innerHTML = '';
  form.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
}

async function busy(form, label, fn) {
  const btn = form.querySelector('[type="submit"]');
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = text; } }
}

export default {
  render(ctx, { mode = 'login', message = '' } = {}) {
    const setup = mode === 'setup';
    const head = setup
      ? `<h1 id="auth-title">Welcome to Health Diary</h1><p>Create the first account. It becomes the administrator of this diary.</p>`
      : `<h1 id="auth-title">Log in</h1><p>Your health diary is private. Log in to continue.</p>`;
    const fields = setup
      ? `<div class="field"><label class="label" for="au-code">Setup code</label>
          <input id="au-code" name="code" type="text" class="code-input" autocomplete="off" autocapitalize="characters" spellcheck="false" required
            placeholder="ABCD-EFGH-…" aria-describedby="au-code-hint">
          <p class="hint" id="au-code-hint">The code is in the server log. Run <span class="tag">docker logs health-diary</span> on the server.</p></div>
        <div class="field"><label class="label" for="au-user">Username</label>
          <input id="au-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="40"
            aria-describedby="au-user-hint">
          <p class="hint" id="au-user-hint">Letters, digits, dots, dashes or underscores.</p></div>
        ${pwField('au-pw', 'Password', 'new-password', { hint: true })}
        ${pwField('au-pw2', 'Password again', 'new-password')}`
      : `<div class="field"><label class="label" for="au-user">Username</label>
          <input id="au-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
        ${pwField('au-pw', 'Password', 'current-password')}`;
    // A message from the app (logged out, session ended) is information, not an error.
    const info = message ? `<div class="notice" role="status">${ICON.info}<div><p>${esc(message)}</p></div></div>` : '';
    return `<div class="auth">
      <section class="card auth-card" aria-labelledby="auth-title">
        <div class="auth-head"><img src="icon.png" alt="" width="64" height="64">${head}</div>
        ${info}
        <form class="auth-form" data-form="${setup ? 'setup' : 'login'}" novalidate>
          ${fields}
          ${errorBox('')}
          <button class="btn primary" type="submit">${setup ? 'Create account' : 'Log in'}</button>
        </form>
      </section>
      <p class="auth-foot">${setup ? 'You can add more users later, in Profile → Settings.' : 'Forgot your password? Ask the administrator of this diary to set a new one.'}</p>
    </div>`;
  },

  mounted(ctx) {
    const root = ctx.view;
    root.querySelectorAll('[data-show]').forEach(btn => btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.show);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    }));
    const pw = root.querySelector('#au-pw[autocomplete="new-password"]');
    if (pw) {
      pw.addEventListener('input', () => {
        const h = passwordHint(pw.value, (root.querySelector('#au-user') || {}).value);
        const el = document.getElementById('au-pw-hint');
        el.textContent = h.text;
        el.dataset.level = h.level;
      });
    }
    const first = root.querySelector('.auth-form input');
    if (first) first.focus();
  },

  forms: {
    async login(form, e, ctx) {
      clearError(form);
      const username = form.username.value.trim(), password = form['au-pw'].value;
      if (!username) return showError('Enter your username.', form.username);
      if (!password) return showError('Enter your password.', form['au-pw']);
      await busy(form, 'Logging in…', async () => {
        let user;
        try { user = await ctx.api.login(username, password); } catch (err) {
          form['au-pw'].value = '';
          return showError(err.message || 'Could not log in.', form['au-pw']);
        }
        ctx.onLogin(user);
      });
    },

    async setup(form, e, ctx) {
      clearError(form);
      const code = formatSetupCode(form.code.value);
      const username = form.username.value.trim();
      const pw = form['au-pw'].value, again = form['au-pw2'].value;
      if (!code) return showError('Enter the setup code from the server log.', form.code);
      if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) return showError('Use 2 to 40 letters, digits, dots, dashes or underscores for the username.', form.username);
      const err = newPasswordError(pw, again, username);
      if (err) return showError(err, err.startsWith('The two') ? form['au-pw2'] : form['au-pw']);
      form.code.value = code;
      await busy(form, 'Creating account…', async () => {
        let user;
        try { user = await ctx.api.setup(code, username, pw); } catch (x) {
          return showError(x.message || 'Could not create the account.', /setup code/i.test(x.message || '') ? form.code : null);
        }
        ctx.onLogin(user);
      });
    },
  },
};
