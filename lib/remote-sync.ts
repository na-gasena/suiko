import {
  compressSnapshot,
  decompressSnapshot,
  snapshotBytes,
} from './snapshot-codec.ts';

export type RemoteRole = 'editor' | 'audience';
export type RemoteAccess = {
  roomId: string;
  role: RemoteRole;
  token: string;
  audienceToken?: string;
};
export type RemoteState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'conflict'
  | 'error';

const bytes = (length: number) => {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
};

export function remoteEndpoint() {
  const configured = (
    import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  ).env?.VITE_REMOTE_WS_URL;
  if (configured) return configured.replace(/\/$/, '');
  if (
    typeof location !== 'undefined' &&
    /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  )
    return 'ws://localhost:8787';
  return '';
}

export function createRemoteAccess(): RemoteAccess {
  return {
    roomId: bytes(18),
    role: 'editor',
    token: bytes(32),
    audienceToken: bytes(32),
  };
}

export function readRemoteAccess(url: URL): RemoteAccess | null {
  const roomId = url.searchParams.get('room') || '';
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(roomId)) return null;
  const hash = new URLSearchParams(url.hash.slice(1));
  if (url.searchParams.get('view') === 'audience') {
    const token = hash.get('audience') || '';
    return token ? { roomId, role: 'audience', token } : null;
  }
  const token = hash.get('editor') || '';
  const audienceToken = hash.get('audience') || '';
  return token ? { roomId, role: 'editor', token, audienceToken } : null;
}

export function remoteLinks(baseHref: string, access: RemoteAccess) {
  const editor = new URL(baseHref);
  editor.searchParams.delete('view');
  editor.searchParams.set('room', access.roomId);
  editor.hash = new URLSearchParams({
    editor: access.token,
    ...(access.audienceToken ? { audience: access.audienceToken } : {}),
  }).toString();
  const audience = new URL(editor);
  audience.searchParams.set('view', 'audience');
  audience.hash = new URLSearchParams({
    audience: access.audienceToken || access.token,
  }).toString();
  return { editor: editor.toString(), audience: audience.toString() };
}

type ConnectionOptions<T> = {
  endpoint: string;
  access: RemoteAccess;
  onSnapshot?: (snapshot: T, clockOffset: number) => void;
  onState?: (state: RemoteState) => void;
  onPresence?: (audiences: number) => void;
};

export class RemoteConnection<T> {
  private options: ConnectionOptions<T>;
  private socket: WebSocket | null = null;
  private stopped = false;
  private authenticated = false;
  private retry = 0;
  private retryTimer = 0;
  private sendTimer = 0;
  private latest: T | null = null;
  private takeover = false;
  private sending = false;
  private pendingSend = false;
  private lastRevision = 0;
  private readonly clientId = crypto.randomUUID();

  constructor(options: ConnectionOptions<T>) {
    this.options = options;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    this.socket?.close(1000, 'client_closed');
    this.socket = null;
  }

  sendSnapshot(snapshot: T) {
    this.latest = snapshot;
    clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => this.flush(), 200);
  }

  takeOver() {
    if (this.options.access.role !== 'editor') return;
    this.takeover = true;
    this.stopped = false;
    this.retry = 0;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    const previous = this.socket;
    this.socket = null;
    this.authenticated = false;
    previous?.close(1000, 'editor_takeover');
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    this.authenticated = false;
    this.options.onState?.(this.retry ? 'reconnecting' : 'connecting');
    const url = new URL(
      `${this.options.endpoint}/rooms/${this.options.access.roomId}`,
    );
    url.searchParams.set('role', this.options.access.role);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      socket.send(
        JSON.stringify({
          type: 'auth',
          token: this.options.access.token,
          audienceToken: this.options.access.audienceToken,
          ...(this.options.access.role === 'editor'
            ? { clientId: this.clientId }
            : {}),
          ...(this.takeover ? { takeover: true } : {}),
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      if (event.data === 'pong') return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === 'authenticated') {
        this.authenticated = true;
        this.takeover = false;
        this.retry = 0;
        this.options.onState?.('connected');
        void this.flush();
      }
      if (message.type === 'editor_conflict') {
        this.authenticated = false;
        this.options.onState?.('conflict');
        socket.close(4009, 'editor_conflict');
      }
      if (
        (message.type === 'snapshot' || message.type === 'snapshot_gzip') &&
        (message.snapshot || message.payload)
      ) {
        const serverTime = Number(message.serverTime) || Date.now();
        const editorTime = Number(message.editorTime) || serverTime;
        const revision = Number(message.revision) || 0;
        if (revision <= this.lastRevision) return;
        if (message.type === 'snapshot_gzip') {
          void decompressSnapshot<T>(String(message.payload))
            .then((snapshot) => {
              if (this.socket !== socket || revision <= this.lastRevision)
                return;
              this.lastRevision = revision;
              this.options.onSnapshot?.(snapshot, serverTime - editorTime);
            })
            .catch(() => this.options.onState?.('error'));
        } else {
          this.lastRevision = revision;
          this.options.onSnapshot?.(
            message.snapshot as T,
            serverTime - editorTime,
          );
        }
      }
      if (message.type === 'presence')
        this.options.onPresence?.(Number(message.audiences) || 0);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped || event.code === 1000) return;
      if (event.code === 4001 || event.code === 4009) {
        this.authenticated = false;
        this.options.onState?.('conflict');
        return;
      }
      if (event.code === 1008 || event.code === 1009) {
        this.options.onState?.('error');
        return;
      }
      this.options.onState?.('reconnecting');
      const delay = Math.min(5000, 400 * 2 ** Math.min(this.retry++, 4));
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    });
    socket.addEventListener('error', () => socket.close());
  }

  private async flush() {
    if (
      !this.latest ||
      !this.authenticated ||
      this.options.access.role !== 'editor' ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    if (this.sending) {
      this.pendingSend = true;
      return;
    }
    this.sending = true;
    const socket = this.socket;
    const snapshot = this.latest;
    try {
      const payload =
        snapshotBytes(snapshot) >= 32 * 1024
          ? await compressSnapshot(snapshot)
          : null;
      if (
        !this.stopped &&
        this.socket === socket &&
        this.authenticated &&
        socket.readyState === WebSocket.OPEN
      )
        socket.send(
          JSON.stringify(
            payload
              ? { type: 'snapshot_gzip', editorTime: Date.now(), payload }
              : { type: 'snapshot', editorTime: Date.now(), snapshot },
          ),
        );
    } catch {
      this.options.onState?.('error');
    } finally {
      this.sending = false;
      if (this.pendingSend) {
        this.pendingSend = false;
        void this.flush();
      }
    }
  }
}
