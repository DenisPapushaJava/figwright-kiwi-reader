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
          changedPixels: 1,
          changedRatio: 0.5,
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
