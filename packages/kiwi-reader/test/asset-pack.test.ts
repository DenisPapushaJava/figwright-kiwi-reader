import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ASSET_MANIFEST_SCHEMA_VERSION,
  collectDesignAssetInventory,
  saveVectorAssetPack,
} from '../src/asset-pack.js';
import { CapturedBlobStore } from '../src/blob-store.js';
import { CapturedNetworkAssetStore } from '../src/network-assets.js';
import type { CapturedNode } from '../src/scenegraph.js';

const squarePath = (): Uint8Array => {
  const bytes = new Uint8Array(1 + 8 + 1 + 8 + 1 + 8 + 1 + 8 + 1);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const point = (command: number, x: number, y: number): void => {
    bytes[offset++] = command;
    view.setFloat32(offset, x, true);
    offset += 4;
    view.setFloat32(offset, y, true);
    offset += 4;
  };
  point(1, 0, 0);
  point(2, 16, 0);
  point(2, 16, 16);
  point(2, 0, 16);
  bytes[offset] = 3;
  return bytes;
};

const fixture = (): { root: CapturedNode; blobs: CapturedBlobStore } => {
  const blobs = new CapturedBlobStore();
  const message = {
    blobs: [{ bytes: squarePath() }],
    nodeChanges: [
      {
        guid: { sessionID: 1, localID: 1 },
        name: 'Root',
        type: 'FRAME',
        size: { x: 100, y: 100 },
        fillPaints: [
          {
            type: 'IMAGE',
            image: { hash: Uint8Array.of(0xab, 0xcd) },
            scaleMode: 'FILL',
          },
        ],
      },
      {
        guid: { sessionID: 1, localID: 2 },
        name: 'First icon',
        type: 'VECTOR',
        size: { x: 16, y: 16 },
        fillGeometry: [{ commandsBlob: 0 }],
        fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
      },
      {
        guid: { sessionID: 1, localID: 3 },
        name: 'Same icon',
        type: 'VECTOR',
        size: { x: 16, y: 16 },
        fillGeometry: [{ commandsBlob: 0 }],
        fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
      },
    ],
  };
  blobs.captureMessage(message);
  const children = message.nodeChanges.slice(1).map((raw, index): CapturedNode => ({
    id: `1:${index + 2}`,
    name: raw.name,
    type: raw.type,
    visible: true,
    raw,
    children: [],
  }));
  return {
    blobs,
    root: {
      id: '1:1',
      name: 'Root',
      type: 'FRAME',
      visible: true,
      raw: message.nodeChanges[0] as CapturedNode['raw'],
      children,
    },
  };
};

describe('Kiwi asset pack', () => {
  it('reports vector availability and image references without embedding binary data', () => {
    const { root, blobs } = fixture();
    const inventory = collectDesignAssetInventory(root, blobs);

    expect(inventory.summary).toEqual({
      vectors: 2,
      exportableVectors: 2,
      images: 1,
      availableImages: 0,
    });
    expect(inventory.entries).toContainEqual({
      assetId: 'image:abcd',
      nodeId: '1:1',
      nodeName: 'Root',
      kind: 'image',
      available: false,
      imageHash: 'abcd',
      scaleMode: 'FILL',
      reason: 'IMAGE_BODY_UNAVAILABLE',
    });
    expect(JSON.stringify(inventory)).not.toContain('__bytes');
  });

  it('writes content-addressed vectors once and can safely replace its manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figwright-kiwi-assets-'));
    try {
      const { root, blobs } = fixture();
      const first = await saveVectorAssetPack({
        root,
        blobs,
        fileKey: 'fixture-file',
        outDir: directory,
      });
      const second = await saveVectorAssetPack({
        root,
        blobs,
        fileKey: 'fixture-file',
        outDir: directory,
      });

      expect(first.manifest.schemaVersion).toBe(ASSET_MANIFEST_SCHEMA_VERSION);
      expect(Object.keys(first.manifest.assets)).toHaveLength(1);
      expect(first.manifest.usages).toHaveLength(2);
      expect(first.manifest.missing).toEqual([
        {
          nodeId: '1:1',
          nodeName: 'Root',
          kind: 'image',
          reason: 'IMAGE_BODY_UNAVAILABLE',
          imageHash: 'abcd',
        },
      ]);
      expect(second.manifest.usages).toHaveLength(2);

      const [asset] = Object.values(first.manifest.assets);
      expect(asset).toBeDefined();
      await expect(stat(join(directory, asset?.path ?? 'missing'))).resolves.toMatchObject({
        size: expect.any(Number),
      });
      const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8')) as {
        schemaVersion?: string;
        assets?: unknown;
      };
      expect(manifest).toMatchObject({
        schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
        assets: expect.any(Object),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('matches Kiwi image hashes to captured network bodies and writes the raster once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figwright-kiwi-images-'));
    try {
      const { root, blobs } = fixture();
      const imageBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
      const imageHash = createHash('sha1').update(imageBytes).digest('hex');
      const paints = root.raw.fillPaints as Array<{ image: { hash: Uint8Array } }>;
      const imagePaint = paints[0];
      expect(imagePaint).toBeDefined();
      if (imagePaint === undefined) throw new Error('fixture image paint missing');
      imagePaint.image.hash = Uint8Array.from(Buffer.from(imageHash, 'hex'));
      const networkAssets = new CapturedNetworkAssetStore();
      networkAssets.ingest({
        url: 'https://www.figma.com/image/captured',
        mimeType: 'image/png',
        payload: Buffer.from(imageBytes).toString('base64'),
        base64Encoded: true,
      });

      const inventory = collectDesignAssetInventory(root, blobs, networkAssets);
      expect(inventory.summary).toMatchObject({ images: 1, availableImages: 1 });
      const saved = await saveVectorAssetPack({
        root,
        blobs,
        networkAssets,
        fileKey: 'fixture-file',
        outDir: directory,
      });

      expect(Object.keys(saved.manifest.assets)).toHaveLength(2);
      expect(saved.manifest.usages).toHaveLength(3);
      expect(saved.manifest.missing).toEqual([]);
      const raster = Object.values(saved.manifest.assets).find(asset => asset.kind === 'image');
      expect(raster).toMatchObject({ mimeType: 'image/png', bytes: imageBytes.byteLength });
      expect(await readFile(join(directory, raster?.path ?? 'missing'))).toEqual(
        Buffer.from(imageBytes),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
