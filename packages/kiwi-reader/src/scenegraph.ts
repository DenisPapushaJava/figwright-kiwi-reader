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
  raw: KiwiNodeChange;
  children: CapturedNode[];
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

  get size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.nodes.clear();
  }

  apply(message: unknown): number {
    if (!isMessage(message) || !Array.isArray(message.nodeChanges)) return 0;

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
    const normalized = normalizeNodeId(id);
    if (!this.nodes.has(normalized)) return null;

    const childIds = new Map<string, Array<{ id: string; position: string }>>();
    for (const [childId, node] of this.nodes) {
      if (node.parentIndex?.guid === undefined) continue;
      const parentId = nodeId(node.parentIndex.guid);
      const children = childIds.get(parentId) ?? [];
      children.push({ id: childId, position: node.parentIndex.position ?? '' });
      childIds.set(parentId, children);
    }
    for (const children of childIds.values()) {
      children.sort((a, b) => a.position.localeCompare(b.position));
    }

    let visited = 0;
    const build = (nodeIdValue: string, depth: number): CapturedNode | null => {
      const raw = this.nodes.get(nodeIdValue);
      if (raw === undefined || visited++ >= maxNodes) return null;
      const children =
        depth >= maxDepth
          ? []
          : (childIds.get(nodeIdValue) ?? [])
              .map(child => build(child.id, depth + 1))
              .filter((child): child is CapturedNode => child !== null);
      return {
        id: nodeIdValue,
        name: raw.name ?? '',
        type: raw.type ?? 'UNKNOWN',
        visible: raw.visible !== false,
        raw,
        children,
      };
    };

    return build(normalized, 0);
  }
}

export const normalizeNodeId = (id: string): string => id.replace('-', ':');

export const jsonSafe = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return `<binary ${value.length} bytes>`;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
};
