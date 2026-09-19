import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CapturedBlobStore } from './blob-store.js';
import { capturedBlobRef } from './blob-store.js';
import type { CapturedNetworkAssetStore } from './network-assets.js';
import type { CapturedNode } from './scenegraph.js';
import { renderVectorSubtree } from './vector-assets.js';

type UnknownRecord = Record<string, unknown>;
const INTERNAL_BYTES_KEY = '__bytes';

export const DESIGN_CONTEXT_SCHEMA_VERSION = 'figwright-kiwi-context@1' as const;
export const ASSET_MANIFEST_SCHEMA_VERSION = 'figwright-kiwi-assets@1' as const;

export interface DesignAssetInventoryEntry {
  assetId: string;
  nodeId: string;
  nodeName: string;
  kind: 'vector' | 'image';
  available: boolean;
  imageHash?: string;
  scaleMode?: string;
  imageTransform?: number[][];
  rotation?: number;
  filtersApplied?: boolean;
  reason?: string;
}

export interface DesignAssetInventory {
  entries: DesignAssetInventoryEntry[];
  summary: {
    vectors: number;
    exportableVectors: number;
    images: number;
    availableImages: number;
  };
}

export interface AssetManifest {
  schemaVersion: typeof ASSET_MANIFEST_SCHEMA_VERSION;
  source: {
    provider: 'kiwi-browser';
    fileKey: string;
    rootNodeId: string;
  };
  generatedAt: string;
  assets: Record<
    string,
    | {
        kind: 'vector';
        format: 'svg';
        path: string;
        checksum: string;
        width: number;
        height: number;
        renderedNodes: number;
        warnings: string[];
      }
    | {
        kind: 'image';
        format: string;
        path: string;
        checksum: string;
        mimeType: string;
        bytes: number;
      }
  >;
  usages: Array<{
    nodeId: string;
    nodeName: string;
    kind: 'vector' | 'image';
    assetId: string;
    scaleMode?: string;
    imageTransform?: number[][];
    rotation?: number;
    filtersApplied?: boolean;
  }>;
  missing: Array<{
    nodeId: string;
    nodeName: string;
    kind: 'vector' | 'image';
    reason: string;
    imageHash?: string;
  }>;
}

const record = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const byteArray = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (
    Array.isArray(value) &&
    value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Uint8Array.from(value as number[]);
  }
  const source = record(value);
  if (source === null) return null;
  return byteArray(source[INTERNAL_BYTES_KEY] ?? source.bytes ?? source.data);
};

const imageHash = (value: unknown): string | null => {
  if (typeof value === 'string' && value !== '') return value.toLowerCase();
  const bytes = byteArray(value);
  return bytes === null ? null : Buffer.from(bytes).toString('hex');
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const imageTransform = (value: unknown): number[][] | undefined => {
  if (Array.isArray(value) && value.length === 2) {
    const rows = value.filter(
      row =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every(item => finiteNumber(item) !== undefined),
    );
    if (rows.length === 2) return rows as number[][];
  }
  const source = record(value);
  if (source === null) return undefined;
  const values = ['m00', 'm01', 'm02', 'm10', 'm11', 'm12'].map(key => finiteNumber(source[key]));
  return values.every(item => item !== undefined)
    ? [values.slice(0, 3) as number[], values.slice(3) as number[]]
    : undefined;
};

const ownVectorRefs = (node: CapturedNode): string[] => {
  const raw = node.raw as UnknownRecord;
  const output: string[] = [];
  for (const key of ['fillGeometry', 'strokeGeometry']) {
    const geometry = raw[key];
    if (!Array.isArray(geometry)) continue;
    for (const item of geometry) {
      const ref = capturedBlobRef(item, 'commandsBlob');
      if (ref !== null) output.push(ref);
    }
  }
  const vectorRef = capturedBlobRef(record(raw.vectorData), 'vectorNetworkBlob');
  if (vectorRef !== null) output.push(vectorRef);
  return output;
};

const paintImages = (
  node: CapturedNode,
): Array<{
  hash: string | null;
  scaleMode?: string;
  imageTransform?: number[][];
  rotation?: number;
  filtersApplied?: boolean;
}> => {
  const raw = node.raw as UnknownRecord;
  const output: Array<{
    hash: string | null;
    scaleMode?: string;
    imageTransform?: number[][];
    rotation?: number;
    filtersApplied?: boolean;
  }> = [];
  for (const key of ['fillPaints', 'strokePaints']) {
    const paints = raw[key];
    if (!Array.isArray(paints)) continue;
    for (const item of paints) {
      const paint = record(item);
      if (paint?.type !== 'IMAGE' || paint.visible === false) continue;
      const image = record(paint.image ?? paint.imageThumbnail);
      const hash = imageHash(image?.hash ?? paint.imageHash);
      const scaleMode = typeof paint.scaleMode === 'string' ? paint.scaleMode : undefined;
      const transform = imageTransform(paint.imageTransform ?? paint.transform);
      const rotation = finiteNumber(paint.rotation ?? paint.imageRotation);
      const filters = record(paint.filters ?? paint.imageFilters);
      const filtersApplied =
        filters !== null &&
        Object.values(filters).some(
          filterValue =>
            typeof filterValue === 'number' && Number.isFinite(filterValue) && filterValue !== 0,
        );
      output.push({
        hash,
        ...(scaleMode === undefined ? {} : { scaleMode }),
        ...(transform === undefined ? {} : { imageTransform: transform }),
        ...(rotation === undefined || rotation === 0 ? {} : { rotation }),
        ...(filtersApplied ? { filtersApplied: true } : {}),
      });
    }
  }
  return output;
};

export const collectDesignAssetInventory = (
  root: CapturedNode,
  blobs: CapturedBlobStore,
  networkAssets?: CapturedNetworkAssetStore,
): DesignAssetInventory => {
  const entries: DesignAssetInventoryEntry[] = [];
  const visit = (node: CapturedNode): void => {
    const refs = ownVectorRefs(node);
    if (refs.length > 0) {
      const blobsAvailable = refs.every(ref => blobs.resolve(ref) !== null);
      const rendered = blobsAvailable ? renderVectorSubtree(node, blobs) : null;
      const available = rendered !== null && rendered.warnings.length === 0;
      entries.push({
        assetId: `vector:${node.id}`,
        nodeId: node.id,
        nodeName: node.name,
        kind: 'vector',
        available,
        ...(available
          ? {}
          : {
              reason: blobsAvailable
                ? (rendered?.warnings[0] ?? 'VECTOR_RENDER_UNAVAILABLE')
                : 'VECTOR_BLOB_UNAVAILABLE',
            }),
      });
    }
    for (const image of paintImages(node)) {
      const id = image.hash ?? `${node.id}:unknown`;
      const available =
        image.hash !== null && (networkAssets?.resolveHash(image.hash) ?? null) !== null;
      entries.push({
        assetId: `image:${id}`,
        nodeId: node.id,
        nodeName: node.name,
        kind: 'image',
        available,
        ...(image.hash === null
          ? { reason: 'IMAGE_HASH_UNAVAILABLE' }
          : {
              imageHash: image.hash,
              ...(available ? {} : { reason: 'IMAGE_BODY_UNAVAILABLE' }),
            }),
        ...(image.scaleMode === undefined ? {} : { scaleMode: image.scaleMode }),
        ...(image.imageTransform === undefined ? {} : { imageTransform: image.imageTransform }),
        ...(image.rotation === undefined ? {} : { rotation: image.rotation }),
        ...(image.filtersApplied === undefined ? {} : { filtersApplied: image.filtersApplied }),
      });
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return {
    entries,
    summary: {
      vectors: entries.filter(item => item.kind === 'vector').length,
      exportableVectors: entries.filter(item => item.kind === 'vector' && item.available).length,
      images: entries.filter(item => item.kind === 'image').length,
      availableImages: entries.filter(item => item.kind === 'image' && item.available).length,
    },
  };
};

const atomicWrite = async (path: string, data: string | Uint8Array): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
};

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const writeContentAddressed = async (
  absolutePath: string,
  checksum: string,
  data: string | Uint8Array,
): Promise<void> => {
  try {
    if (sha256(await readFile(absolutePath)) === checksum) return;
  } catch {
    // The content-addressed file does not exist yet.
  }
  await atomicWrite(absolutePath, data);
};

const candidateNodes = (root: CapturedNode): CapturedNode[] => {
  const output: CapturedNode[] = [];
  const seen = new Set<string>();
  const visit = (node: CapturedNode): void => {
    if (ownVectorRefs(node).length > 0 && !seen.has(node.id)) {
      seen.add(node.id);
      output.push(node);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return output;
};

const extensionForMime = (mimeType: string): string => {
  const subtype = mimeType.toLowerCase().split('/')[1]?.split(/[;+]/)[0];
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'svg+xml') return 'svg';
  return subtype?.replaceAll(/[^a-z0-9.+-]/g, '') || 'bin';
};

export const saveVectorAssetPack = async (options: {
  root: CapturedNode;
  blobs: CapturedBlobStore;
  networkAssets?: CapturedNetworkAssetStore;
  fileKey: string;
  outDir: string;
}): Promise<{ manifestPath: string; manifest: AssetManifest }> => {
  const outDir = resolve(options.outDir);
  const vectorDir = join(outDir, 'vectors');
  const imageDir = join(outDir, 'images');
  await mkdir(vectorDir, { recursive: true });
  await mkdir(imageDir, { recursive: true });
  const assets: AssetManifest['assets'] = {};
  const usages: AssetManifest['usages'] = [];
  const missing: AssetManifest['missing'] = [];
  const writes: Promise<void>[] = [];

  for (const node of candidateNodes(options.root)) {
    const rendered = renderVectorSubtree(node, options.blobs);
    if (rendered === null) {
      missing.push({
        nodeId: node.id,
        nodeName: node.name,
        kind: 'vector',
        reason: 'VECTOR_RENDER_UNAVAILABLE',
      });
      continue;
    }
    const checksum = sha256(rendered.svg);
    const assetId = `vector:sha256:${checksum}`;
    const relativePath = `vectors/${checksum}.svg`;
    const absolutePath = join(outDir, relativePath);
    if (assets[assetId] === undefined) {
      writes.push(writeContentAddressed(absolutePath, checksum, rendered.svg));
      assets[assetId] = {
        kind: 'vector',
        format: 'svg',
        path: relativePath.replaceAll('\\', '/'),
        checksum,
        width: rendered.width,
        height: rendered.height,
        renderedNodes: rendered.renderedNodes,
        warnings: rendered.warnings,
      };
    }
    usages.push({ nodeId: node.id, nodeName: node.name, kind: 'vector', assetId });
  }

  const inventory = collectDesignAssetInventory(options.root, options.blobs, options.networkAssets);
  for (const entry of inventory.entries) {
    if (entry.kind !== 'image') continue;
    const image =
      entry.imageHash === undefined
        ? null
        : (options.networkAssets?.resolveHash(entry.imageHash) ?? null);
    if (image === null) {
      missing.push({
        nodeId: entry.nodeId,
        nodeName: entry.nodeName,
        kind: 'image',
        reason: entry.reason ?? 'IMAGE_BODY_UNAVAILABLE',
        ...(entry.imageHash === undefined ? {} : { imageHash: entry.imageHash }),
      });
      continue;
    }
    const assetId = `image:sha256:${image.sha256}`;
    const extension = extensionForMime(image.mimeType);
    const relativePath = `images/${image.sha256}.${extension}`;
    const absolutePath = join(outDir, relativePath);
    if (assets[assetId] === undefined) {
      writes.push(writeContentAddressed(absolutePath, image.sha256, image.bytes));
      assets[assetId] = {
        kind: 'image',
        format: extension,
        path: relativePath,
        checksum: image.sha256,
        mimeType: image.mimeType,
        bytes: image.bytes.byteLength,
      };
    }
    usages.push({
      nodeId: entry.nodeId,
      nodeName: entry.nodeName,
      kind: 'image',
      assetId,
      ...(entry.scaleMode === undefined ? {} : { scaleMode: entry.scaleMode }),
      ...(entry.imageTransform === undefined ? {} : { imageTransform: entry.imageTransform }),
      ...(entry.rotation === undefined ? {} : { rotation: entry.rotation }),
      ...(entry.filtersApplied === undefined ? {} : { filtersApplied: entry.filtersApplied }),
    });
  }

  await Promise.all(writes);

  const manifest: AssetManifest = {
    schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
    source: { provider: 'kiwi-browser', fileKey: options.fileKey, rootNodeId: options.root.id },
    generatedAt: new Date().toISOString(),
    assets,
    usages,
    missing,
  };
  const manifestPath = join(outDir, 'assets.manifest.json');
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifest };
};
