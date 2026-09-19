import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const DIST_ENTRY = join(import.meta.dirname, '..', 'dist', 'mcp.mjs');

const captureFixture = (large = false) => {
  const schema = parseSchema(`
    message Guid {
      int sessionID = 1;
      int localID = 2;
    }
    message ParentIndex {
      Guid guid = 1;
      string position = 2;
    }
    message NodeChange {
      Guid guid = 1;
      string name = 2;
      string type = 3;
      ParentIndex parentIndex = 4;
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
  const children = large
    ? Array.from({ length: 2_000 }, (_, index) => ({
        guid: { sessionID: 6, localID: index + 141 },
        name: `Section ${index} ${'x'.repeat(800)}`,
        type: 'FRAME',
        parentIndex: {
          guid: { sessionID: 6, localID: 140 },
          position: `${index}`.padStart(5, '0'),
        },
      }))
    : [
        {
          guid: { sessionID: 6, localID: 141 },
          name: 'Child',
          type: 'TEXT',
          parentIndex: { guid: { sessionID: 6, localID: 140 }, position: 'a' },
        },
      ];
  const messageFrame = zstdCompressSync(
    codec.encodeMessage({
      nodeChanges: [
        { guid: { sessionID: 6, localID: 140 }, name: 'Root', type: 'FRAME' },
        ...children,
      ],
    }),
  );
  return {
    expectedNodes: children.length + 1,
    schemaPayload: Buffer.from(schemaFrame).toString('base64'),
    messagePayload: Buffer.from(messageFrame).toString('base64'),
  };
};

const parseToolText = (response: Record<string, unknown>): Record<string, unknown> => {
  expect(response).not.toHaveProperty('error');
  const result = response.result as { content?: Array<{ type?: string; text?: string }> };
  const text = result.content?.find(item => item.type === 'text')?.text;
  expect(text).toBeTypeOf('string');
  return JSON.parse(text ?? '{}') as Record<string, unknown>;
};

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
};

describe.skipIf(!existsSync(DIST_ENTRY))('Kiwi read-only MCP wire (built dist)', () => {
  it('advertises only the bounded browser read tools and exits with its client', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [DIST_ENTRY], {
      env: { ...process.env, FIGWRIGHT_KIWI_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    let extensionSocket: WebSocket | null = null;
    const assetDirectory = await mkdtemp(join(tmpdir(), 'figwright-kiwi-wire-assets-'));
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    child.once('exit', code => {
      for (const resolve of pending.values()) {
        resolve({ error: { code, message: `server exited\n${stderr}` } });
      }
      pending.clear();
    });
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === '') continue;
        const message = JSON.parse(line) as { id?: number } & Record<string, unknown>;
        if (message.id !== undefined) pending.get(message.id)?.(message);
      }
    });

    const send = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId++;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${method}\n${stderr}`)),
          10_000,
        );
        pending.set(id, value => {
          clearTimeout(timeout);
          pending.delete(id);
          resolve(value);
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    };

    try {
      const initialized = await send('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'kiwi-wire-test', version: '0' },
      });
      expect(initialized).not.toHaveProperty('error');
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );

      const listed = await send('tools/list');
      const result = listed.result as { tools: Array<{ name: string }> };
      expect(result.tools.map(tool => tool.name)).toEqual([
        'browser_status',
        'list_files',
        'use_file',
        'get_selection',
        'get_node',
        'get_design_context',
        'save_assets',
        'capture_reference',
        'compare_screenshots',
      ]);

      const status = await send('tools/call', { name: 'browser_status', arguments: {} });
      expect(status).not.toHaveProperty('error');

      extensionSocket = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: 'chrome-extension://ppaieabnmndpngcaeafaooajodebhmci',
      });
      await new Promise<void>((resolve, reject) => {
        extensionSocket?.once('open', resolve);
        extensionSocket?.once('error', reject);
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for captured nodes')),
          5_000,
        );
        extensionSocket?.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            type?: string;
            session?: { nodes?: number };
          };
          if (message.type === 'capture-status' && message.session?.nodes === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      const fixture = captureFixture();
      extensionSocket.send(
        JSON.stringify({
          type: 'hello',
          tabId: 17,
          url: 'https://www.figma.com/design/file/Test?node-id=6-140',
          title: 'Test – Figma',
          captureImages: true,
        }),
      );
      extensionSocket.send(
        JSON.stringify({ type: 'frame', tabId: 17, payload: fixture.schemaPayload }),
      );
      extensionSocket.send(
        JSON.stringify({ type: 'frame', tabId: 17, payload: fixture.messagePayload }),
      );
      await ready;

      const used = parseToolText(
        await send('tools/call', { name: 'use_file', arguments: { tabId: 17 } }),
      );
      expect(used).toMatchObject({ boundTabId: 17 });

      const selection = parseToolText(
        await send('tools/call', { name: 'get_selection', arguments: {} }),
      );
      expect(selection).toMatchObject({
        fileKey: 'file',
        selectedNodeId: '6:140',
        nodes: [{ id: '6:140', name: 'Root', type: 'FRAME' }],
      });

      const node = parseToolText(
        await send('tools/call', { name: 'get_node', arguments: { nodeId: '6:140', depth: 0 } }),
      );
      expect(node).toMatchObject({
        node: { id: '6:140', name: 'Root' },
        capture: { fileKey: 'file', tabId: 17, visited: 1, truncated: true },
      });

      const context = parseToolText(
        await send('tools/call', {
          name: 'get_design_context',
          arguments: { nodeId: '6:140', depth: 2, detail: 'full' },
        }),
      );
      expect(context).toMatchObject({
        schemaVersion: 'figwright-kiwi-context@1',
        nodes: [{ id: '6:140', children: [{ id: '6:141', name: 'Child' }] }],
        capture: { provider: 'kiwi-browser', fileKey: 'file', tabId: 17, truncated: false },
        capabilities: { vectorAssets: 'not-present', rasterImages: 'not-present' },
        assets: { summary: { vectors: 0, images: 0 } },
      });

      const saved = parseToolText(
        await send('tools/call', {
          name: 'save_assets',
          arguments: { nodeId: '6:140', depth: 2, outDir: assetDirectory },
        }),
      );
      expect(saved).toMatchObject({
        schemaVersion: 'figwright-kiwi-assets@1',
        assets: 0,
        usages: 0,
        missing: [],
      });
      const savedManifest = JSON.parse(
        await readFile(join(assetDirectory, 'assets.manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(savedManifest).toMatchObject({
        schemaVersion: 'figwright-kiwi-assets@1',
        source: { provider: 'kiwi-browser', fileKey: 'file', rootNodeId: '6:140' },
      });

      const referencePath = join(assetDirectory, 'reference.png');
      const referenceRequest = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for reference request')),
          5_000,
        );
        extensionSocket?.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            type?: string;
            requestId?: string;
            tabId?: number;
          };
          if (message.type !== 'capture-reference-request' || message.requestId === undefined)
            return;
          clearTimeout(timeout);
          const png = new Uint8Array(24);
          png.set([137, 80, 78, 71, 13, 10, 26, 10]);
          png.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
          const view = new DataView(png.buffer);
          view.setUint32(16, 1280, false);
          view.setUint32(20, 720, false);
          extensionSocket?.send(
            JSON.stringify({
              type: 'capture-reference',
              tabId: message.tabId,
              requestId: message.requestId,
              payload: Buffer.from(png).toString('base64'),
              viewport: { width: 1280, height: 720, pageX: 0, pageY: 0 },
            }),
          );
          resolve();
        });
      });
      const reference = parseToolText(
        await send('tools/call', {
          name: 'capture_reference',
          arguments: { tabId: 17, outPath: referencePath },
        }),
      );
      await referenceRequest;
      expect(reference).toMatchObject({
        schemaVersion: 'figwright-kiwi-reference@1',
        imagePath: referencePath,
        width: 1280,
        height: 720,
        cropConfidence: 'viewport-only',
      });

      const largeFixture = captureFixture(true);
      const largeReady = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for large capture')),
          5_000,
        );
        extensionSocket?.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            type?: string;
            session?: { nodes?: number };
          };
          if (
            message.type === 'capture-status' &&
            message.session?.nodes === largeFixture.expectedNodes
          ) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      extensionSocket.send(
        JSON.stringify({
          type: 'hello',
          tabId: 17,
          reset: true,
          url: 'https://www.figma.com/design/file/Test?node-id=6-140',
          captureImages: true,
        }),
      );
      extensionSocket.send(
        JSON.stringify({ type: 'frame', tabId: 17, payload: largeFixture.schemaPayload }),
      );
      extensionSocket.send(
        JSON.stringify({ type: 'frame', tabId: 17, payload: largeFixture.messagePayload }),
      );
      await largeReady;
      const sectionedResponse = await send('tools/call', {
        name: 'get_design_context',
        arguments: { nodeId: '6:140', depth: 2, detail: 'full' },
      });
      const sectioned = parseToolText(sectionedResponse);
      expect(sectionedResponse.result).toBeDefined();
      expect(JSON.stringify(sectioned).length).toBeLessThan(1_500_000);
      expect(sectioned).toMatchObject({
        sectionPlan: { sectionsTruncated: true, omittedSections: 1_799 },
      });
    } finally {
      extensionSocket?.close();
      let code = child.exitCode;
      if (code === null) {
        const exited = once(child, 'exit');
        child.stdin.end();
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
        [code] = (await exited) as [number | null];
        clearTimeout(timeout);
      }
      expect(code).toBe(0);
      await rm(assetDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
