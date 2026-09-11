import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeTime,
  defaults,
  diffText,
  eventRow,
  layoutText,
  markAlpha,
  newSession,
  timeLabel,
  toCsv,
} from '../lib/revision.ts';

test('middle replacement retains the original deletion offset', () => {
  assert.deepEqual(
    diffText(
      '雨のあと、街はまだ眠っている。',
      '雨のあと、道はまだ眠っている。',
    ),
    { start: 5, removed: '街', inserted: '道' },
  );
});
test('deletion, insertion, empty input and repeated characters round-trip', () => {
  for (const [a, b] of [
    ['雨雨雨', '雨雨'],
    ['', '春'],
    ['夏', ''],
    ['あいう', 'あXいう'],
    ['庭\n風', '庭\n雨'],
    [' same ', ' same '],
  ]) {
    const d = diffText(a, b);
    assert.equal(
      a.slice(0, d.start) + d.inserted + a.slice(d.start + d.removed.length),
      b,
    );
  }
});
test('emoji families, surrogate pairs and combining marks stay intact', () => {
  assert.deepEqual(diffText('あ👨‍👩‍👧‍👦い', 'あ🌸い'), {
    start: 1,
    removed: '👨‍👩‍👧‍👦',
    inserted: '🌸',
  });
  assert.deepEqual(diffText('か\u3099', 'か'), {
    start: 0,
    removed: 'か\u3099',
    inserted: 'か',
  });
});
test('active time freezes in break while wall time continues', () => {
  const s = {
    ...newSession(1, 1000),
    activeMs: 2000,
    activeSince: 3000,
    phase: 'writing',
  };
  assert.equal(activeTime(s, 5000), 4000);
  const paused = { ...s, activeMs: 4000, activeSince: null, phase: 'break' };
  assert.equal(activeTime(paused, 100000), 4000);
  const e = eventRow(paused, 'resume', '', '', defaults, 100000);
  assert.equal(e.elapsedMs, 99000);
  assert.equal(e.activeMs, 4000);
  assert.equal(timeLabel(3600000), '01:00:00');
});
test('permanent traces remain after a day, temporary input disappears', () => {
  assert.equal(markAlpha(86400000, defaults, false), 0.07);
  assert.equal(markAlpha(86400000, defaults, true), 0);
  assert.ok(
    markAlpha(1000, defaults, false) > markAlpha(8000, defaults, false),
  );
});
test('layout wraps without moving earlier glyph positions', () => {
  const a = layoutText('あ'.repeat(40), () => 34);
  assert.equal(a[0].x, 92);
  assert.ok(a.at(-1).y > a[0].y);
  assert.deepEqual(
    layoutText('あい', () => 34)[0],
    layoutText('あ', () => 34)[0],
  );
  assert.equal(layoutText('あ\nい', () => 34)[1].y, 268);
  assert.equal(layoutText('😀い', () => 34)[1].start, 2);
});
test('CSV has BOM, readable change columns, milliseconds and formula protection', () => {
  const s = { ...newSession(2, 0), sequence: 5 };
  const event = eventRow(s, 'insert', '', '=SUM(1,2)\n"風"', defaults, 1234);
  const csv = toCsv([event]);
  assert.ok(csv.startsWith('\ufeff"紙番号"'));
  assert.ok(csv.includes('"0時間00分01.234秒"'));
  assert.ok(csv.includes('"\'=SUM(1,2)\n""風"""'));
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(event.sequence, 6);
});
test('composition and committed revisions remain distinct event types', () => {
  const s = newSession(1, 0);
  const a = eventRow(
    s,
    'composition_update',
    'か',
    'かぜ',
    defaults,
    123,
    'かぜ',
    'ime-1',
  );
  const b = eventRow(
    { ...s, sequence: 1 },
    'composition_commit',
    '',
    '風',
    defaults,
    456,
    '',
    'ime-1',
  );
  assert.equal(a.compositionId, b.compositionId);
  assert.equal(a.type, 'composition_update');
  assert.equal(b.type, 'composition_commit');
  const csv = toCsv([b, a]);
  assert.ok(csv.includes('"入力"'));
  assert.ok(!csv.includes('composition_update'));
});
