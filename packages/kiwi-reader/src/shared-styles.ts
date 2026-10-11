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
  byReference: ReadonlyMap<string, readonly KiwiNodeChange[]>;
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
  const byReference = new Map<string, KiwiNodeChange[]>();
  for (const node of nodes) {
    if (!isSharedStyle(node)) continue;
    for (const key of ownReferenceKeys(node)) {
      const definitions = byReference.get(key);
      if (definitions === undefined) byReference.set(key, [node]);
      else definitions.push(node);
    }
  }
  return { byReference };
};

export const hasSharedStyleDefinitionChange = (
  previous: KiwiNodeChange | undefined,
  change: KiwiNodeChange,
): boolean => isSharedStyle(previous) || isSharedStyle(change);

const lookup = (reference: unknown, index: SharedStyleIndex): KiwiNodeChange | null => {
  const source = record(reference);
  const version =
    nonEmptyString(source?.version) ?? nonEmptyString(record(source?.assetRef)?.version);
  for (const key of referenceKeys(reference)) {
    const definitions = index.byReference.get(key);
    if (definitions === undefined) continue;
    // A local GUID identifies the exact definition even when several library versions coexist.
    if (key.startsWith('guid:')) return definitions[0] ?? null;
    if (version !== undefined) {
      const exact = definitions.find(style => style.version === version);
      if (exact !== undefined) return exact;
    }
    const only = definitions.length === 1 ? definitions[0] : undefined;
    // Legacy captures may omit version metadata. Never substitute a known different version,
    // or guess between multiple definitions; keep the node's captured paint in those cases.
    if (
      only !== undefined &&
      (version === undefined || nonEmptyString(only.version) === undefined)
    ) {
      return only;
    }
    return null;
  }
  return null;
};

export const sharedStyleReferenceId = (reference: unknown): string | undefined => {
  const guid = guidId(reference);
  // An all-ones GUID explicitly detaches the style; it is not a missing style definition.
  if (guid === '4294967295:4294967295') return undefined;
  const key = assetKey(reference);
  if (key !== null) return key;
  return guid === null ? undefined : `StyleID:${guid}`;
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
        const id = sharedStyleReferenceId(reference);
        if (id === undefined) continue;
        used = true;
        this.stats.bindings++;
        const style = lookup(reference, this.index);
        // Figma paint styles store their paints in fillPaints even when bound to a stroke.
        const value =
          field.value === 'strokePaints' &&
          style?.styleType === 'FILL' &&
          Array.isArray(style.fillPaints)
            ? style.fillPaints
            : style?.[field.value];
        if (style === null || !Array.isArray(value)) {
          this.stats.unresolved++;
          continue;
        }
        const type = nonEmptyString(style.styleType) ?? field.expectedType;
        this.styles[id] = { name: nonEmptyString(style.name) ?? id, type };
        this.stats.resolved++;
        if (output === source) output = { ...source };
        output[field.value] = value;
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
