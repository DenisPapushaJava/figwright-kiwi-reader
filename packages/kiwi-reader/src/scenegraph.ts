export interface KiwiGuid {
  sessionID?: number;
  localID?: number;
}

export interface KiwiNodeChange {
  guid?: KiwiGuid;
  parentIndex?: { guid?: KiwiGuid; position?: string };
  phase?: string;
  name?: string;
  type?: string;
  visible?: boolean;
  [key: string]: unknown;
}

export interface KiwiMessage {
  nodeChanges?: KiwiNodeChange[];
  [key: string]: unknown;
}

export interface CapturedNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  parentStackMode?: string;
  raw: KiwiNodeChange;
  children: CapturedNode[];
}

export interface SceneGraphFindResult {
  node: CapturedNode | null;
  visited: number;
  nodeLimitReached: boolean;
  depthLimitReached: boolean;
}

export class SceneGraphLimitError extends Error {
  constructor(readonly maxNodes: number) {
    super(`Captured scene graph exceeds the ${maxNodes} node limit`);
    this.name = 'SceneGraphLimitError';
  }
}

export const nodeId = (guid: KiwiGuid | undefined): string =>
  `${guid?.sessionID ?? 0}:${guid?.localID ?? 0}`;

const isMessage = (value: unknown): value is KiwiMessage =>
  typeof value === 'object' && value !== null;

const isRemoved = (node: KiwiNodeChange): boolean =>
  node.phase === 'REMOVED' || node.phase === 'DELETED';

/** Incrementally merges the node changes already delivered to the authenticated Figma tab. */
export class SceneGraphStore {
  private readonly nodes = new Map<string, KiwiNodeChange>();

  constructor(private readonly maxNodes = 250_000) {}

  get size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.nodes.clear();
  }

  apply(message: unknown): number {
    if (!isMessage(message) || !Array.isArray(message.nodeChanges)) return 0;

    let projectedSize = this.nodes.size;
    const projectedPresence = new Map<string, boolean>();
    for (const change of message.nodeChanges) {
      if (typeof change !== 'object' || change === null || change.guid === undefined) continue;
      const id = nodeId(change.guid);
      const wasPresent = projectedPresence.get(id) ?? this.nodes.has(id);
      const willBePresent = !isRemoved(change);
      if (wasPresent !== willBePresent) projectedSize += willBePresent ? 1 : -1;
      projectedPresence.set(id, willBePresent);
    }
    if (projectedSize > this.maxNodes) throw new SceneGraphLimitError(this.maxNodes);

    let applied = 0;
    for (const change of message.nodeChanges) {
      if (typeof change !== 'object' || change === null || change.guid === undefined) continue;
      const id = nodeId(change.guid);
      if (isRemoved(change)) this.nodes.delete(id);
      else this.nodes.set(id, { ...this.nodes.get(id), ...change });
      applied++;
    }
    return applied;
  }

  has(id: string): boolean {
    return this.nodes.has(normalizeNodeId(id));
  }

  find(id: string, maxDepth = 8, maxNodes = 2_000): CapturedNode | null {
    return this.findWithStats(id, maxDepth, maxNodes).node;
  }

  findWithStats(id: string, maxDepth = 8, maxNodes = 2_000): SceneGraphFindResult {
    const normalized = normalizeNodeId(id);
    if (!this.nodes.has(normalized)) {
      return { node: null, visited: 0, nodeLimitReached: false, depthLimitReached: false };
    }

    const childIds = new Map<string, Array<{ id: string; position: string }>>();
    for (const [childId, node] of this.nodes) {
      if (node.parentIndex?.guid === undefined) continue;
      const parentId = nodeId(node.parentIndex.guid);
      const children = childIds.get(parentId) ?? [];
      children.push({ id: childId, position: node.parentIndex.position ?? '' });
      childIds.set(parentId, children);
    }
    for (const children of childIds.values()) {
      children.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    }

    let visited = 0;
    let nodeLimitReached = false;
    let depthLimitReached = false;
    const build = (nodeIdValue: string, depth: number): CapturedNode | null => {
      const raw = this.nodes.get(nodeIdValue);
      if (raw === undefined) return null;
      if (visited >= maxNodes) {
        nodeLimitReached = true;
        return null;
      }
      visited++;
      const directChildren = childIds.get(nodeIdValue) ?? [];
      if (depth >= maxDepth && directChildren.length > 0) depthLimitReached = true;
      const children =
        depth >= maxDepth
          ? []
          : directChildren
              .map(child => build(child.id, depth + 1))
              .filter((child): child is CapturedNode => child !== null);
      const parentRaw =
        raw.parentIndex?.guid === undefined
          ? undefined
          : this.nodes.get(nodeId(raw.parentIndex.guid));
      return {
        id: nodeIdValue,
        name: raw.name ?? '',
        type: raw.type ?? 'UNKNOWN',
        visible: raw.visible !== false,
        ...(typeof parentRaw?.stackMode === 'string'
          ? { parentStackMode: parentRaw.stackMode }
          : {}),
        raw,
        children,
      };
    };

    return {
      node: build(normalized, 0),
      visited,
      nodeLimitReached,
      depthLimitReached,
    };
  }
}

export const normalizeNodeId = (id: string): string => id.replaceAll('-', ':');

export const jsonSafe = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return `<binary ${value.length} bytes>`;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
};
