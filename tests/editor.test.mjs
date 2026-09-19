import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { build } from 'esbuild';

test('editor: IME commit, trace persistence, break, restore, projection and CSV', async () => {
  await build({
    entryPoints: ['app/studio.tsx'],
    outfile: 'work/studio-test.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost:3000/',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  for (const name of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'HTMLTextAreaElement',
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? win : win[name],
    });
  Object.assign(globalThis, {
    indexedDB,
    IDBKeyRange,
    localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  globalThis.requestAnimationFrame = (cb) =>
    setTimeout(() => cb(performance.now()), 16);
  globalThis.cancelAnimationFrame = clearTimeout;
  win.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  win.HTMLCanvasElement.prototype.getContext = () =>
    new Proxy(
      { measureText: (text) => ({ width: Array.from(text).length * 34 }) },
      { get: (obj, key) => (key in obj ? obj[key] : () => {}) },
    );
  let held = false;
  navigator.locks = {
    request: async (_name, _opts, fn) => {
      if (held) return fn(null);
      held = true;
      try {
        return await fn({ name: 'test' });
      } finally {
        held = false;
      }
    },
  };
  let exported;
  URL.createObjectURL = (blob) => {
    exported = blob;
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = () => {};
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: Studio } = await import('../work/studio-test.mjs');
  let root = createRoot(document.getElementById('root'));
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 40));
  const flush = async () => {
    await act(sleep);
    await act(sleep);
  };
  const change = async (value, inputType = 'insertText') => {
    await act(async () => {
      const input = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(
        win.HTMLTextAreaElement.prototype,
        'value',
      ).set.call(input, value);
      input.dispatchEvent(
        new win.InputEvent('input', { bubbles: true, inputType }),
      );
      await sleep();
    });
  };
  const composition = async (type, data) => {
    await act(async () => {
      document
        .querySelector('textarea')
        .dispatchEvent(new win.CompositionEvent(type, { bubbles: true, data }));
      await sleep();
    });
  };
  const click = async (label) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === label,
    );
    assert.ok(button, `button ${label} exists`);
    await act(async () => {
      button.click();
      await sleep();
    });
  };
  const clickAria = async (label) => {
    const button = document.querySelector(`[aria-label="${label}"]`);
    assert.ok(button, `button ${label} exists`);
    await act(async () => {
      button.click();
      await sleep();
    });
  };
  const read = async (store) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('suiko-no-ato-v1', 1);
      req.onsuccess = () => {
        const db = req.result;
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => {
          resolve(q.result);
          db.close();
        };
        q.onerror = () => reject(q.error);
      };
      req.onerror = () => reject(req.error);
    });
  const observer = new BroadcastChannel('suiko-no-ato-live-v1');
  let projection;
  observer.onmessage = (e) => {
    if (e.data.type === 'snapshot') projection = e.data.payload;
  };
  try {
    await act(async () => {
      root.render(React.createElement(Studio));
      await sleep();
    });
    await flush();
    assert.ok(
      document.querySelector('textarea'),
      'editor boots with a writable textarea',
    );
    assert.equal(document.querySelector('textarea').disabled, false);
    assert.equal(document.querySelectorAll('textarea').length, 1);
    assert.ok(
      document.querySelector('.paper textarea'),
      'writing and marks share one paper',
    );
    assert.equal(document.querySelector('.controls textarea'), null);
    assert.ok(
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent.includes('別ウィンドウ'),
      ),
    );
    assert.equal(
      document.querySelector('.settings'),
      null,
      'settings stay hidden',
    );
    const settingsButton = document.querySelector('[aria-label="設定を表示"]');
    assert.ok(settingsButton, 'settings have a compact entry point');
    await act(async () => {
      settingsButton.click();
      await sleep();
    });
    assert.ok(document.querySelector('.settings'));
    assert.equal(document.querySelectorAll('.numeric-setting').length, 4);
    const fadeInput = document.querySelector('#fade-seconds');
    assert.equal(fadeInput.max, '3600');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        win.HTMLInputElement.prototype,
        'value',
      ).set.call(fadeInput, '450');
      fadeInput.dispatchEvent(new win.InputEvent('input', { bubbles: true }));
      await sleep();
    });
    assert.equal(
      JSON.parse(localStorage.getItem('suiko-settings')).fadeSeconds,
      450,
    );
    assert.equal(
      fadeInput.value,
      '450',
      'manual value can exceed slider range',
    );
    assert.equal(document.querySelector('#letter-spacing').type, 'number');
    assert.equal(document.querySelector('#line-spacing').type, 'number');
    await act(async () => {
      const weight = document.querySelector('#font-weight');
      weight.value = '700';
      weight.dispatchEvent(new win.Event('change', { bubbles: true }));
      const align = document.querySelector('#text-align');
      align.value = 'center';
      align.dispatchEvent(new win.Event('change', { bubbles: true }));
      await sleep();
    });
    assert.equal(document.querySelector('textarea').style.fontWeight, '700');
    assert.equal(document.querySelector('textarea').style.textAlign, 'center');
    await act(async () => {
      document.querySelector('[aria-label="設定を隠す"]').click();
      await sleep();
    });
    assert.equal(document.querySelector('.settings'), null);
    assert.ok(!document.body.textContent.includes('言葉と、その手前'));
    await change('雨');
    await composition('compositionstart', '');
    await change('雨か', 'insertCompositionText');
    await composition('compositionupdate', 'か');
    await change('雨かぜ', 'insertCompositionText');
    await composition('compositionupdate', 'かぜ');
    await change('雨風', 'insertCompositionText');
    await composition('compositionupdate', '風');
    await composition('compositionend', '風');
    await change('雨風', 'insertFromComposition');
    await flush();
    const events = await read('events');
    assert.equal(
      events.filter((e) => e.type === 'composition_commit').length,
      1,
      'native final input must not duplicate the IME commit',
    );
    assert.equal(
      events.some((e) => e.type === 'composition_update'),
      false,
      'intermediate IME events stay out of the saved history',
    );
    assert.equal(
      (await read('marks')).length,
      0,
      'unconfirmed candidates must not become permanent traces',
    );
    assert.equal(
      projection.text,
      '雨風',
      'projection receives the live full text',
    );
    assert.equal(
      projection.settings.fontWeight,
      700,
      'projection receives weight',
    );
    assert.equal(
      projection.settings.textAlign,
      'center',
      'projection receives alignment',
    );
    await clickAria('一時停止');
    await flush();
    assert.equal((await read('sessions'))[0].phase, 'break');
    await change('雨', 'deleteContentBackward');
    await flush();
    assert.equal(
      (await read('sessions'))[0].phase,
      'writing',
      'ordinary edits resume timer',
    );
    assert.equal((await read('marks')).length, 1);
    assert.equal((await read('marks'))[0].text, '風');
    await clickAria('一時停止');
    await flush();
    assert.equal(document.querySelector('textarea').disabled, false);
    const paused = (await read('sessions'))[0];
    assert.equal(paused.phase, 'break');
    assert.equal(paused.activeSince, null);
    await act(async () => {
      root.unmount();
      await sleep();
    });
    root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(React.createElement(Studio));
      await sleep();
    });
    await flush();
    assert.equal(
      document.querySelector('textarea').value,
      '雨',
      'confirmed text restores',
    );
    assert.equal(
      document.querySelector('textarea').disabled,
      false,
      'paused editor remains editable after reload',
    );
    assert.ok(
      document.querySelector('.paper-bottom').textContent.includes('1 文字'),
      'marks restore',
    );
    assert.equal((await read('sessions'))[0].phase, 'break');
    assert.equal(
      document.querySelector('textarea').style.fontWeight,
      '700',
      'weight restores',
    );
    assert.equal(
      document.querySelector('textarea').style.textAlign,
      'center',
      'alignment restores',
    );
    await act(async () => document.querySelector('textarea').focus());
    assert.equal(
      (await read('sessions'))[0].phase,
      'break',
      'focus alone keeps timer paused',
    );
    assert.equal(document.querySelector('textarea').disabled, false);
    await composition('compositionstart', '');
    await flush();
    assert.equal(
      (await read('sessions'))[0].phase,
      'writing',
      'IME typing resumes timer',
    );
    assert.equal(
      (await read('sessions'))[0].activeMs,
      paused.activeMs,
      'pause time is excluded',
    );
    await change('雨か', 'insertCompositionText');
    await composition('compositionupdate', 'か');
    await change('雨', 'deleteCompositionText');
    await composition('compositionend', '');
    await flush();
    assert.equal(
      (await read('marks')).length,
      1,
      'cancelled composition adds no permanent trace',
    );
    assert.equal(
      (await read('events')).some((e) => e.type === 'composition_cancel'),
      false,
    );
    await click('CSV出力');
    await flush();
    assert.ok(exported, 'CSV download is produced');
    const csv = await exported.text();
    assert.ok(csv.includes('"入力"'));
    assert.ok(!csv.includes('break_start'));
    assert.ok(!csv.includes('composition_update'));
    assert.ok(csv.includes('風'));
    assert.ok(csv.includes('推敲時間'));
    assert.equal(
      document.querySelectorAll('[role="alert"]').length,
      0,
      'no save error',
    );
    await click('新しく書く');
    await flush();
    await click('次へ');
    await flush();
    assert.equal(
      document.querySelector('textarea').value,
      '',
      'next session starts with empty paper',
    );
    assert.equal((await read('sessions')).length, 2);
    assert.equal(
      (await read('sessions')).find((s) => s.number === 1).phase,
      'ended',
    );
    await click('履歴');
    await flush();
    await click('01');
    await flush();
    assert.ok(
      document
        .querySelector('[data-slot="sheet-content"]')
        .textContent.includes('入力'),
      'archive opens with committed changes',
    );
    const closeTab = async (number) => {
      const button = document.querySelector(
        '[aria-label="' + number + 'を削除"]',
      );
      assert.ok(button);
      await act(async () => {
        button.click();
        await sleep();
      });
      await flush();
    };
    const oldEvents = (await read('events')).filter(
      (e) => e.sessionNumber === 1,
    );
    await closeTab('01');
    assert.equal(
      (await read('sessions')).some((s) => s.number === 1),
      false,
    );
    assert.equal(
      (await read('events')).some((e) => e.sessionNumber === 1),
      false,
    );
    assert.equal((await read('marks')).length, 0);
    assert.equal(document.querySelector('[aria-label="01を削除"]'), null);
    await click('CSV出力');
    assert.ok(
      !(await exported.text()).includes('composition_commit'),
      'deleted sessions excluded from full CSV',
    );
    await click('削除を取り消す');
    await flush();
    assert.ok(document.querySelector('[aria-label="01を削除"]'));
    assert.deepEqual(
      (await read('events'))
        .filter((e) => e.sessionNumber === 1)
        .sort((a, b) => a.sequence - b.sequence),
      oldEvents.sort((a, b) => a.sequence - b.sequence),
    );
    assert.equal((await read('marks')).length, 1);
    await closeTab('02');
    assert.equal(
      (await read('sessions')).some((s) => s.number === 2),
      false,
    );
    assert.equal(
      (await read('sessions')).find((s) => s.number === 3).phase,
      'ready',
    );
    assert.equal(document.querySelector('textarea').value, '');
    assert.equal(projection.session.number, 3);
    await click('削除を取り消す');
    await flush();
    assert.equal(
      (await read('sessions')).find((s) => s.number === 2).phase,
      'ended',
    );
    assert.equal(
      projection.session.number,
      3,
      'undo leaves current writing session intact',
    );
    await closeTab('01');
    await act(async () => {
      root.unmount();
      await sleep();
    });
    root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(React.createElement(Studio));
      await sleep();
    });
    await flush();
    await click('履歴');
    await flush();
    assert.equal(
      document.querySelector('[aria-label="01を削除"]'),
      null,
      'closed history stays deleted after reload',
    );
    assert.ok(document.querySelector('[aria-label="03を削除"]'));
  } finally {
    observer.close();
    await act(async () => {
      root.unmount();
      await sleep();
    });
    dom.window.close();
  }
});
