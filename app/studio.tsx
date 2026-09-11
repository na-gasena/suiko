'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowUpRight,
  Download,
  History,
  Pause,
  Play,
  Plus,
  Settings2,
} from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  activeTime,
  defaults,
  diffText,
  eventLabels,
  eventRow,
  fontChoices,
  newSession,
  timeLabel,
  toCsv,
  type Mark,
  type RevisionEvent,
  type Session,
  type Settings,
} from '@/lib/revision';
import {
  loadEvents,
  loadMarks,
  loadSessions,
  save,
  removeSession,
  restoreSession,
  type SavedSession,
} from '@/lib/storage';
import Paper, { measureGlyphs } from './paper';
import { measurePaperText, paperTextStyleFor } from '@/lib/paper-layout';
import { MotionPicker } from './motion-study';

type Snapshot = {
  session: Session;
  text: string;
  composing: boolean;
  marks: Mark[];
  settings: Settings;
};
const CHANNEL = 'suiko-no-ato-live-v1';
const historyTypes = new Set([
  'insert',
  'delete',
  'replace',
  'paste',
  'undo',
  'redo',
  'composition_commit',
]);
function historyChanges(events: RevisionEvent[]) {
  return events.filter(
    (event) =>
      historyTypes.has(event.type) &&
      (event.removed.length > 0 || event.inserted.length > 0),
  );
}

function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export default function Studio() {
  const [mode, setMode] = useState<'editor' | 'audience' | null>(null);
  useEffect(() => {
    queueMicrotask(() =>
      setMode(
        new URLSearchParams(window.location.search).get('view') === 'audience'
          ? 'audience'
          : 'editor',
      ),
    );
  }, []);
  // The initial frame may already be on the performance display; keep it blank.
  if (!mode)
    return <div className="audience" aria-label="紙面を準備しています" />;
  return mode === 'audience' ? <Audience /> : <Editor />;
}

function Audience() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => {
      if (e.data.type === 'snapshot') {
        setSnapshot(e.data.payload);
        channel.postMessage({ type: 'audience_ready' });
      }
    };
    channel.postMessage({ type: 'hello' });
    const timer = window.setInterval(() => {
      channel.postMessage({ type: 'hello' });
    }, 5000);
    const fullscreen = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        channel.postMessage({ type: 'audience_fullscreen_error' });
      }
    };
    const doubleClick = () => {
      void fullscreen();
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.code === 'KeyF' &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        void fullscreen();
      }
    };
    document.addEventListener('dblclick', doubleClick);
    document.addEventListener('keydown', keydown);
    return () => {
      channel.close();
      clearInterval(timer);
      document.removeEventListener('dblclick', doubleClick);
      document.removeEventListener('keydown', keydown);
    };
  }, []);
  const height = snapshot
    ? Math.max(
        620,
        measurePaperText(
          snapshot.composing && !snapshot.settings.showComposition
            ? snapshot.session.text
            : snapshot.text,
          snapshot.settings,
        ).height,
        ...snapshot.marks.map((m) => m.y + 150),
      )
    : 620;
  return (
    <main
      className={`audience${snapshot?.settings.invert ? ' audience-inverted' : ''}`}
      aria-label="投影画面。ダブルクリックまたはFキーで全画面表示を切り替えます。"
    >
      <div
        className="audience-paper"
        style={{ '--paper-height': height } as CSSProperties}
      >
        {snapshot && (
          <Paper
            text={snapshot.text}
            committed={snapshot.session.text}
            composing={snapshot.composing}
            marks={snapshot.marks}
            settings={snapshot.settings}
            number={snapshot.session.number}
            paused={snapshot.session.phase === 'break'}
            blankLabel={false}
            textOnly
          />
        )}
      </div>
    </main>
  );
}

function Editor() {
  const [session, setSession] = useState<Session | null>(null);
  const [draft, setDraft] = useState('');
  const [marks, setMarks] = useState<Mark[]>([]);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [composing, setComposing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [recent, setRecent] = useState<RevisionEvent[]>([]);
  const [, setSaveState] = useState('読み込み中');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [audienceSeen, setAudienceSeen] = useState(0);
  const [locked, setLocked] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmNext, setConfirmNext] = useState(false);
  const [archive, setArchive] = useState<Session[]>([]);
  const [archiveId, setArchiveId] = useState('');
  const [archiveEvents, setArchiveEvents] = useState<RevisionEvent[]>([]);
  const [archiveMarks, setArchiveMarks] = useState<Mark[]>([]);
  const [archiveLimit, setArchiveLimit] = useState(80);
  const [exporting, setExporting] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveBusyRef = useRef(false);
  const [deletedSessions, setDeletedSessions] = useState<SavedSession[]>([]);
  const archiveSelectionRef = useRef('');
  const sessionRef = useRef<Session | null>(null);
  const draftRef = useRef('');
  const marksRef = useRef<Mark[]>([]);
  const settingsRef = useRef<Settings>(defaults);
  const composingRef = useRef(false);
  const compositionRef = useRef({
    id: '',
    base: '',
    last: '',
    data: '',
    loggedData: '',
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const saveFailed = useRef(false);
  const unsaved = useRef(new Map<string, RevisionEvent>());
  const allSessions = useRef<Session[]>([]);
  const allMarks = useRef(new Map<string, Mark[]>());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const ownsLock = useRef(false);

  function syncSession(value: Session) {
    sessionRef.current = value;
    setSession(value);
    allSessions.current = [
      ...allSessions.current.filter((s) => s.id !== value.id),
      value,
    ].sort((a, b) => a.number - b.number);
  }
  function syncDraft(value: string) {
    draftRef.current = value;
    setDraft(value);
  }
  function syncMarks(value: Mark[]) {
    marksRef.current = value;
    setMarks(value);
    if (sessionRef.current) allMarks.current.set(sessionRef.current.id, value);
  }
  function persist(
    value: Session,
    event?: RevisionEvent,
    additions: Mark[] = [],
  ) {
    if (event) unsaved.current.set(event.id, event);
    pending.current++;
    setSaveState('保存中');
    queue.current = queue.current
      .then(() => save(value, event, additions))
      .then(() => {
        if (event) unsaved.current.delete(event.id);
        if (!unsaved.current.size) saveFailed.current = false;
      })
      .catch(() => {
        saveFailed.current = true;
        setError(
          '自動保存に失敗しました。画面を閉じる前にCSVを出力してください。入力はこの画面に保持されています。',
        );
      })
      .finally(() => {
        pending.current--;
        setSaveState(
          unsaved.current.size || saveFailed.current
            ? '未保存あり'
            : pending.current
              ? '保存中'
              : '保存済み',
        );
      });
  }
  function record(
    type: string,
    before: string,
    after: string,
    additions: Mark[] = [],
    composition = '',
    compositionId = '',
    patch: Partial<Session> = {},
  ) {
    const current = sessionRef.current;
    if (!current) return;
    if (
      type === 'composition_start' ||
      type === 'composition_update' ||
      type === 'composition_end' ||
      type === 'composition_cancel'
    )
      return;
    const stamp = Date.now();
    const event = eventRow(
      current,
      type,
      before,
      after,
      settingsRef.current,
      stamp,
      composition,
      compositionId,
    );
    const next = {
      ...current,
      ...patch,
      sequence: event.sequence,
      updatedAt: stamp,
    };
    syncSession(next);
    if (historyTypes.has(event.type) && (event.removed || event.inserted))
      setRecent((rows) => [event, ...rows].slice(0, 6));
    persist(next, event, additions);
  }
  function begin() {
    const current = sessionRef.current;
    if (!current || current.phase !== 'ready') return;
    const stamp = Date.now();
    syncSession({
      ...current,
      startedAt: stamp,
      activeSince: stamp,
      phase: 'writing',
    });
    record('session_start', current.text, current.text);
    setNow(stamp);
  }
  function traces(before: string, after: string, temporary: boolean): Mark[] {
    const current = sessionRef.current;
    if (!current) return [];
    const change = diffText(before, after);
    if (!change.removed) return [];
    return measureGlyphs(before, settingsRef.current)
      .filter(
        (g) =>
          g.start >= change.start &&
          g.start < change.start + change.removed.length &&
          g.text.trim(),
      )
      .map((g) => ({
        id: crypto.randomUUID(),
        sessionId: current.id,
        text: g.text,
        x: g.x,
        y: g.y,
        createdAt: Date.now(),
        temporary,
      }));
  }
  function addMarks(additions: Mark[]) {
    if (additions.length)
      syncMarks([
        ...marksRef.current.filter(
          (m) => !m.temporary || Date.now() - m.createdAt < 2200,
        ),
        ...additions,
      ]);
  }
  function commit(value: string, inputType = '', compositionId = '') {
    begin();
    const current = sessionRef.current;
    if (!current) return;
    syncDraft(value);
    if (current.text === value) return;
    const change = diffText(current.text, value);
    const type = compositionId
      ? 'composition_commit'
      : inputType === 'historyUndo'
        ? 'undo'
        : inputType === 'historyRedo'
          ? 'redo'
          : inputType === 'insertFromPaste'
            ? 'paste'
            : change.removed && change.inserted
              ? 'replace'
              : change.removed
                ? 'delete'
                : 'insert';
    const additions = traces(current.text, value, false);
    addMarks(additions);
    record(type, current.text, value, additions, '', compositionId, {
      text: value,
    });
  }
  function updateComposition(value: string, data: string) {
    if (!composingRef.current) return;
    const c = compositionRef.current;
    syncDraft(value);
    if (value === c.last && data === c.loggedData) return;
    // The first IME update may replace selected committed text. That deletion belongs to the final commit only.
    const additions =
      c.last === c.base || !settingsRef.current.showComposition
        ? []
        : traces(c.last, value, !settingsRef.current.retainComposition);
    addMarks(additions);
    record('composition_update', c.last, value, additions, data, c.id);
    c.last = value;
    c.loggedData = data;
  }
  function breakOrResume() {
    if (composingRef.current || !sessionRef.current) return;
    const current = sessionRef.current;
    if (current.phase === 'ready') begin();
    else if (current.phase === 'writing')
      record('break_start', current.text, current.text, [], '', '', {
        phase: 'break',
        activeMs: activeTime(current, Date.now()),
        activeSince: null,
      });
    else if (current.phase === 'break')
      record('resume', current.text, current.text, [], '', '', {
        phase: 'writing',
        activeSince: Date.now(),
      });
    inputRef.current?.focus();
  }
  function nextSession() {
    const current = sessionRef.current;
    if (!current || composingRef.current) return;
    record('session_end', current.text, current.text, [], '', '', {
      phase: 'ended',
      activeMs: activeTime(current, Date.now()),
      activeSince: null,
    });
    const next = newSession(
      Math.max(...allSessions.current.map((s) => s.number), 0) + 1,
    );
    syncSession(next);
    syncDraft('');
    syncMarks([]);
    setRecent([]);
    persist(next);
    setConfirmNext(false);
    setNow(Date.now());
    inputRef.current?.focus();
  }
  function changeSettings(patch: Partial<Settings>) {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    try {
      localStorage.setItem('suiko-settings', JSON.stringify(next));
    } catch {
      setNotice('表示設定はこの画面を開いている間だけ保持されます。');
    }
    const current = sessionRef.current;
    if (current && current.phase !== 'ready')
      record('settings', current.text, current.text);
  }

  useEffect(() => {
    let alive = true,
      release: (() => void) | undefined;
    const start = async (owner: boolean) => {
      ownsLock.current = owner;
      setLocked(!owner);
      try {
        const stored = JSON.parse(
          localStorage.getItem('suiko-settings') || '{}',
        );
        const numberOr = (value: unknown, fallback: number) =>
          Number.isFinite(Number(value)) ? Number(value) : fallback;
        const options: Settings = {
          motion:
            stored.motion === 'float' || stored.motion === 'insect'
              ? stored.motion
              : defaults.motion,
          fadeSeconds: Math.max(
            3,
            Math.min(40, numberOr(stored.fadeSeconds, 12)),
          ),
          residue: Math.max(1, Math.min(16, numberOr(stored.residue, 7))),
          insectSpeed: Math.max(
            20,
            Math.min(220, numberOr(stored.insectSpeed, defaults.insectSpeed)),
          ),
          insectWander: Math.max(
            0,
            Math.min(220, numberOr(stored.insectWander, defaults.insectWander)),
          ),
          floatWind: Math.max(
            0,
            Math.min(220, numberOr(stored.floatWind, defaults.floatWind)),
          ),
          floatLift: Math.max(
            0,
            Math.min(220, numberOr(stored.floatLift, defaults.floatLift)),
          ),
          invert:
            typeof stored.invert === 'boolean'
              ? stored.invert
              : defaults.invert,
          font:
            stored.font === 'gothic' ||
            stored.font === 'serif' ||
            stored.font === 'mono'
              ? stored.font
              : defaults.font,
          letterSpacing: Math.max(
            -4,
            Math.min(
              12,
              numberOr(stored.letterSpacing, defaults.letterSpacing),
            ),
          ),
          lineSpacing: Math.max(
            48,
            Math.min(120, numberOr(stored.lineSpacing, defaults.lineSpacing)),
          ),
          kerning:
            typeof stored.kerning === 'boolean'
              ? stored.kerning
              : defaults.kerning,
          showComposition:
            typeof stored.showComposition === 'boolean'
              ? stored.showComposition
              : true,
          retainComposition: stored.retainComposition === true,
        };
        settingsRef.current = options;
        setSettings(options);
      } catch {
        /* Defaults remain usable when local storage is unavailable. */
      }
      try {
        const sessions = await loadSessions();
        if (!alive) return;
        allSessions.current = sessions;
        let current = sessions.at(-1);
        if (!current || current.phase === 'ended')
          current = newSession((current?.number || 0) + 1);
        const [savedMarks, events] = await Promise.all([
          loadMarks(current.id),
          loadEvents(current.id),
        ]);
        if (!alive) return;
        syncSession(current);
        syncDraft(current.text);
        syncMarks(savedMarks);
        setRecent(historyChanges(events).slice(-6).reverse());
        setSaveState('保存済み');
        if (owner) {
          if (current.sequence) record('restore', current.text, current.text);
          else persist(current);
        }
      } catch {
        if (!alive) return;
        const current = newSession(1);
        syncSession(current);
        setSaveState('保存できません');
        setError(
          'ブラウザの保存領域を開けませんでした。入力は可能ですが、閉じる前にCSVを出力してください。',
        );
      }
    };
    if (navigator.locks) {
      navigator.locks
        .request('suiko-editor-owner', { ifAvailable: true }, async (lock) => {
          if (!alive) return;
          if (!lock) {
            await start(false);
            return;
          }
          const hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          await start(true);
          if (alive) await hold;
        })
        .catch(() => {
          if (alive) {
            setError('編集画面の起動に失敗しました。再読み込みしてください。');
            setLocked(true);
          }
        });
    } else {
      queueMicrotask(() => {
        void start(false);
        setError(
          'このブラウザは編集画面の排他制御に対応していません。最新版のChromeまたはEdgeで開いてください。',
        );
      });
    }
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        pending.current ||
        unsaved.current.size ||
        saveFailed.current ||
        composingRef.current
      )
        event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      alive = false;
      ownsLock.current = false;
      release?.();
      clearInterval(tick);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  useEffect(() => {
    if (session)
      snapshotRef.current = {
        session,
        text: draft,
        composing,
        marks,
        settings,
      };
    if (ownsLock.current && snapshotRef.current)
      channelRef.current?.postMessage({
        type: 'snapshot',
        payload: snapshotRef.current,
      });
  }, [session, draft, composing, marks, settings]);
  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (e) => {
      if (!ownsLock.current) return;
      if (e.data.type === 'audience_ready') setAudienceSeen(Date.now());
      if (e.data.type === 'audience_fullscreen_error')
        setNotice(
          '別ウィンドウを全画面にできませんでした。別ウィンドウを選び、ブラウザの全画面表示をお使いください。',
        );
      if (e.data.type === 'hello' && ownsLock.current && snapshotRef.current)
        channel.postMessage({ type: 'snapshot', payload: snapshotRef.current });
    };
    const timer = window.setInterval(() => {
      if (ownsLock.current) channel.postMessage({ type: 'heartbeat' });
    }, 2000);
    return () => {
      clearInterval(timer);
      channel.close();
      channelRef.current = null;
    };
  }, []);

  async function gatherEvents(id?: string) {
    await queue.current;
    let stored: RevisionEvent[] = [];
    try {
      stored = await loadEvents(id);
    } catch {
      /* Unsaved events remain exportable. */
    }
    return [
      ...new Map(
        [
          ...stored,
          ...[...unsaved.current.values()].filter(
            (e) => !id || e.sessionId === id,
          ),
        ].map((e) => [e.id, e]),
      ).values(),
    ].sort(
      (a, b) => a.sessionNumber - b.sessionNumber || a.sequence - b.sequence,
    );
  }
  async function exportCsv(id?: string) {
    setExporting(true);
    try {
      const events = historyChanges(await gatherEvents(id));
      download(
        toCsv(events),
        `suiko-${id ? 'paper' : 'all'}-${new Date().toISOString().replaceAll(':', '-')}.csv`,
        'text/csv;charset=utf-8',
      );
      setNotice(`${events.length}件の履歴をCSVで出力しました。`);
    } catch {
      setError(
        'CSVを出力できませんでした。画面を閉じずにもう一度お試しください。',
      );
    } finally {
      setExporting(false);
    }
  }
  async function openArchive() {
    await queue.current;
    setArchive([...allSessions.current]);
    setSheetOpen(true);
    if (sessionRef.current) await selectArchive(sessionRef.current.id);
  }
  async function selectArchive(id: string) {
    archiveSelectionRef.current = id;
    setArchiveId(id);
    setArchiveLimit(80);
    setArchiveEvents([]);
    setArchiveMarks([]);
    const events = historyChanges(await gatherEvents(id));
    if (archiveSelectionRef.current !== id) return;
    setArchiveEvents(events);
    try {
      const savedMarks = allMarks.current.get(id) || (await loadMarks(id));
      if (archiveSelectionRef.current === id) setArchiveMarks(savedMarks);
    } catch {
      if (archiveSelectionRef.current === id)
        setArchiveMarks(allMarks.current.get(id) || []);
    }
  }
  async function deleteArchive(id: string) {
    if (locked || composingRef.current || archiveBusyRef.current) return;
    archiveBusyRef.current = true;
    setArchiveBusy(true);
    try {
      // Closing the active tab starts an empty session; undo restores the closed
      // session as history, without replacing the new writing surface.
      if (id === sessionRef.current?.id) nextSession();
      await queue.current;
      const closed = allSessions.current.find((s) => s.id === id);
      if (!closed) return;
      const backup: SavedSession = {
        session: closed,
        events: await gatherEvents(id),
        marks: allMarks.current.get(id) || (await loadMarks(id)),
      };
      await removeSession(id);
      const oldIndex = allSessions.current.findIndex((s) => s.id === id);
      allSessions.current = allSessions.current.filter((s) => s.id !== id);
      allMarks.current.delete(id);
      for (const [key, event] of unsaved.current)
        if (event.sessionId === id) unsaved.current.delete(key);
      setArchive([...allSessions.current]);
      setDeletedSessions((items) => [...items, backup]);
      if (archiveSelectionRef.current === id) {
        const next =
          allSessions.current[
            Math.min(oldIndex, allSessions.current.length - 1)
          ];
        await selectArchive(next?.id || '');
      }
    } catch {
      setError('履歴を削除できませんでした。もう一度お試しください。');
    } finally {
      archiveBusyRef.current = false;
      setArchiveBusy(false);
    }
  }
  async function undoArchiveDelete() {
    const backup = deletedSessions.at(-1);
    if (!backup || locked || archiveBusyRef.current) return;
    archiveBusyRef.current = true;
    setArchiveBusy(true);
    try {
      await restoreSession(backup);
      allSessions.current = [...allSessions.current, backup.session].sort(
        (a, b) => a.number - b.number,
      );
      allMarks.current.set(backup.session.id, backup.marks);
      setArchive([...allSessions.current]);
      setDeletedSessions((items) => items.slice(0, -1));
      await selectArchive(backup.session.id);
    } catch {
      setError('履歴を復元できませんでした。もう一度お試しください。');
    } finally {
      archiveBusyRef.current = false;
      setArchiveBusy(false);
    }
  }
  function project() {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'audience');
    const opened = window.open(
      url.toString(),
      'suiko-audience',
      'popup=yes,width=1280,height=800',
    );
    if (!opened) setNotice('ポップアップを許可してください。');
    else setNotice('別ウィンドウを開きました。');
  }

  if (!session)
    return (
      <div className="loading">
        紙面を準備しています…
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    );
  const elapsed = activeTime(session, now);
  const archiveSession = archive.find((s) => s.id === archiveId);
  return (
    <main className="studio">
      <header className="header">
        <div className="header-actions">
          <button className="subtle flat" onClick={openArchive}>
            <History />
            履歴
          </button>
          <button
            className="subtle"
            disabled={exporting}
            onClick={() => exportCsv()}
          >
            <Download />
            CSV出力
          </button>
          <button className="action" onClick={project}>
            別ウィンドウ
            <ArrowUpRight />
          </button>
        </div>
      </header>
      {locked && (
        <div className="error" role="alert">
          別の編集画面が開いています。ここは閲覧のみです。編集を移す場合は、先の画面を閉じて再読み込みしてください。
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice">
          <output>{notice}</output>
          <button
            className="subtle flat"
            onClick={() => setNotice('')}
            aria-label="通知を閉じる"
          >
            ×
          </button>
        </div>
      )}
      <div className="workspace">
        <aside className="controls" aria-label="演者の操作">
          <section className="session-card">
            <div className="section-label">
              <span>{String(session.number).padStart(2, '0')}</span>
            </div>
            <div className="clock-line">
              <span
                className={`clock ${elapsed >= 3600000 ? 'over-hour' : ''}`}
              >
                {timeLabel(elapsed)}
              </span>
            </div>
            <div className="session-actions">
              <button
                className="action"
                onClick={breakOrResume}
                disabled={locked || composing}
                aria-label={
                  session.phase === 'writing'
                    ? '一時停止'
                    : session.phase === 'break'
                      ? '再開'
                      : '開始'
                }
                title={
                  session.phase === 'writing'
                    ? '一時停止'
                    : session.phase === 'break'
                      ? '再開'
                      : '開始'
                }
              >
                {session.phase === 'writing' ? <Pause /> : <Play />}
              </button>
              <button
                className="subtle"
                onClick={() => setConfirmNext(true)}
                disabled={
                  locked ||
                  composing ||
                  (session.phase === 'ready' && !session.text)
                }
              >
                <Plus />
                新しく書く
              </button>
            </div>
            <button
              className="subtle settings-button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-label={settingsOpen ? '設定を隠す' : '設定を表示'}
              title="設定"
            >
              <Settings2 />
              設定
            </button>
          </section>
          {settingsOpen && (
            <section className="settings">
              <div className="section-label">
                <span>紙面の設定</span>
              </div>
              <div className="setting">
                <div className="setting-head">
                  <span>消した文字の動き</span>
                </div>
                <MotionPicker
                  value={settings.motion}
                  onChange={(motion) => changeSettings({ motion })}
                  disabled={locked || composing}
                />
              </div>
              <div className="setting">
                <div className="setting-head">
                  <label htmlFor="font-choice">フォント</label>
                </div>
                <select
                  id="font-choice"
                  className="font-select"
                  value={settings.font}
                  disabled={locked || composing}
                  onChange={(event) =>
                    changeSettings({
                      font: event.currentTarget.value as Settings['font'],
                    })
                  }
                >
                  {fontChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting">
                <div className="setting-head">
                  <span>文字詰め</span>
                  <output>{settings.letterSpacing} px</output>
                </div>
                <Slider
                  min={-4}
                  max={12}
                  step={1}
                  value={[settings.letterSpacing]}
                  disabled={locked || composing}
                  onValueChange={(value) =>
                    changeSettings({
                      letterSpacing: Array.isArray(value) ? value[0] : value,
                    })
                  }
                />
              </div>
              <div className="setting">
                <div className="setting-head">
                  <span>行詰め</span>
                  <output>{settings.lineSpacing} px</output>
                </div>
                <Slider
                  min={48}
                  max={120}
                  step={1}
                  value={[settings.lineSpacing]}
                  disabled={locked || composing}
                  onValueChange={(value) =>
                    changeSettings({
                      lineSpacing: Array.isArray(value) ? value[0] : value,
                    })
                  }
                />
              </div>
              <div className="toggle-row">
                <label htmlFor="invert-paper">地と文字を反転</label>
                <Switch
                  id="invert-paper"
                  checked={settings.invert}
                  disabled={locked || composing}
                  onCheckedChange={(value) => changeSettings({ invert: value })}
                />
              </div>
              <div className="toggle-row">
                <label htmlFor="font-kerning">カーニング</label>
                <Switch
                  id="font-kerning"
                  checked={settings.kerning}
                  disabled={locked || composing}
                  onCheckedChange={(value) =>
                    changeSettings({ kerning: value })
                  }
                />
              </div>
              {settings.motion === 'eraser' && (
                <>
                  <div className="setting">
                    <div className="setting-head">
                      <span id="fade-label">薄くなる時間</span>
                      <output>{settings.fadeSeconds} 秒</output>
                    </div>
                    <Slider
                      aria-labelledby="fade-label"
                      min={3}
                      max={40}
                      step={1}
                      value={[settings.fadeSeconds]}
                      disabled={locked || composing}
                      onValueChange={(value) =>
                        changeSettings({
                          fadeSeconds: Array.isArray(value) ? value[0] : value,
                        })
                      }
                    />
                  </div>
                  <div className="setting">
                    <div className="setting-head">
                      <span id="residue-label">消し跡の濃さ</span>
                      <output>{settings.residue} %</output>
                    </div>
                    <Slider
                      aria-labelledby="residue-label"
                      min={1}
                      max={16}
                      step={1}
                      value={[settings.residue]}
                      disabled={locked || composing}
                      onValueChange={(value) =>
                        changeSettings({
                          residue: Array.isArray(value) ? value[0] : value,
                        })
                      }
                    />
                  </div>
                </>
              )}
              {settings.motion === 'insect' && (
                <>
                  <div className="setting">
                    <div className="setting-head">
                      <span id="insect-speed-label">速度</span>
                      <output>{settings.insectSpeed} %</output>
                    </div>
                    <Slider
                      aria-labelledby="insect-speed-label"
                      min={20}
                      max={220}
                      step={1}
                      value={[settings.insectSpeed]}
                      disabled={locked || composing}
                      onValueChange={(value) =>
                        changeSettings({
                          insectSpeed: Array.isArray(value) ? value[0] : value,
                        })
                      }
                    />
                  </div>
                  <div className="setting">
                    <div className="setting-head">
                      <span id="insect-wander-label">揺れ</span>
                      <output>{settings.insectWander} %</output>
                    </div>
                    <Slider
                      aria-labelledby="insect-wander-label"
                      min={0}
                      max={220}
                      step={1}
                      value={[settings.insectWander]}
                      disabled={locked || composing}
                      onValueChange={(value) =>
                        changeSettings({
                          insectWander: Array.isArray(value) ? value[0] : value,
                        })
                      }
                    />
                  </div>
                </>
              )}
              {settings.motion === 'float' && (
                <>
                  <div className="setting">
                    <div className="setting-head">
                      <span id="float-wind-label">風</span>
                      <output>{settings.floatWind} %</output>
                    </div>
                    <Slider
                      aria-labelledby="float-wind-label"
                      min={0}
                      max={220}
                      step={1}
                      value={[settings.floatWind]}
                      disabled={locked || composing}
                      onValueChange={(value) =>
                        changeSettings({
                          floatWind: Array.isArray(value) ? value[0] : value,
                        })
                      }
                    />
                  </div>
                  <div className="setting">
                    <div className="setting-head">
                      <span id="float-lift-label">浮力</span>
                      <output>{settings.floatLift} %</output>
                    </div>
                    <Slider
                      aria-labelledby="float-lift-label"
                      min={0}
                      max={220}
                      step={1}
                      value={[settings.floatLift]}
                      disabled={locked || composing}
                      onValueChange={(value) =>
                        changeSettings({
                          floatLift: Array.isArray(value) ? value[0] : value,
                        })
                      }
                    />
                  </div>
                </>
              )}
              <div className="toggle-row">
                <label htmlFor="show-ime">別ウィンドウに変換途中を表示</label>
                <Switch
                  id="show-ime"
                  checked={settings.showComposition}
                  disabled={locked || composing}
                  onCheckedChange={(value) =>
                    changeSettings({ showComposition: value })
                  }
                />
              </div>
              <div className="toggle-row">
                <label htmlFor="retain-ime">変換途中も跡に残す</label>
                <Switch
                  id="retain-ime"
                  checked={settings.retainComposition}
                  disabled={locked || composing}
                  onCheckedChange={(value) =>
                    changeSettings({ retainComposition: value })
                  }
                />
              </div>
            </section>
          )}
        </aside>
        <section className="canvas-area" aria-label="文章を編集">
          <div className="canvas-top">
            <h2>
              <label htmlFor="poem-input">入力</label>
            </h2>
            <span className="input-state">{composing ? '変換中' : ''}</span>
          </div>
          <Paper
            text={draft}
            committed={session.text}
            composing={composing}
            marks={marks}
            settings={settings}
            number={session.number}
            paused={session.phase === 'break'}
            textOnly
          >
            <textarea
              id="poem-input"
              ref={inputRef}
              className="paper-input"
              style={paperTextStyleFor(settings)}
              aria-label="文章を編集"
              aria-describedby="editor-help"
              value={draft}
              placeholder="ここに入力"
              maxLength={2000}
              disabled={locked || session.phase === 'break'}
              spellCheck={false}
              onChange={(e) => {
                const value = e.currentTarget.value;
                const native = e.nativeEvent as InputEvent;
                if (composingRef.current)
                  updateComposition(value, compositionRef.current.data);
                else commit(value, native.inputType);
              }}
              onCompositionStart={() => {
                begin();
                composingRef.current = true;
                setComposing(true);
                const base = sessionRef.current?.text || '';
                compositionRef.current = {
                  id: crypto.randomUUID(),
                  base,
                  last: base,
                  data: '',
                  loggedData: '',
                };
                record(
                  'composition_start',
                  base,
                  base,
                  [],
                  '',
                  compositionRef.current.id,
                );
              }}
              onCompositionUpdate={(e) => {
                const element = e.currentTarget;
                const data = e.data;
                compositionRef.current.data = data;
                queueMicrotask(() => {
                  if (composingRef.current)
                    updateComposition(element.value, data);
                });
              }}
              onCompositionEnd={(e) => {
                const value = e.currentTarget.value;
                const c = compositionRef.current;
                updateComposition(value, e.data);
                record('composition_end', c.last, value, [], e.data, c.id);
                composingRef.current = false;
                setComposing(false);
                if (value === c.base) {
                  syncDraft(value);
                  record('composition_cancel', c.base, value, [], e.data, c.id);
                } else commit(value, '', c.id);
              }}
            />
          </Paper>
          <div className="paper-bottom">
            <span id="editor-help">{draft.length} / 2,000</span>
            <span>{marks.filter((m) => !m.temporary).length} 文字の消し跡</span>
          </div>
          <section className="history-preview">
            <div className="history-head">
              <h3>直近の推敲</h3>
              <button className="subtle flat" onClick={openArchive}>
                すべての履歴
                <ArrowUpRight />
              </button>
            </div>
            <div className="history-rows">
              {recent.length ? (
                recent.map((event) => (
                  <div className="history-row" key={event.id}>
                    <time>{timeLabel(event.elapsedMs).slice(3)}</time>
                    <span>{eventLabels[event.type] || event.type}</span>
                    <span className="change-text">
                      {event.removed && (
                        <span className="removed">{event.removed}</span>
                      )}
                      {event.removed && event.inserted ? ' → ' : ''}
                      {event.inserted ||
                        (!event.removed ? event.composition || '—' : '')}
                    </span>
                  </div>
                ))
              ) : (
                <div className="empty-history">履歴なし</div>
              )}
            </div>
          </section>
        </section>
      </div>
      <span
        className={`audience-status ${audienceSeen && now - audienceSeen < 12000 ? 'is-connected' : ''}`}
        aria-label={
          audienceSeen && now - audienceSeen < 12000 ? '接続中' : '未接続'
        }
        title={audienceSeen && now - audienceSeen < 12000 ? '接続中' : '未接続'}
      />
      <AlertDialog open={confirmNext} onOpenChange={setConfirmNext}>
        <AlertDialogContent>
          <AlertDialogTitle>新しく書きますか？</AlertDialogTitle>
          <AlertDialogDescription className="dialog-description">
            {String(session.number).padStart(2, '0')}{' '}
            の履歴を保存し、新しく書きます。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>戻る</AlertDialogCancel>
            <AlertDialogAction onClick={nextSession}>次へ</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="!w-full !max-w-[800px]">
          <SheetHeader>
            <SheetTitle>履歴</SheetTitle>
          </SheetHeader>
          <div className="sheet-body">
            <div className="archive-list">
              {archive.map((s) => (
                <div
                  className="archive-tab"
                  data-selected={archiveId === s.id}
                  key={s.id}
                >
                  <button
                    className="archive-select"
                    aria-pressed={archiveId === s.id}
                    onClick={() => selectArchive(s.id)}
                  >
                    {String(s.number).padStart(2, '0')}
                  </button>
                  <button
                    className="archive-close"
                    aria-label={`${String(s.number).padStart(2, '0')}を削除`}
                    title="削除"
                    disabled={locked || composing || archiveBusy}
                    onClick={() => deleteArchive(s.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {deletedSessions.length > 0 && (
              <div className="archive-undo">
                <output>
                  {String(deletedSessions.at(-1)!.session.number).padStart(
                    2,
                    '0',
                  )}
                  を削除しました
                </output>
                <button
                  className="subtle"
                  disabled={locked || archiveBusy}
                  onClick={undoArchiveDelete}
                >
                  削除を取り消す
                </button>
              </div>
            )}
            {archiveSession && (
              <>
                <p className="small-note">
                  {new Date(archiveSession.startedAt).toLocaleString('ja-JP')} ·{' '}
                  {archiveEvents.length}件
                </p>
                <Paper
                  text={archiveSession.text}
                  committed={archiveSession.text}
                  composing={false}
                  marks={archiveMarks.filter((m) => !m.temporary)}
                  settings={settings}
                  number={archiveSession.number}
                  paused={archiveSession.phase === 'break'}
                />
                <div className="export-row">
                  <button
                    className="action"
                    disabled={exporting}
                    onClick={() => exportCsv(archiveId)}
                  >
                    <Download />
                    この履歴のCSV
                  </button>
                  <button
                    className="subtle"
                    disabled={exporting}
                    onClick={() => exportCsv()}
                  >
                    <Download />
                    全履歴のCSV
                  </button>
                </div>
              </>
            )}
            <Table className="event-table">
              <TableHeader>
                <TableRow>
                  <TableHead>経過時間</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead>消した言葉</TableHead>
                  <TableHead>加えた言葉</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {archiveEvents
                  .slice()
                  .reverse()
                  .slice(0, archiveLimit)
                  .map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        {timeLabel(e.elapsedMs)}.
                        {String(e.elapsedMs % 1000).padStart(3, '0')}
                      </TableCell>
                      <TableCell>{eventLabels[e.type] || e.type}</TableCell>
                      <TableCell>{e.removed || '—'}</TableCell>
                      <TableCell>
                        {e.inserted || e.composition || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
            {archiveEvents.length > archiveLimit && (
              <button
                className="subtle"
                onClick={() => setArchiveLimit((n) => n + 80)}
              >
                さらに80件を表示
              </button>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}
