import assert from 'node:assert/strict';

const endpoint = process.env.REMOTE_TEST_URL || 'ws://127.0.0.1:8787';
const roomId = `test_${crypto.randomUUID().replaceAll('-', '')}`;
const editorToken = crypto.randomUUID().replaceAll('-', '');
const audienceToken = crypto.randomUUID().replaceAll('-', '');

function connect(role) {
  const socket = new WebSocket(`${endpoint}/rooms/${roomId}?role=${role}`);
  const messages = [];
  const waiters = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    const waiter = waiters.find(({ type }) => type === message.type);
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const next = (type) => {
    const index = messages.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, timer: 0 };
      waiters.push(waiter);
      waiter.timer = setTimeout(() => {
        const current = waiters.indexOf(waiter);
        if (current >= 0) waiters.splice(current, 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 5000);
    });
  };
  return { socket, opened, next };
}

const editor = connect('editor');
await editor.opened;
editor.socket.send(
  JSON.stringify({
    type: 'auth',
    token: editorToken,
    audienceToken,
  }),
);
await editor.next('authenticated');

const audience = connect('audience');
await audience.opened;
audience.socket.send(JSON.stringify({ type: 'auth', token: audienceToken }));
await audience.next('authenticated');
let presence;
do {
  presence = await editor.next('presence');
} while (presence.audiences !== 1);
assert.equal(presence.audiences, 1);

const expected = { text: 'いぬが→わたしは', revision: 1 };
editor.socket.send(
  JSON.stringify({
    type: 'snapshot',
    editorTime: Date.now(),
    snapshot: expected,
  }),
);
const delivered = await audience.next('snapshot');
assert.deepEqual(delivered.snapshot, expected);
assert.equal(typeof delivered.serverTime, 'number');

editor.socket.close();
audience.socket.close();
console.log('Remote Worker WebSocket test passed.');
