import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import { normalizeNodeId, SceneGraphStore } from './scenegraph.js';
import { KiwiWireDecoder } from './wire.js';

interface ExtensionHello {
  type: 'hello';
  tabId: number;
  url: string;
  title?: string;
  reset?: boolean;
}

interface ExtensionFrame {
  type: 'frame';
  tabId: number;
  payload: string;
}

type ExtensionMessage = ExtensionHello | ExtensionFrame | { type: 'ping' };

export interface FigmaLocation {
  fileKey: string;
  selectedNodeId: string | null;
}

export interface CaptureSessionStatus {
  tabId: number;
  connected: boolean;
  fileKey: string;
  selectedNodeId: string | null;
  url: string;
  title: string | null;
  schemaReady: boolean;
  nodes: number;
  decodedFrames: number;
  ignoredFrames: number;
}

export interface CaptureStatus {
  connected: boolean;
  sessions: readonly CaptureSessionStatus[];
}

interface CaptureStatusMessage {
  type: 'capture-status';
  session: CaptureSessionStatus;
}

interface CaptureErrorMessage {
  type: 'capture-error';
  tabId: number;
  code: 'KIWI_DECODE_FAILED';
  message: string;
  session: CaptureSessionStatus;
}

export const parseFigmaLocation = (input: string): FigmaLocation | null => {
  try {
    const url = new URL(input);
    if (url.hostname !== 'www.figma.com') return null;
    const match = url.pathname.match(/^\/(?:design|file|board|proto|slides)\/([^/]+)/);
    if (match?.[1] === undefined) return null;
    const rawNodeId = url.searchParams.get('node-id');
    return {
      fileKey: match[1],
      selectedNodeId: rawNodeId === null ? null : normalizeNodeId(rawNodeId),
    };
  } catch {
    return null;
  }
};

const isExtensionOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin;
  return origin?.startsWith('chrome-extension://') === true;
};

const parseMessage = (data: Buffer): ExtensionMessage | null => {
  try {
    const value: unknown = JSON.parse(data.toString('utf8'));
    if (typeof value !== 'object' || value === null || !('type' in value)) return null;
    return value as ExtensionMessage;
  } catch {
    return null;
  }
};

export class KiwiCaptureSession {
  readonly graph = new SceneGraphStore();
  readonly decoder = new KiwiWireDecoder();

  connected = true;
  fileKey: string;
  selectedNodeId: string | null;
  url: string;
  title: string | null;
  decodedFrames = 0;
  ignoredFrames = 0;
  consecutiveDecodeFailures = 0;
  lastActivityAt = Date.now();

  constructor(
    readonly tabId: number,
    hello: ExtensionHello,
    location: FigmaLocation,
  ) {
    this.fileKey = location.fileKey;
    this.selectedNodeId = location.selectedNodeId;
    this.url = hello.url;
    this.title = hello.title ?? null;
  }

  get status(): CaptureSessionStatus {
    return {
      tabId: this.tabId,
      connected: this.connected,
      fileKey: this.fileKey,
      selectedNodeId: this.selectedNodeId,
      url: this.url,
      title: this.title,
      schemaReady: this.decoder.ready,
      nodes: this.graph.size,
      decodedFrames: this.decodedFrames,
      ignoredFrames: this.ignoredFrames,
    };
  }

  updateHello(hello: ExtensionHello, location: FigmaLocation): void {
    if (hello.reset === true || location.fileKey !== this.fileKey) this.reset();
    this.connected = true;
    this.fileKey = location.fileKey;
    this.selectedNodeId = location.selectedNodeId;
    this.url = hello.url;
    this.title = hello.title ?? null;
    this.lastActivityAt = Date.now();
  }

  ingest(payload: string): number {
    this.lastActivityAt = Date.now();
    const decoded = this.decoder.ingestBase64(payload);
    if (decoded.kind === 'message') {
      this.consecutiveDecodeFailures = 0;
      this.decodedFrames++;
      return this.graph.apply(decoded.message);
    }
    if (decoded.kind === 'schema') this.consecutiveDecodeFailures = 0;
    if (decoded.kind === 'ignored') {
      this.ignoredFrames++;
      this.consecutiveDecodeFailures++;
      if (decoded.source === 'schema' || this.consecutiveDecodeFailures >= 3) {
        throw new Error(decoded.error);
      }
    }
    return 0;
  }

  reset(): void {
    this.graph.clear();
    this.decoder.reset();
    this.decodedFrames = 0;
    this.ignoredFrames = 0;
    this.consecutiveDecodeFailures = 0;
  }
}

export class KiwiCaptureServer extends EventEmitter {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly sessionMap = new Map<number, KiwiCaptureSession>();
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;

  constructor(options: { host?: string; port?: number } = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 9224;
  }

  get status(): CaptureStatus {
    return {
      connected: this.socket?.readyState === this.socket?.OPEN,
      sessions: this.listSessions().map(session => session.status),
    };
  }

  get sessions(): readonly KiwiCaptureSession[] {
    return this.listSessions();
  }

  async start(): Promise<number> {
    if (this.server !== null) throw new Error('Kiwi capture server is already running');
    const server = new WebSocketServer({
      host: this.host,
      port: this.requestedPort,
      maxPayload: 256 * 1024 * 1024,
      verifyClient: ({ req }: { req: IncomingMessage }) => isExtensionOrigin(req),
    });
    this.server = server;

    server.on('connection', socket => this.bind(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No TCP address');
    return address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.socket?.close(1000, 'Server stopped');
    this.socket = null;
    for (const session of this.sessionMap.values()) session.connected = false;
    if (server === null) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  listSessions(): KiwiCaptureSession[] {
    return [...this.sessionMap.values()].toSorted((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  sessionForFile(fileKey: string): KiwiCaptureSession | null {
    return this.listSessions().find(session => session.fileKey === fileKey) ?? null;
  }

  findNode(id: string, fileKey?: string): ReturnType<SceneGraphStore['find']> {
    const sessions =
      fileKey === undefined
        ? this.listSessions()
        : this.listSessions().filter(session => session.fileKey === fileKey);
    for (const session of sessions) {
      const node = session.graph.find(id);
      if (node !== null) return node;
    }
    return null;
  }

  waitForNode(id: string, timeoutMs: number, fileKey?: string): Promise<void> {
    if (this.findNode(id, fileKey) !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onUpdate = (): void => {
        if (this.findNode(id, fileKey) === null) return;
        clearTimeout(timer);
        this.off('update', onUpdate);
        resolve();
      };
      const timer = setTimeout(() => {
        this.off('update', onUpdate);
        reject(new Error(`Timed out waiting for Figma node ${id}`));
      }, timeoutMs);
      this.on('update', onUpdate);
    });
  }

  private bind(socket: WebSocket): void {
    this.socket?.close(4000, 'Replaced by a newer browser connection');
    this.socket = socket;
    this.emit('status', this.status);

    socket.on('message', data => {
      if (!Buffer.isBuffer(data)) return;
      const message = parseMessage(data);
      if (message === null || message.type === 'ping') return;

      if (message.type === 'hello') {
        const location = parseFigmaLocation(message.url);
        if (location === null || !Number.isInteger(message.tabId)) return;
        const current = this.sessionMap.get(message.tabId);
        let session = current;
        if (session === undefined) {
          session = new KiwiCaptureSession(message.tabId, message, location);
          this.sessionMap.set(message.tabId, session);
        } else {
          session.updateHello(message, location);
        }
        this.sendSessionStatus(socket, session);
        this.emit('status', this.status);
        return;
      }

      const session = this.sessionMap.get(message.tabId);
      if (session === undefined) return;
      try {
        const applied = session.ingest(message.payload);
        if (applied > 0) this.emit('update', session.status);
        this.sendSessionStatus(socket, session);
        this.emit('status', this.status);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const response: CaptureErrorMessage = {
          type: 'capture-error',
          tabId: session.tabId,
          code: 'KIWI_DECODE_FAILED',
          message: detail,
          session: session.status,
        };
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(response));
      }
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const session of this.sessionMap.values()) session.connected = false;
      this.emit('status', this.status);
    });
  }

  private sendSessionStatus(socket: WebSocket, session: KiwiCaptureSession): void {
    if (socket.readyState !== socket.OPEN) return;
    const message: CaptureStatusMessage = { type: 'capture-status', session: session.status };
    socket.send(JSON.stringify(message));
  }
}
