import { DurableObject } from 'cloudflare:workers';

type Env = { ROOMS: DurableObjectNamespace<SuikoRoom> };
type Role = 'editor' | 'audience';
type Attachment = { role: Role; authenticated: boolean; clientId?: string };
type AuthRecord = {
  editorHash: string;
  audienceHash: string;
  updatedAt: number;
};
type LatestRecord = {
  revision: number;
  serverTime: number;
  editorTime: number;
  snapshot?: unknown;
  payload?: string;
};

// The stored value must remain under the SQLite-backed DO's 2 MB value limit.
const MAX_MESSAGE_BYTES = 1024 * 1024;
const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const allowedOrigins = new Set([
  'https://na-gasena.github.io',
  'http://localhost:3000',
  'http://localhost:4173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4173',
]);

function json(value: unknown, status = 200, origin = '') {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(origin && allowedOrigins.has(origin)
        ? { 'access-control-allow-origin': origin, vary: 'Origin' }
        : {}),
    },
  });
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sendIfOpen(socket: WebSocket, payload: string) {
  try {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  } catch {
    // A closing hibernatable socket can remain in getWebSockets briefly.
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    if (url.pathname === '/health') return json({ ok: true }, 200, origin);
    const match = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]{20,64})$/);
    if (!match) return json({ error: 'not_found' }, 404, origin);
    if (origin && !allowedOrigins.has(origin))
      return json({ error: 'origin_denied' }, 403);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return json({ error: 'websocket_required' }, 426, origin);
    return env.ROOMS.getByName(match[1]).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class SuikoRoom extends DurableObject<Env> {
  private latest: LatestRecord | null = null;
  private persistenceTimer: ReturnType<typeof setTimeout> | null = null;
  private authTouchedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
  }

  async fetch(request: Request) {
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'editor' && role !== 'audience')
      return json({ error: 'invalid_role' }, 400);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: Attachment = { role, authenticated: false };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [role]);
    sendIfOpen(server, JSON.stringify({ type: 'auth_required' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, 'message_too_large');
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      socket.close(1003, 'invalid_json');
      return;
    }
    const attachment = socket.deserializeAttachment() as Attachment;
    if (!attachment.authenticated) {
      if (message.type !== 'auth') {
        socket.close(1008, 'auth_required');
        return;
      }
      await this.authenticate(socket, attachment, message);
      return;
    }
    if (
      (message.type === 'snapshot' || message.type === 'snapshot_gzip') &&
      attachment.role === 'editor'
    ) {
      await this.publishSnapshot(
        socket,
        message.type === 'snapshot_gzip'
          ? { payload: message.payload }
          : { snapshot: message.snapshot },
        Number(message.editorTime),
      );
      return;
    }
    if (message.type === 'hello') {
      await this.sendLatest(socket);
      return;
    }
  }

  private async authenticate(
    socket: WebSocket,
    attachment: Attachment,
    message: Record<string, unknown>,
  ) {
    const token = typeof message.token === 'string' ? message.token : '';
    if (token.length < 32) {
      socket.close(1008, 'invalid_token');
      return;
    }
    let auth = await this.ctx.storage.get<AuthRecord>('auth');
    const now = Date.now();
    if (auth && now - auth.updatedAt > ROOM_LIFETIME_MS) {
      await this.ctx.storage.deleteAll();
      auth = undefined;
    }
    if (!auth) {
      if (
        attachment.role !== 'editor' ||
        typeof message.audienceToken !== 'string'
      ) {
        socket.close(1008, 'room_not_initialized');
        return;
      }
      const audienceToken = message.audienceToken;
      if (audienceToken.length < 32) {
        socket.close(1008, 'invalid_audience_token');
        return;
      }
      auth = {
        editorHash: await digest(token),
        audienceHash: await digest(audienceToken),
        updatedAt: now,
      };
      await this.ctx.storage.put('auth', auth);
    }
    const expected =
      attachment.role === 'editor' ? auth.editorHash : auth.audienceHash;
    if ((await digest(token)) !== expected) {
      socket.close(1008, 'forbidden');
      return;
    }
    if (attachment.role === 'editor') {
      const clientId =
        typeof message.clientId === 'string' &&
        /^[0-9a-f-]{36}$/.test(message.clientId)
          ? message.clientId
          : undefined;
      const activeEditors = this.ctx
        .getWebSockets('editor')
        .filter((editor) => {
          if (editor === socket) return false;
          const current = editor.deserializeAttachment() as Attachment;
          return current.authenticated && editor.readyState === WebSocket.OPEN;
        });
      const competingEditors = activeEditors.filter(
        (editor) =>
          !clientId ||
          (editor.deserializeAttachment() as Attachment).clientId !== clientId,
      );
      if (competingEditors.length && message.takeover !== true) {
        sendIfOpen(
          socket,
          JSON.stringify({ type: 'editor_conflict', serverTime: now }),
        );
        socket.close(4009, 'editor_conflict');
        return;
      }
      for (const editor of activeEditors)
        editor.close(
          4001,
          message.takeover === true ? 'editor_replaced' : 'editor_reconnected',
        );
    }
    attachment.authenticated = true;
    if (attachment.role === 'editor')
      attachment.clientId =
        typeof message.clientId === 'string' ? message.clientId : undefined;
    socket.serializeAttachment(attachment);
    sendIfOpen(
      socket,
      JSON.stringify({
        type: 'authenticated',
        role: attachment.role,
        serverTime: now,
      }),
    );
    await this.sendLatest(socket);
    this.broadcastPresence();
  }

  private async publishSnapshot(
    editor: WebSocket,
    content: { snapshot?: unknown; payload?: unknown },
    editorTime: number,
  ) {
    if (
      (!content.snapshot || typeof content.snapshot !== 'object') &&
      (typeof content.payload !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(content.payload))
    )
      return;
    const previous =
      this.latest || (await this.ctx.storage.get<LatestRecord>('latest'));
    const latest: LatestRecord = {
      revision: (previous?.revision || 0) + 1,
      serverTime: Date.now(),
      editorTime: Number.isFinite(editorTime) ? editorTime : Date.now(),
      ...(typeof content.payload === 'string'
        ? { payload: content.payload }
        : { snapshot: content.snapshot }),
    };
    this.latest = latest;
    this.schedulePersistence();
    const payload = JSON.stringify({
      type: latest.payload ? 'snapshot_gzip' : 'snapshot',
      ...latest,
    });
    for (const socket of this.ctx.getWebSockets('audience')) {
      const info = socket.deserializeAttachment() as Attachment;
      if (info.authenticated) sendIfOpen(socket, payload);
    }
    sendIfOpen(
      editor,
      JSON.stringify({
        type: 'ack',
        revision: latest.revision,
        serverTime: latest.serverTime,
      }),
    );
  }

  private async sendLatest(socket: WebSocket) {
    const latest =
      this.latest || (await this.ctx.storage.get<LatestRecord>('latest'));
    if (latest) this.latest = latest;
    if (latest)
      sendIfOpen(
        socket,
        JSON.stringify({
          type: latest.payload ? 'snapshot_gzip' : 'snapshot',
          ...latest,
        }),
      );
  }

  private schedulePersistence() {
    if (this.persistenceTimer !== null) return;
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      this.ctx.waitUntil(this.persistLatest());
    }, 1000);
  }

  private async persistLatest() {
    const latest = this.latest;
    if (!latest) return;
    await this.ctx.storage.put('latest', latest);
    if (latest.serverTime - this.authTouchedAt < 60_000) return;
    const auth = await this.ctx.storage.get<AuthRecord>('auth');
    if (!auth) return;
    await this.ctx.storage.put('auth', {
      ...auth,
      updatedAt: latest.serverTime,
    });
    this.authTouchedAt = latest.serverTime;
  }

  private broadcastPresence() {
    const audiences = this.ctx
      .getWebSockets('audience')
      .filter(
        (socket) =>
          (socket.deserializeAttachment() as Attachment).authenticated,
      ).length;
    const payload = JSON.stringify({
      type: 'presence',
      audiences,
      serverTime: Date.now(),
    });
    for (const socket of this.ctx.getWebSockets('editor')) {
      const info = socket.deserializeAttachment() as Attachment;
      if (info.authenticated) sendIfOpen(socket, payload);
    }
  }

  webSocketClose() {
    this.broadcastPresence();
  }
}
