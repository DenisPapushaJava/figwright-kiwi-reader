import type { KiwiNodeChange } from './scenegraph.js';

type UnknownRecord = Record<string, unknown>;

export const VARIABLE_GRAPH_DEPENDENCY = '@figlens/variable-graph';

export interface ResolvedKiwiVariable {
  name: string;
  type: string;
}

export interface VariableColorStats {
  bindings: number;
  resolved: number;
  unresolved: number;
  modeFallbacks: number;
}

export interface VariableColorIndex {
  variablesByReference: ReadonlyMap<string, KiwiNodeChange>;
  setsByReference: ReadonlyMap<string, KiwiNodeChange>;
}

export type VariableModeMap = ReadonlyMap<string, string>;

const record = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

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

const assetKey = (value: unknown): string | null => {
  const source = record(value);
  const asset = record(source?.assetRef);
  return nonEmptyString(asset?.key) ?? null;
};

const referenceKeys = (value: unknown): string[] => {
  const keys: string[] = [];
  const guid = guidId(value);
  const key = assetKey(value);
  if (guid !== null) keys.push(`guid:${guid}`);
  if (key !== null) keys.push(`key:${key}`);
  return keys;
};

const ownReferenceKeys = (node: KiwiNodeChange): string[] => {
  const keys = [`guid:${guidId(node.guid) ?? '0:0'}`];
  const key = nonEmptyString(node.key);
  if (key !== undefined) keys.push(`key:${key}`);
  return keys;
};

const bindingId = (value: unknown): string | null => {
  const guid = guidId(value);
  if (guid !== null) return `VariableID:${guid}`;
  const key = assetKey(value);
  return key === null ? null : `VariableKey:${key}`;
};

const lookup = (
  reference: unknown,
  index: ReadonlyMap<string, KiwiNodeChange>,
): KiwiNodeChange | null => {
  for (const key of referenceKeys(reference)) {
    const found = index.get(key);
    if (found !== undefined) return found;
  }
  return null;
};

export const buildVariableColorIndex = (nodes: Iterable<KiwiNodeChange>): VariableColorIndex => {
  const variablesByReference = new Map<string, KiwiNodeChange>();
  const setsByReference = new Map<string, KiwiNodeChange>();
  for (const node of nodes) {
    const target =
      node.type === 'VARIABLE'
        ? variablesByReference
        : node.type === 'VARIABLE_SET'
          ? setsByReference
          : null;
    if (target === null) continue;
    for (const key of ownReferenceKeys(node)) target.set(key, node);
  }
  return { variablesByReference, setsByReference };
};

export const hasVariableDefinitionChange = (
  previous: KiwiNodeChange | undefined,
  change: KiwiNodeChange,
): boolean => {
  const type = change.type ?? previous?.type;
  if (type === 'VARIABLE' || type === 'VARIABLE_SET') return true;
  return [
    'variableData',
    'variableDataValues',
    'variableSetID',
    'variableSetModes',
    'variableResolvedType',
    'variableTokenName',
  ].some(key => Object.hasOwn(change, key));
};

const applyModeOverrides = (
  inherited: VariableModeMap,
  raw: KiwiNodeChange,
): Map<string, string> => {
  const output = new Map(inherited);
  const modeMap = record(raw.variableModeBySetMap);
  const entries = Array.isArray(modeMap?.entries) ? modeMap.entries : [];
  for (const value of entries) {
    const entry = record(value);
    const modeId = guidId(entry?.variableModeID);
    if (entry === null || modeId === null) continue;
    for (const key of referenceKeys(entry.variableSetID)) output.set(key, modeId);
    for (const key of referenceKeys(entry.variableSetExtensionID)) output.set(key, modeId);
  }
  return output;
};

const activeMode = (
  variable: KiwiNodeChange,
  modes: VariableModeMap,
  index: VariableColorIndex,
): { id: string | null; usedFallback: boolean } => {
  const setReference = variable.variableSetID;
  for (const key of referenceKeys(setReference)) {
    const explicit = modes.get(key);
    if (explicit !== undefined) return { id: explicit, usedFallback: false };
  }

  const set = lookup(setReference, index.setsByReference);
  if (set !== null) {
    for (const key of ownReferenceKeys(set)) {
      const explicit = modes.get(key);
      if (explicit !== undefined) return { id: explicit, usedFallback: false };
    }
    const firstMode = Array.isArray(set.variableSetModes) ? set.variableSetModes[0] : undefined;
    const fallback = guidId(record(firstMode)?.id);
    if (fallback !== null) return { id: fallback, usedFallback: true };
  }

  const values = record(variable.variableDataValues);
  const firstEntry = Array.isArray(values?.entries) ? values.entries[0] : undefined;
  const fallback = guidId(record(firstEntry)?.modeID);
  return { id: fallback, usedFallback: fallback !== null };
};

interface ColorResolution {
  color: UnknownRecord | null;
  modeFallbacks: number;
  variable: KiwiNodeChange | null;
}

const resolveVariableData = (
  variableData: unknown,
  modes: VariableModeMap,
  index: VariableColorIndex,
  trail: ReadonlySet<string>,
): ColorResolution => {
  const value = record(record(variableData)?.value);
  const direct = record(value?.colorValue);
  if (
    direct !== null &&
    finiteNumber(direct.r) !== undefined &&
    finiteNumber(direct.g) !== undefined &&
    finiteNumber(direct.b) !== undefined
  ) {
    return { color: direct, modeFallbacks: 0, variable: null };
  }

  const alias = value?.alias;
  const aliasId = bindingId(alias);
  if (aliasId === null || trail.has(aliasId)) {
    return { color: null, modeFallbacks: 0, variable: null };
  }
  const variable = lookup(alias, index.variablesByReference);
  if (variable === null) return { color: null, modeFallbacks: 0, variable: null };

  const mode = activeMode(variable, modes, index);
  const values = record(variable.variableDataValues);
  const entries = Array.isArray(values?.entries) ? values.entries : [];
  const selected =
    entries.find(entry => guidId(record(entry)?.modeID) === mode.id) ?? entries[0] ?? null;
  const selectedData = record(selected)?.variableData ?? variable.variableData;
  const nested = resolveVariableData(selectedData, modes, index, new Set([...trail, aliasId]));
  return {
    color: nested.color,
    modeFallbacks: nested.modeFallbacks + (mode.usedFallback ? 1 : 0),
    variable,
  };
};

const mergeBinding = (value: unknown, field: string, id: string): UnknownRecord => {
  const existing = record(value);
  const output: UnknownRecord = {};
  if (existing !== null) {
    for (const [key, item] of Object.entries(existing)) {
      if (typeof item === 'string' && item !== '') output[key] = item;
    }
  }
  output[field] = id;
  return output;
};

const variableType = (variable: KiwiNodeChange): string =>
  nonEmptyString(variable.variableResolvedType) ??
  nonEmptyString(record(variable.variableData)?.resolvedDataType) ??
  'COLOR';

export class VariableColorResolver {
  readonly stats: VariableColorStats = {
    bindings: 0,
    resolved: 0,
    unresolved: 0,
    modeFallbacks: 0,
  };

  readonly variables: Record<string, ResolvedKiwiVariable> = {};

  constructor(private readonly index: VariableColorIndex) {}

  modesFor(raw: KiwiNodeChange, inherited: VariableModeMap = new Map()): Map<string, string> {
    return applyModeOverrides(inherited, raw);
  }

  resolveNode(
    raw: KiwiNodeChange,
    inheritedModes: VariableModeMap,
  ): { raw: KiwiNodeChange; modes: VariableModeMap; usesVariables: boolean } {
    const modes = applyModeOverrides(inheritedModes, raw);
    let usesVariables = false;

    const resolveColor = (owner: UnknownRecord, colorVar: unknown): UnknownRecord => {
      const alias = record(record(colorVar)?.value)?.alias;
      const id = bindingId(alias);
      if (id === null) return owner;
      usesVariables = true;
      this.stats.bindings++;
      const resolved = resolveVariableData(colorVar, modes, this.index, new Set());
      this.stats.modeFallbacks += resolved.modeFallbacks;
      if (resolved.variable !== null) {
        this.variables[id] = {
          name: nonEmptyString(resolved.variable.name) ?? id,
          type: variableType(resolved.variable),
        };
      }
      const output: UnknownRecord = {
        ...owner,
        boundVariables: mergeBinding(owner.boundVariables, 'color', id),
      };
      if (resolved.color === null) {
        this.stats.unresolved++;
        return output;
      }
      this.stats.resolved++;
      output.color = resolved.color;
      const alpha = finiteNumber(resolved.color.a);
      if (alpha !== undefined && alpha !== 1 && owner.type === 'SOLID') {
        output.opacity = (finiteNumber(owner.opacity) ?? 1) * alpha;
      }
      return output;
    };

    const resolvePaint = (value: unknown): unknown => {
      const paint = record(value);
      if (paint === null) return value;
      const output =
        paint.colorVar === undefined ? { ...paint } : resolveColor(paint, paint.colorVar);
      for (const field of ['gradientStops', 'stops', 'stopsVar'] as const) {
        const stops = output[field];
        if (!Array.isArray(stops)) continue;
        output[field] = stops.map(stop => {
          const source = record(stop);
          return source?.colorVar === undefined ? stop : resolveColor(source, source.colorVar);
        });
      }
      return output;
    };

    const resolvePaints = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(resolvePaint) : value;

    const output: KiwiNodeChange = { ...raw };
    for (const field of ['fillPaints', 'strokePaints', 'backgroundPaints'] as const) {
      if (raw[field] !== undefined) output[field] = resolvePaints(raw[field]);
    }
    if (Array.isArray(raw.effects)) {
      output.effects = raw.effects.map(value => {
        const effect = record(value);
        return effect?.colorVar === undefined ? value : resolveColor(effect, effect.colorVar);
      });
    }

    const textData = record(raw.textData);
    if (textData !== null && Array.isArray(textData.styleOverrideTable)) {
      output.textData = {
        ...textData,
        styleOverrideTable: textData.styleOverrideTable.map(value => {
          const style = record(value);
          if (style === null || style.fillPaints === undefined) return value;
          return Object.assign({}, style, { fillPaints: resolvePaints(style.fillPaints) });
        }),
      };
    }

    return { raw: output, modes, usesVariables };
  }
}
