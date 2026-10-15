// Login and first setup. Not a tab: main.js shows it when nobody is logged in.
//   render(ctx, { mode: 'login' | 'setup', message }) → HTML     mounted(ctx) → focus the first field
//   forms: { login, setup } → api.login / api.setup, then ctx.onLogin(user)
// Errors show inline in a role="alert" box. main.js does not send clicks to this screen,
// so mounted() adds the listeners for the show-password buttons and the password hint.
import { esc } from '../core/format.js';
import { ICON } from '../core/ui.js';
import { busy, clearErrors, errorBox, pwField, showError as showErrorIn, togglePassword, updatePwHint } from './form-fields.js';
import { formatSetupCode, newPasswordError } from './profile-account.js';

const showError = (message, field) => showErrorIn('auth-error', message, field);

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
          ${errorBox('auth-error', 'auth-error')}
          <button class="btn primary" type="submit">${setup ? 'Create account' : 'Log in'}</button>
        </form>
      </section>
      <p class="auth-foot">${setup ? 'You can add more users later, in Profile → Settings.' : 'Forgot your password? Ask the administrator of this diary to set a new one.'}</p>
    </div>`;
  },

  mounted(ctx) {
    const root = ctx.view;
    root.querySelectorAll('[data-act="pw-show"]').forEach(btn => btn.addEventListener('click', () => togglePassword(btn)));
    const pw = root.querySelector('#au-pw[autocomplete="new-password"]');
    if (pw) pw.addEventListener('input', () => updatePwHint(pw, (root.querySelector('#au-user') || {}).value));
    const first = root.querySelector('.auth-form input');
    if (first) first.focus();
  },

  forms: {
    async login(form, e, ctx) {
      clearErrors(form);
      const username = form.username.value.trim(), password = form['au-pw'].value;
      if (!username) return showError('Enter your username.', form.username);
      if (!password) return showError('Enter your password.', form['au-pw']);
      await busy(form, async () => {
        let user;
        try { user = await ctx.api.login(username, password); } catch (err) {
          form['au-pw'].value = '';
          return showError(err.message || 'Could not log in.', form['au-pw']);
        }
        ctx.onLogin(user);
      }, 'Logging in…');
    },

    async setup(form, e, ctx) {
      clearErrors(form);
      const code = formatSetupCode(form.code.value);
      const username = form.username.value.trim();
      const pw = form['au-pw'].value, again = form['au-pw2'].value;
      if (!code) return showError('Enter the setup code from the server log.', form.code);
      if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) return showError('Use 2 to 40 letters, digits, dots, dashes or underscores for the username.', form.username);
      const err = newPasswordError(pw, again, username);
      if (err) return showError(err, err.startsWith('The two') ? form['au-pw2'] : form['au-pw']);
      form.code.value = code;
      await busy(form, async () => {
        let user;
        try { user = await ctx.api.setup(code, username, pw); } catch (x) {
          return showError(x.message || 'Could not create the account.', /setup code/i.test(x.message || '') ? form.code : null);
        }
        ctx.onLogin(user);
      }, 'Creating account…');
    },
  },
};
