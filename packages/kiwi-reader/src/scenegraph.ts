import {
  buildSharedStyleIndex,
  hasSharedStyleDefinitionChange,
  SHARED_STYLE_GRAPH_DEPENDENCY,
  SharedStyleResolver,
  type ResolvedKiwiStyle,
  type SharedStyleIndex,
} from './shared-styles.js';
import {
  buildVariableColorIndex,
  hasVariableDefinitionChange,
  VARIABLE_GRAPH_DEPENDENCY,
  VariableColorResolver,
  type ResolvedKiwiVariable,
  type VariableColorIndex,
  type VariableModeMap,
} from './variable-colors.js';

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
    componentSetId?: string;
    componentSetName?: string;
  };
  componentProperties?: Readonly<Record<string, { type: string; value: string | boolean }>>;
  raw: KiwiNodeChange;
  children: CapturedNode[];
}

export interface SceneGraphFindResult {
  node: CapturedNode | null;
  dependencies: ReadonlySet<string>;
  visited: number;
  nodeLimitReached: boolean;
  depthLimitReached: boolean;
  resolvedInstances: number;
  unresolvedInstances: number;
  instanceCycles: number;
  variableColorBindings: number;
  resolvedVariableColors: number;
  unresolvedVariableColors: number;
  variableModeFallbacks: number;
  variables: Readonly<Record<string, ResolvedKiwiVariable>>;
  sharedStyleBindings: number;
  resolvedSharedStyles: number;
  unresolvedSharedStyles: number;
  styles: Readonly<Record<string, ResolvedKiwiStyle>>;
}

export interface SceneGraphSectionOutline {
  root: { id: string; name: string; type: string };
  totalNodes: number;
  totalSections: number;
  sections: Array<{ id: string; name: string; type: string; nodes: number }>;
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
  booleanAssignments: Map<string, boolean>;
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
  const localOverrides = new Map<string, UnknownRecord>();
  const symbolData = record(raw.symbolData);
  const symbolOverrides = symbolData?.symbolOverrides;
  if (Array.isArray(symbolOverrides)) {
    for (const override of symbolOverrides) addOverride(localOverrides, prefix, override);
  } else {
    const overrideRecord = record(symbolOverrides);
    if (overrideRecord?.guidPath !== undefined) {
      addOverride(localOverrides, prefix, overrideRecord);
    } else if (overrideRecord !== null) {
      for (const override of Object.values(overrideRecord)) {
        addOverride(localOverrides, prefix, override);
      }
    }
  }
  if (Array.isArray(raw.derivedSymbolData)) {
    for (const override of raw.derivedSymbolData) addOverride(localOverrides, prefix, override);
  } else {
    const derived = record(raw.derivedSymbolData);
    const derivedOverrides = derived?.symbolOverrides ?? derived?.overrides;
    if (Array.isArray(derivedOverrides)) {
      for (const override of derivedOverrides) addOverride(localOverrides, prefix, override);
    }
  }
  for (const [key, local] of localOverrides) {
    const inherited = overrides.get(key);
    overrides.set(key, inherited === undefined ? local : mergeRecords(local, inherited));
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

const inheritedTextAssignments = (
  raw: KiwiNodeChange,
  inherited: ReadonlyMap<string, string> | undefined,
): Map<string, string> => {
  const assignments = textAssignments(raw);
  if (inherited === undefined) return assignments;
  for (const [definitionId, characters] of inherited) {
    assignments.set(definitionId, characters);
  }
  return assignments;
};

const readBooleanAssignment = (assignment: UnknownRecord): boolean | null => {
  const direct = record(assignment.value)?.boolValue;
  if (typeof direct === 'boolean') return direct;
  const resolved = record(record(assignment.varValue)?.value)?.boolValue;
  return typeof resolved === 'boolean' ? resolved : null;
};

const booleanAssignments = (raw: KiwiNodeChange): Map<string, boolean> => {
  const assignmentEntries = record(raw.componentPropAssignments)?.entries;
  const source: unknown[] = Array.isArray(raw.componentPropAssignments)
    ? raw.componentPropAssignments
    : Array.isArray(assignmentEntries)
      ? assignmentEntries
      : [];
  const assignments = new Map<string, boolean>();
  for (const value of source) {
    const assignment = record(value);
    if (assignment === null) continue;
    const definitionId = guidId(assignment.defID ?? assignment.defId);
    const visible = readBooleanAssignment(assignment);
    if (definitionId !== null && visible !== null) assignments.set(definitionId, visible);
  }
  return assignments;
};

const inheritedBooleanAssignments = (
  raw: KiwiNodeChange,
  inherited: ReadonlyMap<string, boolean> | undefined,
): Map<string, boolean> => {
  const assignments = booleanAssignments(raw);
  if (inherited === undefined) return assignments;
  for (const [definitionId, visible] of inherited) assignments.set(definitionId, visible);
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

const applyBooleanAssignment = (
  raw: KiwiNodeChange,
  assignments: ReadonlyMap<string, boolean>,
): KiwiNodeChange => {
  const refs = Array.isArray(raw.componentPropRefs)
    ? raw.componentPropRefs
    : Array.isArray(raw.componentPropRef)
      ? raw.componentPropRef
      : [];
  for (const value of refs) {
    const ref = record(value);
    if (ref?.componentPropNodeField !== 'VISIBLE') continue;
    const definitionId = guidId(ref.defID ?? ref.defId);
    const visible = definitionId === null ? undefined : assignments.get(definitionId);
    if (visible !== undefined) {
      return { ...raw, visible };
    }
  }
  return raw;
};

const valueCounts = (values: readonly string[]): Map<string, number> => {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
};

const variantProperties = (
  master: KiwiNodeChange,
): Record<string, { type: 'VARIANT'; value: string }> | undefined => {
  if (!Array.isArray(master.variantPropSpecs) || master.variantPropSpecs.length === 0) {
    return undefined;
  }
  const expectedValues = master.variantPropSpecs.flatMap(value => {
    const spec = record(value);
    return typeof spec?.value === 'string' ? [spec.value] : [];
  });
  if (expectedValues.length !== master.variantPropSpecs.length || typeof master.name !== 'string') {
    return undefined;
  }
  const properties: Record<string, { type: 'VARIANT'; value: string }> = {};
  for (const segment of master.name.split(',')) {
    const separator = segment.indexOf('=');
    if (separator < 1) return undefined;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (name === '' || value === '' || properties[name] !== undefined) return undefined;
    properties[name] = { type: 'VARIANT', value };
  }
  const actualValues = Object.values(properties).map(property => property.value);
  const expectedCounts = valueCounts(expectedValues);
  const actualCounts = valueCounts(actualValues);
  if (
    actualValues.length !== expectedValues.length ||
    [...expectedCounts].some(([value, count]) => actualCounts.get(value) !== count)
  ) {
    return undefined;
  }
  return properties;
};

const instanceMasterId = (raw: KiwiNodeChange): string | null => {
  const swapped = guidId(raw.overriddenSymbolID);
  if (swapped !== null) return swapped;
  return guidId(record(raw.symbolData)?.symbolID);
};

/** Incrementally merges the node changes already delivered to the authenticated Figma tab. */
export class SceneGraphStore {
  private readonly nodes = new Map<string, KiwiNodeChange>();
  private variableColorIndex: VariableColorIndex | null = null;
  private sharedStyleIndex: SharedStyleIndex | null = null;
  private readonly changeHistory: Array<{
    revision: number;
    affectedNodeIds: ReadonlySet<string> | null;
  }> = [];
  private currentRevision = 0;

  constructor(private readonly maxNodes = 250_000) {}

  get size(): number {
    return this.nodes.size;
  }

  /** Monotonically increases whenever a decoded change mutates this captured graph. */
  get revision(): number {
    return this.currentRevision;
  }

  clear(): void {
    if (this.nodes.size > 0) {
      this.currentRevision++;
      this.recordChange(null);
    }
    this.nodes.clear();
    this.variableColorIndex = null;
    this.sharedStyleIndex = null;
  }

  affectsDependenciesSince(revision: number, dependencies: ReadonlySet<string>): boolean {
    if (revision >= this.currentRevision) return false;
    const oldest = this.changeHistory[0];
    if (oldest === undefined || revision < oldest.revision - 1) return true;
    for (const change of this.changeHistory) {
      if (change.revision <= revision) continue;
      if (change.affectedNodeIds === null) return true;
      const [smaller, larger] =
        dependencies.size <= change.affectedNodeIds.size
          ? [dependencies, change.affectedNodeIds]
          : [change.affectedNodeIds, dependencies];
      for (const id of smaller) {
        if (larger.has(id)) return true;
      }
    }
    return false;
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

    const validChanges = message.nodeChanges.filter(
      (change): change is KiwiNodeChange =>
        typeof change === 'object' && change !== null && change.guid !== undefined,
    );
    const affectedNodeIds = new Set<string>();
    let variableDefinitionsChanged = false;
    let sharedStyleDefinitionsChanged = false;
    const oldExpandedAncestors = new Set<string>();
    for (const change of validChanges) {
      const id = nodeId(change.guid);
      if (hasVariableDefinitionChange(this.nodes.get(id), change)) {
        variableDefinitionsChanged = true;
      }
      if (hasSharedStyleDefinitionChange(this.nodes.get(id), change)) {
        sharedStyleDefinitionsChanged = true;
      }
      this.addAncestorChain(id, affectedNodeIds, oldExpandedAncestors);
    }

    for (const change of validChanges) {
      const id = nodeId(change.guid);
      if (isRemoved(change)) this.nodes.delete(id);
      else this.nodes.set(id, { ...this.nodes.get(id), ...change });
    }
    if (validChanges.length > 0) {
      if (variableDefinitionsChanged) {
        this.variableColorIndex = null;
        affectedNodeIds.add(VARIABLE_GRAPH_DEPENDENCY);
      }
      if (sharedStyleDefinitionsChanged) {
        this.sharedStyleIndex = null;
        affectedNodeIds.add(SHARED_STYLE_GRAPH_DEPENDENCY);
      }
      const newExpandedAncestors = new Set<string>();
      for (const change of validChanges) {
        this.addAncestorChain(nodeId(change.guid), affectedNodeIds, newExpandedAncestors);
      }
      this.currentRevision++;
      this.recordChange(affectedNodeIds);
    }
    return validChanges.length;
  }

  has(id: string): boolean {
    return this.nodes.has(normalizeNodeId(id));
  }

  /**
   * Summarizes every direct child without expanding a depth-first read first. This keeps a large
   * first section from consuming the normal read budget and hiding its later siblings from an MCP
   * section plan. Counts describe the captured raw subtree; component expansion may make a later
   * normalized section larger, so callers must still apply their normal response limits.
   */
  sectionOutline(id: string, maxSections: number): SceneGraphSectionOutline | null {
    const normalized = normalizeNodeId(id);
    const root = this.nodes.get(normalized);
    if (root === undefined) return null;

    const childIds = this.buildChildIndex();
    const directChildren = childIds.get(normalized) ?? [];
    const countSubtree = (rootId: string): number => {
      let count = 0;
      const stack = [rootId];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined || visited.has(current) || !this.nodes.has(current)) continue;
        visited.add(current);
        count++;
        for (const child of childIds.get(current) ?? []) stack.push(child.id);
      }
      return count;
    };
    const allSections = directChildren.map(child => {
      const raw = this.nodes.get(child.id);
      return {
        id: child.id,
        name: raw?.name ?? '',
        type: raw?.type ?? 'UNKNOWN',
        nodes: countSubtree(child.id),
      };
    });

    return {
      root: { id: normalized, name: root.name ?? '', type: root.type ?? 'UNKNOWN' },
      totalNodes: 1 + allSections.reduce((sum, section) => sum + section.nodes, 0),
      totalSections: allSections.length,
      sections: allSections.slice(0, Math.max(0, maxSections)),
    };
  }

  find(id: string, maxDepth = 8, maxNodes = 2_000): CapturedNode | null {
    return this.findWithStats(id, maxDepth, maxNodes).node;
  }

  findWithStats(id: string, maxDepth = 8, maxNodes = 2_000): SceneGraphFindResult {
    const normalized = normalizeNodeId(id);
    const dependencies = new Set<string>([normalized]);
    if (!this.nodes.has(normalized)) {
      return {
        node: null,
        dependencies,
        visited: 0,
        nodeLimitReached: false,
        depthLimitReached: false,
        resolvedInstances: 0,
        unresolvedInstances: 0,
        instanceCycles: 0,
        variableColorBindings: 0,
        resolvedVariableColors: 0,
        unresolvedVariableColors: 0,
        variableModeFallbacks: 0,
        variables: {},
        sharedStyleBindings: 0,
        resolvedSharedStyles: 0,
        unresolvedSharedStyles: 0,
        styles: {},
      };
    }

    const childIds = this.buildChildIndex();

    let visited = 0;
    let nodeLimitReached = false;
    let depthLimitReached = false;
    let resolvedInstances = 0;
    let unresolvedInstances = 0;
    let instanceCycles = 0;
    const sharedStyleResolver = new SharedStyleResolver(this.getSharedStyleIndex());
    const variableResolver = new VariableColorResolver(this.getVariableColorIndex());
    const rootVariableModes = this.inheritedVariableModes(
      normalized,
      dependencies,
      variableResolver,
    );

    const build = (
      sourceId: string,
      outputId: string,
      depth: number,
      resolvedParentId?: string,
      context?: InstanceOverrideContext,
      parentStackMode?: string,
      inheritedVariableModes: VariableModeMap = new Map(),
    ): CapturedNode | null => {
      const sourceRaw = this.nodes.get(sourceId);
      if (sourceRaw === undefined) return null;
      dependencies.add(sourceId);
      if (visited >= maxNodes) {
        nodeLimitReached = true;
        return null;
      }
      visited++;

      const segment = overrideSegment(sourceRaw, sourceId);
      const fullPath = context === undefined ? [] : [...context.fullPath, segment];
      let raw =
        context === undefined
          ? sourceRaw
          : applyBooleanAssignment(
              applyTextAssignment(sourceRaw, context.textAssignments),
              context.booleanAssignments,
            );
      const override =
        context === undefined ? null : findOverride(context.overrides, context.prefix, fullPath);
      if (override !== null) raw = mergeRecords(raw, override) as KiwiNodeChange;
      const styleResolution = sharedStyleResolver.resolveNode(raw);
      raw = styleResolution.raw;
      if (styleResolution.usesStyles) dependencies.add(SHARED_STYLE_GRAPH_DEPENDENCY);
      const variableResolution = variableResolver.resolveNode(raw, inheritedVariableModes);
      raw = variableResolution.raw;
      if (variableResolution.usesVariables) dependencies.add(VARIABLE_GRAPH_DEPENDENCY);
      let childVariableModes = variableResolution.modes;

      const directChildren = childIds.get(sourceId) ?? [];
      let sourceChildren = directChildren;
      let childContext = context === undefined ? undefined : { ...context, fullPath };
      let mainComponent: CapturedNode['mainComponent'];
      let componentProperties: CapturedNode['componentProperties'];

      if (raw.type === 'INSTANCE' && directChildren.length === 0) {
        const masterId = instanceMasterId(raw);
        if (masterId !== null) {
          dependencies.add(masterId);
          const master = this.nodes.get(masterId);
          if (master === undefined) {
            unresolvedInstances++;
          } else if (context?.resolutionTrail.has(masterId) === true) {
            unresolvedInstances++;
            instanceCycles++;
          } else {
            resolvedInstances++;
            componentProperties = variantProperties(master);
            const componentSetId =
              master.parentIndex?.guid === undefined ? null : nodeId(master.parentIndex.guid);
            const componentSet =
              componentSetId === null ? undefined : this.nodes.get(componentSetId);
            if (componentSetId !== null) dependencies.add(componentSetId);
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
              ...(componentProperties !== undefined &&
              componentSetId !== null &&
              componentSet !== undefined &&
              typeof componentSet.componentKey === 'string' &&
              componentSet.componentKey !== ''
                ? { componentSetId, componentSetName: componentSet.name ?? '' }
                : {}),
            };
            sourceChildren = childIds.get(masterId) ?? [];
            // A master can establish a default collection mode, while the placed instance and its
            // ancestors remain authoritative at the usage site.
            const masterModes = variableResolver.modesFor(master);
            childVariableModes = new Map([...masterModes, ...variableResolution.modes]);
            const inheritedOverrides = new Map(context?.overrides ?? []);
            const prefix = context === undefined ? [] : [...context.prefix, segment];
            addInstanceOverrides(inheritedOverrides, prefix, raw);
            childContext = {
              namespaceId: outputId,
              prefix,
              fullPath: [],
              overrides: inheritedOverrides,
              // A component may expose a text property owned by a component nested several
              // instances below it. The placed outer instance carries the user's assignment while
              // each nested master carries its own default. Keep both scopes and let the placed
              // instance win, otherwise expansion silently falls back to labels such as "Action".
              textAssignments: inheritedTextAssignments(raw, context?.textAssignments),
              booleanAssignments: inheritedBooleanAssignments(raw, context?.booleanAssignments),
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
                  childVariableModes,
                );
              })
              .filter((child): child is CapturedNode => child !== null);
      const parentRawId =
        raw.parentIndex?.guid === undefined ? undefined : nodeId(raw.parentIndex.guid);
      const parentRaw = parentRawId === undefined ? undefined : this.nodes.get(parentRawId);
      if (parentRawId !== undefined) dependencies.add(parentRawId);
      return {
        id: outputId,
        name: raw.name ?? '',
        type: raw.type ?? 'UNKNOWN',
        visible: raw.visible !== false,
        ...(resolvedParentId === undefined ? {} : { resolvedParentId }),
        ...(mainComponent === undefined ? {} : { mainComponent }),
        ...(componentProperties === undefined ? {} : { componentProperties }),
        ...(typeof (parentStackMode ?? parentRaw?.stackMode) === 'string'
          ? { parentStackMode: (parentStackMode ?? parentRaw?.stackMode) as string }
          : {}),
        raw,
        children,
      };
    };

    return {
      node: build(normalized, normalized, 0, undefined, undefined, undefined, rootVariableModes),
      dependencies,
      visited,
      nodeLimitReached,
      depthLimitReached,
      resolvedInstances,
      unresolvedInstances,
      instanceCycles,
      variableColorBindings: variableResolver.stats.bindings,
      resolvedVariableColors: variableResolver.stats.resolved,
      unresolvedVariableColors: variableResolver.stats.unresolved,
      variableModeFallbacks: variableResolver.stats.modeFallbacks,
      variables: variableResolver.variables,
      sharedStyleBindings: sharedStyleResolver.stats.bindings,
      resolvedSharedStyles: sharedStyleResolver.stats.resolved,
      unresolvedSharedStyles: sharedStyleResolver.stats.unresolved,
      styles: sharedStyleResolver.styles,
    };
  }

  private getSharedStyleIndex(): SharedStyleIndex {
    this.sharedStyleIndex ??= buildSharedStyleIndex(this.nodes.values());
    return this.sharedStyleIndex;
  }

  private getVariableColorIndex(): VariableColorIndex {
    this.variableColorIndex ??= buildVariableColorIndex(this.nodes.values());
    return this.variableColorIndex;
  }

  private inheritedVariableModes(
    id: string,
    dependencies: Set<string>,
    resolver: VariableColorResolver,
  ): VariableModeMap {
    const ancestors: KiwiNodeChange[] = [];
    let parentGuid = this.nodes.get(id)?.parentIndex?.guid;
    const seen = new Set<string>();
    while (parentGuid !== undefined) {
      const parentId = nodeId(parentGuid);
      if (seen.has(parentId)) break;
      seen.add(parentId);
      dependencies.add(parentId);
      const parent = this.nodes.get(parentId);
      if (parent === undefined) break;
      ancestors.push(parent);
      parentGuid = parent.parentIndex?.guid;
    }
    let modes: VariableModeMap = new Map();
    for (const ancestor of ancestors.toReversed()) modes = resolver.modesFor(ancestor, modes);
    return modes;
  }

  private buildChildIndex(): Map<string, Array<{ id: string; position: string }>> {
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
    return childIds;
  }

  private addAncestorChain(id: string, output: Set<string>, expanded: Set<string>): void {
    let current: string | null = id;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      output.add(current);
      if (expanded.has(current)) break;
      expanded.add(current);
      const parentGuid: KiwiGuid | undefined = this.nodes.get(current)?.parentIndex?.guid;
      current = parentGuid === undefined ? null : nodeId(parentGuid);
    }
  }

  private recordChange(affectedNodeIds: ReadonlySet<string> | null): void {
    this.changeHistory.push({
      revision: this.currentRevision,
      affectedNodeIds: affectedNodeIds === null ? null : new Set(affectedNodeIds),
    });
    if (this.changeHistory.length > 256) this.changeHistory.shift();
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
