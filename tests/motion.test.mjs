import test from 'node:test';
import assert from 'node:assert/strict';
import { motionPose, motionAlpha } from '../lib/motion.ts';
import { defaults } from '../lib/revision.ts';

const mark = { id: 'test-character', x: 180, y: 192 };
test('existing eraser remains the default and never moves', () => {
  assert.equal(defaults.motion, 'eraser');
  assert.deepEqual(motionPose(mark, 15, 'eraser'), {
    x: 180,
    y: 192,
    angle: 0,
  });
});
test('both new modes depart from their deletion anchor with deterministic trajectories', () => {
  for (const mode of ['insect', 'float']) {
    assert.deepEqual(motionPose(mark, 0, mode), { x: 180, y: 192, angle: 0 });
    const first = motionPose(mark, 3, mode);
    assert.ok(Math.hypot(first.x - mark.x, first.y - mark.y) > 10);
    assert.deepEqual(first, motionPose({ ...mark }, 3, mode));
    assert.notDeepEqual(
      first,
      motionPose({ ...mark, id: 'different-character' }, 3, mode),
    );
  }
  assert.deepEqual(mark, { id: 'test-character', x: 180, y: 192 });
});
test('insects stay on the paper and moving text expires at the fade duration', () => {
  for (let t = 0; t <= 40; t += 0.13) {
    const pose = motionPose(mark, t, 'insect');
    assert.ok(pose.x >= 24 && pose.x <= 916);
    assert.ok(pose.y >= 46 && pose.y <= 594);
  }
  assert.equal(motionAlpha(12000, 12000), 0);
  assert.equal(motionAlpha(20000, 12000), 0);
  assert.ok(motionAlpha(3000, 12000) > motionAlpha(9000, 12000));
});
