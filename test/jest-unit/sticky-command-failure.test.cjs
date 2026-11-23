'use strict';

/**
 * STICKY_SET / STICKY_CLEAR 的回應必須進到畫面。
 * 背景回 ok:false 或 sendMessage reject 時，不能再顯示成功，並收回樂觀更新的狀態。
 */

const { JSDOM } = require('jsdom');
const { createEnv, waitForCondition, contentScriptCodes } = require('./helpers/create-env.cjs');

function watchToasts(win) {
  const calls = [];
  const orig = win.__SK.showToast;
  win.__SK.showToast = function showToast(kind, msg, opts) {
    calls.push({ kind, msg, opts });
    return orig.apply(this, arguments);
  };
  return calls;
}

function addParagraph(env) {
  const p = env.document.createElement('p');
  p.textContent = 'Hello world this is a long paragraph for testing purposes only.';
  env.document.body.appendChild(p);
  return p;
}

const pageUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  billedInputTokens: 0,
  billedCostUSD: 0,
  costUSD: 0,
  cacheHits: 0,
};

function stubGemini(env, p) {
  env.window.__SK.collectParagraphs = () => [{ kind: 'element', el: p }];
  env.window.__SK.translateUnits = async () => ({
    done: 1, failures: [], pageUsage, rpdWarning: false,
  });
}

function stubGoogle(env, p) {
  env.window.__SK.collectParagraphs = () => [{ kind: 'element', el: p }];
  env.window.__SK.translateUnitsGoogle = async () => ({ done: 1, failures: [], chars: 12 });
}

function restoreViaDebug(env) {
  env.window.dispatchEvent(new env.window.CustomEvent('shinkansen-debug-request', {
    detail: { action: 'RESTORE' },
  }));
}

describe('sticky command failure is shown and reverted', () => {
  let env;

  afterEach(() => {
    if (!env) return;
    env.window.__SK.cancelRescan?.();
    env.cleanup();
    env = null;
  });

  test('STICKY_CLEAR ok:false restores the translated page and shows an error', async () => {
    env = createEnv();
    const p = addParagraph(env);
    env.shinkansen.testInject(p, '你好世界，這是一段僅用於測試的長段落。');
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true, stickySlot: 2 });
    const translatedHTML = p.innerHTML;

    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_CLEAR') {
        return Promise.resolve({ ok: false, error: 'temporary storage failure' });
      }
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);
    restoreViaDebug(env);

    const shown = await waitForCondition(() => toasts.some(
      t => t.kind === 'error' && t.msg.includes('已恢復翻譯內容') && t.opts?.detail === 'temporary storage failure',
    ));
    expect(shown).toBe(true);
    expect(toasts.some(t => t.kind === 'success' && t.msg.includes('已還原原文'))).toBe(false);

    const state = env.shinkansen.getState();
    expect(state.translated).toBe(true);
    expect(state.stickyTranslate).toBe(true);
    expect(state.stickySlot).toBe(2);
    expect(p.innerHTML).toBe(translatedHTML);
    expect(p.getAttribute('data-shinkansen-translated')).toBe('1');
  });

  test('STICKY_CLEAR rejection restores the translated page and shows an error', async () => {
    env = createEnv();
    const p = addParagraph(env);
    env.shinkansen.testInject(p, '你好世界，這是一段僅用於測試的長段落。');
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true, stickySlot: 1 });

    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_CLEAR') return Promise.reject(new Error('port closed'));
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);
    restoreViaDebug(env);

    const shown = await waitForCondition(() => toasts.some(
      t => t.kind === 'error' && t.opts?.detail === 'port closed',
    ));
    expect(shown).toBe(true);
    expect(env.shinkansen.getState()).toMatchObject({
      translated: true, stickyTranslate: true, stickySlot: 1,
    });
    expect(toasts.some(t => t.kind === 'success')).toBe(false);
  });

  test('STICKY_CLEAR ok:true keeps the page restored and shows success', async () => {
    env = createEnv();
    const p = addParagraph(env);
    env.shinkansen.testInject(p, '你好世界，這是一段僅用於測試的長段落。');
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true, stickySlot: 2 });

    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_CLEAR') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);
    restoreViaDebug(env);

    const shown = await waitForCondition(() => toasts.some(
      t => t.kind === 'success' && t.msg === '已還原原文',
    ));
    expect(shown).toBe(true);
    expect(toasts.some(t => t.kind === 'error')).toBe(false);
    expect(env.shinkansen.getState()).toMatchObject({
      translated: false, stickyTranslate: false, stickySlot: null,
    });
    expect(p.getAttribute('data-shinkansen-translated')).toBeNull();
    expect(p.textContent).toContain('Hello world');
  });

  test('STICKY_SET ok:false keeps the translation, clears sticky, and does not show success', async () => {
    env = createEnv();
    const p = addParagraph(env);
    stubGemini(env, p);
    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_SET') {
        return Promise.resolve({ ok: false, error: 'temporary storage failure' });
      }
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);

    await env.window.__SK.translatePage({ slot: 1 });

    expect(env.shinkansen.getState()).toMatchObject({
      translated: true, stickyTranslate: false, stickySlot: null,
    });
    expect(toasts.some(t => t.kind === 'error' && t.msg.includes('未能儲存') && t.opts?.detail === 'temporary storage failure')).toBe(true);
    expect(toasts.some(t => t.kind === 'success' && String(t.msg).includes('翻譯完成'))).toBe(false);
  });

  test('STICKY_SET rejection on the Google path reverts sticky and shows an error', async () => {
    env = createEnv();
    const p = addParagraph(env);
    stubGoogle(env, p);
    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_SET') return Promise.reject(new Error('port closed'));
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);

    await env.window.__SK.translatePageGoogle({ slot: 3 });

    expect(env.shinkansen.getState()).toMatchObject({
      translated: true, stickyTranslate: false, stickySlot: null,
    });
    expect(toasts.some(t => t.kind === 'error' && t.opts?.detail === 'port closed')).toBe(true);
    expect(toasts.some(t => t.kind === 'success' && String(t.msg).includes('翻譯完成'))).toBe(false);
  });

  test('STICKY_SET ok:true shows translation success and keeps the slot', async () => {
    env = createEnv();
    const p = addParagraph(env);
    stubGemini(env, p);
    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_SET') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);

    await env.window.__SK.translatePage({ slot: 1 });

    expect(env.shinkansen.getState()).toMatchObject({
      translated: true, stickyTranslate: true, stickySlot: 1,
    });
    expect(toasts.some(t => t.kind === 'success' && String(t.msg).includes('翻譯完成'))).toBe(true);
    expect(toasts.some(t => t.kind === 'error' && t.msg.includes('未能儲存'))).toBe(false);
  });

  test('failed STICKY_CLEAR restarts the SPA observer and late-content rescan it stopped', async () => {
    env = createEnv();
    const p = addParagraph(env);
    env.shinkansen.testInject(p, '你好世界，這是一段僅用於測試的長段落。');
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true, stickySlot: 2 });
    env.window.__SK.startSpaObserver();
    expect(env.window.__SK.isSpaObserverActive()).toBe(true);

    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_CLEAR') {
        return Promise.resolve({ ok: false, error: 'temporary storage failure' });
      }
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);
    restoreViaDebug(env);

    const shown = await waitForCondition(() => toasts.some(t => t.kind === 'error'));
    expect(shown).toBe(true);
    expect(env.shinkansen.getState().translated).toBe(true);
    expect(env.window.__SK.isSpaObserverActive()).toBe(true);
    env.window.__SK.stopSpaObserver();
  });

  test('RESTORE debug command reports a failed STICKY_CLEAR instead of success', async () => {
    env = createEnv();
    const p = addParagraph(env);
    env.shinkansen.testInject(p, '你好世界，這是一段僅用於測試的長段落。');
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true, stickySlot: 2 });
    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_CLEAR') {
        return Promise.resolve({ ok: false, error: 'temporary storage failure' });
      }
      return Promise.resolve({ ok: true });
    });
    const responses = [];
    env.window.addEventListener('shinkansen-debug-response', (e) => responses.push(e.detail));
    restoreViaDebug(env);

    const answered = await waitForCondition(() => responses.length > 0);
    expect(answered).toBe(true);
    expect(responses[0]).toMatchObject({ ok: false, error: 'temporary storage failure' });
    expect(env.shinkansen.getState().translated).toBe(true);
  });

  test('restore during a pending STICKY_SET does not restart the SPA observer', async () => {
    env = createEnv();
    const p = addParagraph(env);
    stubGemini(env, p);
    let finishSet;
    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_SET') {
        return new Promise((resolve) => { finishSet = () => resolve({ ok: true }); });
      }
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);

    const translating = env.window.__SK.translatePage({ slot: 1 });
    const pending = await waitForCondition(() => typeof finishSet === 'function');
    expect(pending).toBe(true);
    restoreViaDebug(env);
    const restored = await waitForCondition(() => toasts.some(
      t => t.kind === 'success' && t.msg === '已還原原文',
    ));
    expect(restored).toBe(true);

    finishSet();
    await translating;
    expect(env.shinkansen.getState().translated).toBe(false);
    expect(env.window.__SK.isSpaObserverActive()).toBe(false);
  });

  test('switching to Google waits for sticky clear and keeps the page when it fails', async () => {
    env = createEnv();
    const p = addParagraph(env);
    env.shinkansen.testInject(p, '你好世界，這是一段僅用於測試的長段落。');
    env.shinkansen.setTestState({ translated: true, stickyTranslate: true, stickySlot: 1 });
    const translatedHTML = p.innerHTML;
    let googleCalls = 0;
    env.window.__SK.translateUnitsGoogle = async () => {
      googleCalls += 1;
      return { done: 1, failures: [], chars: 4 };
    };
    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_CLEAR') {
        return Promise.resolve({ ok: false, error: 'temporary storage failure' });
      }
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);

    await env.window.__SK.translatePageGoogle({ slot: 3 });

    expect(googleCalls).toBe(0);
    expect(env.shinkansen.getState().translated).toBe(true);
    expect(p.innerHTML).toBe(translatedHTML);
    expect(toasts.some(t => t.kind === 'error' && t.msg.includes('已恢復翻譯內容'))).toBe(true);
    expect(toasts.some(t => t.kind === 'success' && String(t.msg).includes('Google 翻譯完成'))).toBe(false);
  });

  test('failed clear during an in-flight rescan schedules the rescan again', async () => {
    env = createEnv();
    const p = addParagraph(env);
    stubGemini(env, p);
    env.window.__SK.RESCAN_DELAYS_MS = [0, 60_000];
    let calls = 0;
    let releaseRescan;
    env.window.__SK.translateUnits = async () => {
      calls += 1;
      if (calls === 1) {
        return { done: 1, failures: [], pageUsage, rpdWarning: false };
      }
      if (calls === 2) {
        return new Promise((resolve) => {
          releaseRescan = () => resolve({ done: 0, failures: [] });
        });
      }
      return { done: 0, failures: [] };
    };
    let finishClear;
    env.chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.type === 'STICKY_SET') return Promise.resolve({ ok: true });
      if (msg?.type === 'STICKY_CLEAR') {
        return new Promise((resolve) => {
          finishClear = () => resolve({ ok: false, error: 'temporary storage failure' });
        });
      }
      return Promise.resolve({ ok: true });
    });
    const toasts = watchToasts(env.window);

    await env.window.__SK.translatePage({ slot: 1 });
    const rescanStarted = await waitForCondition(() => calls === 2 && typeof releaseRescan === 'function');
    expect(rescanStarted).toBe(true);

    restoreViaDebug(env);
    const clearPending = await waitForCondition(() => typeof finishClear === 'function');
    expect(clearPending).toBe(true);
    releaseRescan();
    await new Promise(r => setImmediate(r));
    const callsAfterBail = calls;

    finishClear();
    const shown = await waitForCondition(() => toasts.some(
      t => t.kind === 'error' && t.msg.includes('已恢復翻譯內容'),
    ));
    expect(shown).toBe(true);
    const restarted = await waitForCondition(() => calls > callsAfterBail);
    expect(restarted).toBe(true);
    expect(env.shinkansen.getState().translated).toBe(true);
  });

  test('reload STICKY_CLEAR ok:false shows an error instead of a cleared log', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://example.com/reloaded',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    const win = dom.window;
    const origGet = win.performance.getEntriesByType?.bind(win.performance);
    win.performance.getEntriesByType = (type) => {
      if (type === 'navigation') return [{ type: 'reload' }];
      return origGet ? origGet(type) : [];
    };
    let finishClear;
    const logs = [];
    win.chrome = {
      runtime: {
        sendMessage: jest.fn().mockImplementation((msg) => {
          if (msg?.type === 'LOG') logs.push(msg.payload?.message);
          if (msg?.type === 'STICKY_CLEAR') {
            return new Promise((resolve) => {
              finishClear = () => resolve({ ok: false, error: 'temporary storage failure' });
            });
          }
          return Promise.resolve({ ok: true });
        }),
        getManifest: jest.fn().mockReturnValue({ version: 'test' }),
        onMessage: { addListener: jest.fn() },
      },
      storage: {
        sync: { get: jest.fn().mockImplementation(() => Promise.resolve({})) },
        onChanged: { addListener: jest.fn() },
      },
    };
    for (const code of contentScriptCodes) win.eval(code);

    const toasts = watchToasts(win);
    finishClear();
    const shown = await waitForCondition(() => toasts.some(
      t => t.kind === 'error' && t.msg.includes('重新載入後未能清除'),
    ));
    expect(shown).toBe(true);
    expect(logs).toContain('page reload, sticky clear failed');
    expect(logs).not.toContain('page reload, sticky cleared');
    win.close();
  });
});
