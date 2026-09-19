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
  resolvedParentId?: string;
  mainComponent?: {
    id: string;
    name: string;
    key: string;
  };
  raw: KiwiNodeChange;
  children: CapturedNode[];
}

export interface SceneGraphFindResult {
  node: CapturedNode | null;
  visited: number;
  nodeLimitReached: boolean;
  depthLimitReached: boolean;
  resolvedInstances: number;
  unresolvedInstances: number;
  instanceCycles: number;
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

type UnknownRecord = Record<string, unknown>;

interface InstanceOverrideContext {
  namespaceId: string;
  prefix: string[];
  fullPath: string[];
  overrides: Map<string, UnknownRecord>;
  textAssignments: Map<string, string>;
  resolutionTrail: Set<string>;
}

const record = (value: unknown): UnknownRecord | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? (value as UnknownRecord) : null;
};

const guidId = (value: unknown): string | null => {
  const source = record(value);
  if (source === null) return null;
  if (source.guid !== undefined) return guidId(source.guid);
  const sessionID = source.sessionID;
  const localID = source.localID;
  if (
    (typeof sessionID !== 'number' && typeof sessionID !== 'string') ||
    (typeof localID !== 'number' && typeof localID !== 'string')
  ) {
    return null;
  }
  return `${sessionID}:${localID}`;
};

const pathKey = (segments: readonly string[]): string => segments.join('\u0000');

const overridePath = (value: unknown): string[] => {
  const source = record(value);
  if (source === null) return [];
  const path = record(source.guidPath);
  const rawGuids = Array.isArray(path?.guids)
    ? path.guids
    : path?.guid !== undefined
      ? [path.guid]
      : Array.isArray(source.guidPath)
        ? source.guidPath
        : [];
  const result = rawGuids.map(guidId).filter((id): id is string => id !== null);
  if (result.length > 0) return result;
  const direct = guidId(source.guid ?? source.nodeID);
  if (direct !== null) return [direct];
  if (typeof source.nodeId === 'string' && source.nodeId !== '') {
    return [normalizeNodeId(source.nodeId)];
  }
  return [];
};

const overrideSegment = (raw: KiwiNodeChange, fallbackId: string): string =>
  guidId(raw.overrideKey) ?? fallbackId;

const mergeRecords = (base: UnknownRecord, patch: UnknownRecord): UnknownRecord => {
  const output: UnknownRecord = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      key === 'guid' ||
      key === 'guidPath' ||
      key === 'nodeId' ||
      key === 'nodeID' ||
      key === 'id' ||
      key === 'parentIndex' ||
      key === 'phase'
    ) {
      continue;
    }
    const current = record(output[key]);
    const next = record(value);
    output[key] = current !== null && next !== null ? mergeRecords(current, next) : value;
  }
  return output;
};

const addOverride = (
  overrides: Map<string, UnknownRecord>,
  prefix: readonly string[],
  value: unknown,
): void => {
  const patch = record(value);
  if (patch === null) return;
  const path = overridePath(patch);
  if (path.length === 0) return;
  const key = pathKey([...prefix, ...path]);
  overrides.set(key, mergeRecords(overrides.get(key) ?? {}, patch));
};

const addInstanceOverrides = (
  overrides: Map<string, UnknownRecord>,
  prefix: readonly string[],
  raw: KiwiNodeChange,
): void => {
  const symbolData = record(raw.symbolData);
  const symbolOverrides = symbolData?.symbolOverrides;
  if (Array.isArray(symbolOverrides)) {
    for (const override of symbolOverrides) addOverride(overrides, prefix, override);
  } else {
    const overrideRecord = record(symbolOverrides);
    if (overrideRecord?.guidPath !== undefined) {
      addOverride(overrides, prefix, overrideRecord);
    } else if (overrideRecord !== null) {
      for (const override of Object.values(overrideRecord)) {
        addOverride(overrides, prefix, override);
      }
    }
  }
  if (Array.isArray(raw.derivedSymbolData)) {
    for (const override of raw.derivedSymbolData) addOverride(overrides, prefix, override);
  } else {
    const derived = record(raw.derivedSymbolData);
    const derivedOverrides = derived?.symbolOverrides ?? derived?.overrides;
    if (Array.isArray(derivedOverrides)) {
      for (const override of derivedOverrides) addOverride(overrides, prefix, override);
    }
  }
};

const findOverride = (
  overrides: ReadonlyMap<string, UnknownRecord>,
  prefix: readonly string[],
  fullPath: readonly string[],
): UnknownRecord | null => {
  const segment = fullPath.at(-1);
  if (segment === undefined) return null;
  const candidates = [[segment], [...prefix, segment], [...prefix, ...fullPath]];
  let result: UnknownRecord | null = null;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const patch = overrides.get(key);
    if (patch !== undefined) result = mergeRecords(result ?? {}, patch);
  }
  return result;
};

const readTextAssignment = (assignment: UnknownRecord): string | null => {
  const paths = [
    ['value', 'textValue', 'characters'],
    ['value', 'textDataValue', 'characters'],
    ['varValue', 'value', 'textValue', 'characters'],
    ['varValue', 'value', 'textDataValue', 'characters'],
  ];
  for (const path of paths) {
    let cursor: unknown = assignment;
    for (const key of path) cursor = record(cursor)?.[key];
    if (typeof cursor === 'string') return cursor;
  }
  return null;
};

const textAssignments = (raw: KiwiNodeChange): Map<string, string> => {
  const assignmentEntries = record(raw.componentPropAssignments)?.entries;
  const source: unknown[] = Array.isArray(raw.componentPropAssignments)
    ? raw.componentPropAssignments
    : Array.isArray(assignmentEntries)
      ? assignmentEntries
      : [];
  const assignments = new Map<string, string>();
  for (const value of source) {
    const assignment = record(value);
    if (assignment === null) continue;
    const definitionId = guidId(assignment.defID ?? assignment.defId);
    const characters = readTextAssignment(assignment);
    if (definitionId !== null && characters !== null) assignments.set(definitionId, characters);
  }
  return assignments;
};

const assignedText = (
  raw: KiwiNodeChange,
  assignments: ReadonlyMap<string, string>,
): string | null => {
  const refs = Array.isArray(raw.componentPropRefs)
    ? raw.componentPropRefs
    : Array.isArray(raw.componentPropRef)
      ? raw.componentPropRef
      : [];
  for (const value of refs) {
    const ref = record(value);
    if (ref === null) continue;
    const field = typeof ref.componentPropNodeField === 'string' ? ref.componentPropNodeField : '';
    if (field !== 'TEXT_DATA' && field !== 'TEXT' && field !== 'CHARACTERS') continue;
    const definitionId = guidId(ref.defID ?? ref.defId);
    if (definitionId !== null && assignments.has(definitionId)) {
      return assignments.get(definitionId) ?? null;
    }
  }
  return null;
};

const applyTextAssignment = (
  raw: KiwiNodeChange,
  assignments: ReadonlyMap<string, string>,
): KiwiNodeChange => {
  const characters = assignedText(raw, assignments);
  if (characters === null) return raw;
  return {
    ...raw,
    textData: { ...record(raw.textData), characters },
  };
};

const instanceMasterId = (raw: KiwiNodeChange): string | null => {
  const swapped = guidId(raw.overriddenSymbolID);
  if (swapped !== null) return swapped;
  return guidId(record(raw.symbolData)?.symbolID);
};

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
      return {
        node: null,
        visited: 0,
        nodeLimitReached: false,
        depthLimitReached: false,
        resolvedInstances: 0,
        unresolvedInstances: 0,
        instanceCycles: 0,
      };
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
    let resolvedInstances = 0;
    let unresolvedInstances = 0;
    let instanceCycles = 0;

    const build = (
      sourceId: string,
      outputId: string,
      depth: number,
      resolvedParentId?: string,
      context?: InstanceOverrideContext,
      parentStackMode?: string,
    ): CapturedNode | null => {
      const sourceRaw = this.nodes.get(sourceId);
      if (sourceRaw === undefined) return null;
      if (visited >= maxNodes) {
        nodeLimitReached = true;
        return null;
      }
      visited++;

      const segment = overrideSegment(sourceRaw, sourceId);
      const fullPath = context === undefined ? [] : [...context.fullPath, segment];
      let raw =
        context === undefined ? sourceRaw : applyTextAssignment(sourceRaw, context.textAssignments);
      const override =
        context === undefined ? null : findOverride(context.overrides, context.prefix, fullPath);
      if (override !== null) raw = mergeRecords(raw, override) as KiwiNodeChange;

      const directChildren = childIds.get(sourceId) ?? [];
      let sourceChildren = directChildren;
      let childContext = context === undefined ? undefined : { ...context, fullPath };
      let mainComponent: CapturedNode['mainComponent'];

      if (raw.type === 'INSTANCE' && directChildren.length === 0) {
        const masterId = instanceMasterId(raw);
        if (masterId !== null) {
          const master = this.nodes.get(masterId);
          if (master === undefined) {
            unresolvedInstances++;
          } else if (context?.resolutionTrail.has(masterId) === true) {
            unresolvedInstances++;
            instanceCycles++;
          } else {
            resolvedInstances++;
            mainComponent = {
              id: masterId,
              name: master.name ?? '',
              key:
                typeof master.componentKey === 'string'
                  ? master.componentKey
                  : typeof master.key === 'string'
                    ? master.key
                    : typeof master.originComponentKey === 'string'
                      ? master.originComponentKey
                      : '',
            };
            sourceChildren = childIds.get(masterId) ?? [];
            const inheritedOverrides = new Map(context?.overrides ?? []);
            const prefix = context === undefined ? [] : [...context.prefix, segment];
            addInstanceOverrides(inheritedOverrides, prefix, raw);
            childContext = {
              namespaceId: outputId,
              prefix,
              fullPath: [],
              overrides: inheritedOverrides,
              textAssignments: textAssignments(raw),
              resolutionTrail: new Set([...(context?.resolutionTrail ?? []), masterId]),
            };
          }
        }
      }

      if (depth >= maxDepth && sourceChildren.length > 0) depthLimitReached = true;
      const children =
        depth >= maxDepth
          ? []
          : sourceChildren
              .map(child => {
                const childOutputId =
                  childContext === undefined ? child.id : `${childContext.namespaceId}/${child.id}`;
                const nextContext =
                  childContext === undefined
                    ? undefined
                    : { ...childContext, fullPath: childContext.fullPath };
                return build(
                  child.id,
                  childOutputId,
                  depth + 1,
                  outputId,
                  nextContext,
                  typeof raw.stackMode === 'string' ? raw.stackMode : undefined,
                );
              })
              .filter((child): child is CapturedNode => child !== null);
      const parentRaw =
        raw.parentIndex?.guid === undefined
          ? undefined
          : this.nodes.get(nodeId(raw.parentIndex.guid));
      return {
        id: outputId,
        name: raw.name ?? '',
        type: raw.type ?? 'UNKNOWN',
        visible: raw.visible !== false,
        ...(resolvedParentId === undefined ? {} : { resolvedParentId }),
        ...(mainComponent === undefined ? {} : { mainComponent }),
        ...(typeof (parentStackMode ?? parentRaw?.stackMode) === 'string'
          ? { parentStackMode: (parentStackMode ?? parentRaw?.stackMode) as string }
          : {}),
        raw,
        children,
      };
    };

    return {
      node: build(normalized, normalized, 0),
      visited,
      nodeLimitReached,
      depthLimitReached,
      resolvedInstances,
      unresolvedInstances,
      instanceCycles,
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
