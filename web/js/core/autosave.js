// Autosave with no lost edits.
//  - The value is captured when the user edits, not when the timer fires, so changing day
//    or screen can never write one day's text into another day.
//  - flush() saves at once; the router calls it before every navigation.
//  - A failed save stays queued (also in this browser's storage) and retries when the
//    connection returns, every 15 s, or when the user taps Retry.
import { setSaveState, store } from './ui.js';

const RETRY_MS = 15000;

/**
 * const saver = createAutosave('log', (key, value) => api.saveLog(key, value));
 * saver.queue('2026-10-14', log);   // after each edit
 * await saver.flush();              // before leaving the screen
 */
export function createAutosave(name, save, { delay = 600 } = {}) {
  const pending = new Map(store.get(`pending-${name}`, [])); // key → latest value
  let timer = null, retryTimer = null, running = null;

  const persist = () => store.set(`pending-${name}`, [...pending]);

  async function run() {
    clearTimeout(timer); timer = null;
    if (running) { await running; if (!pending.size) return; }
    if (!pending.size) return;
    running = (async () => {
      setSaveState('saving');
      for (const [key, value] of [...pending]) {
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

  window.addEventListener('online', () => { if (pending.size) run(); });
  if (pending.size) setTimeout(run, 1000); // edits left from an earlier visit

  return {
    queue(key, value) {
      // structuredClone: later edits to the live object must not change the queued copy.
      pending.set(key, structuredClone(value));
      persist();
      setSaveState('saving');
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    flush: () => run(),
    has: key => pending.has(key),
    get: key => pending.get(key),
  };
}
