import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CapturedNetworkAssetStore } from '../src/network-assets.js';

describe('CapturedNetworkAssetStore', () => {
  it('indexes image bodies by the SHA-1 hash used by Kiwi and deduplicates bytes', () => {
    const store = new CapturedNetworkAssetStore();
    const bytes = Uint8Array.of(137, 80, 78, 71, 1, 2, 3);
    const payload = Buffer.from(bytes).toString('base64');
    const expectedHash = createHash('sha1').update(bytes).digest('hex');

    expect(
      store.ingest({
        url: 'https://www.figma.com/image/asset',
        mimeType: 'image/png',
        payload,
        base64Encoded: true,
      }),
    ).toMatchObject({ sha1: expectedHash, mimeType: 'image/png' });
    store.ingest({
      url: 'https://www.figma.com/image/again',
      mimeType: 'image/png',
      payload,
      base64Encoded: true,
    });

    expect(store.resolveHash(expectedHash)?.bytes).toEqual(bytes);
    expect(store.stats).toMatchObject({ received: 2, retained: 1, deduplicated: 1, rejected: 0 });
  });

  it('rejects non-images, malformed base64 and data outside configured budgets', () => {
    const store = new CapturedNetworkAssetStore({ maxAssetBytes: 3, maxTotalBytes: 3 });
    expect(
      store.ingest({
        url: 'https://www.figma.com/api/data',
        mimeType: 'application/json',
        payload: 'e30=',
        base64Encoded: true,
      }),
    ).toBeNull();
    expect(
      store.ingest({
        url: 'https://www.figma.com/image/bad',
        mimeType: 'image/png',
        payload: '***',
        base64Encoded: true,
      }),
    ).toBeNull();
    expect(
      store.ingest({
        url: 'https://www.figma.com/image/large',
        mimeType: 'image/png',
        payload: Buffer.from([1, 2, 3, 4]).toString('base64'),
        base64Encoded: true,
      }),
    ).toBeNull();
    expect(store.stats).toMatchObject({ received: 3, retained: 0, rejected: 3, bytes: 0 });
  });
});
