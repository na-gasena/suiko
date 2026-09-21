import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compressSnapshot,
  decompressSnapshot,
  snapshotBytes,
} from '../lib/snapshot-codec.ts';

test('a long erasure history fits the WebSocket budget without losing marks', async () => {
  const sessionId = crypto.randomUUID();
  const snapshot = {
    text: '文章を推敲する',
    marks: Array.from({ length: 3000 }, (_, index) => ({
      id: crypto.randomUUID(),
      sessionId,
      text: '花',
      x: 480,
      y: 300,
      createdAt: 1_789_927_200_000 + index * 700,
      temporary: false,
    })),
  };
  assert.ok(snapshotBytes(snapshot) > 256 * 1024);
  const payload = await compressSnapshot(snapshot);
  assert.ok(payload);
  assert.ok(Buffer.byteLength(payload) < 256 * 1024);
  assert.deepEqual(await decompressSnapshot(payload), snapshot);
});
