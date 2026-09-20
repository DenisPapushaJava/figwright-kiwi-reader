import {
  DesignContextNodeSchema,
  type DesignContextNode,
  type DetailLevel,
  type SerializedNode,
} from '@figwright/shared';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  collectDesignAssetInventory,
  DESIGN_CONTEXT_SCHEMA_VERSION,
  rasterAssetCaveats,
  saveVectorAssetPack,
} from './asset-pack.js';
import { KiwiCaptureServer, type KiwiCaptureSession } from './capture-server.js';
import { NormalizedNodeCache, type CachedNodeRead } from './normalized-node-cache.js';
import { comparePngFiles } from './png-diff.js';
import {
  analyzePortableProject,
  mapProjectComponents,
  mapProjectIcons,
  scanPortableComponents,
} from './project-grounding.js';
import { minimumProjectedNodeBytes } from './projection-budget.js';
import { saveReferenceCapture } from './reference-capture.js';
import { normalizeNodeId, type CapturedNode } from './scenegraph.js';
import { mapProjectTokens } from './token-grounding.js';

const DEFAULT_MAX_NODES = 2_000;
const DEFAULT_MAX_DEPTH = 12;
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_SECTION_PLAN_SECTIONS = 200;
const MAX_SECTION_NAME_CHARS = 500;
const MAX_ASSET_INVENTORY_ENTRIES = 1_000;
const IMPLEMENTATION_CONTEXT_SCHEMA_VERSION = 'figwright-kiwi-implementation@1';
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

const serializedTextResult = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
});

const serializeJson = (value: unknown): string => JSON.stringify(value);
const serializedBytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const jsonBytes = (value: unknown): number => serializedBytes(serializeJson(value));
const textResult = (value: unknown): CallToolResult => serializedTextResult(serializeJson(value));

const normalizationCaches = new WeakMap<KiwiCaptureSession, NormalizedNodeCache>();

const normalizationCache = (session: KiwiCaptureSession): NormalizedNodeCache => {
  const existing = normalizationCaches.get(session);
  if (existing !== undefined) return existing;
  const created = new NormalizedNodeCache();
  normalizationCaches.set(session, created);
  return created;
};

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
  const cache = normalizationCache(session);
  const cached = cache.read(
    session.graph,
    selectedNodeId,
    options.depth ?? DEFAULT_MAX_DEPTH,
    options.maxNodes ?? DEFAULT_MAX_NODES,
  );
  const result = cached.result;
  if (result.node === null) {
    throw new Error(
      `Node ${selectedNodeId} is not present in the captured graph for file ${session.fileKey}. ` +
        'Reload the Figma tab with the reader enabled if it was selected after capture.',
    );
  }
  return { session, selectedNodeId, captured: result.node, stats: result, cache, cached };
};

const normalizedPickedNode = (result: {
  captured: CapturedNode;
  cache: NormalizedNodeCache;
  cached: CachedNodeRead;
}): SerializedNode => {
  const normalized = result.cache.normalize(result.cached);
  if (normalized === null) throw new Error(`Node ${result.captured.id} disappeared during read`);
  return normalized;
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

const groundingRoots = (
  capture: KiwiCaptureServer,
  routing: KiwiMcpRoutingState,
  options: {
    nodeId?: string;
    depth?: number;
    tabId?: number;
    fileKey?: string;
  },
): { roots: DesignContextNode[]; caveats: string[] } => {
  const result = pickNode(capture, routing, options.nodeId, {
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.tabId === undefined ? {} : { tabId: options.tabId }),
    ...(options.fileKey === undefined ? {} : { fileKey: options.fileKey }),
  });
  const projected = projectNode(normalizedPickedNode(result), 'full');
  const truncated = result.stats.nodeLimitReached || result.stats.depthLimitReached;
  return {
    roots: [DesignContextNodeSchema.parse(projected)],
    caveats: truncated
      ? [
          `The captured subtree was truncated after ${result.stats.visited} nodes; unmapped project assets may belong to omitted descendants.`,
        ]
      : [],
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

const captureMetadata = (result: ReturnType<typeof pickNode>) => ({
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
});

const sectionPlanRoot = (result: ReturnType<typeof pickNode>): CapturedNode =>
  result.captured.children.length > 0
    ? result.captured
    : (result.session.graph.find(result.selectedNodeId, 1, MAX_SECTION_PLAN_SECTIONS + 1) ??
      result.captured);

const projectionBudgetReason = (
  root: CapturedNode,
  detail: DetailLevel,
  label: string,
): string | null => {
  const minimumBytes = minimumProjectedNodeBytes(root, detail);
  return minimumBytes > MAX_RESPONSE_BYTES
    ? `minimum ${label} projection ${minimumBytes} bytes exceeds ${MAX_RESPONSE_BYTES}`
    : null;
};

const designContext = (result: ReturnType<typeof pickNode>, detail: DetailLevel) => {
  const projected = projectNode(normalizedPickedNode(result), detail);
  const assets = designAssets(result.captured, result.session);
  return {
    schemaVersion: DESIGN_CONTEXT_SCHEMA_VERSION,
    nodes: [projected],
    capture: captureMetadata(result),
    capabilities: {
      structuredProperties: 'captured-when-present',
      componentInstances:
        result.stats.unresolvedInstances === 0 ? 'resolved' : 'partially-resolved',
      componentProperties: 'variants-and-boolean-visibility',
      instanceSwaps: 'resolved-from-symbol-overrides',
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
      mixedTextRuns: 'style-overrides',
      variables: 'unsupported',
      visualReference: 'not-captured',
    },
    assets,
    caveats: [
      'Variables and mixed-text links, lists, and per-run bindings are not resolved yet.',
      'When Kiwi exposes an instance swap only as an overridden symbol id, the swapped component tree is resolved but its component-property definition name is unavailable.',
      ...rasterAssetCaveats(assets.summary, result.session.captureImages),
      ...(result.stats.unresolvedInstances === 0
        ? []
        : [
            `${result.stats.unresolvedInstances} component instance(s) could not be expanded because the captured graph did not contain a usable master component.`,
          ]),
    ],
  };
};

const uniqueStrings = (...groups: readonly (readonly string[])[]): string[] => [
  ...new Set(groups.flat()),
];

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
        'Read-only Figma browser capture. For implementation in an existing codebase, call get_implementation_context once with that project rootDir; it returns the full design tree plus component, icon, and token grounding. Use get_design_context for design-only inspection. Follow sectionPlan for large selections. No Figma writes are available.',
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
        connected: capture.status.connected,
        sessions: capture.listSessions().map(session =>
          Object.assign(session.status, {
            normalizationCache: normalizationCache(session).stats,
          }),
        ),
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
      const cache = normalizationCache(session);
      const cached = cache.read(session.graph, session.selectedNodeId, 0, 1);
      const node = cache.normalize(cached);
      return textResult({
        nodes: node === null ? [] : [node],
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
      const preflightReason = projectionBudgetReason(result.captured, 'full', 'node');
      if (preflightReason !== null) {
        return textResult({
          node: { id: result.captured.id, name: result.captured.name, type: result.captured.type },
          ...sectionPlan(result.captured, preflightReason),
        });
      }
      const output = {
        node: normalizedPickedNode(result),
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
      const serialized = serializeJson(output);
      const bytes = serializedBytes(serialized);
      if (bytes > MAX_RESPONSE_BYTES) {
        return textResult({
          node: { id: result.captured.id, name: result.captured.name, type: result.captured.type },
          ...sectionPlan(result.captured, `payload ${bytes} bytes exceeds ${MAX_RESPONSE_BYTES}`),
        });
      }
      return serializedTextResult(serialized);
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
      const resolvedDetail = detail ?? 'full';
      const preflightReason = projectionBudgetReason(result.captured, resolvedDetail, 'design');
      if (preflightReason !== null) {
        return textResult(sectionPlan(result.captured, preflightReason));
      }
      const output = designContext(result, resolvedDetail);
      const serialized = serializeJson(output);
      const bytes = serializedBytes(serialized);
      if (bytes > MAX_RESPONSE_BYTES) {
        return textResult(
          sectionPlan(result.captured, `payload ${bytes} bytes exceeds ${MAX_RESPONSE_BYTES}`),
        );
      }
      return serializedTextResult(serialized);
    },
  );

  server.registerTool(
    'analyze_project',
    {
      description:
        'Detect the local project framework, language, styling system and SVG import mode. ' +
        'The standalone Kiwi bundle uses a portable dependency/config scan and reports its evidence.',
      inputSchema: z.object({
        rootDir: z.string().min(1).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ rootDir }) => textResult(await analyzePortableProject(rootDir ?? process.cwd())),
  );

  server.registerTool(
    'scan_components',
    {
      description:
        'Index exported UI components in the local project. The portable Kiwi scan statically ' +
        'resolves locally declared React props and marks every incomplete contract honestly.',
      inputSchema: z.object({
        rootDir: z.string().min(1).optional(),
        extensions: z.array(z.string().min(1)).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ rootDir, extensions }) => {
      const result = await scanPortableComponents(rootDir ?? process.cwd(), extensions);
      return textResult({
        components: result.components,
        profile: result.profile,
        scanMode: result.profile.scanMode,
        caveats: result.profile.caveats,
        ...(result.omitted === 0
          ? {}
          : {
              truncationNote: `file cap reached: ${result.omitted} further source files were not read, so a missing component may simply be outside what was scanned`,
            }),
      });
    },
  );

  const projectMapInput = z.object({
    nodeId: z.string().optional(),
    depth: z.number().int().min(0).max(32).optional(),
    threshold: z.number().min(0).max(1).optional(),
    rootDir: z.string().min(1).optional(),
    tabId: z.number().int().optional(),
    fileKey: z.string().optional(),
  });

  server.registerTool(
    'component_map',
    {
      description:
        'Map component instances in the selected Figma subtree to exported components in the local ' +
        'project. Returns confidence, instance ids, variant axes, explicit map-file overrides and ' +
        'honest scan caveats so an agent can reuse the UI kit instead of rebuilding it.',
      inputSchema: projectMapInput,
      annotations: READ_ONLY,
    },
    async ({ nodeId, depth, threshold, rootDir, tabId, fileKey }) => {
      const grounded = groundingRoots(capture, routing, {
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(depth === undefined ? {} : { depth }),
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
      return textResult(
        await mapProjectComponents({
          roots: grounded.roots,
          rootDir: rootDir ?? process.cwd(),
          ...(threshold === undefined ? {} : { threshold }),
          captureCaveats: grounded.caveats,
        }),
      );
    },
  );

  server.registerTool(
    'icon_map',
    {
      description:
        'Map named Figma icons in the selected subtree to existing project SVG files. Strict ' +
        'near-exact matching prevents a visually wrong icon from being reused; unmatched icons ' +
        'remain explicit export candidates.',
      inputSchema: projectMapInput,
      annotations: READ_ONLY,
    },
    async ({ nodeId, depth, threshold, rootDir, tabId, fileKey }) => {
      const grounded = groundingRoots(capture, routing, {
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(depth === undefined ? {} : { depth }),
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
      return textResult(
        await mapProjectIcons({
          roots: grounded.roots,
          rootDir: rootDir ?? process.cwd(),
          ...(threshold === undefined ? {} : { threshold }),
          captureCaveats: grounded.caveats,
        }),
      );
    },
  );

  server.registerTool(
    'token_map',
    {
      description:
        'Map colors observed in the selected Figma subtree to CSS custom properties, SCSS variables, ' +
        'and statically readable Tailwind or UnoCSS theme tokens in the local project. Browser Kiwi ' +
        'cannot resolve Figma variable or shared-style names, so every match is explicitly value-only ' +
        'and ambiguous same-value tokens remain unresolved.',
      inputSchema: z.object({
        nodeId: z.string().optional(),
        depth: z.number().int().min(0).max(32).optional(),
        rootDir: z.string().min(1).optional(),
        tabId: z.number().int().optional(),
        fileKey: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ nodeId, depth, rootDir, tabId, fileKey }) => {
      const grounded = groundingRoots(capture, routing, {
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(depth === undefined ? {} : { depth }),
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
      return textResult(
        await mapProjectTokens({
          roots: grounded.roots,
          rootDir: rootDir ?? process.cwd(),
          captureCaveats: grounded.caveats,
        }),
      );
    },
  );

  server.registerTool(
    'get_implementation_context',
    {
      description:
        'Prepare one bounded, client-independent implementation payload for the selected Figma subtree. ' +
        'It combines full design context, asset inventory, project profile, component reuse, icon reuse, ' +
        'and observed-color token candidates. Pass the codebase rootDir; follow sectionPlan when returned. ' +
        'A section-plan response deliberately defers design projection and project grounding until its sections are requested.',
      inputSchema: projectMapInput.extend({ rootDir: z.string().min(1) }),
      annotations: READ_ONLY,
    },
    async ({ nodeId, depth, threshold, rootDir, tabId, fileKey }) => {
      const result = pickNode(capture, routing, nodeId, {
        ...(depth === undefined ? {} : { depth }),
        ...(tabId === undefined ? {} : { tabId }),
        ...(fileKey === undefined ? {} : { fileKey }),
      });
      if (result.stats.nodeLimitReached || result.stats.depthLimitReached) {
        const plan = sectionPlan(
          sectionPlanRoot(result),
          `captured subtree truncated after ${result.stats.visited} nodes`,
        );
        return textResult({
          schemaVersion: IMPLEMENTATION_CONTEXT_SCHEMA_VERSION,
          designSchemaVersion: plan.schemaVersion,
          nodes: plan.nodes,
          sectionPlan: plan.sectionPlan,
          capture: captureMetadata(result),
          deferred: ['design', 'assets', 'project', 'grounding'],
          caveats: [
            `The captured subtree was truncated after ${result.stats.visited} nodes; request its sections before project grounding.`,
          ],
          note: 'Request each section nodeId with get_implementation_context using the same rootDir.',
        });
      }
      const preflightReason = projectionBudgetReason(result.captured, 'full', 'design');
      if (preflightReason !== null) {
        const plan = sectionPlan(sectionPlanRoot(result), preflightReason);
        return textResult({
          schemaVersion: IMPLEMENTATION_CONTEXT_SCHEMA_VERSION,
          designSchemaVersion: plan.schemaVersion,
          nodes: plan.nodes,
          sectionPlan: plan.sectionPlan,
          capture: captureMetadata(result),
          deferred: ['design', 'assets', 'project', 'grounding'],
          caveats: [
            `The design's minimum structural projection exceeds the response budget; request its sections before project grounding.`,
          ],
          note: 'Request each section nodeId with get_implementation_context using the same rootDir.',
        });
      }
      const context = designContext(result, 'full');
      const designBytes = jsonBytes(context);
      if (designBytes > MAX_RESPONSE_BYTES) {
        const plan = sectionPlan(
          sectionPlanRoot(result),
          `design payload ${designBytes} bytes exceeds ${MAX_RESPONSE_BYTES}`,
        );
        return textResult({
          schemaVersion: IMPLEMENTATION_CONTEXT_SCHEMA_VERSION,
          designSchemaVersion: plan.schemaVersion,
          nodes: plan.nodes,
          sectionPlan: plan.sectionPlan,
          capture: context.capture,
          deferred: ['design', 'assets', 'project', 'grounding'],
          caveats: context.caveats,
          note: 'Request each section nodeId with get_implementation_context using the same rootDir.',
        });
      }
      const roots = context.nodes.map(node => DesignContextNodeSchema.parse(node));
      const projectProfile = await analyzePortableProject(rootDir);
      const [componentMap, iconMap, tokenMap] = await Promise.all([
        mapProjectComponents({
          roots,
          rootDir,
          ...(threshold === undefined ? {} : { threshold }),
          profile: projectProfile,
        }),
        mapProjectIcons({
          roots,
          rootDir,
          ...(threshold === undefined ? {} : { threshold }),
          profile: projectProfile,
        }),
        mapProjectTokens({ roots, rootDir, profile: projectProfile }),
      ]);
      const {
        profile,
        caveats: componentCaveats,
        scanMode: componentScanMode,
        ...components
      } = componentMap;
      const { profile: _iconProfile, caveats: iconCaveats, ...icons } = iconMap;
      const {
        profile: _tokenProfile,
        caveats: tokenCaveats,
        scanMode: tokenScanMode,
        ...tokens
      } = tokenMap;
      const output = {
        schemaVersion: IMPLEMENTATION_CONTEXT_SCHEMA_VERSION,
        capabilities: {
          design: context.capabilities,
          grounding: {
            components: 'portable-export-and-react-prop-match',
            icons: 'strict-svg-name-match',
            tokens: 'exact-observed-color-match',
            componentProps: 'react-static-ast; other-frameworks-unavailable',
            figmaVariables: 'unavailable-in-kiwi-capture',
          },
        },
        caveats: uniqueStrings(context.caveats, componentCaveats, iconCaveats, tokenCaveats),
        design: {
          schemaVersion: context.schemaVersion,
          nodes: context.nodes,
          capture: context.capture,
          assets: context.assets,
        },
        project: {
          profile,
          scanModes: {
            components: componentScanMode,
            tokens: tokenScanMode,
          },
        },
        grounding: { components, icons, tokens },
      };
      const serialized = serializeJson(output);
      const bytes = serializedBytes(serialized);
      if (bytes > MAX_RESPONSE_BYTES) {
        const plan = sectionPlan(
          sectionPlanRoot(result),
          `implementation payload ${bytes} bytes exceeds ${MAX_RESPONSE_BYTES}`,
        );
        return textResult({
          schemaVersion: IMPLEMENTATION_CONTEXT_SCHEMA_VERSION,
          designSchemaVersion: plan.schemaVersion,
          nodes: plan.nodes,
          sectionPlan: plan.sectionPlan,
          capabilities: output.capabilities,
          caveats: output.caveats,
          project: output.project,
          groundingSummary: {
            components: {
              total: components.mappings.length,
              unmapped: components.unmapped.length,
            },
            icons: { total: icons.mappings.length, unmapped: icons.unmapped.length },
            tokens: {
              total: tokens.mappings.length,
              ambiguous: tokens.ambiguous.length,
              unmapped: tokens.unmapped.length,
            },
          },
          note: 'Request each section nodeId with get_implementation_context using the same rootDir.',
        });
      }
      return serializedTextResult(serialized);
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
        'Compare equal-sized reference and implementation PNGs, optionally exclude explicit dynamic regions, write a heatmap, and report exact changed-pixel ratios and bounds.',
      inputSchema: z.object({
        referencePath: z.string().min(1),
        actualPath: z.string().min(1),
        diffPath: z.string().min(1),
        tolerance: z.number().int().min(0).max(255).optional(),
        ignoreRegions: z
          .array(
            z.object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              width: z.number().int().positive(),
              height: z.number().int().positive(),
            }),
          )
          .max(256)
          .optional(),
      }),
      annotations: LOCAL_WRITE,
    },
    async ({ referencePath, actualPath, diffPath, tolerance, ignoreRegions }) =>
      textResult(
        await comparePngFiles({
          referencePath,
          actualPath,
          diffPath,
          ...(tolerance === undefined ? {} : { tolerance }),
          ...(ignoreRegions === undefined ? {} : { ignoreRegions }),
        }),
      ),
  );

  return server;
};
