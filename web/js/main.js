// App shell: start-up and login, the five tabs, the theme, the quick-add button, and event dispatch.
//
// Every screen module (js/screens/*.js) exports an object:
//   render(ctx, params) → HTML string (async allowed)   mounted(ctx)   leave(ctx) → Promise (save pending edits)
//   actions: { name(el, event, ctx) }   for [data-act="name"] clicks inside the screen
//   forms:   { name(form, event, ctx) } for <form data-form="name"> submits (preventDefault is done)
//   input(el, event, ctx)               for input and change events inside the screen
import { api } from './api/index.js';
import { flushAll, resumeAll } from './core/autosave.js';
import { esc } from './core/format.js';
import { getCatalog, mergeCatalog, setCatalog } from './core/schema.js';
import { session } from './core/session.js';
import { clearLocalData, closeSheet, ICON, setSaveState, store, toast } from './core/ui.js';
import auth from './screens/auth.js';
import body from './screens/body.js';
import profile from './screens/profile.js';
import records from './screens/records.js';
import report from './screens/report.js';
import today from './screens/today.js';

const SCREENS = { today, body, records, report, profile };
const TABS = Object.keys(SCREENS);
const view = document.getElementById('view');

let catalogVersion = 0; // version of the user's catalog on the server (see saveCatalog)

const ctx = {
  api,
  view,
  user: null,
  screen: null, // the screen object on display
  tab: null,
  params: {},
  /** Go to a tab. params are passed to render (for example { date }). */
  go: (tab, params) => navigate(tab, params),
  /** Draw the current screen again with the same params. */
  refresh: () => navigate(ctx.tab, ctx.params, { keepScroll: true, history: 'replace' }),
  /** Opens the quick-add sheet. preset: 'meal' | 'symptom' | 'weight' | … */
  quickAdd: preset => import('./screens/quickadd.js').then(m => m.openQuickAdd(ctx, preset)),
  logout,
  onLogin,
  /** Saves the user's own symptoms, types, measurements and counters, and uses them at once.
      When another device saved in between, both changes are merged (my change wins on the same item). */
  async saveCatalog(catalog) {
    const base = getCatalog();
    let res;
    try {
      res = await api.saveCatalog(catalog, catalogVersion);
    } catch (e) {
      if (e.status !== 409 || !e.data) throw e;
      const merged = mergeCatalog(base, catalog, e.data.catalog);
      res = await api.saveCatalog(merged, e.data.version);
      toast('Merged with changes from another device.');
    }
    catalogVersion = res.version;
    setCatalog(res.catalog);
  },
};

// ---------- Navigation and addresses
// Each screen has an address, so the browser back button and the back gesture work:
//   #today  #today/2026-10-07  #trends  #records  #report  #profile  #profile/settings

const SLUG = { body: 'trends' };           // tab id → address word
const TAB_OF = { trends: 'body', body: 'body' }; // address word → tab id (#body still works)

export function routeOf(hash) {
  const [word, arg] = String(hash || '').replace(/^#/, '').split('/');
  const tab = TAB_OF[word] || (SCREENS[word] ? word : null);
  if (!tab) return null;
  if (tab === 'today' && /^\d{4}-\d{2}-\d{2}$/.test(arg || '')) return { tab, params: { date: arg } };
  if (tab === 'profile' && arg === 'settings') return { tab, params: { view: 'settings' } };
  return { tab, params: {} };
}

function hashOf(tab, params) {
  let h = SLUG[tab] || tab;
  if (tab === 'today' && params.date) h += `/${params.date}`;
  if (tab === 'profile' && params.view === 'settings') h += '/settings';
  return `#${h}`;
}

let renderSeq = 0;

/** history: 'push' (a new step for the back button), 'replace', or 'none' (we came from the back button). */
async function navigate(tab, params = {}, { keepScroll = false, history: mode = 'push' } = {}) {
  if (!SCREENS[tab]) tab = 'today';
  closeSheet();
  // Save pending edits of the screen we leave. A failed save stays queued (see autosave.js).
  if (ctx.screen && ctx.screen.leave) await ctx.screen.leave(ctx).catch(() => {});
  const seq = ++renderSeq;
  const scrollY = window.scrollY;
  ctx.tab = tab;
  ctx.params = params;
  ctx.screen = SCREENS[tab];
  store.set('tab', tab);
  const hash = hashOf(tab, params);
  if (mode !== 'none' && location.hash !== hash) {
    if (mode === 'push') history.pushState(null, '', hash); else history.replaceState(null, '', hash);
  }
  document.querySelectorAll('.tabbar [data-tab]').forEach(b => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.getElementById('fab').hidden = !['today', 'body'].includes(tab);
  try {
    const html = await ctx.screen.render(ctx, params);
    if (seq !== renderSeq) return; // a newer navigation started while this one loaded
    view.innerHTML = html;
    if (ctx.screen.mounted) ctx.screen.mounted(ctx);
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error(e);
    view.innerHTML = `<div class="notice is-error" role="alert">${ICON.alert}<div><strong>This screen could not load.</strong><p>${esc(e.message)}</p>
      <button class="btn" type="button" data-shell="retry">Try again</button></div></div>`;
  }
  if (!keepScroll) window.scrollTo(0, 0); else window.scrollTo(0, scrollY);
}

document.querySelector('.tabbar').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  // "Today" always means today, also when you are on another day.
  navigate(b.dataset.tab, b.dataset.tab === 'today' ? { date: null } : {});
});
document.getElementById('fab').addEventListener('click', () => ctx.quickAdd());
window.addEventListener('popstate', () => {
  if (!ctx.user) return;
  const r = routeOf(location.hash) || { tab: 'today', params: {} };
  navigate(r.tab, r.params, { history: 'none' });
});

// ---------- Event dispatch to the current screen

view.addEventListener('click', e => {
  if (e.target.closest('[data-shell="retry"]')) return ctx.refresh();
  if (e.target.closest('[data-shell="reload"]')) return location.reload();
  const el = e.target.closest('[data-act]');
  if (!el || !ctx.screen || !view.contains(el)) return;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return; // handled as input
  const fn = ctx.screen.actions && ctx.screen.actions[el.dataset.act];
  if (fn) { e.preventDefault(); run(() => fn(el, e, ctx)); }
});
view.addEventListener('submit', e => {
  const form = e.target.closest('form[data-form]');
  if (!form || !ctx.screen) return;
  e.preventDefault();
  const fn = ctx.screen.forms && ctx.screen.forms[form.dataset.form];
  if (fn) run(() => fn(form, e, ctx));
});
for (const type of ['input', 'change']) {
  view.addEventListener(type, e => {
    // Text fields send 'input'; checkboxes, selects, dates and files are handled on 'change' only.
    const t = e.target;
    const changeOnly = t.type === 'checkbox' || t.type === 'radio' || t.type === 'file' || t.tagName === 'SELECT';
    if ((type === 'input') === changeOnly) return;
    if (ctx.screen && ctx.screen.input) run(() => ctx.screen.input(t, e, ctx));
  });
}

/** Runs a handler and shows its error. Handlers throw to report failure; they never fail silently. */
async function run(fn) {
  try { await fn(); } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong.', { tone: 'error' });
  }
}

// ---------- Theme: auto (follows the device), light or dark. Saved per device.

const THEMES = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];
export const getTheme = () => { try { return localStorage.getItem('hd-theme') || 'auto'; } catch (e) { return 'auto'; } };

export function setTheme(t) {
  try { localStorage.setItem('hd-theme', t); } catch (e) { /* storage blocked */ }
  window.applyTheme(t); // theme.js: sets data-theme and the browser bar color
  drawThemeButton();
  document.querySelectorAll('[data-act="theme"]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.value === t)));
}
ctx.themes = THEMES;
ctx.getTheme = getTheme;
ctx.setTheme = setTheme;

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
/** The theme the user sees now: 'light' or 'dark'. */
const shownTheme = () => { const t = getTheme(); return t === 'auto' ? (systemDark() ? 'dark' : 'light') : t; };

function drawThemeButton() {
  const t = getTheme(), next = shownTheme() === 'dark' ? 'light' : 'dark';
  const btn = document.getElementById('theme-btn');
  btn.innerHTML = ICON[`theme-${t}`];
  btn.setAttribute('aria-label', `Switch to ${next} theme`);
  btn.title = t === 'auto' ? `Theme: Auto (${shownTheme()}). Tap for ${next}.` : `Theme: ${t}. Tap for ${next}.`;
}
// One tap always changes what you see: light ↔ dark. "Auto" (follow the device) is in Profile → Settings.
document.getElementById('theme-btn').addEventListener('click', () => {
  const next = shownTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  toast(`${next === 'dark' ? 'Dark' : 'Light'} theme. Choose Auto in Profile → Settings.`);
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawThemeButton);

// ---------- Login, logout, start-up

function showAuth(mode, message) {
  closeSheet();
  ctx.screen = null;
  ctx.tab = null;
  document.body.classList.add('is-auth');
  view.innerHTML = auth.render(ctx, { mode, message });
  auth.mounted(ctx);
}

async function onLogin(user) {
  ctx.user = user;
  session.set(user);
  // The user's own items. Without them the app still works with the built-in ones.
  const catalog = await api.getCatalog().catch(() => null);
  catalogVersion = catalog ? catalog.version || 0 : 0;
  setCatalog(catalog);
  resumeAll(); // edits this user made earlier on this device and that were not saved yet
  document.body.classList.remove('is-auth');
  const r = routeOf(location.hash);
  if (r) navigate(r.tab, r.params, { history: 'replace' });
  else navigate(store.get('tab', 'today'), {}, { history: 'replace' });
  if (user.notice) {
    toast(user.notice, { ms: 15000, action: { label: 'OK', run: () => api.dismissNotice().catch(() => {}) } });
  }
}

// After logout or the end of a session the page reloads. That empties every in-memory cache,
// so nothing of one user is left for the next user of the same device.
const ENDED = 'hd-session-ended';

/** logout() for the Log out button. After the account was deleted: logout(message, { deleted: true }). */
async function logout(message = 'You are logged out.', { deleted = false } = {}) {
  if (!deleted && !(await flushAll())) {
    throw new Error('Some changes are not saved yet. Connect to the server, wait for "Saved", then log out.');
  }
  try {
    if (!deleted) await api.logout(); // a deleted account has no session left
  } catch (e) {
    // Offline: the session cookie would stay valid, so do not pretend the logout worked.
    throw new Error(`You are not logged out: ${e.message}`);
  }
  clearLocalData(session.uid);
  sessionStorage.setItem(ENDED, message);
  location.reload();
}

window.addEventListener('diary:logged-out', () => {
  if (!ctx.user) return;
  ctx.user = null;
  // Unsaved edits stay in this browser for this user only, and are sent after the next login.
  session.set(null);
  setSaveState('');
  sessionStorage.setItem(ENDED, 'Your session has ended. Please log in again.');
  location.reload();
});

async function boot() {
  drawThemeButton();
  if (api.isDemo) document.getElementById('demo-badge').hidden = false;
  try {
    const s = await api.authStatus();
    const message = sessionStorage.getItem(ENDED);
    sessionStorage.removeItem(ENDED);
    if (s.user) onLogin(s.user);
    else showAuth(s.setupNeeded ? 'setup' : 'login', message || undefined);
  } catch (e) {
    view.innerHTML = `<div class="notice is-error" role="alert">${ICON.alert}<div><strong>Cannot reach the server.</strong><p>${esc(e.message)}</p>
      <button class="btn" type="button" data-shell="reload">Try again</button></div></div>`;
  }
}

// Auth screen events go to the auth module (it is not one of the tabs).
view.addEventListener('submit', e => {
  if (ctx.screen || !document.body.classList.contains('is-auth')) return;
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = auth.forms[form.dataset.form];
  if (fn) run(() => fn(form, e, ctx));
});

boot();
