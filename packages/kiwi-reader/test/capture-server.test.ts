import { zstdCompressSync } from 'node:zlib';

import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { KiwiCaptureServer, parseFigmaLocation } from '../src/capture-server.js';

const servers: KiwiCaptureServer[] = [];

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

  it('rejects clients outside a Chrome extension origin', async () => {
    const server = new KiwiCaptureServer({ port: 0 });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'https://example.com',
    });

    const statusCode = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      socket.once('error', reject);
    });
    expect(statusCode).toBe(401);
  });

  it('accepts a read-only extension capture and exposes the decoded node', async () => {
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

    const server = new KiwiCaptureServer({ port: 0 });
    servers.push(server);
    const port = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: 'chrome-extension://figwright-test',
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
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
        payload: Buffer.from(schemaFrame).toString('base64'),
      }),
    );
    socket.send(
      JSON.stringify({
        type: 'frame',
        tabId: 17,
        payload: Buffer.from(messageFrame).toString('base64'),
      }),
    );

    await server.waitForNode('6:140', 2_000, 'file');
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
      origin: 'chrome-extension://figwright-test',
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
});
