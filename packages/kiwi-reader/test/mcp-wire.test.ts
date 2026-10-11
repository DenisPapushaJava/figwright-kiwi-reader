import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { encodeRgbaPng } from '../src/png-diff.js';

const DIST_ENTRY = join(import.meta.dirname, '..', 'dist', 'mcp.mjs');
const HUB_ENTRY = join(import.meta.dirname, '..', 'dist', 'hub.mjs');

const captureFixture = (
  mode: 'small' | 'large' | 'unicode' = 'small',
  rootType = 'FRAME',
  includePages = false,
) => {
  const schema = parseSchema(`
    message Guid {
      int sessionID = 1;
      int localID = 2;
    }
    message ParentIndex {
      Guid guid = 1;
      string position = 2;
    }
    message SymbolData {
      Guid symbolID = 1;
    }
    message NodeChange {
      Guid guid = 1;
      string name = 2;
      string type = 3;
      ParentIndex parentIndex = 4;
      SymbolData symbolData = 5;
      string componentKey = 6;
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
  const children =
    mode === 'large'
      ? Array.from({ length: 2_000 }, (_, index) => ({
          guid: { sessionID: 6, localID: index + 141 },
          name: `Section ${index} ${'x'.repeat(800)}`,
          type: 'FRAME',
          parentIndex: {
            guid: { sessionID: 6, localID: 140 },
            position: `${index}`.padStart(5, '0'),
          },
        }))
      : mode === 'unicode'
        ? [
            {
              guid: { sessionID: 6, localID: 141 },
              name: `Unicode ${'Ж'.repeat(800_000)}`,
              type: 'TEXT',
              parentIndex: { guid: { sessionID: 6, localID: 140 }, position: 'a' },
            },
            {
              guid: { sessionID: 6, localID: 142 },
              name: 'Sibling section',
              type: 'FRAME',
              parentIndex: { guid: { sessionID: 6, localID: 140 }, position: 'b' },
            },
          ]
        : [
            {
              guid: { sessionID: 6, localID: 141 },
              name: 'Child',
              type: 'TEXT',
              parentIndex: { guid: { sessionID: 6, localID: 140 }, position: 'a' },
            },
            {
              guid: { sessionID: 6, localID: 142 },
              name: 'Button instance',
              type: 'INSTANCE',
              parentIndex: { guid: { sessionID: 6, localID: 140 }, position: 'b' },
              symbolData: { symbolID: { sessionID: 9, localID: 1 } },
            },
          ];
  const masters =
    mode !== 'small'
      ? []
      : [
          {
            guid: { sessionID: 9, localID: 1 },
            name: 'Button',
            type: 'SYMBOL',
            componentKey: 'button-key',
          },
        ];
  const messageFrame = zstdCompressSync(
    codec.encodeMessage({
      nodeChanges: [
        ...(includePages
          ? [
              { guid: { sessionID: 0, localID: 1 }, name: 'Current page', type: 'CANVAS' },
              { guid: { sessionID: 0, localID: 2 }, name: 'Other page', type: 'CANVAS' },
              { guid: { sessionID: 0, localID: 3 }, name: 'Duplicate', type: 'CANVAS' },
              { guid: { sessionID: 0, localID: 4 }, name: 'Duplicate', type: 'CANVAS' },
            ]
          : []),
        {
          guid: { sessionID: 6, localID: 140 },
          name: 'Root',
          type: rootType,
          ...(includePages
            ? { parentIndex: { guid: { sessionID: 0, localID: 1 }, position: 'a' } }
            : {}),
        },
        ...masters,
        ...children,
      ],
    }),
  );
  return {
    expectedNodes: children.length + masters.length + 1 + (includePages ? 4 : 0),
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
    await Promise.all([
      writeFile(
        join(assetDirectory, 'package.json'),
        JSON.stringify({ dependencies: { react: '^19.0.0' } }),
        'utf8',
      ),
      writeFile(
        join(assetDirectory, 'Button.tsx'),
        'export const Button = () => <button />;\n',
        'utf8',
      ),
      writeFile(
        join(assetDirectory, 'search.svg'),
        '<svg><path fill="currentColor" d="M0 0h1v1H0z"/></svg>',
        'utf8',
      ),
      writeFile(join(assetDirectory, 'tokens.css'), ':root { --color-brand: #6266f0; }\n', 'utf8'),
    ]);
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
      const initialization = initialized.result as {
        instructions: string;
        capabilities: { prompts?: unknown };
      };
      expect(initialization.instructions).toContain('Start with browser_status');
      expect(initialization.instructions).toContain('get_implementation_context');
      expect(initialization.instructions).toContain('actual absolute project rootDir');
      expect(initialization.instructions.length).toBeLessThan(2_000);
      expect(initialization.capabilities).toHaveProperty('prompts');
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );

      const promptList = await send('prompts/list');
      expect(promptList).not.toHaveProperty('error');
      const prompts = (
        promptList.result as { prompts: Array<{ name: string; arguments: unknown[] }> }
      ).prompts;
      expect(prompts.map(prompt => prompt.name)).toEqual([
        'figlens_codex',
        'figlens_claude',
        'figlens_cursor',
      ]);
      for (const prompt of prompts) {
        expect(prompt.arguments).toEqual([
          expect.objectContaining({ name: 'rootDir', required: false }),
          expect.objectContaining({ name: 'nodeId', required: false }),
        ]);
        // eslint-disable-next-line no-await-in-loop -- verify each advertised profile over the actual wire
        const response = await send('prompts/get', {
          name: prompt.name,
          arguments: {
            rootDir: assetDirectory,
            nodeId: 'https://www.figma.com/design/file/Test?node-id=6-140',
          },
        });
        expect(response).not.toHaveProperty('error');
        const messages = (
          response.result as {
            messages: Array<{ role: string; content: { type: string; text: string } }>;
          }
        ).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ role: 'user', content: { type: 'text' } });
        expect(messages[0]!.content.text).toContain(JSON.stringify(assetDirectory));
        expect(messages[0]!.content.text).toContain('6-140');
        expect(messages[0]!.content.text).toContain('sectionPlan');
        expect(messages[0]!.content.text).toContain(
          'Change project files only when implementation is requested',
        );
      }
      const selectionPrompt = await send('prompts/get', { name: 'figlens_codex' });
      expect(selectionPrompt).not.toHaveProperty('error');
      const invalidPrompt = await send('prompts/get', {
        name: 'figlens_codex',
        arguments: { rootDir: ' ' },
      });
      expect(invalidPrompt).toHaveProperty('error');

      const listed = await send('tools/list');
      const result = listed.result as {
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
        }>;
      };
      expect(result.tools.map(tool => tool.name)).toEqual([
        'browser_status',
        'list_files',
        'use_file',
        'get_selection',
        'get_node',
        'get_design_context',
        'analyze_project',
        'scan_components',
        'component_map',
        'icon_map',
        'token_map',
        'get_implementation_context',
        'save_assets',
        'capture_reference',
        'compare_screenshots',
      ]);
      expect(result.tools.find(tool => tool.name === 'get_implementation_context')).toMatchObject({
        description: expect.stringContaining('client-independent implementation payload'),
        inputSchema: { required: expect.arrayContaining(['rootDir']) },
      });
      expect(result.tools.find(tool => tool.name === 'compare_screenshots')).toMatchObject({
        description: expect.stringContaining('dynamic regions'),
        inputSchema: {
          required: expect.arrayContaining(['referencePath', 'actualPath', 'diffPath']),
          properties: expect.objectContaining({ ignoreRegions: expect.any(Object) }),
        },
      });

      const status = await send('tools/call', { name: 'browser_status', arguments: {} });
      expect(status).not.toHaveProperty('error');

      extensionSocket = new WebSocket(`ws://127.0.0.1:${port}`, {
        origin: 'chrome-extension://ppaieabnmndpngcaeafaooajodebhmci',
      });
      await new Promise<void>((resolve, reject) => {
        extensionSocket?.once('open', resolve);
        extensionSocket?.once('error', reject);
      });
      const fixture = captureFixture('small', 'FRAME', true);
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
          if (
            message.type === 'capture-status' &&
            message.session?.nodes === fixture.expectedNodes
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
        selectionSource: 'url',
        selectionVerified: false,
        complete: false,
        nodes: [{ id: '6:140', name: 'Root', type: 'FRAME' }],
      });

      const node = parseToolText(
        await send('tools/call', { name: 'get_node', arguments: { nodeId: '6:140', depth: 0 } }),
      );
      expect(node).toMatchObject({
        node: { id: '6:140', name: 'Root' },
        capture: { fileKey: 'file', tabId: 17, visited: 1, truncated: true },
      });
      await send('tools/call', { name: 'get_node', arguments: { nodeId: '6:140', depth: 0 } });
      const cachedStatus = parseToolText(
        await send('tools/call', { name: 'browser_status', arguments: {} }),
      );
      expect(cachedStatus).toMatchObject({
        sessions: [
          {
            tabId: 17,
            normalizationCache: { entries: 2, hits: 1, misses: 2, normalizations: 2 },
          },
        ],
      });

      // The URL can stay on the page while two independent elements are selected.
      let browserSelection: {
        url: string;
        count: number | null;
        nodeIds: string[];
        complete: boolean;
        pageName: string | null;
        incompleteReason?: 'scan-timeout' | undefined;
      } = {
        url: 'https://www.figma.com/design/file/Test?node-id=0-1',
        pageName: 'Current page',
        count: 2,
        nodeIds: ['6:141', '6:142'],
        complete: true,
      };
      const replyToSelection = (data: unknown) => {
        const request = JSON.parse(String(data)) as {
          type: string;
          tabId: number;
          requestId: string;
        };
        if (request.type !== 'capture-selection-request') return;
        extensionSocket?.send(
          JSON.stringify({
            type: 'capture-selection',
            tabId: request.tabId,
            requestId: request.requestId,
            selection: browserSelection,
          }),
        );
      };
      extensionSocket.on('message', replyToSelection);
      extensionSocket.send(
        JSON.stringify({
          type: 'hello',
          tabId: 17,
          url: browserSelection.url,
          selectionCapture: true,
          captureImages: true,
        }),
      );
      // The next status confirms that the hello has been applied before making MCP requests.
      await new Promise<void>(resolve => extensionSocket?.once('message', () => resolve()));
      const multiple = parseToolText(
        await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
      );
      expect(multiple).toMatchObject({
        selectionCount: 2,
        selectedNodeIds: ['6:141', '6:142'],
        selectedNodeId: null,
        selectionSource: 'browser-dom',
        selectionVerified: true,
        complete: true,
        nodes: [
          { id: '6:141', name: 'Child' },
          { id: '6:142', name: 'Button instance' },
        ],
        missingNodeIds: [],
      });
      const pairSelection = browserSelection;
      browserSelection = {
        ...browserSelection,
        count: 150,
        nodeIds: Array.from({ length: 150 }, (_, i) => `6:${141 + i}`),
      };
      const largeSelection = parseToolText(
        await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
      );
      expect(largeSelection).toMatchObject({
        selectionCount: 150,
        selectionVerified: true,
        complete: true,
      });
      expect(largeSelection.selectedNodeIds).toHaveLength(150);
      browserSelection = pairSelection;
      const ambiguous = await send('tools/call', {
        name: 'get_design_context',
        arguments: { tabId: 17 },
      });
      expect(ambiguous.result).toMatchObject({ isError: true });
      expect(JSON.stringify(ambiguous.result)).toContain('2 elements are selected');
      browserSelection = { ...browserSelection, count: 1, nodeIds: ['6:142'] };
      const singleContext = parseToolText(
        await send('tools/call', {
          name: 'get_design_context',
          arguments: { tabId: 17, depth: 0 },
        }),
      );
      expect(singleContext).toMatchObject({ nodes: [{ id: '6:142', name: 'Button instance' }] });
      browserSelection = { ...browserSelection, count: 0, nodeIds: [] };
      expect(
        parseToolText(
          await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
        ),
      ).toMatchObject({ nodes: [], selectionCount: 0, selectedNodeIds: [], complete: true });
      // A stale URL points at another page; the active page comes from the browser DOM.
      browserSelection = {
        ...browserSelection,
        url: 'https://www.figma.com/design/file/Test?node-id=0-2',
      };
      expect(
        parseToolText(
          await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
        ),
      ).toMatchObject({
        selectedNodeIds: [],
        currentPage: { id: '0:1', name: 'Current page', type: 'CANVAS' },
      });
      const overview = parseToolText(
        await send('tools/call', {
          name: 'get_design_context',
          arguments: { tabId: 17, depth: 32 },
        }),
      );
      expect(overview).toMatchObject({
        scope: 'page-overview',
        fallbackReason: 'no-selection',
        selectionCount: 0,
        selectionVerified: true,
        nodes: [{ id: '0:1', name: 'Current page', type: 'CANVAS' }],
        sectionPlan: {
          sections: [{ nodeId: '6:140', name: 'Root', type: 'FRAME' }],
          sectionsTruncated: false,
        },
        capture: { visited: 1 },
      });
      expect(overview).not.toHaveProperty('assets');
      expect(
        parseToolText(
          await send('tools/call', {
            name: 'get_implementation_context',
            arguments: { tabId: 17, rootDir: assetDirectory },
          }),
        ),
      ).toMatchObject({
        schemaVersion: 'figwright-kiwi-implementation@1',
        scope: 'page-overview',
        nodes: [{ id: '0:1' }],
        deferred: ['design', 'assets', 'project', 'grounding'],
      });
      expect(
        parseToolText(
          await send('tools/call', {
            name: 'get_design_context',
            arguments: { tabId: 17, nodeId: '6:141' },
          }),
        ),
      ).toMatchObject({ nodes: [{ id: '6:141', name: 'Child' }] });
      for (const pageName of ['Duplicate', 'Missing page', null]) {
        browserSelection = { ...browserSelection, pageName };
        const unresolvedPage = await send('tools/call', {
          name: 'get_design_context',
          arguments: { tabId: 17 },
        });
        expect(unresolvedPage.result).toMatchObject({ isError: true });
        expect(JSON.stringify(unresolvedPage.result)).toContain(
          'current page could not be identified uniquely',
        );
      }
      browserSelection = {
        ...browserSelection,
        count: null,
        pageName: 'Current page',
        complete: false,
      };
      const unknownSelection = await send('tools/call', {
        name: 'get_design_context',
        arguments: { tabId: 17 },
      });
      expect(unknownSelection.result).toMatchObject({ isError: true });
      expect(JSON.stringify(unknownSelection.result)).toContain('selection is incomplete');
      browserSelection = {
        ...browserSelection,
        count: 2,
        nodeIds: ['6:141'],
        complete: false,
        incompleteReason: 'scan-timeout',
      };
      expect(
        parseToolText(
          await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
        ),
      ).toMatchObject({
        selectionCount: 2,
        selectedNodeIds: ['6:141'],
        selectionVerified: false,
        complete: false,
        selectionIncompleteReason: 'scan-timeout',
      });
      browserSelection = {
        ...browserSelection,
        count: 1,
        nodeIds: ['123:456'],
        complete: true,
        incompleteReason: undefined,
      };
      expect(
        parseToolText(
          await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
        ),
      ).toMatchObject({ nodes: [], selectedNodeIds: ['123:456'], missingNodeIds: ['123:456'] });
      extensionSocket.off('message', replyToSelection);
      extensionSocket.send(
        JSON.stringify({
          type: 'hello',
          tabId: 17,
          url: 'https://www.figma.com/design/file/Test?node-id=6-140',
          captureImages: true,
        }),
      );
      await new Promise<void>(resolve => extensionSocket?.once('message', () => resolve()));

      const context = parseToolText(
        await send('tools/call', {
          name: 'get_design_context',
          arguments: { nodeId: '6:140', depth: 2, detail: 'full' },
        }),
      );
      expect(context).toMatchObject({
        schemaVersion: 'figwright-kiwi-context@1',
        nodes: [
          {
            id: '6:140',
            children: [
              { id: '6:141', name: 'Child' },
              {
                id: '6:142',
                name: 'Button instance',
                mainComponent: { id: '9:1', name: 'Button', key: 'button-key' },
              },
            ],
          },
        ],
        capture: { provider: 'kiwi-browser', fileKey: 'file', tabId: 17, truncated: false },
        capabilities: {
          vectorAssets: 'not-present',
          rasterImages: 'not-present',
          instanceSwaps: 'resolved-from-symbol-overrides',
        },
        assets: { summary: { vectors: 0, images: 0 } },
      });

      const analyzed = parseToolText(
        await send('tools/call', {
          name: 'analyze_project',
          arguments: { rootDir: assetDirectory },
        }),
      );
      expect(analyzed).toMatchObject({
        framework: 'react',
        scanMode: 'portable-static-ast',
      });

      const scanned = parseToolText(
        await send('tools/call', {
          name: 'scan_components',
          arguments: { rootDir: assetDirectory },
        }),
      );
      expect(scanned).toMatchObject({
        scanMode: 'portable-static-ast',
        components: [{ name: 'Button', filePath: 'Button.tsx', propsExtracted: true }],
      });

      const componentMap = parseToolText(
        await send('tools/call', {
          name: 'component_map',
          arguments: { nodeId: '6:140', rootDir: assetDirectory },
        }),
      );
      expect(componentMap).toMatchObject({
        scannedComponentCount: 1,
        mappings: [
          {
            figmaComponentName: 'Button',
            status: 'high',
            candidate: { name: 'Button', filePath: 'Button.tsx', confidence: 1 },
          },
        ],
      });

      const iconMap = parseToolText(
        await send('tools/call', {
          name: 'icon_map',
          arguments: { nodeId: '6:140', rootDir: assetDirectory },
        }),
      );
      expect(iconMap).toMatchObject({ mappings: [], svgFileCount: 1 });

      const tokenMap = parseToolText(
        await send('tools/call', {
          name: 'token_map',
          arguments: { nodeId: '6:140', rootDir: assetDirectory },
        }),
      );
      expect(tokenMap).toMatchObject({
        mappings: [],
        projectTokenCount: 1,
        tokenFiles: ['tokens.css'],
        scanMode: 'portable-css-scss-js-config',
        variableBindings: 'unavailable',
      });

      const implementationContext = parseToolText(
        await send('tools/call', {
          name: 'get_implementation_context',
          arguments: { nodeId: '6:140', rootDir: assetDirectory },
        }),
      );
      expect(implementationContext).toMatchObject({
        schemaVersion: 'figwright-kiwi-implementation@1',
        capabilities: {
          design: { componentInstances: 'resolved' },
          grounding: {
            components: 'project-and-installed-dependency-static-match',
            icons: 'strict-svg-and-dependency-registry-match',
            tokens: 'exact-observed-color-match-in-project-and-dependencies',
            componentProps:
              'react-static-ast-and-package-declarations; other-frameworks-unavailable',
          },
        },
        design: {
          nodes: [{ id: '6:140', children: [{ id: '6:141' }, { id: '6:142' }] }],
          capture: { provider: 'kiwi-browser', fileKey: 'file' },
        },
        project: {
          profile: { framework: 'react' },
          scanModes: {
            components: 'portable-static-ast',
            tokens: 'portable-css-scss-js-config',
          },
        },
        grounding: {
          components: {
            mappings: [{ figmaComponentName: 'Button', status: 'high' }],
          },
          icons: { mappings: [], svgFileCount: 1 },
          tokens: { mappings: [], projectTokenCount: 1 },
        },
      });
      expect(JSON.stringify(implementationContext).length).toBeLessThan(1_500_000);

      const truncatedImplementationContext = parseToolText(
        await send('tools/call', {
          name: 'get_implementation_context',
          arguments: { nodeId: '6:140', depth: 0, rootDir: '\0' },
        }),
      );
      expect(truncatedImplementationContext).toMatchObject({
        schemaVersion: 'figwright-kiwi-implementation@1',
        designSchemaVersion: 'figwright-kiwi-context@1',
        nodes: [{ id: '6:140' }],
        sectionPlan: {
          reason: 'captured subtree truncated after 1 nodes',
          totalNodes: 3,
          sections: [{ nodeId: '6:141' }, { nodeId: '6:142' }],
        },
        capture: { visited: 1, truncated: true },
        deferred: ['design', 'assets', 'project', 'grounding'],
        note: expect.stringContaining('get_implementation_context'),
      });
      expect(truncatedImplementationContext).not.toHaveProperty('project');
      expect(truncatedImplementationContext).not.toHaveProperty('groundingSummary');

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

      const actualPath = join(assetDirectory, 'actual.png');
      const diffPath = join(assetDirectory, 'diff.png');
      await Promise.all([
        writeFile(
          referencePath,
          encodeRgbaPng(2, 1, Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255])),
        ),
        writeFile(
          actualPath,
          encodeRgbaPng(2, 1, Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255])),
        ),
      ]);
      const comparison = parseToolText(
        await send('tools/call', {
          name: 'compare_screenshots',
          arguments: {
            referencePath,
            actualPath,
            diffPath,
            ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1 }],
          },
        }),
      );
      expect(comparison).toMatchObject({
        totalPixels: 2,
        comparedPixels: 1,
        ignoredPixels: 1,
        changedPixels: 0,
        changedRatio: 0,
        changedRatioOfTotal: 0,
        ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1 }],
        boundingBox: null,
        diffPath,
      });

      const largeFixture = captureFixture('large');
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
        sectionPlan: { totalNodes: 2_001, sectionsTruncated: true, omittedSections: 1_800 },
      });

      const implementationPlanResponse = await send('tools/call', {
        name: 'get_implementation_context',
        arguments: { nodeId: '6:140', depth: 2, rootDir: assetDirectory },
      });
      const implementationPlan = parseToolText(implementationPlanResponse);
      expect(JSON.stringify(implementationPlan).length).toBeLessThan(1_500_000);
      expect(implementationPlan).toMatchObject({
        schemaVersion: 'figwright-kiwi-implementation@1',
        designSchemaVersion: 'figwright-kiwi-context@1',
        sectionPlan: { totalNodes: 2_001, sectionsTruncated: true, omittedSections: 1_800 },
        capture: { truncated: true },
        deferred: ['design', 'assets', 'project', 'grounding'],
        note: expect.stringContaining('get_implementation_context'),
      });

      const unicodeFixture = captureFixture('unicode');
      const unicodeReady = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for Unicode capture')),
          10_000,
        );
        extensionSocket?.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            type?: string;
            session?: { nodes?: number };
          };
          if (
            message.type === 'capture-status' &&
            message.session?.nodes === unicodeFixture.expectedNodes
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
          captureImages: false,
        }),
      );
      extensionSocket.send(
        JSON.stringify({ type: 'frame', tabId: 17, payload: unicodeFixture.schemaPayload }),
      );
      extensionSocket.send(
        JSON.stringify({ type: 'frame', tabId: 17, payload: unicodeFixture.messagePayload }),
      );
      await unicodeReady;

      const statusBeforePreflight = parseToolText(
        await send('tools/call', { name: 'browser_status', arguments: {} }),
      ) as { sessions: Array<{ normalizationCache: { normalizations: number } }> };
      const normalizationsBefore =
        statusBeforePreflight.sessions[0]?.normalizationCache.normalizations;

      const unicodeImplementation = parseToolText(
        await send('tools/call', {
          name: 'get_implementation_context',
          arguments: { nodeId: '6:140', rootDir: '\0' },
        }),
      );
      expect(unicodeImplementation).toMatchObject({
        sectionPlan: {
          reason: expect.stringMatching(/^minimum design projection \d+ bytes exceeds 1500000$/),
        },
        deferred: ['design', 'assets', 'project', 'grounding'],
      });
      expect(unicodeImplementation).not.toHaveProperty('project');

      const unicodeDesign = parseToolText(
        await send('tools/call', {
          name: 'get_design_context',
          arguments: { nodeId: '6:140', detail: 'full' },
        }),
      );
      expect(unicodeDesign).toMatchObject({
        sectionPlan: {
          reason: expect.stringMatching(/^minimum design projection \d+ bytes exceeds 1500000$/),
        },
      });
      expect(Buffer.byteLength(JSON.stringify(unicodeDesign), 'utf8')).toBeLessThan(1_500_000);

      const unicodeNode = parseToolText(
        await send('tools/call', {
          name: 'get_node',
          arguments: { nodeId: '6:140' },
        }),
      );
      expect(unicodeNode).toMatchObject({
        sectionPlan: {
          reason: expect.stringMatching(/^minimum node projection \d+ bytes exceeds 1500000$/),
        },
      });

      const statusAfterPreflight = parseToolText(
        await send('tools/call', { name: 'browser_status', arguments: {} }),
      ) as { sessions: Array<{ normalizationCache: { normalizations: number } }> };
      expect(statusAfterPreflight.sessions[0]?.normalizationCache.normalizations).toBe(
        normalizationsBefore,
      );
      browserSelection = { ...browserSelection, count: 1, nodeIds: ['6:141'], complete: true };
      extensionSocket.on('message', replyToSelection);
      extensionSocket.send(
        JSON.stringify({
          type: 'hello',
          tabId: 17,
          url: browserSelection.url,
          selectionCapture: true,
        }),
      );
      await new Promise<void>(resolve => extensionSocket?.once('message', () => resolve()));
      const oversizedSelection = parseToolText(
        await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
      );
      expect(oversizedSelection).toMatchObject({
        selectedNodeIds: ['6:141'],
        selectionVerified: true,
        detailsOmitted: true,
        nodes: [{ id: '6:141', nameTruncated: true }],
      });
      expect(Buffer.byteLength(JSON.stringify(oversizedSelection), 'utf8')).toBeLessThan(1_500_000);
      extensionSocket.off('message', replyToSelection);

      const pageFixture = captureFixture('large', 'CANVAS');
      const pageReady = new Promise<void>(resolve => {
        const onPage = (data: unknown) => {
          const message = JSON.parse(String(data)) as { type: string; session?: { nodes: number } };
          if (
            message.type !== 'capture-status' ||
            message.session?.nodes !== pageFixture.expectedNodes
          )
            return;
          extensionSocket?.off('message', onPage);
          resolve();
        };
        extensionSocket?.on('message', onPage);
      });
      extensionSocket.send(
        JSON.stringify({
          type: 'hello',
          tabId: 17,
          reset: true,
          url: 'https://www.figma.com/design/file/Test?node-id=6-140',
        }),
      );
      extensionSocket.send(
        JSON.stringify({ type: 'frame', tabId: 17, payload: pageFixture.schemaPayload }),
      );
      extensionSocket.send(
        JSON.stringify({ type: 'frame', tabId: 17, payload: pageFixture.messagePayload }),
      );
      await pageReady;
      expect(
        parseToolText(
          await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
        ),
      ).toMatchObject({
        nodes: [],
        selectedNodeId: null,
        urlNodeId: '6:140',
        selectionVerified: false,
        selectionSource: 'url',
      });
      browserSelection = {
        ...browserSelection,
        count: 0,
        nodeIds: [],
        complete: true,
        pageName: 'Root',
      };
      extensionSocket.on('message', replyToSelection);
      extensionSocket.send(
        JSON.stringify({
          type: 'hello',
          tabId: 17,
          url: browserSelection.url,
          selectionCapture: true,
        }),
      );
      await new Promise<void>(resolve => extensionSocket?.once('message', () => resolve()));
      const largeOverview = parseToolText(
        await send('tools/call', { name: 'get_design_context', arguments: { tabId: 17 } }),
      );
      expect(largeOverview).toMatchObject({
        scope: 'page-overview',
        sectionPlan: { totalNodes: 2_001, sectionsTruncated: true, omittedSections: 1_800 },
      });
      expect((largeOverview.sectionPlan as { sections: unknown[] }).sections).toHaveLength(200);
      expect(Buffer.byteLength(JSON.stringify(largeOverview), 'utf8')).toBeLessThan(1_500_000);
      browserSelection = {
        ...browserSelection,
        count: 2_000,
        nodeIds: Array.from({ length: 2_000 }, (_, index) => `6:${index + 141}`),
      };
      const largeSelectionDetails = parseToolText(
        await send('tools/call', { name: 'get_selection', arguments: { tabId: 17 } }),
      );
      expect(largeSelectionDetails).toMatchObject({
        selectionCount: 2_000,
        complete: true,
        detailsOmitted: true,
        missingNodeIds: [],
      });
      expect(largeSelectionDetails.selectedNodeIds).toHaveLength(2_000);
      expect((largeSelectionDetails.nodes as unknown[]).length).toBeLessThan(2_000);
      expect(Buffer.byteLength(JSON.stringify(largeSelectionDetails), 'utf8')).toBeLessThan(
        1_500_000,
      );
      extensionSocket.off('message', replyToSelection);
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
  }, 45_000);
});

describe.skipIf(!existsSync(HUB_ENTRY))('Kiwi shared MCP hub (built dist)', () => {
  it('serves concurrent explicit targets and protects the loopback HTTP endpoint', async () => {
    const capturePort = await freePort();
    const hubPort = await freePort();
    const token = '0123456789abcdef0123456789abcdef';
    const child = spawn(process.execPath, [HUB_ENTRY], {
      env: {
        ...process.env,
        FIGWRIGHT_KIWI_PORT: String(capturePort),
        FIGWRIGHT_KIWI_HUB_PORT: String(hubPort),
        FIGWRIGHT_KIWI_HUB_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for hub\n${stderr}`)),
        10_000,
      );
      child.stderr.on('data', () => {
        if (!stderr.includes('shared MCP hub ready')) return;
        clearTimeout(timeout);
        resolve();
      });
      child.once('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`Hub exited with ${code}\n${stderr}`));
      });
    });

    const parseSse = (body: string): Record<string, unknown> => {
      const data = body
        .split(/\r?\n/)
        .find(line => line.startsWith('data: '))
        ?.slice('data: '.length);
      expect(data).toBeTypeOf('string');
      return JSON.parse(data ?? '{}') as Record<string, unknown>;
    };
    const call = async (
      id: number,
      method: string,
      params: Record<string, unknown>,
      headers: Record<string, string> = {},
    ) =>
      fetch(`http://127.0.0.1:${hubPort}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });

    let extensionSocket: WebSocket | null = null;
    try {
      await ready;

      const health = await fetch(`http://127.0.0.1:${hubPort}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        ok: true,
        authentication: 'bearer',
      });

      const unauthorized = await fetch(`http://127.0.0.1:${hubPort}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unauthorized.status).toBe(401);

      const hostileOrigin = await call(1, 'tools/list', {}, { origin: 'https://example.com' });
      expect(hostileOrigin.status).toBe(403);

      const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port: hubPort,
            path: '/mcp',
            method: 'POST',
            headers: {
              accept: 'application/json, text/event-stream',
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              host: 'example.com',
            },
          },
          response => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
          },
        );
        request.once('error', reject);
        request.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
      });
      expect(hostileHostStatus).toBe(403);

      const listedResponse = await call(3, 'tools/list', {});
      expect(listedResponse.status).toBe(200);
      const listed = parseSse(await listedResponse.text());
      const listedResult = listed.result as {
        tools: Array<{ name: string; inputSchema: unknown }>;
      };
      expect(listedResult.tools.map(tool => tool.name)).not.toContain('use_file');
      expect(listedResult.tools.map(tool => tool.name)).toEqual(
        expect.arrayContaining([
          'analyze_project',
          'scan_components',
          'component_map',
          'icon_map',
          'token_map',
          'get_implementation_context',
        ]),
      );
      expect(listedResult.tools.find(tool => tool.name === 'get_selection')).toMatchObject({
        inputSchema: {
          properties: { tabId: { type: 'integer' }, fileKey: { type: 'string' } },
        },
      });

      extensionSocket = new WebSocket(`ws://127.0.0.1:${capturePort}`, {
        origin: 'chrome-extension://ppaieabnmndpngcaeafaooajodebhmci',
      });
      await new Promise<void>((resolve, reject) => {
        extensionSocket?.once('open', resolve);
        extensionSocket?.once('error', reject);
      });
      const fixture = captureFixture();
      const capturedTabs = new Set<number>();
      const capturesReady = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for two hub capture sessions')),
          5_000,
        );
        extensionSocket?.on('message', data => {
          const message = JSON.parse(data.toString()) as {
            type?: string;
            session?: { tabId?: number; nodes?: number };
          };
          if (message.type !== 'capture-status' || message.session?.nodes !== fixture.expectedNodes)
            return;
          if (message.session.tabId !== undefined) capturedTabs.add(message.session.tabId);
          if (capturedTabs.size !== 2) return;
          clearTimeout(timeout);
          resolve();
        });
      });
      for (const [tabId, fileKey] of [
        [17, 'file-a'],
        [18, 'file-b'],
      ] as const) {
        extensionSocket.send(
          JSON.stringify({
            type: 'hello',
            tabId,
            url: `https://www.figma.com/design/${fileKey}/Test?node-id=6-140`,
          }),
        );
        extensionSocket.send(
          JSON.stringify({ type: 'frame', tabId, payload: fixture.schemaPayload }),
        );
        extensionSocket.send(
          JSON.stringify({ type: 'frame', tabId, payload: fixture.messagePayload }),
        );
      }
      await capturesReady;

      const [fileAResponse, fileBResponse] = await Promise.all([
        call(4, 'tools/call', {
          name: 'get_selection',
          arguments: { fileKey: 'file-a' },
        }),
        call(5, 'tools/call', {
          name: 'get_design_context',
          arguments: { fileKey: 'file-b', nodeId: '6:140', depth: 0 },
        }),
      ]);
      const fileA = parseToolText(parseSse(await fileAResponse.text()));
      const fileB = parseToolText(parseSse(await fileBResponse.text()));
      expect(fileA).toMatchObject({ fileKey: 'file-a', selectedNodeId: '6:140' });
      expect(fileB).toMatchObject({ capture: { fileKey: 'file-b', tabId: 18 } });
    } finally {
      extensionSocket?.close();
      if (child.exitCode === null) child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
    }
  }, 30_000);
});
