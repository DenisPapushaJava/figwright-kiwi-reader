import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import { SceneGraphStore } from './scenegraph.js';
import { KiwiWireDecoder } from './wire.js';

interface ExtensionHello {
  type: 'hello';
  url: string;
  title?: string;
}

interface ExtensionFrame {
  type: 'frame';
  payload: string;
}

type ExtensionMessage = ExtensionHello | ExtensionFrame | { type: 'ping' };

export interface CaptureStatus {
  connected: boolean;
  url: string | null;
  title: string | null;
  schemaReady: boolean;
  nodes: number;
  decodedFrames: number;
  ignoredFrames: number;
}

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

export class KiwiCaptureServer extends EventEmitter {
  readonly graph = new SceneGraphStore();
  readonly decoder = new KiwiWireDecoder();

  private readonly host: string;
  private readonly requestedPort: number;
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private currentUrl: string | null = null;
  private currentTitle: string | null = null;
  private decodedFrames = 0;
  private ignoredFrames = 0;

  constructor(options: { host?: string; port?: number } = {}) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 9224;
  }

  get status(): CaptureStatus {
    return {
      connected: this.socket?.readyState === this.socket?.OPEN,
      url: this.currentUrl,
      title: this.currentTitle,
      schemaReady: this.decoder.ready,
      nodes: this.graph.size,
      decodedFrames: this.decodedFrames,
      ignoredFrames: this.ignoredFrames,
    };
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
    this.socket?.close();
    this.socket = null;
    if (server === null) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  waitForNode(id: string, timeoutMs: number): Promise<void> {
    if (this.graph.has(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onUpdate = (): void => {
        if (!this.graph.has(id)) return;
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
      if (message === null) return;
      if (message.type === 'ping') return;
      if (message.type === 'hello') {
        if (message.url !== this.currentUrl) {
          this.graph.clear();
          this.decoder.reset();
          this.decodedFrames = 0;
          this.ignoredFrames = 0;
        }
        this.currentUrl = message.url;
        this.currentTitle = message.title ?? null;
        this.emit('status', this.status);
        return;
      }

      const decoded = this.decoder.ingestBase64(message.payload);
      if (decoded.kind === 'message') {
        this.decodedFrames++;
        const applied = this.graph.apply(decoded.message);
        if (applied > 0) this.emit('update', this.status);
      } else if (decoded.kind === 'ignored') {
        this.ignoredFrames++;
      }
      this.emit('status', this.status);
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.emit('status', this.status);
    });
  }
}
