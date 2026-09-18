import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FIGWRIGHT_KIWI_EXTENSION_ID,
  FIGWRIGHT_KIWI_EXTENSION_ORIGIN,
} from '../src/capture-server.js';

describe('Kiwi extension identity', () => {
  it('pins the capture server origin to the ID derived from the manifest public key', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'extension', 'manifest.json'), 'utf8'),
    ) as { key: string };
    const digest = createHash('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest()
      .subarray(0, 16);
    const id = [...digest]
      .flatMap(byte => [byte >> 4, byte & 15])
      .map(value => String.fromCharCode(97 + value))
      .join('');

    expect(id).toBe(FIGWRIGHT_KIWI_EXTENSION_ID);
    expect(FIGWRIGHT_KIWI_EXTENSION_ORIGIN).toBe(`chrome-extension://${id}`);
  });
});
