import { constants, zstdCompressSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { ZstdMessageStream } from '../src/zstd-message-stream.js';

describe('Zstandard message stream compatibility', () => {
  it.each([0, 1, 200, 600, 70_000])(
    'reads native frames with a checksum and %i bytes across transport boundaries',
    size => {
      const expected = Buffer.from(
        Array.from({ length: size }, (_, i) => (i * 131 + (i % 7)) & 255),
      );
      const compressed = zstdCompressSync(expected, {
        params: { [constants.ZSTD_c_checksumFlag]: 1 },
      });
      const stream = new ZstdMessageStream();
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < compressed.length; offset += 7) {
        chunks.push(stream.push(compressed.subarray(offset, offset + 7)));
        expect(stream.complete).toBe(offset + 7 >= compressed.length);
      }
      expect(Buffer.concat(chunks)).toEqual(expected);
    },
  );
});
