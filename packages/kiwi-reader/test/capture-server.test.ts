import { zstdCompressSync } from 'node:zlib';

import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  type CaptureStatus,
  FIGWRIGHT_KIWI_EXTENSION_ORIGIN,
  KiwiCaptureServer,
  KiwiCaptureSession,
  parseFigmaLocation,
} from '../src/capture-server.js';

const servers: KiwiCaptureServer[] = [];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const fixtureFrames = () => {
  const schema = parseSchema(`
    message Guid {
      int sessionID = 1;
      int localID = 2;
    }
    message NodeChange {
      Guid guid = 1;
      string name = 2;
      string type = 3;
    }
    message Message {
      NodeChange[] nodeChanges = 1;
    }
  `);
  const codec = compileSchema(schema) as {
    encodeMessage: (value: unknown) => Uint8Array;
  };
  const schemaBytes = zstdCompressSync(encodeBinarySchema(schema));
  const schemaFrame = new Uint8Array(12 + schemaBytes.length);
  schemaFrame.set(new TextEncoder().encode('fig-wire'));
  schemaFrame.set(schemaBytes, 12);
  const messageFrame = zstdCompressSync(
    codec.encodeMessage({
      nodeChanges: [{ guid: { sessionID: 6, localID: 140 }, name: 'Business', type: 'FRAME' }],
    }),
  );
  return {
    schemaPayload: Buffer.from(schemaFrame).toString('base64'),
    messagePayload: Buffer.from(messageFrame).toString('base64'),
  };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
});

describe('KiwiCaptureServer', () => {
  it('parses the file and selected node from supported Figma URLs', () => {
    expect(
      parseFigmaLocation('https://www.figma.com/design/file-key/Name?node-id=1213-57067'),
    ).toEqual({ fileKey: 'file-key', selectedNodeId: '1213:57067' });
    expect(parseFigmaLocation('https://example.com/design/file-key/Name')).toBeNull();
  });

  it.each(['https://example.com', 'chrome-extension://unrelated-extension'])(
    'rejects an unauthorized capture origin: %s',
    async origin => {
      const server = new KiwiCaptureServer({ port: 0 });
      servers.push(server);
      const port = await server.start();
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin,
      });

      const statusCode = await new Promise<number>((resolve, reject) => {
        socket.once('unexpected-response', (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        socket.once('error', reject);
      });
      expect(statusCode).toBe(401);
    },
  );

  it('accepts a read-only extension capture and exposes the decoded node', async () => {
    const { messagePayload, schemaPayload } = fixtureFrames();

    const server = new KiwiCaptureServer({ port: 0 });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: FIGWRIGHT_KIWI_EXTENSION_ORIGIN,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const progressReady = new Promise<Record<string, unknown>>(resolve => {
      socket.on('message', data => {
        const message: unknown = JSON.parse(data.toString());
        if (!isRecord(message) || message.type !== 'capture-status') return;
        const session = message.session;
        if (!isRecord(session) || session.nodes !== 1) return;
        resolve(message);
      });
    });

    socket.send(
      JSON.stringify({
        type: 'hello',
        tabId: 17,
        url: 'https://www.figma.com/design/file/Test?node-id=6-140',
        title: 'Test – Figma',
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'frame',
        tabId: 17,
        payload: schemaPayload,
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'frame',
        tabId: 17,
        payload: messagePayload,
      }),
    );

    await server.waitForNode('6:140', 2_000, 'file');
    await expect(progressReady).resolves.toMatchObject({
      type: 'capture-status',
      session: {
        tabId: 17,
        fileKey: 'file',
        selectedNodeId: '6:140',
        schemaReady: true,
        nodes: 1,
        decodedFrames: 1,
      },
    });
    expect(server.findNode('6:140', 'file')).toMatchObject({
      id: '6:140',
      name: 'Business',
      type: 'FRAME',
    });
    expect(server.status.connected).toBe(true);
    expect(server.status.sessions).toEqual([
      expect.objectContaining({
        tabId: 17,
        fileKey: 'file',
        selectedNodeId: '6:140',
        connected: true,
        schemaReady: true,
        nodes: 1,
        decodedFrames: 1,
      }),
    ]);

    const resetReady = new Promise<void>(resolve => {
      server.on('status', status => {
        if (status.sessions[0]?.schemaReady === false) resolve();
      });
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        tabId: 17,
        reset: true,
        url: 'https://www.figma.com/design/file/Test?node-id=6-140',
      }),
    );
    await resetReady;
    expect(server.sessionForFile('file')?.graph.size).toBe(0);
    socket.close();
  });

  it('keeps independent state for multiple Figma tabs', async () => {
    const server = new KiwiCaptureServer({ port: 0 });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: FIGWRIGHT_KIWI_EXTENSION_ORIGIN,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const sessionsReady = new Promise<void>(resolve => {
      server.on('status', status => {
        if (status.sessions.length === 2) resolve();
      });
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        tabId: 10,
        url: 'https://www.figma.com/design/first/One?node-id=1-1',
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'hello',
        tabId: 20,
        url: 'https://www.figma.com/design/second/Two?node-id=2-2',
      }),
    );

    await sessionsReady;
    expect(server.sessions.map(session => session.fileKey).toSorted()).toEqual(['first', 'second']);
    expect(server.sessionForFile('first')?.selectedNodeId).toBe('1:1');
    expect(server.sessionForFile('second')?.selectedNodeId).toBe('2:2');
    socket.close();
  });

  it('discards captured tabs when the extension connection is replaced or closed', async () => {
    const { messagePayload, schemaPayload } = fixtureFrames();
    const server = new KiwiCaptureServer({ port: 0 });
    servers.push(server);
    const port = await server.start();
    expect(server.status.connected).toBe(false);
    const connect = async (): Promise<WebSocket> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: FIGWRIGHT_KIWI_EXTENSION_ORIGIN,
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return socket;
    };

    const first = await connect();
    first.send(
      JSON.stringify({
        type: 'hello',
        tabId: 17,
        url: 'https://www.figma.com/design/old/Test?node-id=6-140',
      }),
    );
    first.send(JSON.stringify({ type: 'frame', tabId: 17, payload: schemaPayload }));
    first.send(JSON.stringify({ type: 'frame', tabId: 17, payload: messagePayload }));
    await server.waitForNode('6:140', 2_000, 'old');
    expect(server.status.sessions).toHaveLength(1);

    const firstClosed = new Promise<void>(resolve => first.once('close', resolve));
    const replacement = await connect();
    await firstClosed;
    expect(server.status.sessions).toEqual([]);
    expect(server.findNode('6:140', 'old')).toBeNull();

    const nextSession = new Promise<void>(resolve => {
      server.on('status', (status: CaptureStatus) => {
        if (status.sessions.some(session => session.tabId === 18)) resolve();
      });
    });
    replacement.send(
      JSON.stringify({ type: 'hello', tabId: 18, url: 'https://www.figma.com/design/new/Test' }),
    );
    await nextSession;
    const disconnected = new Promise<void>(resolve => {
      server.on('status', (status: CaptureStatus) => {
        if (!status.connected) resolve();
      });
    });
    replacement.close();
    await disconnected;
    expect(server.status.connected).toBe(false);
    expect(server.status.sessions).toEqual([]);
  });

  it('removes a detached tab from the server session list', async () => {
    const server = new KiwiCaptureServer({ port: 0 });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: FIGWRIGHT_KIWI_EXTENSION_ORIGIN,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const attached = new Promise<void>(resolve => {
      server.on('status', (status: CaptureStatus) => {
        if (status.sessions.some(session => session.tabId === 31)) resolve();
      });
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        tabId: 31,
        url: 'https://www.figma.com/design/file/Test?node-id=6-140',
      }),
    );
    await attached;
    const detached = new Promise<void>(resolve => {
      server.on('status', (status: CaptureStatus) => {
        if (status.sessions.length === 0) resolve();
      });
    });
    socket.send(JSON.stringify({ type: 'detach', tabId: 31 }));
    await detached;

    expect(server.sessions).toEqual([]);
    socket.close();
  });

  it('reports consecutive decode failures once until a successful frame resets the threshold', () => {
    const { messagePayload, schemaPayload } = fixtureFrames();
    const session = new KiwiCaptureSession(
      44,
      {
        type: 'hello',
        tabId: 44,
        url: 'https://www.figma.com/design/file/Test?node-id=6-140',
      },
      { fileKey: 'file', selectedNodeId: '6:140' },
    );
    const invalidPayload = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1]).toString('base64');

    expect(session.ingest(schemaPayload)).toBe(0);
    expect(session.ingest(invalidPayload)).toBe(0);
    expect(session.ingest(invalidPayload)).toBe(0);
    expect(() => session.ingest(invalidPayload)).toThrow(/./);
    expect(session.captureErrorActive).toBe(true);
    expect(() => session.ingest(invalidPayload)).not.toThrow();
    expect(session.ingest(messagePayload)).toBe(1);
    expect(session.captureErrorActive).toBe(false);
    expect(session.ingest(invalidPayload)).toBe(0);
    expect(session.ingest(invalidPayload)).toBe(0);
    expect(() => session.ingest(invalidPayload)).toThrow(/./);
  });

  it('retains only image network bodies in the matching tab session and clears them on reset', () => {
    const session = new KiwiCaptureSession(
      45,
      {
        type: 'hello',
        tabId: 45,
        url: 'https://www.figma.com/design/file/Test?node-id=6-140',
      },
      { fileKey: 'file', selectedNodeId: '6:140' },
    );
    expect(
      session.ingestAsset({
        url: 'https://www.figma.com/image/test',
        mimeType: 'image/png',
        payload: Buffer.from([1, 2, 3]).toString('base64'),
        base64Encoded: true,
      }),
    ).toBe(true);
    expect(session.status.networkAssets).toMatchObject({ received: 1, retained: 1, bytes: 3 });
    session.reset();
    expect(session.status.networkAssets).toMatchObject({ received: 0, retained: 0, bytes: 0 });
  });

  it('coalesces progress while retaining the latest counters', async () => {
    const { messagePayload, schemaPayload } = fixtureFrames();
    const server = new KiwiCaptureServer({ port: 0, statusThrottleMs: 100 });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: FIGWRIGHT_KIWI_EXTENSION_ORIGIN,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const statuses: Record<string, unknown>[] = [];
    socket.on('message', data => {
      const message: unknown = JSON.parse(data.toString());
      if (isRecord(message) && message.type === 'capture-status') statuses.push(message);
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        tabId: 52,
        url: 'https://www.figma.com/design/file/Test?node-id=6-140',
      }),
    );
    socket.send(JSON.stringify({ type: 'frame', tabId: 52, payload: schemaPayload }));
    for (let index = 0; index < 10; index++) {
      socket.send(JSON.stringify({ type: 'frame', tabId: 52, payload: messagePayload }));
    }
    await server.waitForNode('6:140', 2_000, 'file');
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(statuses.length).toBeLessThanOrEqual(3);
    expect(statuses.at(-1)).toMatchObject({
      session: { tabId: 52, decodedFrames: 10, nodes: 1 },
    });
    socket.close();
  });

  it('rejects pending node waiters when the capture server stops', async () => {
    const server = new KiwiCaptureServer({ port: 0 });
    servers.push(server);
    await server.start();
    const waiting = server.waitForNode('77:1', 10_000);
    await server.stop();
    await expect(waiting).rejects.toThrow(/stopped while waiting/);
  });

  it('reports an incompatible Kiwi schema to the extension', async () => {
    const server = new KiwiCaptureServer({ port: 0 });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: FIGWRIGHT_KIWI_EXTENSION_ORIGIN,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const errorReady = new Promise<Record<string, unknown>>(resolve => {
      socket.on('message', data => {
        const message: unknown = JSON.parse(data.toString());
        if (isRecord(message) && message.type === 'capture-error') resolve(message);
      });
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        tabId: 17,
        url: 'https://www.figma.com/design/file/Test?node-id=6-140',
      }),
    );
    const invalidSchema = new Uint8Array(16);
    invalidSchema.set(new TextEncoder().encode('fig-wire'));
    invalidSchema.set([1, 2, 3, 4], 12);
    socket.send(
      JSON.stringify({
        type: 'frame',
        tabId: 17,
        payload: Buffer.from(invalidSchema).toString('base64'),
      }),
    );

    await expect(errorReady).resolves.toMatchObject({
      type: 'capture-error',
      tabId: 17,
      code: 'KIWI_DECODE_FAILED',
      session: {
        fileKey: 'file',
        ignoredFrames: 1,
      },
    });
    socket.close();
  });
});
