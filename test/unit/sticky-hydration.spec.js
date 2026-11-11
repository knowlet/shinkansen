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
function setup() {
  const reads = [];
  const writes = [];
  const browser = {
    runtime: { getManifest: () => ({ version: 'test' }), onMessage: event(), onInstalled: event() },
    storage: {
      onChanged: event(),
      session: {
        get() { const gate = deferred(); reads.push(gate); return gate.promise; },
        async set(value) { writes.push(JSON.parse(JSON.stringify(value))); },
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
  return { reads, writes, send,
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

test('a failed read can be retried and successful hydration stays cached', async () => {
  const h = setup();
  const first = h.send('STICKY_QUERY', 1);
  h.reads[0].reject(new Error('temporary storage failure'));
  expect(await first).toMatchObject({ ok: false, error: 'temporary storage failure' });
  const retry = h.send('STICKY_QUERY', 1);
  expect(h.reads).toHaveLength(2);
  h.reads[1].resolve({ stickyTabs: { 1: 3, 2: 'gemini' } });
  expect(await retry).toMatchObject({ shouldTranslate: true, slot: 3 });
  expect(await h.send('STICKY_QUERY', 2)).toMatchObject({ shouldTranslate: false });
  expect(h.reads).toHaveLength(2);
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
  test(`${type} does not persist incomplete state after hydration failure`, async () => {
    const h = setup();
    const mutation = h.send(type, 1, { slot: 3 });
    h.reads[0].reject(new Error('temporary storage failure'));
    expect(await mutation).toMatchObject({ ok: false });
    expect(h.writes).toHaveLength(0);
    const retry = h.send(type, 1, { slot: 3 });
    h.reads[1].resolve({ stickyTabs: { 1: 1, 2: 2 } });
    expect(await retry).toMatchObject({ ok: true });
    expect(h.writes.at(-1)).toEqual({ stickyTabs: type === 'STICKY_SET' ? { 1: 3, 2: 2 } : { 2: 2 } });
  });
}

for (const action of ['created', 'removed']) {
  test(`${action} handles hydration failure without a write or unhandled rejection`, async () => {
    const h = setup();
    const pending = action === 'created' ? h.created({ id: 2, openerTabId: 1 }) : h.removed(1);
    h.reads[0].reject(new Error('temporary storage failure'));
    await pending;
    expect(h.writes).toHaveLength(0);
    const query = h.send('STICKY_QUERY', 1);
    h.reads[1].resolve({ stickyTabs: { 1: 2 } });
    expect(await query).toMatchObject({ slot: 2 });
  });
}
