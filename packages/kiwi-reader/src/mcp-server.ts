import type { DetailLevel, SerializedNode } from '@figwright/shared';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  collectDesignAssetInventory,
  DESIGN_CONTEXT_SCHEMA_VERSION,
  rasterAssetCaveats,
  saveVectorAssetPack,
} from './asset-pack.js';
import { KiwiCaptureServer, type KiwiCaptureSession } from './capture-server.js';
import { normalizeCapturedNode } from './normalize.js';
import { comparePngFiles } from './png-diff.js';
import { saveReferenceCapture } from './reference-capture.js';
import { normalizeNodeId, type CapturedNode } from './scenegraph.js';

const DEFAULT_MAX_NODES = 2_000;
const DEFAULT_MAX_DEPTH = 12;
const MAX_RESPONSE_CHARS = 1_500_000;
const MAX_SECTION_PLAN_SECTIONS = 200;
const MAX_SECTION_NAME_CHARS = 500;
const MAX_ASSET_INVENTORY_ENTRIES = 1_000;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false } as const;

export interface KiwiMcpRoutingState {
  boundTabId: number | null;
}

export interface KiwiMcpServerOptions {
  persistentRouting?: boolean;
  routing?: KiwiMcpRoutingState;
}

interface SessionTarget {
  fileKey?: string;
  tabId?: number;
}

const textResult = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const activeSessions = (capture: KiwiCaptureServer): KiwiCaptureSession[] =>
  capture
    .listSessions()
    .filter(session => session.connected && session.decoder.ready && session.graph.size > 0);

const sessionByTarget = (
  capture: KiwiCaptureServer,
  routing: KiwiMcpRoutingState,
  target?: SessionTarget,
): KiwiCaptureSession => {
  const sessions = activeSessions(capture);
  const hasExplicitTarget = target?.tabId !== undefined || target?.fileKey !== undefined;
  const tabId = target?.tabId ?? (target?.fileKey === undefined ? routing.boundTabId : null);
  const selected = hasExplicitTarget
    ? sessions.find(
        session =>
          (target?.tabId === undefined || session.tabId === target.tabId) &&
          (target?.fileKey === undefined || session.fileKey === target.fileKey),
      )
    : ((tabId === null ? undefined : sessions.find(session => session.tabId === tabId)) ??
      sessions[0]);
  if (selected === undefined) {
    if (hasExplicitTarget) {
      const label = [
        target?.tabId === undefined ? null : `tabId=${target.tabId}`,
        target?.fileKey === undefined ? null : `fileKey=${target.fileKey}`,
      ]
        .filter(Boolean)
        .join(', ');
      throw new Error(`No decoded Figma tab matches ${label}. Call list_files and retry.`);
    }
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

const pickNode = (
  capture: KiwiCaptureServer,
  routing: KiwiMcpRoutingState,
  raw: string | undefined,
  options: { depth?: number; maxNodes?: number; fileKey?: string; tabId?: number } = {},
) => {
  const target = parseNodeTarget(raw);
  const session = sessionByTarget(capture, routing, {
    ...(options.tabId === undefined ? {} : { tabId: options.tabId }),
    ...(target.fileKey === undefined && options.fileKey === undefined
      ? {}
      : { fileKey: target.fileKey ?? options.fileKey }),
  });
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
  const {
    locked: _locked,
    parentId: _parentId,
    visible,
    children: _sourceChildren,
    ...full
  } = node;
  return {
    ...full,
    ...(visible ? {} : { visible: false }),
    ...(children ? { children } : {}),
  };
};

const countTree = (node: CapturedNode): number =>
  1 + node.children.reduce((sum, child) => sum + countTree(child), 0);

const boundedName = (name: string): { name: string; nameTruncated?: true } =>
  name.length <= MAX_SECTION_NAME_CHARS
    ? { name }
    : { name: name.slice(0, MAX_SECTION_NAME_CHARS), nameTruncated: true };

const sectionPlan = (root: CapturedNode, reason: string) => {
  const sections = root.children.slice(0, MAX_SECTION_PLAN_SECTIONS).map(child => {
    const bounded = boundedName(child.name);
    const summary: {
      nodeId: string;
      name: string;
      nameTruncated?: true;
      type: string;
      nodes: number;
    } = {
      nodeId: child.id,
      name: bounded.name,
      type: child.type,
      nodes: countTree(child),
    };
    if (bounded.nameTruncated === true) summary.nameTruncated = true;
    return summary;
  });
  return {
    schemaVersion: DESIGN_CONTEXT_SCHEMA_VERSION,
    nodes: [{ id: root.id, ...boundedName(root.name), type: root.type }],
    sectionPlan: {
      reason,
      totalNodes: countTree(root),
      sections,
      sectionsTruncated: root.children.length > sections.length,
      omittedSections: Math.max(0, root.children.length - sections.length),
    },
    note: 'Request each section nodeId with get_design_context at detail full.',
  };
};

const designAssets = (root: CapturedNode, session: KiwiCaptureSession) => {
  const inventory = collectDesignAssetInventory(root, session.blobs, session.networkAssets);
  const entries = inventory.entries.slice(0, MAX_ASSET_INVENTORY_ENTRIES);
  return {
    summary: inventory.summary,
    entries,
    entriesTruncated: entries.length < inventory.entries.length,
    omittedEntries: Math.max(0, inventory.entries.length - entries.length),
  };
};

export const createKiwiMcpServer = (
  capture: KiwiCaptureServer,
  options: KiwiMcpServerOptions = {},
): McpServer => {
  const persistentRouting = options.persistentRouting ?? true;
  const routing = options.routing ?? { boundTabId: null };
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
    () =>
      textResult({
        ...capture.status,
        boundTabId: persistentRouting ? routing.boundTabId : null,
        routing: persistentRouting ? 'connection-bound' : 'explicit-target',
      }),
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
          bound: persistentRouting && session.tabId === routing.boundTabId,
        })),
      }),
  );

  if (persistentRouting) {
    server.registerTool(
      'use_file',
      {
        description:
          'Bind reads on this MCP connection to one captured Figma tab by tabId or fileKey; release returns to most-recent routing.',
        inputSchema: z.object({
          tabId: z.number().int().optional(),
          fileKey: z.string().optional(),
          release: z.boolean().optional(),
        }),
        annotations: READ_ONLY,
      },
      ({ tabId, fileKey, release }) => {
        if (release === true) routing.boundTabId = null;
        else if (tabId !== undefined || fileKey !== undefined) {
          const session = sessionByTarget(capture, routing, {
            ...(tabId === undefined ? {} : { tabId }),
            ...(fileKey === undefined ? {} : { fileKey }),
          });
          routing.boundTabId = session.tabId;
        }
        return textResult({ boundTabId: routing.boundTabId, files: capture.status.sessions });
      },
    );
  }

  server.registerTool(
    'get_selection',
    {
      description:
        'Read the node selected in the active Figma browser tab URL, without descendants.',
      inputSchema: z.object({
        tabId: z.number().int().optional(),
        fileKey: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ tabId, fileKey }) => {
      const session = sessionByTarget(capture, routing, {
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
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
        tabId: z.number().int().optional(),
        fileKey: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ nodeId, depth, tabId, fileKey }) => {
      const result = pickNode(capture, routing, nodeId, {
        ...(depth === undefined ? {} : { depth }),
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
      const output = {
        node: normalizeCapturedNode(result.captured),
        capture: {
          fileKey: result.session.fileKey,
          tabId: result.session.tabId,
          visited: result.stats.visited,
          truncated: result.stats.nodeLimitReached || result.stats.depthLimitReached,
          instanceResolution: {
            resolved: result.stats.resolvedInstances,
            unresolved: result.stats.unresolvedInstances,
            cycles: result.stats.instanceCycles,
          },
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
        tabId: z.number().int().optional(),
        fileKey: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ nodeId, depth, detail, tabId, fileKey }) => {
      const result = pickNode(capture, routing, nodeId, {
        ...(depth === undefined ? {} : { depth }),
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
      const projected = projectNode(normalizeCapturedNode(result.captured), detail ?? 'full');
      const assets = designAssets(result.captured, result.session);
      const output = {
        schemaVersion: DESIGN_CONTEXT_SCHEMA_VERSION,
        nodes: [projected],
        capture: {
          provider: 'kiwi-browser',
          fileKey: result.session.fileKey,
          tabId: result.session.tabId,
          visited: result.stats.visited,
          truncated: result.stats.nodeLimitReached || result.stats.depthLimitReached,
          instanceResolution: {
            resolved: result.stats.resolvedInstances,
            unresolved: result.stats.unresolvedInstances,
            cycles: result.stats.instanceCycles,
          },
        },
        capabilities: {
          structuredProperties: 'captured-when-present',
          componentInstances:
            result.stats.unresolvedInstances === 0 ? 'resolved' : 'partially-resolved',
          vectorAssets:
            assets.summary.vectors === 0
              ? 'not-present'
              : assets.summary.vectors === assets.summary.exportableVectors
                ? 'exportable'
                : 'partially-exportable',
          rasterImages: !result.session.captureImages
            ? 'disabled-by-user'
            : assets.summary.images === 0
              ? 'not-present'
              : assets.summary.availableImages === assets.summary.images
                ? 'exportable'
                : 'partially-exportable',
          mixedTextRuns: 'unsupported',
          variables: 'unsupported',
          visualReference: 'not-captured',
        },
        assets,
        caveats: [
          'Variables, non-text component-property assignments and mixed text runs are not resolved yet.',
          ...rasterAssetCaveats(assets.summary, result.session.captureImages),
          ...(result.stats.unresolvedInstances === 0
            ? []
            : [
                `${result.stats.unresolvedInstances} component instance(s) could not be expanded because the captured graph did not contain a usable master component.`,
              ]),
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

  server.registerTool(
    'save_assets',
    {
      description:
        'Export browser-captured vector geometry into a content-addressed SVG asset pack and write its versioned manifest locally.',
      inputSchema: z.object({
        nodeId: z.string().optional(),
        depth: z.number().int().min(0).max(32).optional(),
        outDir: z.string().min(1),
        tabId: z.number().int().optional(),
        fileKey: z.string().optional(),
      }),
      annotations: LOCAL_WRITE,
    },
    async ({ nodeId, depth, outDir, tabId, fileKey }) => {
      const result = pickNode(capture, routing, nodeId, {
        depth: depth ?? DEFAULT_MAX_DEPTH,
        maxNodes: DEFAULT_MAX_NODES,
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
      const saved = await saveVectorAssetPack({
        root: result.captured,
        blobs: result.session.blobs,
        networkAssets: result.session.networkAssets,
        fileKey: result.session.fileKey,
        outDir,
      });
      return textResult({
        schemaVersion: saved.manifest.schemaVersion,
        manifestPath: saved.manifestPath,
        assets: Object.keys(saved.manifest.assets).length,
        usages: saved.manifest.usages.length,
        missing: saved.manifest.missing,
      });
    },
  );

  server.registerTool(
    'capture_reference',
    {
      description:
        'Capture the visible Figma browser viewport as a PNG reference and write explicit viewport metadata beside it. This is not a native node export.',
      inputSchema: z.object({
        outPath: z.string().min(1),
        tabId: z.number().int().optional(),
        fileKey: z.string().optional(),
      }),
      annotations: LOCAL_WRITE,
    },
    async ({ outPath, tabId, fileKey }) => {
      const session = sessionByTarget(capture, routing, {
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
      const reference = await capture.requestReference(session.tabId);
      const saved = await saveReferenceCapture({
        capture: reference,
        outPath,
        fileKey: session.fileKey,
        tabId: session.tabId,
        selectedNodeId: session.selectedNodeId,
      });
      return textResult({
        schemaVersion: 'figwright-kiwi-reference@1',
        ...saved,
        source: 'figma-browser-viewport',
        cropConfidence: 'viewport-only',
      });
    },
  );

  server.registerTool(
    'compare_screenshots',
    {
      description:
        'Compare equal-sized reference and implementation PNGs, write a heatmap, and report the exact changed-pixel ratio and bounding box.',
      inputSchema: z.object({
        referencePath: z.string().min(1),
        actualPath: z.string().min(1),
        diffPath: z.string().min(1),
        tolerance: z.number().int().min(0).max(255).optional(),
      }),
      annotations: LOCAL_WRITE,
    },
    async ({ referencePath, actualPath, diffPath, tolerance }) =>
      textResult(
        await comparePngFiles({
          referencePath,
          actualPath,
          diffPath,
          ...(tolerance === undefined ? {} : { tolerance }),
        }),
      ),
  );

  return server;
};
