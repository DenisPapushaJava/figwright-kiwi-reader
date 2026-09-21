import {
  MIXED,
  SerializedNodeSchema,
  type SerializedAutoLayout,
  type SerializedEffect,
  type SerializedLetterSpacing,
  type SerializedLineHeight,
  type SerializedFontName,
  type SerializedNode,
  type SerializedPaint,
  type SerializedStyleIds,
  type SerializedTextSegment,
} from '@figwright/shared';

import { nodeId, type CapturedNode, type KiwiGuid } from './scenegraph.js';

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const numericArray = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value) || !value.every(item => finiteNumber(item) !== undefined)) {
    return undefined;
  }
  return value as number[];
};

const color = (value: unknown): { r: number; g: number; b: number } | undefined => {
  const source = record(value);
  const r = finiteNumber(source?.r);
  const g = finiteNumber(source?.g);
  const b = finiteNumber(source?.b);
  return r === undefined || g === undefined || b === undefined ? undefined : { r, g, b };
};

const rgba = (value: unknown): { r: number; g: number; b: number; a: number } | undefined => {
  const source = record(value);
  const rgb = color(value);
  if (rgb === undefined) return undefined;
  return { ...rgb, a: finiteNumber(source?.a) ?? 1 };
};

const normalizeObjectBindings = (value: unknown): Readonly<Record<string, string>> | undefined => {
  const source = record(value);
  if (source === null) return undefined;
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const matrix = (value: unknown): number[][] | undefined => {
  if (Array.isArray(value)) {
    const rows = value.map(numericArray);
    return rows.length === 2 && rows.every(row => row?.length === 3)
      ? (rows as number[][])
      : undefined;
  }
  const source = record(value);
  if (source === null) return undefined;
  const values = ['m00', 'm01', 'm02', 'm10', 'm11', 'm12'].map(key => finiteNumber(source[key]));
  return values.every(item => item !== undefined)
    ? [values.slice(0, 3) as number[], values.slice(3, 6) as number[]]
    : undefined;
};

const normalizePaint = (value: unknown): SerializedPaint | null => {
  const source = record(value);
  const type = nonEmptyString(source?.type);
  if (source === null || type === undefined) return null;
  const base = { visible: source.visible !== false, opacity: finiteNumber(source.opacity) ?? 1 };
  const boundVariables = normalizeObjectBindings(source.boundVariables);

  if (type === 'SOLID') {
    const paintColor = color(source.color ?? source.authoredColor);
    return paintColor === undefined
      ? null
      : {
          type,
          ...base,
          color: paintColor,
          ...(boundVariables === undefined ? {} : { boundVariables }),
        };
  }

  if (
    type === 'GRADIENT_LINEAR' ||
    type === 'GRADIENT_RADIAL' ||
    type === 'GRADIENT_ANGULAR' ||
    type === 'GRADIENT_DIAMOND'
  ) {
    const transform = matrix(source.gradientTransform ?? source.transform);
    const sourceStops = source.gradientStops ?? source.stopsVar ?? source.stops;
    if (transform === undefined || !Array.isArray(sourceStops)) return null;
    const gradientStops = sourceStops
      .map(stop => {
        const raw = record(stop);
        const position = finiteNumber(raw?.position);
        const stopColor = rgba(raw?.color);
        const stopBindings = normalizeObjectBindings(raw?.boundVariables);
        if (position === undefined || stopColor === undefined) return null;
        const output: {
          position: number;
          color: { r: number; g: number; b: number; a: number };
          boundVariables?: Readonly<Record<string, string>>;
        } = { position, color: stopColor };
        if (stopBindings !== undefined) output.boundVariables = stopBindings;
        return output;
      })
      .filter(
        (
          stop,
        ): stop is {
          position: number;
          color: { r: number; g: number; b: number; a: number };
        } => stop !== null,
      );
    return {
      type,
      ...base,
      gradientStops,
      gradientTransform: transform,
      ...(boundVariables === undefined ? {} : { boundVariables }),
    };
  }

  if (type === 'IMAGE' || type === 'VIDEO') {
    const scaleMode = nonEmptyString(source.scaleMode);
    const filters = record(source.filters ?? source.imageFilters);
    const filtersApplied =
      filters !== null &&
      Object.values(filters).some(
        item => typeof item === 'number' && Number.isFinite(item) && item !== 0,
      );
    return {
      type,
      ...base,
      ...(scaleMode === 'FILL' ||
      scaleMode === 'FIT' ||
      scaleMode === 'CROP' ||
      scaleMode === 'TILE'
        ? { scaleMode }
        : {}),
      ...(filtersApplied ? { filtersApplied: true } : {}),
    };
  }

  if (type === 'SHADER') return { type, ...base };
  return null;
};

const normalizePaints = (value: unknown): SerializedPaint[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.map(normalizePaint).filter((paint): paint is SerializedPaint => paint !== null);
};

const normalizeEffects = (value: unknown): SerializedEffect[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(effect => {
    const source = record(effect);
    const type = nonEmptyString(source?.type);
    if (source === null || type === undefined) return [];
    const output: SerializedEffect = { type, visible: source.visible !== false };
    const boundVariables = normalizeObjectBindings(source.boundVariables);
    const radius = finiteNumber(source.radius);
    const spread = finiteNumber(source.spread);
    const effectColor = rgba(source.color);
    const offset = record(source.offset);
    const offsetX = finiteNumber(offset?.x);
    const offsetY = finiteNumber(offset?.y);
    if (radius !== undefined) output.radius = radius;
    if (spread !== undefined) output.spread = spread;
    if (effectColor !== undefined) output.color = effectColor;
    if (offsetX !== undefined && offsetY !== undefined) output.offset = { x: offsetX, y: offsetY };
    if (boundVariables !== undefined) output.boundVariables = boundVariables;
    return [output];
  });
};

const padding = (raw: UnknownRecord, side: 'Top' | 'Right' | 'Bottom' | 'Left'): number => {
  const explicit = finiteNumber(raw[`stackPadding${side}`]);
  if (explicit !== undefined) return explicit;
  return side === 'Left' || side === 'Right'
    ? (finiteNumber(raw.stackHorizontalPadding) ?? 0)
    : (finiteNumber(raw.stackVerticalPadding) ?? 0);
};

const normalizeAutoLayout = (raw: UnknownRecord): SerializedAutoLayout | undefined => {
  const mode = nonEmptyString(raw.stackMode);
  if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL' && mode !== 'GRID') return undefined;
  const output: SerializedAutoLayout = {
    mode,
    paddingTop: padding(raw, 'Top'),
    paddingRight: padding(raw, 'Right'),
    paddingBottom: padding(raw, 'Bottom'),
    paddingLeft: padding(raw, 'Left'),
  };
  if (mode !== 'GRID') {
    output.itemSpacing = finiteNumber(raw.stackSpacing) ?? 0;
    const primary = nonEmptyString(raw.stackPrimaryAlignItems);
    const counter = nonEmptyString(raw.stackCounterAlignItems);
    const wrap = nonEmptyString(raw.stackWrap);
    if (primary !== undefined) output.primaryAxisAlignItems = primary;
    if (counter !== undefined) output.counterAxisAlignItems = counter;
    if (wrap !== undefined) output.layoutWrap = wrap;
    if (wrap === 'WRAP') {
      const counterSpacing = finiteNumber(raw.stackCounterSpacing);
      const alignContent = nonEmptyString(raw.stackCounterAlignContent);
      if (counterSpacing !== undefined && counterSpacing !== 0) {
        output.counterAxisSpacing = counterSpacing;
      }
      if (alignContent !== undefined && alignContent !== 'AUTO') {
        output.counterAxisAlignContent = alignContent;
      }
    }
    if (raw.stackReverseZIndex === true) output.itemReverseZIndex = true;
    if (raw.bordersTakeSpace === true) output.strokesIncludedInLayout = true;
  }
  return output;
};

const normalizeLineHeight = (value: unknown): SerializedLineHeight | undefined => {
  const source = record(value);
  const unit = nonEmptyString(source?.unit ?? source?.units);
  if (unit === undefined) return undefined;
  if (unit === 'AUTO') return { unit };
  const numericValue = finiteNumber(source?.value);
  return numericValue === undefined ? undefined : { unit, value: numericValue };
};

const normalizeLetterSpacing = (value: unknown): SerializedLetterSpacing | undefined => {
  const source = record(value);
  const unit = nonEmptyString(source?.unit ?? source?.units);
  const numericValue = finiteNumber(source?.value);
  return unit === undefined || numericValue === undefined
    ? undefined
    : { unit, value: numericValue };
};

const assetKey = (value: unknown): string | undefined => {
  const source = record(value);
  return nonEmptyString(source?.key) ?? nonEmptyString(record(source?.assetRef)?.key);
};

const styleReferenceId = (value: unknown): string | undefined => {
  const key = assetKey(value);
  if (key !== undefined) return key;
  const guid = record(record(value)?.guid) as KiwiGuid | null;
  return guid === null ? undefined : `StyleID:${nodeId(guid)}`;
};

const normalizeStyleIds = (raw: UnknownRecord): SerializedStyleIds | undefined => {
  const output: SerializedStyleIds = {};
  const fill = styleReferenceId(raw.styleIdForFill);
  const stroke = styleReferenceId(raw.styleIdForStrokeFill);
  const effect = styleReferenceId(raw.styleIdForEffect);
  const text = styleReferenceId(raw.styleIdForText);
  if (fill !== undefined) output.fill = fill;
  if (stroke !== undefined) output.stroke = stroke;
  if (effect !== undefined) output.effect = effect;
  if (text !== undefined) output.text = text;
  return Object.keys(output).length === 0 ? undefined : output;
};

const normalizeFontName = (value: unknown): SerializedFontName | undefined => {
  const font = record(value);
  const family = nonEmptyString(font?.family);
  const style = nonEmptyString(font?.style);
  if (family === undefined || style === undefined) return undefined;

  const postScriptName = nonEmptyString(
    font?.postScriptName ?? font?.postscriptName ?? font?.postscript,
  );
  const variationSettings = record(font?.variationSettings);
  const variations =
    variationSettings === null
      ? undefined
      : Object.fromEntries(
          Object.entries(variationSettings).filter(
            (entry): entry is [string, number] => finiteNumber(entry[1]) !== undefined,
          ),
        );
  return {
    family,
    style,
    ...(postScriptName === undefined ? {} : { postScriptName }),
    ...(variations === undefined || Object.keys(variations).length === 0
      ? {}
      : { variationSettings: variations }),
  };
};

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const matchingFontWeight = (
  raw: UnknownRecord,
  text: UnknownRecord,
  fontName: SerializedFontName,
): number | undefined => {
  const derived = record(raw.derivedTextData);
  const metadata = Array.isArray(text.fontMetaData)
    ? text.fontMetaData
    : Array.isArray(derived?.fontMetaData)
      ? derived.fontMetaData
      : [];
  for (const item of metadata) {
    const meta = record(item);
    const key = normalizeFontName(meta?.key);
    if (key !== undefined && sameValue(key, fontName)) return finiteNumber(meta?.fontWeight);
  }
  return undefined;
};

type NormalizedTextStyle = Omit<SerializedTextSegment, 'characters' | 'start' | 'end'>;

const normalizeTextStyle = (
  raw: UnknownRecord,
  text: UnknownRecord,
  override?: UnknownRecord,
): NormalizedTextStyle | undefined => {
  const source = override === undefined ? raw : { ...raw, ...override };
  const fontName = normalizeFontName(source.fontName ?? text.fontName);
  const fontSize = finiteNumber(source.fontSize ?? text.fontSize);
  if (fontName === undefined || fontSize === undefined) return undefined;

  const variations = fontName.variationSettings;
  const fontWeight =
    finiteNumber(source.fontWeight ?? text.fontWeight ?? variations?.wght) ??
    matchingFontWeight(raw, text, fontName);
  const fills = normalizePaints(source.fillPaints) ?? [];
  const textDecoration = nonEmptyString(source.textDecoration ?? text.textDecoration) ?? 'NONE';
  const textCase = nonEmptyString(source.textCase ?? text.textCase) ?? 'ORIGINAL';
  const lineHeight = normalizeLineHeight(source.lineHeight ?? text.lineHeight);
  const letterSpacing = normalizeLetterSpacing(source.letterSpacing ?? text.letterSpacing);
  const styleIds = normalizeStyleIds(source);

  return {
    fontName,
    fontSize,
    ...(fontWeight === undefined ? {} : { fontWeight }),
    fills,
    textDecoration,
    textCase,
    ...(lineHeight === undefined || lineHeight.unit === 'AUTO' ? {} : { lineHeight }),
    ...(letterSpacing === undefined || letterSpacing.value === 0 ? {} : { letterSpacing }),
    ...(styleIds === undefined ? {} : { styleIds }),
  };
};

const normalizeTextSegments = (
  raw: UnknownRecord,
  text: UnknownRecord,
  characters: string,
): SerializedTextSegment[] | undefined => {
  if (!Array.isArray(text.characterStyleIDs) || !Array.isArray(text.styleOverrideTable)) {
    return undefined;
  }
  const characterStyleIds = text.characterStyleIDs;
  if (
    characterStyleIds.length > characters.length ||
    !characterStyleIds.every(id => typeof id === 'number' && Number.isInteger(id) && id >= 0)
  ) {
    return undefined;
  }

  const overrides = new Map<number, UnknownRecord>();
  for (const item of text.styleOverrideTable) {
    const override = record(item);
    const styleId = finiteNumber(override?.styleID);
    if (
      override === null ||
      styleId === undefined ||
      !Number.isInteger(styleId) ||
      styleId <= 0 ||
      overrides.has(styleId)
    ) {
      return undefined;
    }
    overrides.set(styleId, override);
  }

  const styleIds = Array.from(
    { length: characters.length },
    (_, index) => (characterStyleIds[index] as number | undefined) ?? 0,
  );
  const distinctStyleIds = new Set(styleIds);
  if (distinctStyleIds.size < 2) return undefined;
  for (const styleId of distinctStyleIds) {
    if (styleId !== 0 && !overrides.has(styleId)) return undefined;
  }

  // Figma text offsets use UTF-16 indices. Never manufacture a run boundary inside a surrogate pair
  // if a malformed/cross-version payload assigns its two code units different style ids.
  for (let index = 1; index < characters.length; index += 1) {
    const previous = characters.charCodeAt(index - 1);
    const current = characters.charCodeAt(index);
    if (
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      current >= 0xdc00 &&
      current <= 0xdfff &&
      styleIds[index - 1] !== styleIds[index]
    ) {
      return undefined;
    }
  }

  const resolvedStyles = new Map<number, NormalizedTextStyle>();
  for (const styleId of distinctStyleIds) {
    const style = normalizeTextStyle(raw, text, styleId === 0 ? undefined : overrides.get(styleId));
    if (style === undefined) return undefined;
    resolvedStyles.set(styleId, style);
  }

  const segments: SerializedTextSegment[] = [];
  let start = 0;
  for (let end = 1; end <= characters.length; end += 1) {
    if (end < characters.length && styleIds[end] === styleIds[start]) continue;
    const style = resolvedStyles.get(styleIds[start] as number);
    if (style === undefined) return undefined;
    segments.push({
      characters: characters.slice(start, end),
      start,
      end,
      ...style,
    });
    start = end;
  }
  return segments;
};

const parentId = (raw: UnknownRecord): string | null => {
  const parent = record(raw.parentIndex);
  const guid = record(parent?.guid) as KiwiGuid | null;
  return guid === null ? null : nodeId(guid);
};

const normalizeText = (raw: UnknownRecord, output: SerializedNode): void => {
  const text = record(raw.textData);
  if (text === null) return;
  const characters = typeof text.characters === 'string' ? text.characters : undefined;
  const fontSize = finiteNumber(raw.fontSize ?? text.fontSize);
  const fontName = normalizeFontName(raw.fontName ?? text.fontName);
  const fontWeight =
    finiteNumber(raw.fontWeight ?? text.fontWeight ?? fontName?.variationSettings?.wght) ??
    (fontName === undefined ? undefined : matchingFontWeight(raw, text, fontName));
  if (characters !== undefined) output.characters = characters;
  if (fontSize !== undefined) output.fontSize = fontSize;
  if (fontName !== undefined) output.fontName = fontName;
  if (fontWeight !== undefined) output.fontWeight = fontWeight;
  for (const [sourceKey, targetKey] of [
    ['textAlignHorizontal', 'textAlignHorizontal'],
    ['textAlignVertical', 'textAlignVertical'],
    ['textCase', 'textCase'],
    ['textDecoration', 'textDecoration'],
    ['textAutoResize', 'textAutoResize'],
    ['textTruncation', 'textTruncation'],
    ['textWrapStyle', 'textWrapStyle'],
  ] as const) {
    const value = nonEmptyString(text[sourceKey] ?? raw[sourceKey]);
    if (value !== undefined) output[targetKey] = value;
  }
  const lineHeight = normalizeLineHeight(text.lineHeight ?? raw.lineHeight);
  const letterSpacing = normalizeLetterSpacing(text.letterSpacing ?? raw.letterSpacing);
  if (lineHeight !== undefined) output.lineHeight = lineHeight;
  if (letterSpacing !== undefined) output.letterSpacing = letterSpacing;
  const paragraphSpacing = finiteNumber(text.paragraphSpacing ?? raw.paragraphSpacing);
  const paragraphIndent = finiteNumber(text.paragraphIndent ?? raw.paragraphIndent);
  const maxLines = finiteNumber(text.maxLines ?? raw.maxLines);
  if (paragraphSpacing !== undefined) output.paragraphSpacing = paragraphSpacing;
  if (paragraphIndent !== undefined) output.paragraphIndent = paragraphIndent;
  if (maxLines !== undefined) output.maxLines = maxLines;

  if (characters !== undefined) {
    const segments = normalizeTextSegments(raw, text, characters);
    if (segments !== undefined) {
      output.segments = segments;
      for (const key of [
        'fontName',
        'fontSize',
        'fontWeight',
        'fills',
        'textDecoration',
        'textCase',
        'lineHeight',
        'letterSpacing',
      ] as const) {
        const first = segments[0]?.[key];
        if (segments.some(segment => !sameValue(segment[key], first))) output[key] = MIXED;
      }
    }
  }
};

const normalizeNodeUnchecked = (node: CapturedNode): SerializedNode => {
  const raw = node.raw as UnknownRecord;
  const size = record(raw.size);
  const transform = matrix(raw.transform);
  const output: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    locked: typeof raw.locked === 'boolean' ? raw.locked : false,
    parentId: node.resolvedParentId ?? parentId(raw),
    x: finiteNumber(transform?.[0]?.[2] ?? raw.x) ?? 0,
    y: finiteNumber(transform?.[1]?.[2] ?? raw.y) ?? 0,
    width: finiteNumber(size?.x ?? raw.width) ?? 0,
    height: finiteNumber(size?.y ?? raw.height) ?? 0,
  };

  const m00 = finiteNumber(transform?.[0]?.[0]);
  const m10 = finiteNumber(transform?.[1]?.[0]);
  if (m00 !== undefined && m10 !== undefined) {
    const rotation = (Math.atan2(m10, m00) * 180) / Math.PI;
    if (Math.abs(rotation) > 0.000_001) output.rotation = rotation;
  }
  const opacity = finiteNumber(raw.opacity);
  if (opacity !== undefined && opacity !== 1) output.opacity = opacity;
  const blendMode = nonEmptyString(raw.blendMode);
  if (blendMode !== undefined && blendMode !== 'PASS_THROUGH' && blendMode !== 'NORMAL') {
    output.blendMode = blendMode;
  }
  const arc = record(raw.arcData);
  const startingAngle = finiteNumber(arc?.startingAngle);
  const endingAngle = finiteNumber(arc?.endingAngle);
  const innerRadius = finiteNumber(arc?.innerRadius);
  if (
    startingAngle !== undefined &&
    endingAngle !== undefined &&
    innerRadius !== undefined &&
    (startingAngle !== 0 || endingAngle !== Math.PI * 2 || innerRadius !== 0)
  ) {
    output.arcData = { startingAngle, endingAngle, innerRadius };
  }

  if (raw.rectangleCornerRadiiIndependent === true) {
    output.cornerRadius = MIXED;
    output.cornerRadii = {
      topLeft: finiteNumber(raw.rectangleTopLeftCornerRadius) ?? 0,
      topRight: finiteNumber(raw.rectangleTopRightCornerRadius) ?? 0,
      bottomRight: finiteNumber(raw.rectangleBottomRightCornerRadius) ?? 0,
      bottomLeft: finiteNumber(raw.rectangleBottomLeftCornerRadius) ?? 0,
    };
  } else {
    const radius = finiteNumber(raw.cornerRadius ?? raw.rectangleCornerRadius);
    if (radius !== undefined && radius !== 0) output.cornerRadius = radius;
  }

  const fills = normalizePaints(raw.fillPaints);
  const strokes = normalizePaints(raw.strokePaints);
  const effects = normalizeEffects(raw.effects);
  if (fills !== undefined) output.fills = fills;
  if (strokes !== undefined) output.strokes = strokes;
  if (effects !== undefined) output.effects = effects;

  if (raw.borderStrokeWeightsIndependent === true) {
    output.strokeWeight = MIXED;
    output.strokeWeights = {
      top: finiteNumber(raw.borderTopWeight) ?? 0,
      right: finiteNumber(raw.borderRightWeight) ?? 0,
      bottom: finiteNumber(raw.borderBottomWeight) ?? 0,
      left: finiteNumber(raw.borderLeftWeight) ?? 0,
    };
  } else {
    const strokeWeight = finiteNumber(raw.strokeWeight ?? raw.borderWeight);
    if (strokeWeight !== undefined && strokeWeight !== 0) output.strokeWeight = strokeWeight;
  }
  const strokeAlign = nonEmptyString(raw.strokeAlign);
  const strokeCap = nonEmptyString(raw.strokeCap);
  const strokeJoin = nonEmptyString(raw.strokeJoin);
  const dashPattern = numericArray(raw.dashPattern);
  if (strokeAlign !== undefined) output.strokeAlign = strokeAlign;
  if (strokeCap !== undefined && strokeCap !== 'NONE') output.strokeCap = strokeCap;
  if (strokeJoin !== undefined && strokeJoin !== 'MITER') output.strokeJoin = strokeJoin;
  if (dashPattern !== undefined && dashPattern.length > 0) output.dashPattern = dashPattern;

  const layout = normalizeAutoLayout(raw);
  if (layout !== undefined) output.layout = layout;
  const primarySizing = nonEmptyString(raw.stackPrimarySizing);
  const counterSizing = nonEmptyString(raw.stackCounterSizing);
  const sizingHorizontal =
    node.parentStackMode === 'VERTICAL'
      ? counterSizing
      : node.parentStackMode === 'HORIZONTAL'
        ? primarySizing
        : undefined;
  const sizingVertical =
    node.parentStackMode === 'VERTICAL'
      ? primarySizing
      : node.parentStackMode === 'HORIZONTAL'
        ? counterSizing
        : undefined;
  const layoutAlign = nonEmptyString(raw.stackChildAlignSelf);
  const layoutPositioning = nonEmptyString(raw.stackPositioning);
  const layoutGrow = finiteNumber(raw.stackChildPrimaryGrow);
  if (sizingHorizontal !== undefined) output.layoutSizingHorizontal = sizingHorizontal;
  if (sizingVertical !== undefined) output.layoutSizingVertical = sizingVertical;
  if (layoutAlign !== undefined) output.layoutAlign = layoutAlign;
  if (layoutPositioning !== undefined) output.layoutPositioning = layoutPositioning;
  if (layoutGrow !== undefined && layoutGrow !== 0) output.layoutGrow = layoutGrow;
  for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
    const value = finiteNumber(raw[key]);
    if (value !== undefined) output[key] = value;
  }

  const constraints = record(raw.constraints);
  const horizontal = nonEmptyString(constraints?.horizontal ?? raw.horizontalConstraint);
  const vertical = nonEmptyString(constraints?.vertical ?? raw.verticalConstraint);
  if (horizontal !== undefined && vertical !== undefined) {
    output.constraints = { horizontal, vertical };
  }
  if (raw.clipsContent === true) output.clipsContent = true;
  const overflowDirection = nonEmptyString(raw.overflowDirection);
  if (overflowDirection !== undefined && overflowDirection !== 'NONE') {
    output.overflowDirection = overflowDirection;
  }
  const numberOfFixedChildren = finiteNumber(raw.numberOfFixedChildren);
  if (numberOfFixedChildren !== undefined && numberOfFixedChildren > 0) {
    output.numberOfFixedChildren = numberOfFixedChildren;
  }
  const aspectRatio = record(raw.targetAspectRatio);
  const aspectX = finiteNumber(aspectRatio?.x);
  const aspectY = finiteNumber(aspectRatio?.y);
  if (aspectX !== undefined && aspectY !== undefined && aspectX > 0 && aspectY > 0) {
    output.targetAspectRatio = { x: aspectX, y: aspectY };
  }
  if (raw.isMask === true) output.isMask = true;
  const maskType = nonEmptyString(raw.maskType);
  if (raw.isMask === true && maskType !== undefined) output.maskType = maskType;

  const styleIds = normalizeStyleIds(raw);
  if (styleIds !== undefined) output.styleIds = styleIds;
  if (node.mainComponent !== undefined) output.mainComponent = node.mainComponent;
  if (node.componentProperties !== undefined) {
    output.componentProperties = node.componentProperties;
  }
  normalizeText(raw, output);

  if (node.children.length > 0) output.children = node.children.map(normalizeNodeUnchecked);
  return output;
};

export class KiwiNormalizationError extends Error {
  constructor(capturedNodeId: string, issues: readonly { path: PropertyKey[]; message: string }[]) {
    const summary = issues
      .slice(0, 5)
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    const suffix = issues.length > 5 ? `; ${issues.length - 5} more issue(s)` : '';
    super(`Invalid normalized Kiwi node ${capturedNodeId}: ${summary}${suffix}`);
    this.name = 'KiwiNormalizationError';
  }
}

/** Convert a captured Kiwi subtree into Figwright's established, validated read contract. */
export const normalizeCapturedNode = (node: CapturedNode): SerializedNode => {
  const result = SerializedNodeSchema.safeParse(normalizeNodeUnchecked(node));
  if (!result.success) throw new KiwiNormalizationError(node.id, result.error.issues);
  return result.data;
};
