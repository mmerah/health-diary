// The real back end: the Health Diary server. Same methods as MockApi.

// The iPhone shortcut that reads Apple Health and sends it to the server.
const SHORTCUT_URL = 'shortcuts://run-shortcut?name=Health%20Diary';
// Apple Health data can only come from the iPhone.
const IS_IPHONE = /iPhone/.test(navigator.userAgent);

export class HttpApi {
  constructor(base) {
    this.base = base;
    this.isDemo = false;
    this.can = { sync: IS_IPHONE, accounts: true, paperless: true, import: true, upload: true };
  }

  async req(path, { method = 'GET', body, raw, headers: extra } = {}) {
    // X-Requested-With: the server refuses cookie requests without it.
    const headers = { 'X-Requested-With': 'health-diary', ...(extra || {}) };
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers, body: payload, credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // Session expired or ended on another device: the app shows the login screen.
      if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('diary:logged-out'));
      const detail = Array.isArray(data.detail) ? 'Some values are not valid.' : data.detail;
      const err = new Error(detail || `The server answered ${res.status}.`);
      err.status = res.status;
      err.data = data; // for 409: the newer version on the server
      throw err;
    }
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }

  // ---------- Accounts
  authStatus() { return this.req('/auth/status'); }
  setup(code, username, password) { return this.req('/auth/setup', { method: 'POST', body: { code, username, password } }); }
  login(username, password) { return this.req('/auth/login', { method: 'POST', body: { username, password } }); }
  logout() { return this.req('/auth/logout', { method: 'POST' }); }
  changePassword(current, next) { return this.req('/me/password', { method: 'PUT', body: { current, new: next } }); }
  createIngestToken() { return this.req('/me/ingest-token', { method: 'POST' }); }
  revokeIngestToken() { return this.req('/me/ingest-token', { method: 'DELETE' }); }
  getPaperless() { return this.req('/me/paperless'); }
  /** cfg: { token?, tags?: [names] }. Documents with any of the tags are used. */
  savePaperless(cfg) { return this.req('/me/paperless', { method: 'PUT', body: cfg }); }
  /** [{ name, documentCount }]: all tags in the user's Paperless, to choose from. */
  listPaperlessTags() { return this.req('/me/paperless/tags'); }
  dismissNotice() { return this.req('/me/notice/dismiss', { method: 'POST' }); }
  deleteMe(password) { return this.req('/me', { method: 'DELETE', body: { password } }); }
  async exportData() {
    const res = await this.req('/me/export', { raw: true });
    const name = /filename="?([^";]+)/.exec(res.headers.get('content-disposition') || '');
    return { filename: name ? name[1] : 'health-diary-export.json', blob: await res.blob() };
  }
  listUsers() { return this.req('/users'); }
  createUser(u) { return this.req('/users', { method: 'POST', body: u }); }
  resetPassword(id, password) { return this.req(`/users/${id}/password`, { method: 'PUT', body: { password } }); }
  setAdmin(id, isAdmin) { return this.req(`/users/${id}/admin`, { method: 'PUT', body: { isAdmin } }); }
  deleteUser(id) { return this.req(`/users/${id}`, { method: 'DELETE' }); }

  // ---------- Diary
  // Versions: a save names the version it started from. When another device saved in between,
  // the server answers 409 with the newer version (err.status 409, err.data), and nothing is lost.
  async getProfile() {
    const res = await this.req('/profile', { raw: true });
    const profile = await res.json();
    Object.defineProperty(profile, 'version', { value: Number(res.headers.get('x-version')) || 0, enumerable: false, writable: true });
    return profile;
  }
  /** Returns { version }. With baseVersion, throws a 409 error when the profile changed elsewhere. */
  saveProfile(p, baseVersion) {
    return this.req('/profile', { method: 'PUT', body: p, headers: baseVersion != null ? { 'X-Base-Version': String(baseVersion) } : {} });
  }
  /** Returns { date, log, health, logVersion }. */
  getDay(date) { return this.req(`/days/${date}`); }
  /** Returns { logVersion }. With baseVersion, throws a 409 error (err.data = { log, logVersion }) on conflict. */
  saveLog(date, log, baseVersion) {
    return this.req(`/days/${date}/log`, { method: 'PUT', body: log, headers: baseVersion != null ? { 'X-Base-Version': String(baseVersion) } : {} });
  }
  saveHealth(date, h) { return this.req(`/days/${date}/health`, { method: 'PUT', body: h }); }
  listDays(from, to) { return this.req(`/days?${new URLSearchParams({ from: from || '', to: to || '' })}`); }
  listMeasurements(type, from, to) {
    return this.req(`/measurements?${new URLSearchParams({ type: type || '', from: from || '', to: to || '' })}`);
  }
  addMeasurement(m) { return this.req('/measurements', { method: 'POST', body: m }); }
  deleteMeasurement(id) { return this.req(`/measurements/${id}`, { method: 'DELETE' }); }
  // Documents: the user's own (source 'diary') and Paperless documents (source 'paperless'), in one list.
  // When Paperless cannot be reached, the list has the diary documents and list.paperlessError says why.
  async listDocuments(refresh = false) {
    const r = await this.req(`/documents${refresh ? '?refresh=true' : ''}`);
    const docs = r.documents || [];
    Object.defineProperty(docs, 'paperlessError', { value: r.paperless && r.paperless.error || null, enumerable: false });
    return docs;
  }
  refreshDocuments() { return this.listDocuments(true); }
  /** Uploads a PDF or photo. fields: { date, title, category } (all optional). Returns the new document (status 'processing'). */
  uploadDocument(file, fields = {}) {
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, v);
    return this.req('/documents', { method: 'POST', body: fd });
  }
  getDocument(id) { return this.req(`/documents/${encodeURIComponent(id)}`); }
  updateDocument(id, fields) { return this.req(`/documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: fields }); }
  deleteDocument(id) { return this.req(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  /** Reads a failed document again. Returns the document (status 'processing'). */
  retryDocument(id) { return this.req(`/documents/${encodeURIComponent(id)}/retry`, { method: 'POST' }); }
  /** Address of the original file (PDF or image), to open in a new tab. */
  documentFileUrl(id) { return `${this.base}/documents/${encodeURIComponent(id)}/file`; }
  /** The user's own symptoms, document types, measurements and counters (see core/schema.js). */
  getCatalog() { return this.req('/catalog'); }
  saveCatalog(c) { return this.req('/catalog', { method: 'PUT', body: c }); }
  getSettings() { return this.req('/settings'); }
  saveSettings(s) { return this.req('/settings', { method: 'PUT', body: s }); }
  importAppleHealth(file) {
    const fd = new FormData();
    fd.append('file', file);
    return this.req('/import/apple-health', { method: 'POST', body: fd });
  }

  /** Opens the iPhone shortcut. It sends the data and opens the diary again. */
  async sync() {
    window.location.href = SHORTCUT_URL;
    return false; // the page is about to change
  }
  async resetDemo() {}
  /** { version, commit, built } of the running server. */
  about() { return this.req('/health'); }
}
