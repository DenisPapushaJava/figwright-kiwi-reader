import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { comparePngFiles, encodeRgbaPng } from '../src/png-diff.js';

describe('PNG pixel diff', () => {
  it('reports exact changed pixels, bounds and a reproducible heatmap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figwright-png-diff-'));
    try {
      const referencePath = join(directory, 'reference.png');
      const actualPath = join(directory, 'actual.png');
      const diffPath = join(directory, 'diff.png');
      const reference = Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]);
      const actual = Uint8Array.from([0, 0, 0, 255, 250, 255, 255, 255]);
      await Promise.all([
        writeFile(referencePath, encodeRgbaPng(2, 1, reference)),
        writeFile(actualPath, encodeRgbaPng(2, 1, actual)),
      ]);

      await expect(comparePngFiles({ referencePath, actualPath, diffPath })).resolves.toMatchObject(
        {
          width: 2,
          height: 1,
          comparedPixels: 2,
          ignoredPixels: 0,
          changedPixels: 1,
          changedRatio: 0.5,
          changedRatioOfTotal: 0.5,
          ignoreRegions: [],
          boundingBox: { x: 1, y: 0, width: 1, height: 1 },
        },
      );
      await expect(
        comparePngFiles({ referencePath, actualPath, diffPath, tolerance: 5 }),
      ).resolves.toMatchObject({ changedPixels: 0, boundingBox: null });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('excludes explicit dynamic regions and counts overlapping masks once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figwright-png-mask-'));
    try {
      const referencePath = join(directory, 'reference.png');
      const actualPath = join(directory, 'actual.png');
      const diffPath = join(directory, 'diff.png');
      const reference = new Uint8Array(3 * 2 * 4);
      const actual = reference.slice();
      for (const pixel of [0, 1, 2, 5]) actual.set([255, 255, 255, 255], pixel * 4);
      await Promise.all([
        writeFile(referencePath, encodeRgbaPng(3, 2, reference)),
        writeFile(actualPath, encodeRgbaPng(3, 2, actual)),
      ]);

      await expect(
        comparePngFiles({
          referencePath,
          actualPath,
          diffPath,
          ignoreRegions: [
            { x: 0, y: 0, width: 2, height: 1 },
            { x: 1, y: 0, width: 5, height: 1 },
          ],
        }),
      ).resolves.toMatchObject({
        totalPixels: 6,
        comparedPixels: 3,
        ignoredPixels: 3,
        changedPixels: 1,
        changedRatio: 1 / 3,
        changedRatioOfTotal: 1 / 6,
        ignoreRegions: [
          { x: 0, y: 0, width: 2, height: 1 },
          { x: 1, y: 0, width: 2, height: 1 },
        ],
        boundingBox: { x: 2, y: 1, width: 1, height: 1 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a zero ratio when every pixel is ignored', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figwright-png-full-mask-'));
    try {
      const referencePath = join(directory, 'reference.png');
      const actualPath = join(directory, 'actual.png');
      const diffPath = join(directory, 'diff.png');
      await Promise.all([
        writeFile(referencePath, encodeRgbaPng(1, 1, Uint8Array.from([0, 0, 0, 255]))),
        writeFile(actualPath, encodeRgbaPng(1, 1, Uint8Array.from([255, 255, 255, 255]))),
      ]);

      await expect(
        comparePngFiles({
          referencePath,
          actualPath,
          diffPath,
          ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1 }],
        }),
      ).resolves.toMatchObject({
        comparedPixels: 0,
        ignoredPixels: 1,
        changedPixels: 0,
        changedRatio: 0,
        changedRatioOfTotal: 0,
        boundingBox: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid ignore-region geometry in direct calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figwright-png-invalid-mask-'));
    try {
      const referencePath = join(directory, 'reference.png');
      const actualPath = join(directory, 'actual.png');
      const png = encodeRgbaPng(1, 1, Uint8Array.from([0, 0, 0, 255]));
      await Promise.all([writeFile(referencePath, png), writeFile(actualPath, png)]);

      await expect(
        comparePngFiles({
          referencePath,
          actualPath,
          diffPath: join(directory, 'diff.png'),
          ignoreRegions: [{ x: 0, y: 0, width: 0, height: 1 }],
        }),
      ).rejects.toThrow(/ignore regions/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses mismatched dimensions instead of comparing shifted pixels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figwright-png-size-'));
    try {
      const referencePath = join(directory, 'reference.png');
      const actualPath = join(directory, 'actual.png');
      await Promise.all([
        writeFile(referencePath, encodeRgbaPng(1, 1, Uint8Array.from([0, 0, 0, 255]))),
        writeFile(actualPath, encodeRgbaPng(2, 1, new Uint8Array(8))),
      ]);
      await expect(
        comparePngFiles({ referencePath, actualPath, diffPath: join(directory, 'diff.png') }),
      ).rejects.toThrow(/dimensions differ/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
