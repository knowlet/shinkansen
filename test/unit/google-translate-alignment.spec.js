import { test, expect } from '@playwright/test';
import { translateGoogleBatch } from '../../shinkansen/lib/google-translate.js';

const SEP = '\n\u2063\u2063\u2063\n';
let originalFetch;
test.beforeEach(() => { originalFetch = globalThis.fetch; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

for (const [name, translated] of [
  ['removed separator', '第一段第二段'],
  ['extra separator', ['第一段', '多出一段', '第二段'].join(SEP)],
]) {
  test(`rejects ${name} instead of returning misaligned cacheable translations`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, json: async () => [[[translated]]] };
    };
    await expect(translateGoogleBatch(['first', 'second'])).rejects.toThrow(/segment count mismatch/i);
    expect(calls).toBe(1);
  });
}

test('rejects a later invalid group rather than returning partial translations', async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const source = new URL(url).searchParams.get('q');
    const translated = calls === 1 ? source : ['wrong', 'extra'].join(SEP);
    return { ok: true, json: async () => [[[translated]]] };
  };
  await expect(translateGoogleBatch(['a'.repeat(5400), 'b'.repeat(5400)])).rejects.toThrow(/segment count mismatch/i);
  expect(calls).toBe(2);
});

test('preserves correctly aligned responses and character accounting', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => [[['第一段'], [SEP], ['第二段']]] });
  await expect(translateGoogleBatch(['first', 'second'])).resolves.toEqual({
    translations: ['第一段', '第二段'], chars: 11,
  });
});
