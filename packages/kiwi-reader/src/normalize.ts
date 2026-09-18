import {
  MIXED,
  SerializedNodeSchema,
  type SerializedAutoLayout,
  type SerializedEffect,
  type SerializedLetterSpacing,
  type SerializedLineHeight,
  type SerializedNode,
  type SerializedPaint,
  type SerializedStyleIds,
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

  if (type === 'SOLID') {
    const paintColor = color(source.color ?? source.authoredColor);
    return paintColor === undefined ? null : { type, ...base, color: paintColor };
  }

  if (
    type === 'GRADIENT_LINEAR' ||
    type === 'GRADIENT_RADIAL' ||
    type === 'GRADIENT_ANGULAR' ||
    type === 'GRADIENT_DIAMOND'
  ) {
    const transform = matrix(source.gradientTransform ?? source.transform);
    if (transform === undefined || !Array.isArray(source.gradientStops)) return null;
    const gradientStops = source.gradientStops
      .map(stop => {
        const raw = record(stop);
        const position = finiteNumber(raw?.position);
        const stopColor = rgba(raw?.color);
        return position === undefined || stopColor === undefined
          ? null
          : { position, color: stopColor };
      })
      .filter(
        (
          stop,
        ): stop is {
          position: number;
          color: { r: number; g: number; b: number; a: number };
        } => stop !== null,
      );
    return { type, ...base, gradientStops, gradientTransform: transform };
  }

  if (type === 'IMAGE' || type === 'VIDEO') {
    const scaleMode = nonEmptyString(source.scaleMode);
    return {
      type,
      ...base,
      ...(scaleMode === 'FILL' ||
      scaleMode === 'FIT' ||
      scaleMode === 'CROP' ||
      scaleMode === 'TILE'
        ? { scaleMode }
        : {}),
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

const assetKey = (value: unknown): string | undefined => nonEmptyString(record(value)?.key);

const normalizeStyleIds = (raw: UnknownRecord): SerializedStyleIds | undefined => {
  const output: SerializedStyleIds = {};
  const fill = assetKey(raw.styleIdForFill);
  const stroke = assetKey(raw.styleIdForStrokeFill);
  const effect = assetKey(raw.styleIdForEffect);
  const text = assetKey(raw.styleIdForText);
  if (fill !== undefined) output.fill = fill;
  if (stroke !== undefined) output.stroke = stroke;
  if (effect !== undefined) output.effect = effect;
  if (text !== undefined) output.text = text;
  return Object.keys(output).length === 0 ? undefined : output;
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
  const font = record(raw.fontName ?? text.fontName);
  const family = nonEmptyString(font?.family);
  const style = nonEmptyString(font?.style);
  if (characters !== undefined) output.characters = characters;
  if (fontSize !== undefined) output.fontSize = fontSize;
  if (family !== undefined && style !== undefined) output.fontName = { family, style };
  for (const [sourceKey, targetKey] of [
    ['textAlignHorizontal', 'textAlignHorizontal'],
    ['textAlignVertical', 'textAlignVertical'],
    ['textCase', 'textCase'],
    ['textDecoration', 'textDecoration'],
    ['textAutoResize', 'textAutoResize'],
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
  if (paragraphSpacing !== undefined) output.paragraphSpacing = paragraphSpacing;
  if (paragraphIndent !== undefined) output.paragraphIndent = paragraphIndent;
};

const normalizeNodeUnchecked = (node: CapturedNode): SerializedNode => {
  const raw = node.raw as UnknownRecord;
  const size = record(raw.size);
  const transform = record(raw.transform);
  const output: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    locked: typeof raw.locked === 'boolean' ? raw.locked : false,
    parentId: parentId(raw),
    x: finiteNumber(transform?.m02 ?? raw.x) ?? 0,
    y: finiteNumber(transform?.m12 ?? raw.y) ?? 0,
    width: finiteNumber(size?.x ?? raw.width) ?? 0,
    height: finiteNumber(size?.y ?? raw.height) ?? 0,
  };

  const m00 = finiteNumber(transform?.m00);
  const m10 = finiteNumber(transform?.m10);
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
  const sizingHorizontal = raw.stackMode === 'VERTICAL' ? counterSizing : primarySizing;
  const sizingVertical = raw.stackMode === 'VERTICAL' ? primarySizing : counterSizing;
  const layoutAlign = nonEmptyString(raw.stackChildAlignSelf);
  const layoutPositioning = nonEmptyString(raw.stackPositioning);
  const layoutGrow = finiteNumber(raw.stackChildPrimaryGrow);
  if (sizingHorizontal !== undefined) output.layoutSizingHorizontal = sizingHorizontal;
  if (sizingVertical !== undefined) output.layoutSizingVertical = sizingVertical;
  if (layoutAlign !== undefined) output.layoutAlign = layoutAlign;
  if (layoutPositioning !== undefined) output.layoutPositioning = layoutPositioning;
  if (layoutGrow !== undefined && layoutGrow !== 0) output.layoutGrow = layoutGrow;

  const constraints = record(raw.constraints);
  const horizontal = nonEmptyString(constraints?.horizontal ?? raw.horizontalConstraint);
  const vertical = nonEmptyString(constraints?.vertical ?? raw.verticalConstraint);
  if (horizontal !== undefined && vertical !== undefined) {
    output.constraints = { horizontal, vertical };
  }
  if (raw.clipsContent === true) output.clipsContent = true;
  if (raw.isMask === true) output.isMask = true;
  const maskType = nonEmptyString(raw.maskType);
  if (raw.isMask === true && maskType !== undefined) output.maskType = maskType;

  const styleIds = normalizeStyleIds(raw);
  if (styleIds !== undefined) output.styleIds = styleIds;
  normalizeText(raw, output);

  if (node.children.length > 0) output.children = node.children.map(normalizeNodeUnchecked);
  return output;
};

/** Convert a captured Kiwi subtree into Figwright's established, validated read contract. */
export const normalizeCapturedNode = (node: CapturedNode): SerializedNode =>
  SerializedNodeSchema.parse(normalizeNodeUnchecked(node));
