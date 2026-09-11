import type { Mark, RevisionEvent, Session } from './revision';
let opened: Promise<IDBDatabase> | undefined;
export function database(): Promise<IDBDatabase> {
  if (!opened)
    opened = new Promise((resolve, reject) => {
      const r = indexedDB.open('suiko-no-ato-v1', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        for (const name of ['events', 'marks'])
          db.createObjectStore(name, { keyPath: 'id' }).createIndex(
            'sessionId',
            'sessionId',
          );
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        opened = undefined;
        reject(r.error);
      };
      r.onblocked = () => {
        opened = undefined;
        reject(new Error('別の画面で保存領域が使用されています。'));
      };
    });
  return opened;
}
export async function save(
  s: Session,
  event?: RevisionEvent,
  marks: Mark[] = [],
): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'events', 'marks'], 'readwrite');
    tx.objectStore('sessions').put(s);
    if (event) tx.objectStore('events').put(event);
    for (const mark of marks)
      if (!mark.temporary) tx.objectStore('marks').put(mark);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました。'));
  });
}
async function all<T>(store: string, sessionId?: string): Promise<T[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const source = db.transaction(store, 'readonly').objectStore(store);
    const r = sessionId
      ? source.index('sessionId').getAll(sessionId)
      : source.getAll();
    r.onsuccess = () => resolve(r.result as T[]);
    r.onerror = () => reject(r.error);
  });
}
export const loadSessions = () =>
  all<Session>('sessions').then((rows) =>
    rows.sort((a, b) => a.number - b.number),
  );
export const loadEvents = (id?: string) =>
  all<RevisionEvent>('events', id).then((rows) =>
    rows.sort(
      (a, b) => a.sessionNumber - b.sessionNumber || a.sequence - b.sequence,
    ),
  );
export const loadMarks = (id: string) => all<Mark>('marks', id);

export type SavedSession = {
  session: Session;
  events: RevisionEvent[];
  marks: Mark[];
};

export async function removeSession(id: string): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'events', 'marks'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    for (const name of ['events', 'marks']) {
      const source = tx.objectStore(name);
      const request = source
        .index('sessionId')
        .openKeyCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        source.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('削除できませんでした。'));
  });
}

export async function restoreSession(backup: SavedSession): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'events', 'marks'], 'readwrite');
    tx.objectStore('sessions').put(backup.session);
    for (const event of backup.events) tx.objectStore('events').put(event);
    for (const mark of backup.marks)
      if (!mark.temporary) tx.objectStore('marks').put(mark);
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('復元できませんでした。'));
  });
}
