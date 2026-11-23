import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the real service-worker body with isolated browser/module dependencies.
// Promise gates exercise startup ordering without a browser, network, or real storage.
const source = readFileSync(new URL('../../shinkansen/background.js', import.meta.url), 'utf8')
  .replace(/^import .*;[^\n]*$/gm, '');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const event = () => ({ addListener(fn) { this.listener = fn; } });
function setup({ rejectWrites = 0, gateWrites = false } = {}) {
  const reads = [];
  const writes = [];
  const pendingWrites = [];
  let failuresLeft = rejectWrites;
  const browser = {
    runtime: { getManifest: () => ({ version: 'test' }), onMessage: event(), onInstalled: event() },
    storage: {
      onChanged: event(),
      session: {
        get() { const gate = deferred(); reads.push(gate); return gate.promise; },
        async set(value) {
          const snapshot = JSON.parse(JSON.stringify(value));
          if (gateWrites) {
            const gate = deferred();
            pendingWrites.push({ value: snapshot, gate });
            await gate.promise;
          }
          if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('quota exceeded'); }
          writes.push(snapshot);
        },
      },
    },
    tabs: { onCreated: event(), onRemoved: event(), onUpdated: event() },
    commands: { onCommand: event() },
  };
  vm.runInNewContext(source, {
    browser, debugLog() {},
    getSettings: async () => ({ geminiConfig: {} }),
    getLimitsForSettings: () => ({}), RateLimiter: class {},
    cache: { checkVersionAndClear: async () => ({ cleared: false }) },
  });
  const send = (type, tabId, payload) => new Promise(resolve => {
    expect(browser.runtime.onMessage.listener({ type, payload }, { tab: { id: tabId } }, resolve)).toBe(true);
  });
  return { reads, writes, pendingWrites, send,
    created: tab => browser.tabs.onCreated.listener(tab),
    removed: id => browser.tabs.onRemoved.listener(id) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('concurrent queries share the pending session read and see restored slots', async () => {
  const h = setup();
  const first = h.send('STICKY_QUERY', 1);
  let settled = false;
  const second = h.send('STICKY_QUERY', 2).then(r => { settled = true; return r; });
  await flush();
  expect(settled).toBe(false);
  expect(h.reads).toHaveLength(1);
  h.reads[0].resolve({ stickyTabs: { 1: 1, 2: 2 } });
  expect(await first).toMatchObject({ shouldTranslate: true, slot: 1 });
  expect(await second).toMatchObject({ shouldTranslate: true, slot: 2 });
});

test('a preset change waits for hydration instead of being overwritten by old state', async () => {
  const h = setup();
  const query = h.send('STICKY_QUERY', 1);
  const change = h.send('STICKY_SET', 1, { slot: 3 });
  await flush();
  expect(h.writes).toHaveLength(0);
  h.reads[0].resolve({ stickyTabs: { 1: 1, 2: 2 } });
  await Promise.all([query, change]);
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ slot: 3 });
  expect(h.writes.at(-1)).toEqual({ stickyTabs: { 1: 3, 2: 2 } });
});

test('clearing while hydration is pending does not restore the cleared tab', async () => {
  const h = setup();
  const query = h.send('STICKY_QUERY', 2);
  const clear = h.send('STICKY_CLEAR', 1);
  await flush();
  expect(h.writes).toHaveLength(0);
  h.reads[0].resolve({ stickyTabs: { 1: 1, 2: 2 } });
  await Promise.all([query, clear]);
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: false });
  expect(h.writes.at(-1)).toEqual({ stickyTabs: { 2: 2 } });
});

test('a SET that arrives before a child during hydration is what the child inherits', async () => {
  const h = setup();
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  const child = h.created({ id: 4, openerTabId: 1 });
  await flush();
  expect(h.reads).toHaveLength(1);
  h.reads[0].resolve({ stickyTabs: { 1: 1 } });
  await Promise.all([set, child]);
  expect(await h.send('STICKY_QUERY', 4)).toMatchObject({ shouldTranslate: true, slot: 3 });
  expect(h.writes.at(-1)).toEqual({ stickyTabs: { 1: 3, 4: 3 } });
});

test('a child opened before a SET during hydration keeps the saved opener slot', async () => {
  const h = setup();
  const child = h.created({ id: 4, openerTabId: 1 });
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  await flush();
  expect(h.reads).toHaveLength(1);
  h.reads[0].resolve({ stickyTabs: { 1: 1 } });
  await Promise.all([child, set]);
  expect(await h.send('STICKY_QUERY', 4)).toMatchObject({ shouldTranslate: true, slot: 1 });
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: true, slot: 3 });
});

test('a CLEAR that arrives before a child during hydration is not inherited', async () => {
  const h = setup();
  const clear = h.send('STICKY_CLEAR', 1);
  const child = h.created({ id: 4, openerTabId: 1 });
  await flush();
  expect(h.reads).toHaveLength(1);
  h.reads[0].resolve({ stickyTabs: { 1: 1 } });
  await Promise.all([clear, child]);
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: false });
  expect(await h.send('STICKY_QUERY', 4)).toMatchObject({ shouldTranslate: false });
});

test('a child opened before CLEAR during hydration keeps the saved slot', async () => {
  const h = setup();
  const child = h.created({ id: 4, openerTabId: 1 });
  const clear = h.send('STICKY_CLEAR', 1);
  await flush();
  expect(h.reads).toHaveLength(1);
  h.reads[0].resolve({ stickyTabs: { 1: 1 } });
  await Promise.all([child, clear]);
  expect(await h.send('STICKY_QUERY', 4)).toMatchObject({ shouldTranslate: true, slot: 1 });
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: false });
});

test('a child created during hydration inherits its restored opener slot', async () => {
  const h = setup();
  const query = h.send('STICKY_QUERY', 1);
  const child = h.created({ id: 2, openerTabId: 1 });
  h.reads[0].resolve({ stickyTabs: { 1: 3 } });
  await Promise.all([query, child]);
  expect(await h.send('STICKY_QUERY', 2)).toMatchObject({ shouldTranslate: true, slot: 3 });
});

test('tab removal initializes hydration and removes only the closed saved tab', async () => {
  const h = setup();
  const removal = h.removed(1);
  expect(h.reads).toHaveLength(1);
  h.reads[0].resolve({ stickyTabs: { 1: 1, 2: 2 } });
  await removal;
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: false });
  expect(h.writes.at(-1)).toEqual({ stickyTabs: { 2: 2 } });
});

test('tab removal during an existing read cannot resurrect a closed tab', async () => {
  const h = setup();
  const query = h.send('STICKY_QUERY', 2);
  const removal = h.removed(1);
  h.reads[0].resolve({ stickyTabs: { 1: 1, 2: 2 } });
  await Promise.all([query, removal]);
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: false });
  expect(h.writes.at(-1)).toEqual({ stickyTabs: { 2: 2 } });
});

test('one failed session read is retried immediately and successful hydration stays cached', async () => {
  const h = setup();
  const first = h.send('STICKY_QUERY', 1);
  h.reads[0].reject(new Error('temporary storage failure'));
  await flush();
  expect(h.reads).toHaveLength(2);
  h.reads[1].resolve({ stickyTabs: { 1: 3, 2: 'gemini' } });
  expect(await first).toMatchObject({ shouldTranslate: true, slot: 3 });
  expect(await h.send('STICKY_QUERY', 2)).toMatchObject({ shouldTranslate: false });
  expect(h.reads).toHaveLength(2);
});

test('two failed session reads fail the query and a later read can still hydrate', async () => {
  const h = setup();
  const first = h.send('STICKY_QUERY', 1);
  h.reads[0].reject(new Error('temporary storage failure'));
  await flush();
  h.reads[1].reject(new Error('temporary storage failure'));
  expect(await first).toMatchObject({ ok: false, error: 'temporary storage failure' });
  const retry = h.send('STICKY_QUERY', 1);
  await flush();
  expect(h.reads).toHaveLength(3);
  h.reads[2].resolve({ stickyTabs: { 1: 3, 2: 'gemini' } });
  expect(await retry).toMatchObject({ shouldTranslate: true, slot: 3 });
  expect(h.reads).toHaveLength(3);
});

test('a sticky write after hydration does not read session storage again', async () => {
  const h = setup();
  const first = h.send('STICKY_SET', 1, { slot: 1 });
  h.reads[0].resolve({ stickyTabs: {} });
  expect(await first).toMatchObject({ ok: true });
  const second = h.send('STICKY_CLEAR', 1);
  expect(await second).toMatchObject({ ok: true });
  expect(h.reads).toHaveLength(1);
  expect(h.writes.at(-1)).toEqual({ stickyTabs: {} });
});

test('tabs without openers do not inherit and unrelated removal preserves saved slots', async () => {
  const h = setup();
  const created = h.created({ id: 2 });
  h.reads[0].resolve({ stickyTabs: { 1: 2 } });
  await created;
  await h.removed(99);
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ slot: 2 });
  expect(await h.send('STICKY_QUERY', 2)).toMatchObject({ shouldTranslate: false });
  expect(h.writes).toHaveLength(0);
});

for (const type of ['STICKY_SET', 'STICKY_CLEAR']) {
  test(`${type} writes the merged snapshot after one transient session read failure`, async () => {
    const h = setup();
    const mutation = h.send(type, 1, { slot: 3 });
    await flush();
    expect(h.reads).toHaveLength(1);
    expect(h.writes).toHaveLength(0);
    h.reads[0].reject(new Error('temporary storage failure'));
    await flush();
    expect(h.reads).toHaveLength(2);
    expect(h.writes).toHaveLength(0);
    h.reads[1].resolve({ stickyTabs: { 1: 1, 2: 2 } });
    expect(await mutation).toMatchObject({ ok: true });
    expect(h.writes.at(-1)).toEqual({ stickyTabs: type === 'STICKY_SET' ? { 1: 3, 2: 2 } : { 2: 2 } });
    expect(h.reads).toHaveLength(2);
  });

  test(`${type} does not persist incomplete state when the session read fails twice`, async () => {
    const h = setup();
    const mutation = h.send(type, 1, { slot: 3 });
    h.reads[0].reject(new Error('temporary storage failure'));
    await flush();
    h.reads[1].reject(new Error('temporary storage failure'));
    expect(await mutation).toMatchObject({ ok: false, error: 'temporary storage failure' });
    expect(h.writes).toHaveLength(0);
    const retry = h.send(type, 1, { slot: 3 });
    await flush();
    h.reads[2].resolve({ stickyTabs: { 1: 1, 2: 2 } });
    expect(await retry).toMatchObject({ ok: true });
    expect(h.writes.at(-1)).toEqual({ stickyTabs: type === 'STICKY_SET' ? { 1: 3, 2: 2 } : { 2: 2 } });
  });
}

for (const action of ['created', 'removed']) {
  test(`${action} proceeds after one transient read failure`, async () => {
    const h = setup();
    const pending = action === 'created' ? h.created({ id: 2, openerTabId: 1 }) : h.removed(1);
    await flush();
    h.reads[0].reject(new Error('temporary storage failure'));
    await flush();
    h.reads[1].resolve({ stickyTabs: { 1: 2 } });
    await pending;
    if (action === 'created') {
      expect(h.writes.at(-1)).toEqual({ stickyTabs: { 1: 2, 2: 2 } });
      expect(await h.send('STICKY_QUERY', 2)).toMatchObject({ shouldTranslate: true, slot: 2 });
    } else {
      expect(h.writes.at(-1)).toEqual({ stickyTabs: {} });
      expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: false });
    }
  });

  test(`${action} handles two hydration failures without a write or unhandled rejection`, async () => {
    const h = setup();
    const pending = action === 'created' ? h.created({ id: 2, openerTabId: 1 }) : h.removed(1);
    h.reads[0].reject(new Error('temporary storage failure'));
    await flush();
    h.reads[1].reject(new Error('temporary storage failure'));
    await pending;
    expect(h.writes).toHaveLength(0);
    const query = h.send('STICKY_QUERY', 1);
    await flush();
    h.reads[2].resolve({ stickyTabs: { 1: 2 } });
    expect(await query).toMatchObject({ slot: 2 });
  });
}

for (const type of ['STICKY_SET', 'STICKY_CLEAR']) {
  test(`${type} reports a rejected session write and keeps the last saved map`, async () => {
    const h = setup({ rejectWrites: 1 });
    const mutation = h.send(type, 1, { slot: 3 });
    await flush();
    h.reads[0].resolve({ stickyTabs: { 1: 1, 2: 2 } });
    expect(await mutation).toMatchObject({ ok: false, error: 'quota exceeded' });
    expect(h.writes).toHaveLength(0);
    expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: true, slot: 1 });
    // The next successful write must not carry the rejected change.
    expect(await h.send('STICKY_SET', 2, { slot: 3 })).toMatchObject({ ok: true });
    expect(h.writes.at(-1)).toEqual({ stickyTabs: { 1: 1, 2: 3 } });
  });
}

test('a failed write is not persisted by a concurrent write for another tab', async () => {
  const h = setup({ gateWrites: true });
  const first = h.send('STICKY_SET', 1, { slot: 3 });
  const second = h.send('STICKY_SET', 2, { slot: 4 });
  await flush();
  h.reads[0].resolve({ stickyTabs: { 1: 1, 2: 2 } });
  await flush();
  // Only the first change is being written; the second waits for its outcome.
  expect(h.pendingWrites).toHaveLength(1);
  expect(h.pendingWrites[0].value).toEqual({ stickyTabs: { 1: 3, 2: 2 } });
  h.pendingWrites[0].gate.reject(new Error('quota exceeded'));
  expect(await first).toMatchObject({ ok: false, error: 'quota exceeded' });
  await flush();
  expect(h.pendingWrites).toHaveLength(2);
  expect(h.pendingWrites[1].value).toEqual({ stickyTabs: { 1: 1, 2: 4 } });
  h.pendingWrites[1].gate.resolve();
  expect(await second).toMatchObject({ ok: true });
  expect(h.writes.at(-1)).toEqual({ stickyTabs: { 1: 1, 2: 4 } });
});

test('a new tab does not copy a preset whose save fails', async () => {
  const h = setup({ gateWrites: true });
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  await flush();
  h.reads[0].resolve({ stickyTabs: {} });
  await flush();
  expect(h.pendingWrites).toHaveLength(1);
  const child = h.created({ id: 2, openerTabId: 1 });
  h.pendingWrites[0].gate.reject(new Error('quota exceeded'));
  expect(await set).toMatchObject({ ok: false, error: 'quota exceeded' });
  await child;
  expect(h.writes).toHaveLength(0);
  expect(h.pendingWrites).toHaveLength(1);
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: false });
  expect(await h.send('STICKY_QUERY', 2)).toMatchObject({ shouldTranslate: false });
});

test('a new tab inherits a preset only after that save commits', async () => {
  const h = setup({ gateWrites: true });
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  await flush();
  h.reads[0].resolve({ stickyTabs: { 9: 1 } });
  await flush();
  const child = h.created({ id: 2, openerTabId: 1 });
  h.pendingWrites[0].gate.resolve();
  expect(await set).toMatchObject({ ok: true });
  await flush();
  expect(h.pendingWrites[1].value).toEqual({ stickyTabs: { 1: 3, 2: 3, 9: 1 } });
  h.pendingWrites[1].gate.resolve();
  await child;
  expect(await h.send('STICKY_QUERY', 2)).toMatchObject({ shouldTranslate: true, slot: 3 });
});

test('closing a tab drops a preset that has not been applied yet', async () => {
  const h = setup();
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  const removal = h.removed(1);
  await flush();
  h.reads[0].resolve({ stickyTabs: {} });
  expect(await set).toMatchObject({ ok: false, error: 'tab closed' });
  await removal;
  expect(h.writes).toHaveLength(0);
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ shouldTranslate: false });
});

test('a child query waits for inheritance instead of missing an in-flight opener save', async () => {
  const h = setup({ gateWrites: true });
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  await flush();
  h.reads[0].resolve({ stickyTabs: {} });
  await flush();
  const child = h.created({ id: 2, openerTabId: 1 });
  let settled = false;
  const query = h.send('STICKY_QUERY', 2).then(r => { settled = true; return r; });
  await flush();
  expect(settled).toBe(false);
  h.pendingWrites[0].gate.resolve();
  await flush();
  expect(h.pendingWrites[1].value).toEqual({ stickyTabs: { 1: 3, 2: 3 } });
  h.pendingWrites[1].gate.resolve();
  expect(await query).toMatchObject({ shouldTranslate: true, slot: 3 });
  await child;
});

test('inheritance queued at creation does not overwrite the child preset', async () => {
  const h = setup({ gateWrites: true });
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  await flush();
  h.reads[0].resolve({ stickyTabs: {} });
  await flush();
  const child = h.created({ id: 2, openerTabId: 1 });
  const childSet = h.send('STICKY_SET', 2, { slot: 1 });
  h.pendingWrites[0].gate.resolve();
  await flush();
  h.pendingWrites[1].gate.resolve();
  await flush();
  h.pendingWrites[2].gate.resolve();
  expect(await childSet).toMatchObject({ ok: true });
  await child;
  expect(h.writes.at(-1)).toEqual({ stickyTabs: { 1: 3, 2: 1 } });
  expect(await h.send('STICKY_QUERY', 2)).toMatchObject({ shouldTranslate: true, slot: 1 });
});

test('STICKY_QUERY does not report a slot whose write is still in flight', async () => {
  const h = setup({ gateWrites: true });
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  await flush();
  h.reads[0].resolve({ stickyTabs: { 1: 1 } });
  await flush();
  let settled = false;
  const query = h.send('STICKY_QUERY', 1).then(r => { settled = true; return r; });
  await flush();
  expect(settled).toBe(false);
  h.pendingWrites[0].gate.reject(new Error('quota exceeded'));
  expect(await set).toMatchObject({ ok: false, error: 'quota exceeded' });
  expect(await query).toMatchObject({ shouldTranslate: true, slot: 1 });
});

test('a preset set after the tab closed is not saved', async () => {
  const h = setup();
  const removal = h.removed(1);
  h.reads[0].resolve({ stickyTabs: {} });
  await removal;
  const set = h.send('STICKY_SET', 1, { slot: 3 });
  expect(await set).toMatchObject({ ok: false, error: 'tab closed' });
  expect(h.writes).toHaveLength(0);
});

test('rolling back a failed write keeps a newer successful value for the same tab', async () => {
  const h = setup({ gateWrites: true });
  const first = h.send('STICKY_SET', 1, { slot: 3 });
  const second = h.send('STICKY_SET', 1, { slot: 4 });
  await flush();
  h.reads[0].resolve({ stickyTabs: { 1: 1 } });
  await flush();
  h.pendingWrites[0].gate.reject(new Error('quota exceeded'));
  expect(await first).toMatchObject({ ok: false });
  await flush();
  h.pendingWrites[1].gate.resolve();
  expect(await second).toMatchObject({ ok: true });
  expect(h.writes.at(-1)).toEqual({ stickyTabs: { 1: 4 } });
  expect(await h.send('STICKY_QUERY', 1)).toMatchObject({ slot: 4 });
});
