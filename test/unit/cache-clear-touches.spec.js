// Synthetic storage and manual 5-second timers: no browser or translation API.
import { test, expect } from '@playwright/test';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let cache, store, timers, hooks, writes, originalChrome, originalSetTimeout, originalClearTimeout;
let moduleId = 0;

test.beforeEach(async () => {
  store = { settings: { preserved: true } };
  timers = new Map();
  hooks = {};
  writes = [];
  originalChrome = globalThis.chrome;
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 5000) return originalSetTimeout(callback, delay, ...args);
    const id = {};
    timers.set(id, () => callback(...args));
    return id;
  };
  globalThis.clearTimeout = id => {
    if (!timers.delete(id)) originalClearTimeout(id);
  };
  globalThis.chrome = { storage: {
    sync: { get: async () => ({}), remove: async () => {} },
    local: {
      get: async keys => {
        const snapshot = structuredClone(keys === null ? store : Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]]),
        ));
        if (hooks.get) await hooks.get(keys);
        return snapshot;
      },
      set: async items => {
        writes.push(structuredClone(items));
        if (hooks.set) await hooks.set(items);
        Object.assign(store, structuredClone(items));
      },
      remove: async keys => {
        if (hooks.remove) await hooks.remove(keys);
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
      },
    },
  } };
  // Each test gets its own pending-touch buffer and lifecycle state.
  cache = await import(`../../shinkansen/lib/cache.js?clear-test=${++moduleId}`);
});

test.afterEach(() => {
  timers.clear();
  globalThis.chrome = originalChrome;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

async function seed() {
  const key = 'tc_' + await cache.hashText('hello');
  store[key] = { v: 'old translation', t: 1 };
  return key;
}

function flushTimers() {
  for (const [id, callback] of [...timers]) {
    timers.delete(id);
    callback();
  }
}

function expectEmpty() {
  expect(Object.keys(store).filter(k => k.startsWith('tc_') || k.startsWith('gloss_'))).toEqual([]);
  expect(store.settings).toEqual({ preserved: true });
}

test('clear cancels queued touches and does not resurrect deleted translations', async () => {
  await seed();
  expect(await cache.getBatch(['hello'])).toEqual(['old translation']);
  expect(timers.size).toBe(1);
  expect(await cache.clearAll()).toBe(1);
  flushTimers();
  await Promise.resolve();
  expectEmpty();
  expect(timers.size).toBe(0);
});

for (const kind of ['translation', 'glossary']) {
  test(`clear waits for an already-running ${kind} touch write`, async () => {
    const entered = deferred(), release = deferred();
    hooks.set = async () => { entered.resolve(); await release.promise; };
    if (kind === 'translation') {
      await seed();
      await cache.getBatch(['hello']);
      flushTimers();
    } else {
      store.gloss_example = { v: [{ source: 'hello', target: 'old' }], t: 1 };
      await cache.getGlossary('example');
    }
    await entered.promise;
    let clearSettled = false;
    const clearing = cache.clearAll().then(value => { clearSettled = true; return value; });
    // Drain microtasks while the storage write remains explicitly blocked.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const settledBeforeWrite = clearSettled;
    release.resolve();
    await clearing;
    await Promise.resolve();
    expect(settledBeforeWrite).toBe(false);
    expectEmpty();
  });

  for (const timing of ['before clear', 'during clear']) {
    test(`${kind} read started ${timing} cannot queue a stale touch after clear`, async () => {
      await seed();
      store.gloss_example = { v: [{ source: 'hello', target: 'old' }], t: 1 };
      const readEntered = deferred(), releaseRead = deferred();
      const removeEntered = deferred(), releaseRemove = deferred();
      hooks.get = async keys => {
        if (Array.isArray(keys) || keys === 'gloss_example') {
          readEntered.resolve();
          await releaseRead.promise;
        }
      };
      hooks.remove = async () => { removeEntered.resolve(); await releaseRemove.promise; };
      const read = () => kind === 'translation' ? cache.getBatch(['hello']) : cache.getGlossary('example');
      let reading, clearing;
      if (timing === 'before clear') {
        reading = read();
        await readEntered.promise;
        clearing = cache.clearAll();
        await removeEntered.promise;
      } else {
        clearing = cache.clearAll();
        await removeEntered.promise;
        reading = read();
        await readEntered.promise;
      }
      releaseRemove.resolve();
      await clearing;
      releaseRead.resolve();
      await reading;
      flushTimers();
      await Promise.resolve();
      expectEmpty();
      expect(writes).toEqual([]);
    });
  }
}

test('concurrent clears suppress touches until both finish and allow later reads', async () => {
  const key = await seed();
  await cache.getBatch(['hello']);
  const firstEntered = deferred(), secondEntered = deferred();
  const releaseFirst = deferred(), releaseSecond = deferred();
  let removes = 0;
  hooks.remove = async () => {
    if (++removes === 1) { firstEntered.resolve(); await releaseFirst.promise; }
    else { secondEntered.resolve(); await releaseSecond.promise; }
  };
  const first = cache.clearAll();
  await firstEntered.promise;
  const second = cache.clearAll();
  await secondEntered.promise;
  releaseFirst.resolve();
  await first;
  store[key] = { v: 'read while second clear is active', t: 1 };
  await cache.getBatch(['hello']);
  flushTimers();
  releaseSecond.resolve();
  await second;
  expectEmpty();
  expect(writes).toEqual([]);
  hooks.remove = null;
  await cache.setBatch(['hello'], ['fresh']);
  expect(await cache.getBatch(['hello'])).toEqual(['fresh']);
  expect(timers.size).toBe(1);
  flushTimers();
  await Promise.resolve();
  expect(store[key].v).toBe('fresh');
  expect(await cache.clearAll()).toBe(1);
  expect(await cache.clearAll()).toBe(0);
  expectEmpty();
});

for (const operation of ['get', 'remove']) {
  test(`clear ${operation} failure releases touch suppression for subsequent reads`, async () => {
    const key = await seed();
    const failure = new Error(`synthetic ${operation} failure`);
    hooks[operation] = async () => { throw failure; };
    await expect(cache.clearAll()).rejects.toThrow(failure.message);
    hooks[operation] = null;
    expect(await cache.getBatch(['hello'])).toEqual(['old translation']);
    expect(timers.size).toBe(1);
    flushTimers();
    await Promise.resolve();
    expect(store[key].t).toBeGreaterThan(1);
    expect(await cache.clearAll()).toBe(1);
    expectEmpty();
  });
}

test('a rejected in-flight touch does not reject or strand clear', async () => {
  await seed();
  const entered = deferred(), release = deferred();
  hooks.set = async () => { entered.resolve(); await release.promise; };
  await cache.getBatch(['hello']);
  flushTimers();
  await entered.promise;
  const clearing = cache.clearAll();
  release.reject(new Error('synthetic touch failure'));
  await expect(clearing).resolves.toBe(1);
  expectEmpty();
  hooks.set = null;
  await cache.setBatch(['hello'], ['fresh']);
  expect(await cache.getBatch(['hello'])).toEqual(['fresh']);
  flushTimers();
  await Promise.resolve();
  expect(Object.values(store).some(v => v?.v === 'fresh')).toBe(true);
});

test('version-triggered clearing cannot be undone by a queued touch', async () => {
  await seed();
  store.__cacheVersion = 'old';
  await cache.getBatch(['hello']);
  expect(await cache.checkVersionAndClear('new')).toEqual({ cleared: true, removed: 1, oldVersion: 'old' });
  flushTimers();
  await Promise.resolve();
  expectEmpty();
  expect(store.__cacheVersion).toBe('new');
});
