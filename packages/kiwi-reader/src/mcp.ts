#!/usr/bin/env node
import type { DetailLevel, SerializedNode } from '@figwright/shared';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { KiwiCaptureServer, type KiwiCaptureSession } from './capture-server.js';
import { normalizeCapturedNode } from './normalize.js';
import { normalizeNodeId, type CapturedNode } from './scenegraph.js';

const DEFAULT_MAX_NODES = 2_000;
const DEFAULT_MAX_DEPTH = 12;
const MAX_RESPONSE_CHARS = 1_500_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;

const capture = new KiwiCaptureServer({
  port: Number.parseInt(process.env.FIGWRIGHT_KIWI_PORT ?? '9224', 10),
});
const port = await capture.start();
console.error(`[figwright-kiwi] capture ready on ws://127.0.0.1:${port}`);

let boundTabId: number | null = null;

const textResult = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const activeSessions = (): KiwiCaptureSession[] =>
  capture
    .listSessions()
    .filter(session => session.connected && session.decoder.ready && session.graph.size > 0);

const sessionByTarget = (target?: { fileKey?: string; tabId?: number }): KiwiCaptureSession => {
  const sessions = activeSessions();
  const tabId = target?.tabId ?? boundTabId;
  const selected =
    (tabId === null ? undefined : sessions.find(session => session.tabId === tabId)) ??
    (target?.fileKey === undefined
      ? undefined
      : sessions.find(session => session.fileKey === target.fileKey)) ??
    sessions[0];
  if (selected === undefined) {
    throw new Error(
      'No decoded Figma tab is available. Open the file in Chrome and click the Figwright Kiwi Reader extension.',
    );
  }
  return selected;
};

const parseNodeTarget = (raw: string | undefined): { nodeId: string | null; fileKey?: string } => {
  if (raw === undefined) return { nodeId: null };
  try {
    const url = new URL(raw);
    if (url.hostname === 'www.figma.com') {
      const fileKey = url.pathname.match(/^\/(?:design|file|board|proto|slides)\/([^/]+)/)?.[1];
      const value = url.searchParams.get('node-id');
      return {
        nodeId: value === null ? null : normalizeNodeId(value),
        ...(fileKey === undefined ? {} : { fileKey }),
      };
    }
  } catch {
    // A plain node id is the normal case.
  }
  return { nodeId: normalizeNodeId(raw.trim()) };
};

const pickNode = (raw: string | undefined, options: { depth?: number; maxNodes?: number } = {}) => {
  const target = parseNodeTarget(raw);
  const session = sessionByTarget(
    target.fileKey === undefined ? undefined : { fileKey: target.fileKey },
  );
  const selectedNodeId = target.nodeId ?? session.selectedNodeId;
  if (selectedNodeId === null) {
    throw new Error(
      'No node id was provided and the active Figma tab has no selected node in its URL.',
    );
  }
  const result = session.graph.findWithStats(
    selectedNodeId,
    options.depth ?? DEFAULT_MAX_DEPTH,
    options.maxNodes ?? DEFAULT_MAX_NODES,
  );
  if (result.node === null) {
    throw new Error(
      `Node ${selectedNodeId} is not present in the captured graph for file ${session.fileKey}. ` +
        'Reload the Figma tab with the reader enabled if it was selected after capture.',
    );
  }
  return { session, selectedNodeId, captured: result.node, stats: result };
};

const projectNode = (node: SerializedNode, detail: DetailLevel): Record<string, unknown> => {
  const children = node.children?.map(child => projectNode(child, detail));
  if (detail === 'minimal') {
    return { id: node.id, name: node.name, type: node.type, ...(children ? { children } : {}) };
  }
  if (detail === 'compact') {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      ...(node.visible ? {} : { visible: false }),
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      ...(children ? { children } : {}),
    };
  }
  const { locked: _locked, parentId: _parentId, visible, ...full } = node;
  return { ...full, ...(visible ? {} : { visible: false }) };
};

const countTree = (node: CapturedNode): number =>
  1 + node.children.reduce((sum, child) => sum + countTree(child), 0);

const sectionPlan = (root: CapturedNode, reason: string) => ({
  nodes: [{ id: root.id, name: root.name, type: root.type }],
  sectionPlan: {
    reason,
    totalNodes: countTree(root),
    sections: root.children.map(child => ({
      nodeId: child.id,
      name: child.name,
      type: child.type,
      nodes: countTree(child),
    })),
  },
  note: 'Request each section nodeId with get_design_context at detail full.',
});

const createMcpServer = (): McpServer => {
  const server = new McpServer(
    { name: 'figwright-kiwi-reader', version: '0.1.0' },
    {
      instructions:
        'Read-only Figma browser capture. Use get_design_context for code generation. No Figma writes are available.',
    },
  );

  server.registerTool(
    'browser_status',
    {
      description:
        'Show Chrome connection, captured Figma tabs, selected node ids and cache sizes.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () => textResult({ ...capture.status, boundTabId }),
  );

  server.registerTool(
    'list_files',
    {
      description: 'List every decoded Figma browser tab available to this read-only server.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () =>
      textResult({
        files: capture.status.sessions.map(session => ({
          tabId: session.tabId,
          fileKey: session.fileKey,
          title: session.title,
          url: session.url,
          selectedNodeId: session.selectedNodeId,
          connected: session.connected,
          schemaReady: session.schemaReady,
          nodes: session.nodes,
          bound: session.tabId === boundTabId,
        })),
      }),
  );

  server.registerTool(
    'use_file',
    {
      description:
        'Bind reads to one captured Figma tab by tabId or fileKey; release returns to most-recent routing.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        fileKey: z.string().optional(),
        release: z.boolean().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ tabId, fileKey, release }) => {
      if (release === true) boundTabId = null;
      else if (tabId !== undefined || fileKey !== undefined) {
        const session = sessionByTarget({
          ...(tabId === undefined ? {} : { tabId }),
          ...(fileKey === undefined ? {} : { fileKey }),
        });
        boundTabId = session.tabId;
      }
      return textResult({ boundTabId, files: capture.status.sessions });
    },
  );

  server.registerTool(
    'get_selection',
    {
      description:
        'Read the node selected in the active Figma browser tab URL, without descendants.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () => {
      const session = sessionByTarget();
      if (session.selectedNodeId === null) return textResult({ nodes: [] });
      const node = session.graph.find(session.selectedNodeId, 0, 1);
      return textResult({
        nodes: node === null ? [] : [normalizeCapturedNode(node)],
        fileKey: session.fileKey,
        selectedNodeId: session.selectedNodeId,
      });
    },
  );

  server.registerTool(
    'get_node',
    {
      description:
        'Return a normalized Figma node subtree from a node id or pasted Figma URL. Results are bounded to protect the MCP client.',
      inputSchema: z.object({
        nodeId: z.string(),
        depth: z.number().int().min(0).max(32).optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ nodeId, depth }) => {
      const result = pickNode(nodeId, depth === undefined ? {} : { depth });
      const output = {
        node: normalizeCapturedNode(result.captured),
        capture: {
          fileKey: result.session.fileKey,
          tabId: result.session.tabId,
          visited: result.stats.visited,
          truncated: result.stats.nodeLimitReached || result.stats.depthLimitReached,
        },
      };
      const chars = JSON.stringify(output).length;
      if (chars > MAX_RESPONSE_CHARS) {
        return textResult({
          node: { id: result.captured.id, name: result.captured.name, type: result.captured.type },
          ...sectionPlan(result.captured, `payload ${chars} chars exceeds ${MAX_RESPONSE_CHARS}`),
        });
      }
      return textResult(output);
    },
  );

  server.registerTool(
    'get_design_context',
    {
      description:
        'Return bounded browser-captured design context for a node id, pasted Figma URL, or the current selection. ' +
        'Use detail full for implementation, compact for structure, and minimal for an outline.',
      inputSchema: z.object({
        nodeId: z.string().optional(),
        depth: z.number().int().min(0).max(32).optional(),
        detail: z.enum(['minimal', 'compact', 'full']).optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ nodeId, depth, detail }) => {
      const result = pickNode(nodeId, depth === undefined ? {} : { depth });
      const projected = projectNode(normalizeCapturedNode(result.captured), detail ?? 'full');
      const output = {
        nodes: [projected],
        capture: {
          provider: 'kiwi-browser',
          fileKey: result.session.fileKey,
          tabId: result.session.tabId,
          visited: result.stats.visited,
          truncated: result.stats.nodeLimitReached || result.stats.depthLimitReached,
        },
        caveats: [
          'Component identity, variables, mixed text runs and binary vector/image assets are not resolved yet.',
        ],
      };
      const chars = JSON.stringify(output).length;
      if (chars > MAX_RESPONSE_CHARS) {
        return textResult(
          sectionPlan(result.captured, `payload ${chars} chars exceeds ${MAX_RESPONSE_CHARS}`),
        );
      }
      return textResult(output);
    },
  );

  return server;
};

const stdio = serveStdio(createMcpServer, {
  onerror: error => console.error(`[figwright-kiwi] MCP transport error: ${error.message}`),
});
console.error('[figwright-kiwi] read-only MCP server ready');

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await stdio.close().catch(() => {});
  await capture.stop().catch(() => {});
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());
process.stdin.once('end', () => void shutdown());
process.stdin.once('close', () => void shutdown());
