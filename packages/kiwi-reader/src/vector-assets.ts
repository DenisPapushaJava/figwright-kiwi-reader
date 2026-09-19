import type { CapturedBlobStore } from './blob-store.js';
import { capturedBlobRef } from './blob-store.js';
import type { CapturedNode } from './scenegraph.js';

type UnknownRecord = Record<string, unknown>;

interface Matrix2x3 {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

export interface RenderedVectorAsset {
  svg: string;
  width: number;
  height: number;
  renderedNodes: number;
  warnings: string[];
}

const record = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const matrix = (value: unknown): Matrix2x3 => {
  if (Array.isArray(value) && value.length === 2) {
    const first = value[0];
    const second = value[1];
    if (
      Array.isArray(first) &&
      Array.isArray(second) &&
      first.length === 3 &&
      second.length === 3 &&
      [...first, ...second].every(item => finiteNumber(item) !== undefined)
    ) {
      return {
        m00: first[0] as number,
        m01: first[1] as number,
        m02: first[2] as number,
        m10: second[0] as number,
        m11: second[1] as number,
        m12: second[2] as number,
      };
    }
  }
  const source = record(value);
  return {
    m00: finiteNumber(source?.m00) ?? 1,
    m01: finiteNumber(source?.m01) ?? 0,
    m02: finiteNumber(source?.m02) ?? 0,
    m10: finiteNumber(source?.m10) ?? 0,
    m11: finiteNumber(source?.m11) ?? 1,
    m12: finiteNumber(source?.m12) ?? 0,
  };
};

const matrixAttribute = (value: unknown): string => {
  const item = matrix(value);
  return `matrix(${item.m00} ${item.m10} ${item.m01} ${item.m11} ${item.m02} ${item.m12})`;
};

const number = (value: number): string => {
  if (Object.is(value, -0)) return '0';
  const rounded = Math.round(value * 10_000) / 10_000;
  return String(rounded);
};

const readFloat32 = (view: DataView, offset: number): number | null =>
  offset + 4 <= view.byteLength ? view.getFloat32(offset, true) : null;

const colorChannel = (item: number): string =>
  Math.round(Math.max(0, Math.min(1, item)) * 255)
    .toString(16)
    .padStart(2, '0');

/**
 * Decode Figma's precomputed path-command blob.
 *
 * Adapted from allan-simon/figma-kiwi-protocol@2bb4d6a9 (MIT), with strict bounds and finite-number
 * checks so a malformed private wire frame cannot produce a partial or invalid SVG path.
 */
export const commandsBlobToPath = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength === 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const output: string[] = [];
  let offset = 0;

  const take = (count: number): number[] | null => {
    const values: number[] = [];
    for (let index = 0; index < count; index++) {
      const value = readFloat32(view, offset);
      if (value === null || !Number.isFinite(value)) return null;
      values.push(value);
      offset += 4;
    }
    return values;
  };

  while (offset < bytes.byteLength) {
    const command = bytes[offset++];
    if (command === 0) continue;
    if (command === 3) {
      output.push('Z');
      continue;
    }
    const count = command === 1 || command === 2 ? 2 : command === 4 ? 6 : 0;
    if (count === 0) return null;
    const values = take(count);
    if (values === null) return null;
    if (command === 1)
      output.push(`M ${number(values[0] as number)} ${number(values[1] as number)}`);
    if (command === 2)
      output.push(`L ${number(values[0] as number)} ${number(values[1] as number)}`);
    if (command === 4) output.push(`C ${values.map(number).join(' ')}`);
  }
  return output.length === 0 ? null : output.join(' ');
};

/** Decode the editable vector-network fallback when Figma did not send baked fill geometry. */
export const vectorNetworkBlobToPath = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const vertexCount = view.getUint32(offset, true);
  offset += 4;
  const segmentCount = view.getUint32(offset, true);
  offset += 4;
  const regionCount = view.getUint32(offset, true);
  offset += 4;
  if (
    vertexCount === 0 ||
    segmentCount === 0 ||
    vertexCount > 1_000_000 ||
    segmentCount > 1_000_000
  ) {
    return null;
  }

  const vertices: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < vertexCount; index++) {
    if (offset + 12 > view.byteLength) return null;
    offset += 4;
    const x = view.getFloat32(offset, true);
    offset += 4;
    const y = view.getFloat32(offset, true);
    offset += 4;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    vertices.push({ x, y });
  }

  const segments: Array<{
    start: number;
    end: number;
    startTangentX: number;
    startTangentY: number;
    endTangentX: number;
    endTangentY: number;
  }> = [];
  for (let index = 0; index < segmentCount; index++) {
    if (offset + 28 > view.byteLength) return null;
    offset += 4;
    const start = view.getUint32(offset, true);
    offset += 4;
    const startTangentX = view.getFloat32(offset, true);
    offset += 4;
    const startTangentY = view.getFloat32(offset, true);
    offset += 4;
    const end = view.getUint32(offset, true);
    offset += 4;
    const endTangentX = view.getFloat32(offset, true);
    offset += 4;
    const endTangentY = view.getFloat32(offset, true);
    offset += 4;
    if (start >= vertexCount || end >= vertexCount) return null;
    segments.push({
      start,
      end,
      startTangentX,
      startTangentY,
      endTangentX,
      endTangentY,
    });
  }

  const loops: number[][] = [];
  for (let region = 0; region < regionCount; region++) {
    if (offset + 8 > view.byteLength) return null;
    offset += 4;
    const loopCount = view.getUint32(offset, true);
    offset += 4;
    for (let loopIndex = 0; loopIndex < loopCount; loopIndex++) {
      if (offset + 4 > view.byteLength) return null;
      const itemCount = view.getUint32(offset, true);
      offset += 4;
      if (itemCount > segmentCount || offset + itemCount * 4 > view.byteLength) return null;
      const loop: number[] = [];
      for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
        loop.push(view.getUint32(offset, true));
        offset += 4;
      }
      loops.push(loop);
    }
  }

  const segmentPath = (segmentIndex: number): string | null => {
    const segment = segments[segmentIndex];
    if (segment === undefined) return null;
    const start = vertices[segment.start] as { x: number; y: number };
    const end = vertices[segment.end] as { x: number; y: number };
    const curved =
      Math.abs(segment.startTangentX) > 0.000_001 ||
      Math.abs(segment.startTangentY) > 0.000_001 ||
      Math.abs(segment.endTangentX) > 0.000_001 ||
      Math.abs(segment.endTangentY) > 0.000_001;
    if (!curved) return `L ${number(end.x)} ${number(end.y)}`;
    return `C ${number(start.x + segment.startTangentX)} ${number(start.y + segment.startTangentY)} ${number(end.x + segment.endTangentX)} ${number(end.y + segment.endTangentY)} ${number(end.x)} ${number(end.y)}`;
  };

  const output: string[] = [];
  const orderedLoops = loops.length === 0 ? [segments.map((_, index) => index)] : loops;
  for (const loop of orderedLoops) {
    const first = segments[loop[0] as number];
    if (first === undefined) continue;
    const start = vertices[first.start] as { x: number; y: number };
    output.push(`M ${number(start.x)} ${number(start.y)}`);
    for (const segmentIndex of loop) {
      const path = segmentPath(segmentIndex);
      if (path !== null) output.push(path);
    }
    if (loops.length > 0) output.push('Z');
  }
  return output.length === 0 ? null : output.join(' ');
};

const color = (value: unknown, fallback = '#000000'): { value: string; opacity: number } => {
  const source = record(value);
  const r = finiteNumber(source?.r);
  const g = finiteNumber(source?.g);
  const b = finiteNumber(source?.b);
  if (r === undefined || g === undefined || b === undefined) return { value: fallback, opacity: 1 };
  return {
    value: `#${colorChannel(r)}${colorChannel(g)}${colorChannel(b)}`,
    opacity: finiteNumber(source?.a) ?? 1,
  };
};

const firstSolidPaint = (value: unknown): { color: string; opacity: number } | null => {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const paint = record(item);
    if (paint?.visible === false || paint?.type !== 'SOLID') continue;
    const resolved = color(paint.color ?? paint.authoredColor);
    return {
      color: resolved.value,
      opacity: (finiteNumber(paint.opacity) ?? 1) * resolved.opacity,
    };
  }
  return null;
};

const hasVisibleUnsupportedPaint = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.some(item => {
    const paint = record(item);
    return paint?.visible !== false && typeof paint?.type === 'string' && paint.type !== 'SOLID';
  });

const geometryPaths = (
  value: unknown,
  blobs: CapturedBlobStore,
  warnings: Set<string>,
): Array<{ path: string; windingRule: string }> => {
  if (!Array.isArray(value)) return [];
  const paths: Array<{ path: string; windingRule: string }> = [];
  for (const item of value) {
    const geometry = record(item);
    if (geometry === null) continue;
    const ref = capturedBlobRef(geometry, 'commandsBlob');
    const bytes = ref === null ? null : blobs.resolve(ref);
    if (bytes === null) {
      warnings.add('missing-commands-blob');
      continue;
    }
    const path = commandsBlobToPath(bytes);
    if (path === null) {
      warnings.add('invalid-commands-blob');
      continue;
    }
    paths.push({ path, windingRule: geometry.windingRule === 'ODD' ? 'evenodd' : 'nonzero' });
  }
  return paths;
};

const fallbackVectorPath = (
  raw: UnknownRecord,
  blobs: CapturedBlobStore,
  warnings: Set<string>,
): string | null => {
  const vectorData = record(raw.vectorData);
  const ref = capturedBlobRef(vectorData, 'vectorNetworkBlob');
  const bytes = ref === null ? null : blobs.resolve(ref);
  if (bytes === null) return null;
  const path = vectorNetworkBlobToPath(bytes);
  if (path === null) warnings.add('invalid-vector-network-blob');
  return path;
};

const computedShape = (node: CapturedNode): string | null => {
  const raw = node.raw as UnknownRecord;
  const size = record(raw.size);
  const width = finiteNumber(size?.x ?? raw.width) ?? 0;
  const height = finiteNumber(size?.y ?? raw.height) ?? 0;
  if (width <= 0 || height <= 0) return null;
  if (node.type === 'ELLIPSE') {
    return `<ellipse cx="${number(width / 2)}" cy="${number(height / 2)}" rx="${number(width / 2)}" ry="${number(height / 2)}"/>`;
  }
  if (node.type === 'LINE') return `<path d="M 0 0 L ${number(width)} ${number(height)}"/>`;
  if (node.type === 'RECTANGLE' || node.type === 'ROUNDED_RECTANGLE') {
    const radius = finiteNumber(raw.cornerRadius ?? raw.rectangleCornerRadius) ?? 0;
    return `<rect width="${number(width)}" height="${number(height)}" rx="${number(radius)}"/>`;
  }
  return null;
};

const renderNode = (
  node: CapturedNode,
  blobs: CapturedBlobStore,
  warnings: Set<string>,
  root: boolean,
): { markup: string; renderedNodes: number } => {
  if (!node.visible) return { markup: '', renderedNodes: 0 };
  const raw = node.raw as UnknownRecord;
  const fill = firstSolidPaint(raw.fillPaints);
  const stroke = firstSolidPaint(raw.strokePaints);
  const unsupportedFill = hasVisibleUnsupportedPaint(raw.fillPaints);
  const unsupportedStroke = hasVisibleUnsupportedPaint(raw.strokePaints);
  if (unsupportedFill) warnings.add('unsupported-vector-fill-paint');
  if (unsupportedStroke) warnings.add('unsupported-vector-stroke-paint');
  const fillPaths = geometryPaths(raw.fillGeometry, blobs, warnings);
  const strokePaths = geometryPaths(raw.strokeGeometry, blobs, warnings);
  const vectorFallback = fillPaths.length === 0 ? fallbackVectorPath(raw, blobs, warnings) : null;
  const own: string[] = [];

  for (const geometry of fillPaths) {
    own.push(
      `<path d="${geometry.path}" fill="${unsupportedFill ? 'none' : (fill?.color ?? 'none')}" fill-opacity="${number(fill?.opacity ?? 1)}" fill-rule="${geometry.windingRule}"/>`,
    );
  }
  if (vectorFallback !== null) {
    own.push(
      `<path d="${vectorFallback}" fill="${fill?.color ?? 'none'}" fill-opacity="${number(fill?.opacity ?? 1)}"${stroke === null ? '' : ` stroke="${stroke.color}" stroke-opacity="${number(stroke.opacity)}" stroke-width="${number(finiteNumber(raw.strokeWeight ?? raw.borderWeight) ?? 1)}"`}/>`,
    );
  }
  for (const geometry of strokePaths) {
    own.push(
      `<path d="${geometry.path}" fill="${unsupportedStroke ? 'none' : (stroke?.color ?? 'none')}" fill-opacity="${number(stroke?.opacity ?? 1)}" fill-rule="${geometry.windingRule}"/>`,
    );
  }

  if (own.length === 0) {
    const shape = computedShape(node);
    if (shape !== null && (fill !== null || stroke !== null)) {
      own.push(
        shape.replace(
          '/>',
          `${fill === null ? ' fill="none"' : ` fill="${fill.color}" fill-opacity="${number(fill.opacity)}"`}${stroke === null ? '' : ` stroke="${stroke.color}" stroke-opacity="${number(stroke.opacity)}" stroke-width="${number(finiteNumber(raw.strokeWeight ?? raw.borderWeight) ?? 1)}"`}/>`,
        ),
      );
    }
  }

  let renderedNodes = own.length > 0 ? 1 : 0;
  const children: string[] = [];
  for (const child of node.children) {
    const rendered = renderNode(child, blobs, warnings, false);
    if (rendered.markup !== '') children.push(rendered.markup);
    renderedNodes += rendered.renderedNodes;
  }
  const body = [...own, ...children].join('');
  if (body === '') return { markup: '', renderedNodes };
  const opacity = finiteNumber(raw.opacity);
  const attributes = [
    root ? '' : ` transform="${matrixAttribute(raw.transform)}"`,
    opacity === undefined || opacity === 1 ? '' : ` opacity="${number(opacity)}"`,
  ].join('');
  return { markup: `<g${attributes}>${body}</g>`, renderedNodes };
};

export const renderVectorSubtree = (
  node: CapturedNode,
  blobs: CapturedBlobStore,
): RenderedVectorAsset | null => {
  const raw = node.raw as UnknownRecord;
  const size = record(raw.size);
  const width = finiteNumber(size?.x ?? raw.width) ?? 0;
  const height = finiteNumber(size?.y ?? raw.height) ?? 0;
  if (width <= 0 || height <= 0) return null;
  const warnings = new Set<string>();
  const rendered = renderNode(node, blobs, warnings, true);
  if (rendered.markup === '') return null;
  return {
    width,
    height,
    renderedNodes: rendered.renderedNodes,
    warnings: [...warnings].toSorted(),
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" ` +
      `viewBox="0 0 ${number(width)} ${number(height)}">${rendered.markup}</svg>`,
  };
};
