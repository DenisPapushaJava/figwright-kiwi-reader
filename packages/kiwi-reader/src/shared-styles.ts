import type { KiwiNodeChange } from './scenegraph.js';

type UnknownRecord = Record<string, unknown>;

export const SHARED_STYLE_GRAPH_DEPENDENCY = '@figlens/shared-style-graph';

export interface ResolvedKiwiStyle {
  name: string;
  type: string;
}

export interface SharedStyleStats {
  bindings: number;
  resolved: number;
  unresolved: number;
}

export interface SharedStyleIndex {
  byReference: ReadonlyMap<string, KiwiNodeChange>;
}

const record = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

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
  return nonEmptyString(source?.key) ?? nonEmptyString(record(source?.assetRef)?.key) ?? null;
};

const referenceKeys = (value: unknown): string[] => {
  const output: string[] = [];
  const guid = guidId(value);
  const key = assetKey(value);
  if (guid !== null) output.push(`guid:${guid}`);
  if (key !== null) output.push(`key:${key}`);
  return output;
};

const ownReferenceKeys = (node: KiwiNodeChange): string[] => {
  const output: string[] = [];
  const guid = guidId(node.guid);
  const key = nonEmptyString(node.key);
  if (guid !== null) output.push(`guid:${guid}`);
  if (key !== undefined) output.push(`key:${key}`);
  return output;
};

const isSharedStyle = (node: KiwiNodeChange | undefined): node is KiwiNodeChange =>
  node !== undefined && nonEmptyString(node.styleType) !== undefined;

export const buildSharedStyleIndex = (nodes: Iterable<KiwiNodeChange>): SharedStyleIndex => {
  const byReference = new Map<string, KiwiNodeChange>();
  for (const node of nodes) {
    if (!isSharedStyle(node)) continue;
    for (const key of ownReferenceKeys(node)) byReference.set(key, node);
  }
  return { byReference };
};

export const hasSharedStyleDefinitionChange = (
  previous: KiwiNodeChange | undefined,
  change: KiwiNodeChange,
): boolean => isSharedStyle(previous) || isSharedStyle(change);

const lookup = (reference: unknown, index: SharedStyleIndex): KiwiNodeChange | null => {
  for (const key of referenceKeys(reference)) {
    const found = index.byReference.get(key);
    if (found !== undefined) return found;
  }
  return null;
};

const styleId = (reference: unknown): string | null => {
  const key = assetKey(reference);
  if (key !== null) return key;
  const guid = guidId(reference);
  return guid === null ? null : `StyleID:${guid}`;
};

interface StyleField {
  reference: 'styleIdForFill' | 'styleIdForStrokeFill' | 'styleIdForEffect';
  value: 'fillPaints' | 'strokePaints' | 'effects';
  expectedType: 'FILL' | 'STROKE' | 'EFFECT';
}

const STYLE_FIELDS: readonly StyleField[] = [
  { reference: 'styleIdForFill', value: 'fillPaints', expectedType: 'FILL' },
  { reference: 'styleIdForStrokeFill', value: 'strokePaints', expectedType: 'STROKE' },
  { reference: 'styleIdForEffect', value: 'effects', expectedType: 'EFFECT' },
];

export class SharedStyleResolver {
  readonly stats: SharedStyleStats = { bindings: 0, resolved: 0, unresolved: 0 };
  readonly styles: Record<string, ResolvedKiwiStyle> = {};

  constructor(private readonly index: SharedStyleIndex) {}

  resolveNode(raw: KiwiNodeChange): { raw: KiwiNodeChange; usesStyles: boolean } {
    const resolveRecord = (source: UnknownRecord): { value: UnknownRecord; used: boolean } => {
      let output = source;
      let used = false;
      for (const field of STYLE_FIELDS) {
        const reference = source[field.reference];
        const id = styleId(reference);
        if (id === null) continue;
        used = true;
        this.stats.bindings++;
        const style = lookup(reference, this.index);
        if (style === null || !Array.isArray(style[field.value])) {
          this.stats.unresolved++;
          continue;
        }
        const type = nonEmptyString(style.styleType) ?? field.expectedType;
        this.styles[id] = { name: nonEmptyString(style.name) ?? id, type };
        this.stats.resolved++;
        if (output === source) output = { ...source };
        output[field.value] = style[field.value];
      }
      return { value: output, used };
    };

    const resolved = resolveRecord(raw);
    let output = resolved.value as KiwiNodeChange;
    let usesStyles = resolved.used;
    const textData = record(output.textData);
    if (textData !== null && Array.isArray(textData.styleOverrideTable)) {
      const styleOverrideTable = textData.styleOverrideTable.map(item => {
        const source = record(item);
        if (source === null) return item;
        const style = resolveRecord(source);
        usesStyles ||= style.used;
        return style.value;
      });
      if (output === raw) output = { ...raw };
      output.textData = { ...textData, styleOverrideTable };
    }
    return { raw: output, usesStyles };
  }
}
