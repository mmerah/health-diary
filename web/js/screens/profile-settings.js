// Profile → "Settings": Apple Health sync, Paperless, display, account, users (administrators), demo.
// Forms show their errors inline (role="alert"); buttons throw so the shell shows the error.
import { esc, num, plural } from '../core/format.js';
import { fullLabel, isValidDate } from '../core/dates.js';
import { confirmTwice, copyText, ICON, toast } from '../core/ui.js';
import { busy, clearErrors, errorBox, pwField, showError, togglePassword, updatePwHint } from './form-fields.js';
import { dateTimeLabel, newPasswordError } from './profile-account.js';
import { listsCard } from './profile-lists.js';
import { DEFAULT_TAGS, TAG_SEARCH_FROM, tagRows, tagsOf, tagsText, toggleTag } from './profile-paperless.js';

const DOCS_URL = 'https://github.com/mmerah/health-diary/blob/main/docs/shortcut.md';
let S = null; // { settings, paperless, users }
let T = null; // Paperless tags: { list: [{ name, documentCount }] | null, error, query }

/** Loads what the Settings view needs. Parts the server cannot give are null. */
export async function loadSettings(ctx) {
  const { api, user } = ctx;
  const [settings, paperless, users, about] = await Promise.all([
    api.getSettings(),
    api.can.paperless && !api.isDemo ? api.getPaperless() : null,
    api.can.accounts && user && user.isAdmin ? api.listUsers() : null,
    api.about().catch(() => null),
  ]);
  S = { settings: settings || {}, paperless, users, about };
  return S;
}

// ---------- Small pieces

const card = (id, title, body, extra = '') => `<section class="card form-card settings-card${extra}" id="${id}" aria-labelledby="${id}-title">
  <h2 id="${id}-title">${esc(title)}</h2>${body}</section>`;
const why = text => `<p class="hint why">${ICON.info}<span>${esc(text)}</span></p>`;

function lastSyncText(s) {
  if (!s) return 'No data yet';
  const day = String(s).slice(0, 10), time = String(s).slice(11, 16);
  return isValidDate(day) ? `${fullLabel(day)}${time ? `, ${time}` : ''}` : String(s);
}

// ---------- Cards

function demoCard() {
  return card('set-demo', 'Demo', `
    <p>This is a demo with sample data. It stays in this browser only.</p>
    <p class="hint"><strong>Do not enter real health data here.</strong> To keep a real diary, install Health Diary on your own server.</p>
    <div class="btn-row"><button type="button" class="btn" data-act="demo-reset">Reset sample data</button></div>`, ' is-demo');
}

export function keySection(user, newKey = '') {
  const on = !!user.hasIngestToken;
  const used = dateTimeLabel(user.ingestLastUsed);
  return `<div class="key-status">
      <span class="label">Shortcut key</span>
      <p>${on ? `<span class="pill ok">${ICON.check}On</span> ${used ? `Last used ${esc(used)}` : 'Not used yet'}` : '<span class="pill">Off</span> The shortcut cannot send data.'}</p>
    </div>
    ${newKey ? `<div class="secret-box" role="status">
      <p><strong>Your new key.</strong> Put it in the shortcut now. You see it only once.</p>
      <code id="new-key" class="secret">${esc(newKey)}</code>
      <div class="btn-row"><button type="button" class="btn small" data-act="copy-key">${ICON.copy}Copy key</button></div>
    </div>` : ''}
    <div class="btn-row">
      ${on ? `<button type="button" class="btn small" data-act="key-new" data-replace="1">Replace key</button>
        <button type="button" class="btn small danger" data-act="key-off">Turn off</button>`
    : '<button type="button" class="btn small primary" data-act="key-new">Create key</button>'}
    </div>`;
}

function appleCard(ctx) {
  const { api, user } = ctx;
  const addr = `${location.origin}/api/ingest/health`;
  const shortcut = api.isDemo
    ? why('The shortcut key needs your own server. The demo uses sample data.')
    : `<div class="field"><span class="label">Shortcut address</span>
        <div class="copy-row"><code class="tag" id="ingest-url">${esc(addr)}</code>
        <button type="button" class="btn small" data-act="copy-url" aria-label="Copy shortcut address">${ICON.copy}Copy</button></div></div>
      <div id="key-section" class="stack">${keySection(user)}</div>
      <p><a href="${DOCS_URL}" target="_blank" rel="noopener noreferrer">How to set up the shortcut<span class="sr-only"> (opens in a new tab)</span></a></p>`;
  const imp = api.can.import
    ? `<form class="stack" data-form="import">
        <div class="field"><label class="label" for="imp-file">Apple Health export file</label>
          <input type="file" id="imp-file" name="file" accept=".zip,.xml" required aria-describedby="imp-hint"></div>
        <div class="btn-row"><button type="submit" class="btn">Import</button></div>
        <p class="hint" id="imp-status" aria-live="polite"></p>
      </form>`
    : why('Import needs your own server. The demo cannot read files.');
  return card('set-apple', 'Apple Health sync', `
    <p>Last data received: <strong>${esc(lastSyncText(S.settings.lastSync))}</strong></p>
    <p class="hint">The “Health Diary” shortcut on your iPhone reads Apple Health and sends the data to your diary.</p>
    ${shortcut}
    <hr class="divider">
    <h3>Import your history</h3>
    <p class="hint" id="imp-hint">On your iPhone, open the Health app. Tap your picture, then <strong>Export All Health Data</strong>. Choose the export.zip file here. The import fills only empty days. It does not change data you already have.</p>
    ${imp}`);
}

/** The tag list of the Paperless card: loading, error, or checkboxes with document counts. */
function tagsHtml() {
  const pl = S.paperless;
  const tags = tagsOf(pl);
  if (!pl.hasToken) {
    return `<p class="hint">Your Paperless tags appear here after you save the token. Until then, the diary uses the ${esc(tagsText(tags))}.</p>`;
  }
  const missing = (pl.missingTags || []).map(t => `<li><span class="grow">Not found in Paperless: <strong>${esc(t)}</strong>.</span>
      <button type="button" class="btn small" data-act="pl-tag-remove" data-name="${esc(t)}">Remove it</button></li>`).join('');
  const missingHtml = missing ? `<div class="notice is-caution pl-missing">${ICON.alert}<div><ul class="rows">${missing}</ul></div></div>` : '';
  if (!T || (!T.list && !T.error)) return `${missingHtml}<p class="hint" role="status">Loading your Paperless tags…</p>`;
  if (T.error) {
    return `${missingHtml}<p class="field-error">${ICON.alert}<span>Could not load your tags. ${esc(T.error)}</span></p>
      <p class="hint">The diary now uses the ${esc(tagsText(tags))}.</p>
      <div class="btn-row"><button type="button" class="btn small" data-act="pl-tags-load">Try again</button></div>`;
  }
  const many = T.list.length >= TAG_SEARCH_FROM;
  return `${missingHtml}<p class="hint">Records shows the Paperless documents that have one of the ticked tags.</p>
    ${many ? `<div class="field"><label class="sr-only" for="pl-tag-search">Search tags</label>
      <input id="pl-tag-search" type="search" placeholder="Search tags" autocomplete="off" value="${esc(T.query)}"></div>` : ''}
    <div id="pl-tag-list">${tagListHtml()}</div>
    <p class="hint" id="pl-tags-status" aria-live="polite"></p>`;
}

function tagListHtml() {
  const rows = tagRows(T.list, tagsOf(S.paperless), T.query);
  if (!T.list.length) return '<p class="hint">Your Paperless has no tags yet. Add a tag to your medical documents in Paperless.</p>';
  if (!rows.length) return '<p class="hint">No tag matches.</p>';
  return `<ul class="rows pl-tag-list">${rows.map((r, i) => `<li><label class="check" for="pl-tag-${i}">
      <input type="checkbox" id="pl-tag-${i}" data-act="pl-tag" data-name="${esc(r.name)}"${r.checked ? ' checked' : ''}>
      <span class="grow">${esc(r.name)}</span><span class="muted pl-count">${esc(plural(r.count, 'document'))}</span></label></li>`).join('')}</ul>`;
}

function redrawTags() {
  const el = document.getElementById('pl-tags');
  if (el) el.innerHTML = tagsHtml();
}

/** Loads the user's Paperless tags into the card (after the screen shows, or after a new token). */
export async function loadTags(ctx) {
  if (!S || !S.paperless || !S.paperless.hasToken || !document.getElementById('pl-tags')) return;
  T = { list: null, error: null, query: T ? T.query : '' };
  redrawTags();
  try { T.list = await ctx.api.listPaperlessTags(); } catch (e) { T.error = e.message || 'Paperless did not answer.'; }
  redrawTags();
}

/** Saves the ticked tags. The server answers with the new Paperless settings. */
async function saveTags(ctx, tags) {
  const before = S.paperless;
  try {
    S.paperless = { ...before, ...(await ctx.api.savePaperless({ tags })) };
    if (!Array.isArray(S.paperless.tags)) S.paperless.tags = tags;
  } catch (e) {
    S.paperless = before;
    throw new Error(`Not saved. ${e.message}`);
  }
}

function paperlessCard(ctx) {
  const { api } = ctx;
  const pl = S.paperless;
  let body;
  if (api.isDemo || !api.can.paperless || !pl) {
    body = why('Paperless needs your own server. The demo shows sample documents in Records.');
  } else if (!pl.available) {
    body = `<p>Paperless is not connected. Ask the person who installed Health Diary to connect it.</p>
      <p class="hint">Paperless keeps your scanned medical documents. When it is connected, they appear in Records.</p>
      <details class="settings-more admin-detail"><summary>For the administrator</summary>
        <p class="hint">Set <span class="tag">PAPERLESS_URL</span> on the server, then restart Health Diary.</p></details>`;
  } else {
    const ph = pl.hasToken ? 'Saved. Type a new token to replace it.' : 'Paste your API token';
    body = `<p class="hint">Records shows your documents from Paperless that have one of your tags. Use a separate Paperless user for the diary. Give this user read access to your medical documents only. Then, in Paperless, open the profile of this user and create an <strong>API Auth Token</strong>.</p>
      <form class="stack" data-form="paperless" novalidate>
        <div class="field"><label class="label" for="pl-token">API token</label>
          <input id="pl-token" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(ph)}" aria-describedby="pl-token-hint">
          <p class="hint" id="pl-token-hint">${pl.hasToken ? 'A token is saved. For your safety, it is never shown.' : 'No token saved yet.'}</p></div>
        ${errorBox('pl-error')}
        <div class="btn-row"><button type="submit" class="btn primary">Save token</button>
          ${pl.hasToken ? '<button type="button" class="btn" data-act="pl-test">Test connection</button><button type="button" class="btn ghost" data-act="pl-remove">Remove token</button>' : ''}</div>
        <p class="hint" id="pl-status" aria-live="polite"></p>
      </form>
      <hr class="divider">
      <fieldset class="pl-tags"><legend class="label">Tags to include</legend>
        <div id="pl-tags">${tagsHtml()}</div></fieldset>`;
  }
  return card('set-paperless', 'Paperless', body);
}

function displayCard(ctx) {
  const t = ctx.getTheme ? ctx.getTheme() : 'auto';
  return card('set-display', 'Display · this device', `
    <div class="seg" role="group" aria-label="Theme">${(ctx.themes || []).map(([v, l]) =>
    `<button type="button" data-act="theme" data-value="${esc(v)}" aria-pressed="${t === v}">${esc(l)}</button>`).join('')}</div>
    <p class="hint">Auto follows the setting of your device. Saved on this device only.</p>`);
}

const REPO = 'https://github.com/mmerah/health-diary';

/** Version, build and links. "0.1.0" is a release; "0.1.0-3-g6aa67db" is 3 commits after it. */
function aboutCard() {
  const a = S.about || {};
  const version = a.version || 'unknown';
  const release = /^\d+\.\d+\.\d+$/.test(version);
  const commit = /^[0-9a-f]{7,40}$/.test(a.commit || '') ? a.commit : '';
  const built = a.built && !Number.isNaN(Date.parse(a.built))
    ? new Date(a.built).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  return card('set-about', 'About', `
    <dl class="about-list">
      <div><dt>Version</dt><dd class="num">${esc(version)}${release ? '' : ' <span class="pill">Not a release</span>'}</dd></div>
      ${commit ? `<div><dt>Commit</dt><dd class="num">${link(`${REPO}/commit/${commit}`, commit.slice(0, 7))}</dd></div>` : ''}
      ${built ? `<div><dt>Built</dt><dd>${esc(built)}</dd></div>` : ''}
    </dl>
    <ul class="about-links">
      <li>${link(release ? `${REPO}/releases/tag/v${version}` : `${REPO}/releases`, 'What is new (release notes)')}</li>
      <li>${link(`${REPO}/issues/new/choose`, 'Report a problem')}</li>
      <li>${link(`${REPO}/security/advisories/new`, 'Report a security problem privately')}</li>
      <li>${link(REPO, 'Source code (MIT license)')}</li>
    </ul>
    <p class="hint">Give the version when you report a problem. Never put real health data in a report.</p>`);
}

function accountCard(ctx) {
  const { api, user } = ctx;
  const who = `<p>Logged in as <strong>${esc(user.username)}</strong>${user.isAdmin ? ' <span class="pill info">Administrator</span>' : ''}</p>`;
  const exportBlock = `<div class="stack">
      <h3>Export my data</h3>
      <p class="hint">Download your whole diary as one ZIP file: your data and your original documents. The file is not encrypted. It contains health data: keep it in a safe place.</p>
      <div class="btn-row"><button type="button" class="btn" data-act="export">${ICON.download}Export my data</button></div>
    </div>`;
  if (!api.can.accounts) {
    return card('set-account', 'Account', `${who}${why('Passwords and accounts need your own server. The demo has one sample user.')}<hr class="divider">${exportBlock}`);
  }
  return card('set-account', 'Account', `${who}
    <details class="settings-more"><summary>Change password</summary>
      <form class="stack" data-form="password" novalidate>
        ${pwField('pw-cur', 'Current password', 'current-password')}
        ${pwField('pw-new', 'New password', 'new-password', { hint: true })}
        ${pwField('pw-new2', 'New password again', 'new-password')}
        ${errorBox('pw-error')}
        <p class="hint">Your other devices are logged out after the change.</p>
        <div class="btn-row"><button type="submit" class="btn primary">Change password</button></div>
      </form>
    </details>
    <hr class="divider">
    ${exportBlock}
    <hr class="divider">
    <div class="btn-row"><button type="button" class="btn" data-act="logout">${ICON.logout}Log out</button></div>
    <details class="settings-more danger-zone"><summary>Delete my account</summary>
      <form class="stack" data-form="delete-me" novalidate>
        <p>This deletes your account and your whole diary from this server: days, measurements, profile and settings. <strong>You cannot undo this.</strong></p>
        <p class="hint">Backups of the server can still contain your data for some time. Export your data first if you want to keep it.</p>
        ${pwField('del-pw', 'Your password', 'current-password')}
        ${errorBox('del-error')}
        <div class="btn-row"><button type="submit" class="btn danger">Delete my account</button></div>
      </form>
    </details>`);
}

export function usersList(ctx) {
  const me = ctx.user;
  const admins = S.users.filter(u => u.isAdmin).length;
  return `<ul class="rows users">${S.users.map(u => {
    const self = u.id === me.id;
    // The server refuses to remove the last administrator: do not offer it.
    const lastAdmin = u.isAdmin && admins <= 1;
    return `<li class="user-row">
      <div class="user-top"><span class="grow"><strong>${esc(u.username)}</strong>${self ? ' <span class="muted">(you)</span>' : ''}</span>
        ${u.isAdmin ? '<span class="pill info">Admin</span>' : ''}</div>
      <div class="btn-row user-actions">
        <button type="button" class="btn small" data-act="user-pw" data-id="${esc(u.id)}" aria-expanded="false" aria-controls="upw-${esc(u.id)}">New password</button>
        ${lastAdmin ? '' : `<button type="button" class="btn small" data-act="user-admin" data-id="${esc(u.id)}">${u.isAdmin ? 'Remove administrator' : 'Make administrator'}</button>`}
        ${self ? '' : `<button type="button" class="btn small danger" data-act="user-del" data-id="${esc(u.id)}" aria-label="Delete ${esc(u.username)} and all data">Delete</button>`}
      </div>
      ${lastAdmin ? '<p class="hint">This is the only administrator. To remove this role, make another user an administrator first.</p>' : ''}
      <form class="stack user-pw-form" id="upw-${esc(u.id)}" data-form="user-pw" data-id="${esc(u.id)}" novalidate hidden>
        ${pwField(`upw-in-${esc(u.id)}`, `New password for ${u.username}`, 'new-password')}
        ${errorBox(`upw-err-${esc(u.id)}`)}
        <div class="btn-row"><button type="submit" class="btn primary small">Save password</button></div>
      </form>
    </li>`;
  }).join('')}</ul>`;
}

function usersCard(ctx) {
  return card('set-users', 'Users', `
    <p class="hint">Each user has a separate diary. Administrators manage accounts. They cannot read your diary in the app, but they can set a new password for you. If they do, you see a notice at your next login.</p>
    <div id="users-list">${usersList(ctx)}</div>
    <p class="hint">Delete removes the user and their whole diary. You cannot undo this.</p>
    <hr class="divider">
    <h3>Add a user</h3>
    <form class="stack" data-form="new-user" novalidate>
      <div class="stack">
        <div class="field"><label class="label" for="nu-name">Username</label>
          <input id="nu-name" name="username" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required maxlength="40"></div>
        ${pwField('nu-pw', 'Password', 'new-password', { hint: true })}
      </div>
      <label class="check"><input type="checkbox" name="isAdmin" id="nu-admin"> Administrator (can manage users)</label>
      ${errorBox('nu-error')}
      <div class="btn-row"><button type="submit" class="btn primary">Add user</button></div>
    </form>
    <p class="hint">Give the password to the new user in person. They can change it in Profile → Settings.</p>`);
}

export function settingsView(ctx) {
  const { api } = ctx;
  const showUsers = api.can.accounts && ctx.user && ctx.user.isAdmin && S.users;
  return `${api.isDemo ? demoCard() : ''}
    <div class="profile-grid">
      <div class="profile-col">${displayCard(ctx)}${listsCard()}${appleCard(ctx)}${paperlessCard(ctx)}</div>
      <div class="profile-col">${accountCard(ctx)}${showUsers ? usersCard(ctx) : ''}${aboutCard()}</div>
    </div>`;
}

// ---------- Helpers for handlers

async function redrawUsers(ctx) {
  S.users = await ctx.api.listUsers();
  const el = document.getElementById('users-list');
  if (el) el.innerHTML = usersList(ctx);
}
const userById = id => (S.users || []).find(u => String(u.id) === String(id));

// ---------- Handlers

export const settingsActions = {
  'pw-show'(el) { togglePassword(el); },

  theme(el, e, ctx) { ctx.setTheme(el.dataset.value); },

  async 'demo-reset'(el, e, ctx) {
    if (!confirmTwice(el, 'Tap again to reset all sample data')) return;
    await ctx.api.resetDemo();
    toast('Sample data reset');
    await ctx.refresh();
  },

  async 'copy-url'(el) {
    const ok = await copyText(`${location.origin}/api/ingest/health`, document.getElementById('ingest-url'));
    toast(ok ? 'Address copied' : 'Copy did not work. The address is selected: copy it by hand.');
  },

  async 'key-new'(el, e, ctx) {
    if (el.dataset.replace && !confirmTwice(el, 'Tap again: the old key stops working')) return;
    const { token } = await ctx.api.createIngestToken();
    ctx.user.hasIngestToken = true;
    ctx.user.ingestLastUsed = null;
    const sec = document.getElementById('key-section');
    sec.innerHTML = keySection(ctx.user, token);
    sec.querySelector('[data-act="copy-key"]').focus();
  },

  async 'copy-key'() {
    const code = document.getElementById('new-key');
    const ok = await copyText(code.textContent, code);
    toast(ok ? 'Key copied' : 'Copy did not work. The key is selected: copy it by hand.');
  },

  async 'key-off'(el, e, ctx) {
    if (!confirmTwice(el, 'Tap again to turn off')) return;
    await ctx.api.revokeIngestToken();
    ctx.user.hasIngestToken = false;
    const sec = document.getElementById('key-section');
    sec.innerHTML = keySection(ctx.user);
    toast('Shortcut key turned off');
    sec.querySelector('[data-act="key-new"]').focus();
  },

  async 'pl-test'(el, e, ctx) {
    const st = document.getElementById('pl-status');
    st.textContent = 'Testing the connection…';
    el.disabled = true;
    try {
      const docs = await ctx.api.refreshDocuments();
      st.textContent = `Connected. ${plural(docs.filter(d => d.source !== 'diary').length, 'document')} from Paperless have your ${tagsText(tagsOf(S.paperless))}.`;
    } catch (err) {
      st.textContent = '';
      throw new Error(`Connection failed. ${err.message}`);
    } finally { el.disabled = false; }
  },

  'pl-tags-load'(el, e, ctx) { return loadTags(ctx); },

  async 'pl-tag-remove'(el, e, ctx) {
    const name = el.dataset.name;
    const tags = tagsOf(S.paperless).filter(t => t !== name);
    await saveTags(ctx, tags.length ? tags : [...DEFAULT_TAGS]);
    S.paperless.missingTags = (S.paperless.missingTags || []).filter(t => t !== name);
    redrawTags();
    toast(`${name} removed from your tags`);
    document.querySelector('#pl-tags input, #pl-tags button')?.focus();
  },

  async 'pl-remove'(el, e, ctx) {
    if (!confirmTwice(el, 'Tap again to remove the token')) return;
    S.paperless = await ctx.api.savePaperless({ token: '' });
    toast('Paperless token removed');
    await ctx.refresh();
  },

  async export(el, e, ctx) {
    el.disabled = true;
    try {
      const { filename, blob } = await ctx.api.exportData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'health-diary-export.json';
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Export downloaded');
    } finally { el.disabled = false; }
  },

  logout(el, e, ctx) { return ctx.logout(); },

  'user-pw'(el) {
    const form = document.getElementById(`upw-${el.dataset.id}`);
    const open = form.hidden;
    form.hidden = !open;
    el.setAttribute('aria-expanded', String(open));
    if (open) form.querySelector('input').focus();
  },

  async 'user-admin'(el, e, ctx) {
    const u = userById(el.dataset.id);
    if (!u) throw new Error('This user is no longer in the list.');
    const make = !u.isAdmin;
    if (!make && u.id === ctx.user.id && !confirmTwice(el, 'Tap again: you lose the Users card')) return;
    await ctx.api.setAdmin(u.id, make); // the server refuses to remove the last administrator
    toast(make ? `${u.username} is now an administrator` : `${u.username} is no longer an administrator`);
    if (u.id === ctx.user.id) { ctx.user.isAdmin = make; return ctx.refresh(); }
    return redrawUsers(ctx);
  },

  async 'user-del'(el, e, ctx) {
    const u = userById(el.dataset.id);
    if (!u) throw new Error('This user is no longer in the list.');
    if (!confirmTwice(el, `Tap again: delete ${u.username} and all data`)) return;
    await ctx.api.deleteUser(u.id);
    toast(`${u.username} deleted`);
    await redrawUsers(ctx);
    document.getElementById('nu-name')?.focus();
  },
};

export const settingsForms = {
  async import(form, e, ctx) {
    const file = form.querySelector('#imp-file').files[0];
    const status = document.getElementById('imp-status');
    status.classList.remove('is-error');
    if (!file) { status.textContent = 'Choose the export file first.'; status.classList.add('is-error'); return; }
    await busy(form, async () => {
      status.textContent = `Uploading and reading ${num(Math.max(1, Math.round(file.size / 1e6)))} MB. This can take a few minutes. Keep this page open.`;
      try {
        const r = await ctx.api.importAppleHealth(file);
        const words = { weight: 'weights', bp: 'blood pressures', temp: 'temperatures' };
        const m = Object.entries(r.measurements || {}).map(([k, n]) => `${num(n)} ${words[k] || k}`);
        status.textContent = r.days
          ? `Done. ${plural(r.days, 'day')} from ${fullLabel(r.first)} to ${fullLabel(r.last)}${m.length ? `, and ${m.join(', ')}` : ''}.`
          : 'Done. The file has no new data.';
        toast('Import done');
      } catch (err) {
        status.textContent = `Import failed. ${err.message}`;
        status.classList.add('is-error');
      }
    });
  },

  async paperless(form, e, ctx) {
    clearErrors(form);
    const token = form.token.value.trim();
    if (!token) return showError('pl-error', 'Paste your API token first.', form.token);
    await busy(form, async () => {
      try {
        S.paperless = await ctx.api.savePaperless({ token });
      } catch (err) { return showError('pl-error', err.message); }
      toast('Paperless token saved');
      await ctx.refresh(); // shows the tag list and the token buttons
    });
  },

  async password(form, e, ctx) {
    clearErrors(form);
    const cur = form['pw-cur'].value, pw = form['pw-new'].value, again = form['pw-new2'].value;
    if (!cur) return showError('pw-error', 'Enter your current password.', form['pw-cur']);
    const err = newPasswordError(pw, again, ctx.user.username);
    if (err) return showError('pw-error', err, err.startsWith('The two') ? form['pw-new2'] : form['pw-new']);
    await busy(form, async () => {
      try { await ctx.api.changePassword(cur, pw); } catch (x) { return showError('pw-error', x.message); }
      form.reset();
      form.closest('details').open = false;
      toast('Password changed. Your other devices are logged out.');
    });
  },

  async 'delete-me'(form, e, ctx) {
    clearErrors(form);
    const pw = form['del-pw'].value;
    if (!pw) return showError('del-error', 'Enter your password to confirm.', form['del-pw']);
    const btn = form.querySelector('[type="submit"]');
    if (!confirmTwice(btn, 'Tap again: delete everything')) return;
    await busy(form, async () => {
      try { await ctx.api.deleteMe(pw); } catch (x) { return showError('del-error', x.message); }
      await ctx.logout('Your account and your diary are deleted.', { deleted: true });
    });
  },

  async 'new-user'(form, e, ctx) {
    clearErrors(form);
    const username = form.username.value.trim(), pw = form['nu-pw'].value;
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) return showError('nu-error', 'Use 2 to 40 letters, digits, dots, dashes or underscores for the username.', form.username);
    const err = newPasswordError(pw, null, username);
    if (err) return showError('nu-error', err, form['nu-pw']);
    await busy(form, async () => {
      try { await ctx.api.createUser({ username, password: pw, isAdmin: form.isAdmin.checked }); } catch (x) { return showError('nu-error', x.message); }
      form.reset();
      updatePwHint(form['nu-pw'], '');
      toast(`${username} added`);
      await redrawUsers(ctx);
    });
  },

  async 'user-pw'(form, e, ctx) {
    clearErrors(form);
    const u = userById(form.dataset.id);
    if (!u) throw new Error('This user is no longer in the list.');
    const input = form.querySelector('input');
    const err = newPasswordError(input.value, null, u.username);
    if (err) return showError(`upw-err-${u.id}`, err, input);
    await busy(form, async () => {
      try { await ctx.api.resetPassword(u.id, input.value); } catch (x) { return showError(`upw-err-${u.id}`, x.message); }
      form.reset();
      form.hidden = true;
      const btn = document.querySelector(`[data-act="user-pw"][data-id="${CSS.escape(String(u.id))}"]`);
      if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
      toast(u.id === ctx.user.id ? 'New password saved' : `New password saved for ${u.username}. Give it to them in person.`);
    });
  },
};

async function onTagChange(el, ctx) {
  const name = el.dataset.name;
  const status = document.getElementById('pl-tags-status');
  const now = tagsOf(S.paperless);
  const next = toggleTag(now, name, el.checked);
  if (!next.length) {
    el.checked = true;
    if (status) status.textContent = 'Keep at least one tag. Tick another tag first.';
    return;
  }
  el.disabled = true;
  try {
    await saveTags(ctx, next);
    if (status) status.textContent = `Saved. Records uses the ${tagsText(tagsOf(S.paperless))}.`;
  } catch (e) {
    el.checked = !el.checked;
    if (status) status.textContent = e.message;
  } finally { el.disabled = false; }
}

/** Live password hints. Returns true when it handled the event. */
export function settingsInput(el, e, ctx) {
  if (el.id === 'pl-tag-search') {
    T.query = el.value;
    const list = document.getElementById('pl-tag-list');
    if (list) list.innerHTML = tagListHtml();
    return true;
  }
  if (el.dataset.act === 'pl-tag') { onTagChange(el, ctx); return true; }
  if (el.id === 'pw-new') { updatePwHint(el, ctx.user.username); return true; }
  if (el.id === 'nu-pw') { updatePwHint(el, document.getElementById('nu-name').value); return true; }
  return false;
}
