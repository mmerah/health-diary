// Profile tab, two views chosen at the top and remembered on this device:
//   "My health" (profile-health.js) and "Settings" (profile-settings.js).
// ctx.go('profile', { view: 'settings' }) opens a view directly.
import { esc } from '../core/format.js';
import { store } from '../core/ui.js';
import { flushProfile, healthActions, healthInput, healthView, loadProfile } from './profile-health.js';
import { loadSettings, settingsActions, settingsForms, settingsInput, settingsView } from './profile-settings.js';

const VIEWS = [['health', 'My health'], ['settings', 'Settings']];
let focusView = false;
const viewOf = v => (VIEWS.some(x => x[0] === v) ? v : 'health');

async function viewHtml(ctx, view) {
  if (view === 'settings') { await loadSettings(ctx); return settingsView(ctx); }
  await loadProfile(ctx);
  return healthView(ctx);
}

export default {
  async render(ctx, params = {}) {
    const view = viewOf(params.view || store.get('profile-view', 'health'));
    store.set('profile-view', view);
    const html = await viewHtml(ctx, view);
    return `<div class="screen-head"><h1 class="screen-title">Profile</h1></div>
      <div class="seg profile-views" role="group" aria-label="Profile view">${VIEWS.map(([v, l]) =>
    `<button type="button" data-act="view" data-value="${v}" aria-pressed="${v === view}">${esc(l)}</button>`).join('')}</div>
      <div id="profile-content" class="profile-content">${html}</div>`;
  },

  mounted() {
    // After a switch with the control, keep the focus on it.
    if (focusView) document.querySelector('.profile-views [aria-pressed="true"]')?.focus();
    focusView = false;
  },

  leave() { return flushProfile(); },

  actions: {
    async view(el, e, ctx) {
      if (el.getAttribute('aria-pressed') === 'true') return;
      const view = viewOf(el.dataset.value);
      store.set('profile-view', view);
      focusView = true;
      await ctx.go('profile', { view }); // the address becomes #profile or #profile/settings
    },
    ...healthActions,
    ...settingsActions,
  },

  forms: { ...settingsForms },

  input(el, e, ctx) {
    if (healthInput(el)) return;
    settingsInput(el, e, ctx);
  },
};
