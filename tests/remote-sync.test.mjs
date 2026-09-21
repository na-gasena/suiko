import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRemoteAccess,
  readRemoteAccess,
  RemoteConnection,
  remoteLinks,
} from '../lib/remote-sync.ts';
import { decompressSnapshot } from '../lib/snapshot-codec.ts';

test('remote links keep credentials in the fragment and separate editor and audience access', () => {
  const access = createRemoteAccess();
  const links = remoteLinks('https://na-gasena.github.io/suiko/', access);
  const editor = new URL(links.editor);
  const audience = new URL(links.audience);

  assert.equal(editor.searchParams.get('room'), access.roomId);
  assert.equal(editor.searchParams.has('view'), false);
  assert.equal(editor.searchParams.has('editor'), false);
  assert.equal(
    new URLSearchParams(editor.hash.slice(1)).get('editor'),
    access.token,
  );

  assert.equal(audience.searchParams.get('view'), 'audience');
  assert.equal(audience.searchParams.has('audience'), false);
  assert.equal(
    new URLSearchParams(audience.hash.slice(1)).get('audience'),
    access.audienceToken,
  );
  assert.equal(
    new URLSearchParams(audience.hash.slice(1)).has('editor'),
    false,
  );

  assert.deepEqual(readRemoteAccess(editor), access);
  assert.deepEqual(readRemoteAccess(audience), {
    roomId: access.roomId,
    role: 'audience',
    token: access.audienceToken,
  });
});

test('room identifiers are validated before a remote connection is allowed', () => {
  assert.equal(
    readRemoteAccess(new URL('https://example.test/?room=short#editor=secret')),
    null,
  );
});

test('remote editor stays blocked on conflict and keeps its identity on reconnect', async () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    listeners = new Map();
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
    send(value) {
      this.sent.push(JSON.parse(value));
    }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.emit('close', { code, reason });
    }
    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }
    message(value) {
      this.emit('message', { data: JSON.stringify(value) });
    }
  }
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.WebSocket = FakeWebSocket;
  try {
    const states = [];
    const connection = new RemoteConnection({
      endpoint: 'wss://worker.example',
      access: {
        roomId: 'abcdefghijklmnopqrst',
        role: 'editor',
        token: 'e'.repeat(43),
        audienceToken: 'a'.repeat(43),
      },
      onState: (state) => states.push(state),
    });
    connection.start();
    sockets[0].open();
    assert.equal(sockets[0].sent[0].takeover, undefined);
    sockets[0].message({ type: 'editor_conflict' });
    assert.equal(states.at(-1), 'conflict');
    assert.equal(sockets.length, 1, 'conflict does not reconnect in a loop');

    connection.takeOver();
    assert.equal(sockets.length, 2);
    sockets[1].open();
    assert.equal(sockets[1].sent[0].takeover, true);
    sockets[1].message({ type: 'authenticated' });
    assert.equal(states.at(-1), 'connected');
    const clientId = sockets[1].sent[0].clientId;
    assert.ok(clientId);
    sockets[1].close(1006, 'network_lost');
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(sockets.length, 3);
    sockets[2].open();
    assert.equal(sockets[2].sent[0].clientId, clientId);
    assert.equal(sockets[2].sent[0].takeover, undefined);
    sockets[1].emit('close', { code: 4001, reason: 'stale_close' });
    assert.equal(states.at(-1), 'reconnecting');
    sockets[2].message({ type: 'authenticated' });
    assert.equal(states.at(-1), 'connected');
    const longSnapshot = {
      text: '推敲',
      marks: Array.from({ length: 2000 }, (_, index) => ({
        id: `${index}-${crypto.randomUUID()}`,
        text: '花',
      })),
    };
    connection.sendSnapshot(longSnapshot);
    await new Promise((resolve) => setTimeout(resolve, 280));
    const sent = sockets[2].sent.at(-1);
    assert.equal(sent.type, 'snapshot_gzip');
    assert.deepEqual(await decompressSnapshot(sent.payload), longSnapshot);
    connection.stop();
  } finally {
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
  }
});
