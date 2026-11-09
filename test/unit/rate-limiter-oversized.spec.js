import { test, expect } from '@playwright/test';
import { RateLimiter } from '../../shinkansen/lib/rate-limiter.js';

function setup(tpm = 100, safetyMargin = 0) {
  globalThis.chrome = {
    storage: {
      sync: { get: async () => ({}), remove: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };
  const limiter = new RateLimiter({ rpm: 10, tpm, rpd: 100, safetyMargin });
  // Persistence scheduling is unrelated to admission; avoid leaving real timers.
  limiter.scheduleRpdPersist = () => {};
  const waits = [];
  limiter.sleep = async ms => {
    waits.push(ms);
    if (waits.length > 2) throw new Error('Unbounded wait detected');
    // Model expiry without sleeping for a real minute.
    limiter.requests = [];
    limiter.tokens = [];
  };
  return { limiter, waits };
}

test('oversized request rejects without waiting or consuming budget', async () => {
  const { limiter, waits } = setup();
  await expect(limiter.acquire(101)).rejects.toThrow(RangeError);
  expect(waits).toEqual([]);
  expect(limiter.requests).toEqual([]);
  expect(limiter.tokens).toEqual([]);
  expect(limiter.rpdCount).toBe(0);
});

test('exact effective cap is admitted', async () => {
  const { limiter, waits } = setup();
  await expect(limiter.acquire(100)).resolves.toEqual({ rpdExceeded: false });
  expect(waits).toEqual([]);
  expect(limiter.currentTokenSum()).toBe(100);
});

test('ordinary token contention still waits for expiry', async () => {
  const { limiter, waits } = setup();
  await limiter.acquire(80);
  await limiter.acquire(30);
  expect(waits).toHaveLength(1);
  expect(waits[0]).toBeGreaterThan(0);
  expect(limiter.currentTokenSum()).toBe(30);
  expect(limiter.rpdCount).toBe(2);
});

test('safety margin determines the admission boundary', async () => {
  const { limiter, waits } = setup(100, 0.1);
  await expect(limiter.acquire(91)).rejects.toThrow(RangeError);
  await limiter.acquire(90);
  expect(waits).toEqual([]);
  expect(limiter.rpdCount).toBe(1);
});

test('unlimited token cap still accepts finite requests', async () => {
  const { limiter, waits } = setup(Infinity);
  await limiter.acquire(1_000_000);
  expect(waits).toEqual([]);
});

test('rejected oversized work does not prevent a smaller request', async () => {
  const { limiter, waits } = setup();
  await expect(limiter.acquire(101)).rejects.toThrow(RangeError);
  await limiter.acquire(10);
  expect(waits).toEqual([]);
  expect(limiter.rpdCount).toBe(1);
});

test('cap reductions while waiting are checked before another sleep', async () => {
  const { limiter, waits } = setup();
  await limiter.acquire(80);
  limiter.sleep = async ms => {
    waits.push(ms);
    if (waits.length > 2) throw new Error('Unbounded wait detected');
    limiter.updateLimits({ rpm: 10, tpm: 20, rpd: 100, safetyMargin: 0 });
  };
  await expect(limiter.acquire(30)).rejects.toThrow(RangeError);
  expect(waits).toHaveLength(1);
  expect(limiter.rpdCount).toBe(1);
});
