// Autosave with no lost edits.
//  - The value is captured when the user edits, not when the timer fires, so changing day
//    or screen can never write one day's text into another day.
//  - flush() saves at once; the router calls it before every navigation.
//  - A failed save stays queued (also in this browser's storage) and retries when the
//    connection returns, every 15 s, or when the user taps Retry.
//  - The queue belongs to the logged-in user (session.uid): it is stored per user, and only
//    that user's edits are ever sent. Another user on the same device starts empty.
import { session } from './session.js';
import { setSaveState, store } from './ui.js';

const RETRY_MS = 15000;
const all = new Set(); // every autosave, for resumeAll() and hasUnsaved()

/** After login: send edits left from an earlier visit of this user. */
export const resumeAll = () => all.forEach(a => a.resume());
/** Save everything now. Resolves true when nothing is left unsaved. */
export async function flushAll() {
  for (const a of all) await a.flush();
  return ![...all].some(a => a.dirty);
}

/**
 * const saver = createAutosave('log', (key, value) => api.saveLog(key, value));
 * saver.queue('2026-10-14', log);   // after each edit
 * await saver.flush();              // before leaving the screen
 */
export function createAutosave(name, save, { delay = 600 } = {}) {
  let owner = null;          // the user whose edits are in `pending`
  let pending = new Map();   // key → latest value
  let timer = null, retryTimer = null, running = null;

  const storeKey = uid => `pending-${name}-${uid}`;
  const persist = () => { if (owner != null) store.set(storeKey(owner), [...pending]); };
  /** Switch to the current user's queue (from browser storage) when the user changed. */
  function sync() {
    if (owner === session.uid) return;
    clearTimeout(timer); clearTimeout(retryTimer);
    owner = session.uid;
    pending = new Map(owner == null ? [] : store.get(storeKey(owner), []));
  }

  async function run() {
    sync();
    clearTimeout(timer); timer = null;
    if (running) { await running; if (!pending.size) return; }
    if (!pending.size) return;
    running = (async () => {
      setSaveState('saving');
      const uid = owner;
      for (const [key, value] of [...pending]) {
        if (session.uid !== uid) return false; // logged out while saving
        try {
          await save(key, value);
          // Only drop it if nothing newer was queued while saving.
          if (pending.get(key) === value) pending.delete(key);
        } catch (e) {
          persist();
          const offline = !navigator.onLine || e instanceof TypeError; // fetch network errors are TypeErrors
          setSaveState(offline ? 'offline' : 'error', { retry: () => run() });
          clearTimeout(retryTimer);
          retryTimer = setTimeout(run, RETRY_MS);
          console.error(`Autosave (${name}) failed`, e);
          return false;
        }
      }
      persist();
      setSaveState('saved');
      return true;
    })();
    try { return await running; } finally { running = null; }
  }

  window.addEventListener('online', () => { sync(); if (pending.size) run(); });

  const api = {
    /** Sends edits left from an earlier visit of the current user. main.js calls it after login. */
    resume() { sync(); if (pending.size) setTimeout(run, 500); },
    queue(key, value) {
      sync();
      if (owner == null) return; // nobody logged in
      // structuredClone: later edits to the live object must not change the queued copy.
      pending.set(key, structuredClone(value));
      persist();
      setSaveState('saving');
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    flush: () => run(),
    has: key => { sync(); return pending.has(key); },
    get: key => { sync(); return pending.get(key); },
    /** True when edits are still waiting to be saved. */
    get dirty() { sync(); return pending.size > 0; },
  };
  all.add(api);
  return api;
}
