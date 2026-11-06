import { test, expect } from '@playwright/test';
import { RateLimiter } from '../../shinkansen/lib/rate-limiter.js';

let store;
let rpdReads;
let readRpd;
const limiters = [];

function createLimiter() {
  const limiter = new RateLimiter({
    rpm: 100,
    tpm: 1_000_000,
    rpd: 100,
    safetyMargin: 0,
  });
  limiters.push(limiter);
  return limiter;
}

test.beforeEach(() => {
  store = {};
  rpdReads = 0;
  readRpd = async () => 4;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string' && keys.startsWith('rateLimit_rpd_')) {
            rpdReads++;
            return { [keys]: await readRpd() };
          }
          if (keys === null) return { ...store };
          const result = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (key in store) result[key] = store[key];
          }
          return result;
        },
        set: async items => { Object.assign(store, items); },
        remove: async keys => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        },
      },
    },
  };
});

test.afterEach(() => {
  for (const limiter of limiters.splice(0)) clearTimeout(limiter.rpdPersistTimer);
});

test('a later acquire reloads daily usage after a transient storage read failure', async () => {
  const limiter = createLimiter();
  const error = new Error('storage temporarily unavailable');
  readRpd = async () => { throw error; };

  await expect(limiter.acquire(10)).rejects.toBe(error);
  expect(limiter.rpdLoaded).toBe(false);
  expect(limiter.requests).toEqual([]);
  expect(limiter.tokens).toEqual([]);
  expect(limiter.rpdCount).toBe(0);

  readRpd = async () => 4;
  await expect(limiter.acquire(10)).resolves.toEqual({ rpdExceeded: false });
  expect(rpdReads).toBe(2);
  expect(limiter.rpdCount).toBe(5);
  expect(limiter.requests).toHaveLength(1);
  expect(limiter.currentTokenSum()).toBe(10);
});

test('repeated storage failures do not poison the next acquisition', async () => {
  const limiter = createLimiter();
  readRpd = async () => { throw new Error(`read failure ${rpdReads}`); };

  await expect(limiter.acquire(10)).rejects.toThrow('read failure 1');
  await expect(limiter.acquire(10)).rejects.toThrow('read failure 2');
  expect(limiter.rpdLoadingPromise).toBeNull();

  readRpd = async () => 4;
  await expect(limiter.acquire(10)).resolves.toEqual({ rpdExceeded: false });
  expect(rpdReads).toBe(3);
  expect(limiter.rpdCount).toBe(5);
});

test('concurrent callers share a failed load and then one successful reload', async () => {
  const limiter = createLimiter();
  let rejectRead;
  const error = new Error('shared read failure');
  readRpd = () => new Promise((resolve, reject) => { rejectRead = reject; });

  const failed = Promise.allSettled([limiter.acquire(10), limiter.acquire(20)]);
  expect(rpdReads).toBe(1);
  rejectRead(error);
  expect(await failed).toEqual([
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ]);

  let resolveRead;
  readRpd = () => new Promise(resolve => { resolveRead = resolve; });
  const recovered = Promise.allSettled([limiter.acquire(10), limiter.acquire(20)]);
  resolveRead?.(4);
  expect(await recovered).toEqual([
    { status: 'fulfilled', value: { rpdExceeded: false } },
    { status: 'fulfilled', value: { rpdExceeded: false } },
  ]);
  expect(rpdReads).toBe(2);
  expect(limiter.rpdCount).toBe(6);
  expect(limiter.requests).toHaveLength(2);
  expect(limiter.currentTokenSum()).toBe(30);
});

test('a successful load remains cached for later acquisitions', async () => {
  const limiter = createLimiter();
  await limiter.acquire(10);
  await limiter.acquire(20);

  expect(rpdReads).toBe(1);
  expect(limiter.rpdLoadingPromise).toBeNull();
  expect(limiter.rpdCount).toBe(6);
  await limiter.persistRpd();
  expect(store[`rateLimit_rpd_${limiter.rpdDateKey}`]).toBe(6);
});
