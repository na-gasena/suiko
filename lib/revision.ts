export type Phase = 'ready' | 'writing' | 'break' | 'ended';
export type MotionMode = 'eraser' | 'insect' | 'float';
export type FontChoice = 'mincho' | 'gothic' | 'serif' | 'mono';
export const fontChoices: {
  value: FontChoice;
  title: string;
  family: string;
}[] = [
  {
    value: 'mincho',
    title: '明朝',
    family: '"Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif',
  },
  {
    value: 'gothic',
    title: 'ゴシック',
    family: '"Yu Gothic", "Hiragino Kaku Gothic ProN", sans-serif',
  },
  {
    value: 'serif',
    title: 'セリフ',
    family: 'Georgia, "Times New Roman", serif',
  },
  {
    value: 'mono',
    title: '等幅',
    family: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  },
];
export type Settings = {
  motion: MotionMode;
  fadeSeconds: number;
  residue: number;
  insectSpeed: number;
  insectWander: number;
  floatWind: number;
  floatLift: number;
  invert: boolean;
  font: FontChoice;
  fontSize: number;
  fontWeight: number;
  textAlign: 'left' | 'center';
  letterSpacing: number;
  lineSpacing: number;
  showComposition: boolean;
  retainComposition: boolean;
};
export const defaults: Settings = {
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
};
export type Session = {
  id: string;
  number: number;
  startedAt: number;
  phase: Phase;
  text: string;
  activeMs: number;
  activeSince: number | null;
  sequence: number;
  updatedAt: number;
};
export type Change = { start: number; removed: string; inserted: string };
export type RevisionEvent = {
  id: string;
  sessionId: string;
  sessionNumber: number;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  activeMs: number;
  type: string;
  start: number;
  removed: string;
  inserted: string;
  before: string;
  after: string;
  composition: string;
  compositionId: string;
  settings: Settings;
};
export type Mark = {
  id: string;
  sessionId: string;
  text: string;
  x: number;
  y: number;
  createdAt: number;
  temporary: boolean;
};
export type Glyph = {
  text: string;
  x: number;
  y: number;
  start: number;
  end: number;
};
export const PAPER_WIDTH = 960,
  PAPER_HEIGHT = 620,
  FONT_SIZE = 34,
  LINE_HEIGHT = 76;
export const PAPER_FONT = `${FONT_SIZE}px "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif`;
export function newSession(number: number, now = Date.now()): Session {
  return {
    id: crypto.randomUUID(),
    number,
    startedAt: now,
    phase: 'ready',
    text: '',
    activeMs: 0,
    activeSince: null,
    sequence: 0,
    updatedAt: now,
  };
}
// UTF-16 offsets match textarea selections; differences never split a grapheme.
export function diffText(before: string, after: string): Change {
  const segment = (value: string) =>
    Array.from(
      new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(value),
      (s) => s.segment,
    );
  const a = segment(before),
    b = segment(after);
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  return {
    start: a.slice(0, prefix).join('').length,
    removed: a.slice(prefix, a.length - suffix).join(''),
    inserted: b.slice(prefix, b.length - suffix).join(''),
  };
}
export function activeTime(s: Session, now: number): number {
  return (
    s.activeMs + (s.activeSince === null ? 0 : Math.max(0, now - s.activeSince))
  );
}
export function timeLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
export function layoutText(
  text: string,
  measure: (text: string) => number,
  letterSpacing = 2,
  lineSpacing = LINE_HEIGHT,
): Glyph[] {
  let x = 92,
    y = 192;
  const glyphs: Glyph[] = [];
  for (const item of new Intl.Segmenter('ja', {
    granularity: 'grapheme',
  }).segment(text)) {
    if (item.segment === '\n' || item.segment === '\r\n') {
      x = 92;
      y += lineSpacing;
      continue;
    }
    const width =
      item.segment === '\t' ? 72 : measure(item.segment) + letterSpacing;
    if (x + width > PAPER_WIDTH - 92 && x > 92) {
      x = 92;
      y += lineSpacing;
    }
    glyphs.push({
      text: item.segment,
      x,
      y,
      start: item.index,
      end: item.index + item.segment.length,
    });
    x += width;
  }
  return glyphs;
}
export function markAlpha(
  ageMs: number,
  s: Settings,
  temporary: boolean,
): number {
  const floor = temporary ? 0 : s.residue / 100;
  const duration = (temporary ? 2 : s.fadeSeconds) * 1000;
  const t = Math.min(1, Math.max(0, ageMs / duration));
  return floor + (0.42 - floor) * Math.pow(1 - t, 2);
}
export function eventRow(
  s: Session,
  type: string,
  before: string,
  after: string,
  settings: Settings,
  now = Date.now(),
  composition = '',
  compositionId = '',
): RevisionEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: s.id,
    sessionNumber: s.number,
    sequence: s.sequence + 1,
    timestamp: new Date(now).toISOString(),
    elapsedMs: Math.max(0, now - s.startedAt),
    activeMs: activeTime(s, now),
    type,
    ...diffText(before, after),
    before,
    after,
    composition,
    compositionId,
    settings: { ...settings },
  };
}
export const eventLabels: Record<string, string> = {
  session_start: '開始',
  insert: '入力',
  delete: '削除',
  replace: '置換',
  paste: '貼り付け',
  undo: '取り消し',
  redo: 'やり直し',
  composition_start: '変換開始',
  composition_update: '変換途中',
  composition_end: '変換終了',
  composition_commit: '入力',
  composition_cancel: '変換取消',
  break_start: '休憩',
  resume: '再開',
  session_end: '終了',
  restore: '画面復帰',
  settings: '表示設定変更',
};
export function toCsv(events: RevisionEvent[]): string {
  const changeTypes = new Set([
    'insert',
    'delete',
    'replace',
    'paste',
    'undo',
    'redo',
    'composition_commit',
  ]);
  const cell = (value: string | number) => {
    let s = String(value);
    if (/^[\s]*[=+@-]/.test(s) || /^[\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const clock = (ms: number) =>
    `${Math.floor(Math.max(0, ms) / 3600000)}時間${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}分${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.max(0, ms) % 1000).padStart(3, '0')}秒`;
  const stamp = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日 ${String(date.getHours()).padStart(2, '0')}時${String(date.getMinutes()).padStart(2, '0')}分${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}秒`;
  };
  const header = [
    '紙番号',
    '時刻',
    '経過時間',
    '推敲時間',
    '操作',
    '消した文字',
    '加えた文字',
    '文章',
  ];
  const rows = [...events]
    .filter(
      (e) =>
        changeTypes.has(e.type) &&
        (e.removed.length > 0 || e.inserted.length > 0),
    )
    .sort(
      (a, b) => a.sessionNumber - b.sessionNumber || a.sequence - b.sequence,
    )
    .map((e) => [
      String(e.sessionNumber).padStart(2, '0'),
      stamp(e.timestamp),
      clock(e.elapsedMs),
      clock(e.activeMs),
      eventLabels[e.type] || '変更',
      e.removed,
      e.inserted,
      e.after,
    ]);
  return (
    '\ufeff' +
    [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') +
    '\r\n'
  );
}
