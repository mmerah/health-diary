// Autosave: values are captured at edit time, failures stay queued, and the queue belongs to one user.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Minimal browser stand-ins for the parts autosave.js and ui.js use.
const storage = new Map();
globalThis.localStorage = {
  getItem: k => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: k => storage.delete(k),
  key: i => [...storage.keys()][i],
  get length() { return storage.size; },
};
globalThis.window = { addEventListener() {} };
const statusEl = { dataset: {}, innerHTML: '', setAttribute() {}, querySelector: () => ({}) };
globalThis.document = { getElementById: () => statusEl };

const { createAutosave, flushAll } = await import('../js/core/autosave.js');
const { session } = await import('../js/core/session.js');

const wait = ms => new Promise(r => setTimeout(r, ms));

test('saves the value as it was when the user edited it', async () => {
  session.set({ id: 1 });
  const saved = [];
  const saver = createAutosave('t1', async (k, v) => { saved.push([k, v]); }, { delay: 5 });
  const log = { notes: 'first' };
  saver.queue('2026-10-14', log);
  log.notes = 'changed later, on another day';
  await saver.flush();
  assert.deepEqual(saved, [['2026-10-14', { notes: 'first' }]]);
  assert.equal(saver.dirty, false);
});

test('a failed save stays queued and is sent by the next flush', async () => {
  session.set({ id: 1 });
  let fail = true;
  const saved = [];
  const saver = createAutosave('t2', async (k, v) => { if (fail) throw new Error('down'); saved.push(v); }, { delay: 5 });
  saver.queue('a', { n: 1 });
  assert.equal(await saver.flush(), false);
  assert.equal(saver.dirty, true);
  fail = false;
  assert.equal(await saver.flush(), true);
  assert.deepEqual(saved, [{ n: 1 }]);
});

test('unsaved edits of one user are never shown to or sent for another user', async () => {
  session.set({ id: 1 });
  const sent = [];
  const saver = createAutosave('t3', async (k, v) => { if (session.uid === 1) throw new Error('offline'); sent.push([session.uid, v]); }, { delay: 5 });
  saver.queue('2026-10-14', { notes: 'A private' });
  await saver.flush();
  assert.equal(saver.has('2026-10-14'), true);

  session.set({ id: 2 }); // B logs in on the same device
  assert.equal(saver.has('2026-10-14'), false);
  assert.equal(saver.get('2026-10-14'), undefined);
  assert.equal(await flushAll(), true);
  assert.deepEqual(sent, []);

  session.set({ id: 1 }); // A comes back: the edit is still there and is sent for A
  assert.deepEqual(saver.get('2026-10-14'), { notes: 'A private' });
});

test('nothing is queued when nobody is logged in', async () => {
  session.set(null);
  const saver = createAutosave('t4', async () => { throw new Error('must not be called'); }, { delay: 5 });
  saver.queue('x', { a: 1 });
  await wait(20);
  assert.equal(saver.dirty, false);
});
