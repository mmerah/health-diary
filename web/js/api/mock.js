// The demo back end: sample data kept in this browser. Same methods as HttpApi.
import { today as todayIso, pad } from '../core/dates.js';
import { mergeHealth } from '../core/schema.js';
import { seed, DEMO_USER } from './sample.js';

const KEY = 'health-diary-demo-v3';
const clone = o => (o == null ? o : structuredClone(o));
const demoOnly = () => { throw new Error('Not available in the demo.'); };

export class MockApi {
  constructor() {
    this.isDemo = true;
    // What this back end can do. Screens check these instead of the back-end type.
    this.can = { sync: true, accounts: false, paperless: false, import: false };
    let db = null;
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* storage blocked */ }
    // Re-seed when the stored demo is from an earlier day, so dates stay recent.
    this.db = db && db.seededOn === todayIso() ? db : seed();
    this.persist();
  }

  persist() { try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch (e) { /* storage blocked */ } }

  // ---------- Accounts (the demo has one fixed user)
  async authStatus() { return { setupNeeded: false, user: clone(DEMO_USER) }; }
  async login() { return clone(DEMO_USER); }
  async setup() { return clone(DEMO_USER); }
  async logout() {}
  changePassword = demoOnly;
  async createIngestToken() { return { token: 'demo-key-not-real' }; }
  async revokeIngestToken() {}
  async getPaperless() { return { available: false, url: '', tag: 'medical', hasToken: false, tokenFromServer: false }; }
  savePaperless = demoOnly;
  async dismissNotice() {}
  async deleteMe() { await this.resetDemo(); }
  async listUsers() { return [clone(DEMO_USER)]; }
  createUser = demoOnly;
  resetPassword = demoOnly;
  setAdmin = demoOnly;
  deleteUser = demoOnly;
  importAppleHealth = demoOnly;

  async exportData() {
    const { profile, settings, days, health, measurements } = this.db;
    const dates = [...new Set([...Object.keys(days), ...Object.keys(health)])].sort();
    const data = { format: 'health-diary-export', version: 1, exportedAt: new Date().toISOString(), profile, settings,
      days: dates.map(d => ({ date: d, log: days[d] || null, health: health[d] || null })), measurements };
    return { filename: `health-diary-demo-${todayIso()}.json`, blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }) };
  }

  // ---------- Diary
  // Versions, as on the server: one browser has no other device, so there is never a conflict.
  async getProfile() {
    const p = clone(this.db.profile);
    Object.defineProperty(p, 'version', { value: this.db.profileVersion || 0, enumerable: false, writable: true });
    return p;
  }
  async saveProfile(p) {
    this.db.profile = clone(p);
    this.db.profileVersion = (this.db.profileVersion || 0) + 1;
    this.persist();
    return { version: this.db.profileVersion };
  }

  async getDay(date) {
    return { date, log: clone(this.db.days[date] || null), health: clone(this.db.health[date] || null),
      logVersion: (this.db.logVersions || {})[date] || 0 };
  }
  async saveLog(date, log) {
    this.db.days[date] = clone(log);
    this.db.logVersions = this.db.logVersions || {};
    this.db.logVersions[date] = (this.db.logVersions[date] || 0) + 1;
    this.persist();
    return { logVersion: this.db.logVersions[date] };
  }
  async saveHealth(date, h) { this.db.health[date] = clone(h); this.persist(); }
  async listDays(from, to) {
    const dates = new Set([...Object.keys(this.db.days), ...Object.keys(this.db.health)]);
    return [...dates].filter(d => (!from || d >= from) && (!to || d <= to)).sort()
      .map(d => ({ date: d, log: clone(this.db.days[d] || null), health: clone(this.db.health[d] || null) }));
  }

  async listMeasurements(type, from, to) {
    return clone(this.db.measurements
      .filter(m => (!type || m.type === type) && (!from || m.date >= from) && (!to || m.date <= to))
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))));
  }
  async addMeasurement(m) {
    const row = { ...clone(m), id: this.db.nextId++, source: 'manual' };
    this.db.measurements.push(row);
    this.persist();
    return clone(row);
  }
  async deleteMeasurement(id) { this.db.measurements = this.db.measurements.filter(m => m.id !== id); this.persist(); }

  async listDocuments() { return clone(this.db.documents); }
  async refreshDocuments() { return this.listDocuments(); }

  async getSettings() { return clone(this.db.settings); }
  async saveSettings(s) {
    const { lastSync, ...rest } = s || {}; // lastSync is managed by the "server"
    this.db.settings = { ...this.db.settings, ...clone(rest) };
    this.persist();
  }

  /** Does what the iPhone shortcut does: last night's sleep and today's numbers so far. */
  async sync() {
    const today = todayIso();
    const now = new Date();
    const stamp = `${today}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const minutes = now.getHours() * 60 + now.getMinutes();
    const old = this.db.health[today];
    this.db.health[today] = mergeHealth(old, {
      sleep: { total: 412, deep: 64, rem: 95, core: 253, awake: 21, bed: '23:35', wake: '06:28', naps: [], inBedOnly: false },
      steps: Math.max((old && old.steps) || 0, Math.round(Math.max(0, minutes - 390) * 9.5) + 140),
      restingHr: 58, hrv: 47,
      workouts: minutes > 12 * 60 + 40 ? [{ type: 'Walking', minutes: 24, start: '12:15' }] : [],
    }, stamp);
    this.db.settings.lastSync = stamp;
    this.persist();
    return true;
  }

  async resetDemo() { this.db = seed(); this.persist(); }
  /** The demo build writes its version into config.js (scripts/build_demo.sh). */
  async about() {
    const c = window.DIARY_CONFIG || {};
    return { ok: true, version: c.version || 'dev', commit: c.commit || '', built: c.built || '' };
  }
}
