import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../shinkansen/lib/rate-limiter.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export class RateLimiter', 'class RateLimiter');
const beforeMidnight = Date.parse('2026-11-13T07:59:50Z');
const afterMidnight = Date.parse('2026-11-13T08:00:50.005Z');
const oldKey = 'rateLimit_rpd_20261112';
const newKey = 'rateLimit_rpd_20261113';
function setup({ rpm = 1, tpm = 100, rpd = 1 } = {}) {
  let now = beforeMidnight;
  const store = { [oldKey]: 7 };
  const local = {
    get: async key => key === null ? { ...store } : { [key]: store[key] },
    set: async items => { Object.assign(store, items); },
    remove: async keys => { for (const key of keys) delete store[key]; },
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({ Date: ClockDate, Intl,
    browser: { storage: { local } }, debugLog() {}, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(`${source}\nglobalThis.RateLimiter = RateLimiter;`, context);
  const limiter = new context.RateLimiter({ rpm, tpm, rpd, safetyMargin: 0 });
  return { limiter, store, local, advance(ms) { now += ms; }, setTime(value) { now = value; } };
}
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

for (const dimension of ['rpm', 'tpm']) {
  test(`${dimension} wait crossing midnight accounts to the new Pacific day`, async () => {
    const h = setup(dimension === 'tpm' ? { rpm: 100, tpm: 1 } : {});
    await h.limiter.acquire(1);
    h.limiter.sleep = async ms => { h.advance(ms); };
    expect((await h.limiter.acquire(1)).rpdExceeded).toBe(false);
    expect(h.limiter.snapshot().rpdDateKey).toBe('20261113');
    expect(h.limiter.snapshot().rpdUsed).toBe(1);
    await h.limiter.persistRpd();
    expect(h.store[newKey]).toBe(1);
    expect((await h.limiter.acquire(1)).rpdExceeded).toBe(true);
    expect(h.limiter.snapshot().rpdUsed).toBe(2);
  });
}

test('concurrent midnight waiters recheck slots after asynchronous rollover', async () => {
  const h = setup();
  await h.limiter.acquire(1);
  const sleeps = [];
  h.limiter.sleep = () => { const g = gate(); sleeps.push(g); return g.promise; };
  const admitted = [];
  const a = h.limiter.acquire(1).then(r => admitted.push(r));
  const b = h.limiter.acquire(1).then(r => admitted.push(r));
  await settle();
  expect(sleeps).toHaveLength(2);
  h.setTime(afterMidnight);
  for (const g of sleeps.slice()) g.resolve();
  await settle();
  expect(admitted).toHaveLength(1);
  expect(admitted[0].rpdExceeded).toBe(false);
  expect(h.limiter.snapshot().rpdUsed).toBe(1);
  expect(h.limiter.snapshot().rpmUsed).toBe(1);
  expect(sleeps).toHaveLength(3);
  h.advance(60_005);
  sleeps[2].resolve();
  await Promise.all([a, b]);
  expect(admitted[1].rpdExceeded).toBe(true);
  expect(h.limiter.snapshot().rpdUsed).toBe(2);
});

test('initial storage read spanning midnight is rechecked before admission', async () => {
  const h = setup();
  const g = gate();
  const get = h.local.get;
  h.local.get = async key => { if (key === oldKey) await g.promise; return get(key); };
  const pending = h.limiter.acquire(1);
  h.setTime(afterMidnight);
  g.resolve();
  expect((await pending).rpdExceeded).toBe(false);
  expect(h.limiter.snapshot().rpdUsed).toBe(1);
  expect(h.limiter.snapshot().rpdDateKey).toBe('20261113');
});

test('rollover persistence failure rejects without reserving a slot', async () => {
  const h = setup();
  await h.limiter.acquire(1);
  h.limiter.sleep = async ms => { h.advance(ms); };
  const error = new Error('offline storage failure');
  h.local.set = async () => { throw error; };
  await expect(h.limiter.acquire(1)).rejects.toThrow(error.message);
  expect(h.limiter.rpdCount).toBe(0);
  expect(h.limiter.requests).toHaveLength(1);
  expect(h.limiter.tokens).toHaveLength(1);
});

test('same-day soft warning and exact slot limits are unchanged', async () => {
  const h = setup({ rpm: 2, rpd: 8 });
  expect((await h.limiter.acquire(1)).rpdExceeded).toBe(false);
  expect((await h.limiter.acquire(1)).rpdExceeded).toBe(true);
  expect(h.limiter.computeWaitMs(1)).toBeGreaterThan(0);
  expect(h.limiter.rpdCount).toBe(9);
});

test('initial read failure still rejects without consuming budget', async () => {
  const h = setup();
  h.local.get = async () => { throw new Error('read failed'); };
  await expect(h.limiter.acquire(1)).rejects.toThrow('read failed');
  expect(h.limiter.requests).toHaveLength(0);
  expect(h.limiter.tokens).toHaveLength(0);
  expect(h.limiter.rpdCount).toBe(0);
});

test('rollover persistence spanning another midnight rechecks the day', async () => {
  const h = setup({ rpm: 100 });
  await h.limiter.acquire(1);
  h.setTime(afterMidnight);
  const g = gate();
  const set = h.local.set;
  h.local.set = async items => { if (newKey in items) await g.promise; return set(items); };
  const pending = h.limiter.acquire(1);
  await settle();
  h.advance(24 * 60 * 60 * 1000);
  g.resolve();
  expect((await pending).rpdExceeded).toBe(false);
  expect(h.limiter.snapshot().rpdDateKey).toBe('20261114');
  expect(h.limiter.rpdCount).toBe(1);
});
