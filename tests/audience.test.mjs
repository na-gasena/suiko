import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

test('projection stays text-only before connection, while writing and during breaks', async () => {
  await build({
    entryPoints: ['app/studio.tsx'],
    outfile: 'work/audience-test.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost:3000/?view=audience',
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
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? win : win[name],
    });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  win.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.requestAnimationFrame = (cb) =>
    setTimeout(() => cb(performance.now()), 16);
  globalThis.cancelAnimationFrame = clearTimeout;
  const drawings = [];
  win.HTMLCanvasElement.prototype.getContext = () =>
    new Proxy(
      {
        measureText: (text) => ({ width: Array.from(text).length * 34 }),
        fillText: (text) => drawings.push(text),
      },
      { get: (obj, key) => (key in obj ? obj[key] : () => {}) },
    );
  let fullscreenRequests = 0;
  document.documentElement.requestFullscreen = async () => {
    fullscreenRequests++;
  };
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: Studio } = await import('../work/audience-test.mjs');
  const root = createRoot(document.getElementById('root'));
  const channel = new BroadcastChannel('suiko-no-ato-live-v1');
  const messages = [];
  channel.onmessage = (e) => messages.push(e.data.type);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 60));
  const snapshot = {
    session: { id: 'test', number: 1, phase: 'writing', text: '雨' },
    text: '雨',
    composing: false,
    marks: [
      {
        id: 'mark',
        sessionId: 'test',
        text: '風',
        x: 92,
        y: 192,
        createdAt: 0,
        temporary: false,
      },
    ],
    settings: {
      motion: 'eraser',
      fadeSeconds: 12,
      residue: 7,
      insectSpeed: 100,
      insectWander: 100,
      floatWind: 100,
      floatLift: 100,
      invert: false,
      font: 'mincho',
      fontSize: 34,
      fontWeight: 700,
      textAlign: 'center',
      letterSpacing: 2,
      lineSpacing: 76,
      showComposition: true,
      retainComposition: false,
    },
  };
  const send = async (payload) => {
    drawings.length = 0;
    await act(async () => {
      channel.postMessage({ type: 'snapshot', payload });
      await wait();
    });
    await act(wait);
  };
  try {
    await act(async () => {
      root.render(React.createElement(Studio));
      await wait();
    });
    await act(wait);
    assert.equal(
      document.getElementById('root').textContent,
      '',
      'no loading title or connection message',
    );
    await send(snapshot);
    assert.ok(drawings.includes('雨'));
    assert.ok(drawings.includes('風'));
    assert.ok(
      drawings.every((text) => text === '雨' || text === '風'),
      'only current and erased glyphs are drawn',
    );
    assert.equal(
      document.querySelectorAll('button,output').length,
      0,
      'no controls even on hover',
    );
    assert.ok(
      messages.includes('audience_ready'),
      'connection status goes to the editor',
    );
    const audience = document.querySelector('.audience');
    const paper = document.querySelector('.audience-paper');
    const scrolls = [];
    Object.defineProperties(audience, {
      clientHeight: { configurable: true, value: 620 },
      scrollHeight: { configurable: true, value: 8000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    Object.defineProperty(paper, 'offsetTop', {
      configurable: true,
      value: 0,
    });
    paper.getBoundingClientRect = () => ({ width: 960 });
    audience.scrollTo = ({ top }) => {
      audience.scrollTop = top;
      scrolls.push(top);
    };
    const longText = '雨'.repeat(2000);
    await send({
      ...snapshot,
      text: longText,
      selectionEnd: longText.length,
      session: { ...snapshot.session, text: longText },
    });
    assert.ok(
      scrolls.some((top) => top > 0),
      'long projection follows the active end without shrinking the paper',
    );
    await send({
      ...snapshot,
      session: { ...snapshot.session, phase: 'break' },
    });
    assert.ok(!drawings.includes('休 憩'));
    assert.equal(document.getElementById('root').textContent, '');
    await send({
      ...snapshot,
      text: '',
      marks: [],
      session: { ...snapshot.session, text: '', number: 2, phase: 'ready' },
    });
    assert.equal(drawings.length, 0, 'next empty paper contains no labels');
    await act(async () => {
      document.dispatchEvent(
        new win.KeyboardEvent('keydown', { code: 'KeyF' }),
      );
      await wait();
    });
    assert.equal(fullscreenRequests, 1);
    await act(async () => {
      document.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
      await wait();
    });
    assert.equal(fullscreenRequests, 2);
    document.documentElement.requestFullscreen = async () => {
      throw new Error('denied');
    };
    await act(async () => {
      document.dispatchEvent(
        new win.KeyboardEvent('keydown', { code: 'KeyF' }),
      );
      await wait();
    });
    assert.ok(messages.includes('audience_fullscreen_error'));
    assert.equal(
      document.getElementById('root').textContent,
      '',
      'fullscreen failure never leaks onto projection',
    );
  } finally {
    channel.close();
    await act(async () => {
      root.unmount();
      await wait();
    });
    dom.window.close();
  }
});
