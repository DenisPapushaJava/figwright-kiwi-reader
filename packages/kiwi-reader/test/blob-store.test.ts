import { describe, expect, it } from 'vitest';

import { CapturedBlobStore, capturedBlobRef } from '../src/blob-store.js';
import { SceneGraphStore } from '../src/scenegraph.js';

describe('CapturedBlobStore', () => {
  it('stabilizes message-local geometry refs before scenegraph updates are merged', () => {
    const blobs = new CapturedBlobStore();
    const graph = new SceneGraphStore();
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const initial = {
      blobs: [bytes],
      nodeChanges: [
        {
          guid: { sessionID: 7, localID: 9 },
          name: 'Icon',
          type: 'VECTOR',
          fillGeometry: [{ commandsBlob: 0, windingRule: 'NONZERO' }],
        },
      ],
    };

    blobs.captureMessage(initial);
    graph.apply(initial);
    graph.apply({
      nodeChanges: [{ guid: { sessionID: 7, localID: 9 }, opacity: 0.5 }],
    });

    const node = graph.find('7:9');
    const geometry = (node?.raw.fillGeometry as unknown[])?.[0];
    const ref = capturedBlobRef(geometry, 'commandsBlob');
    expect(ref).toMatch(/^sha256:/);
    expect(ref === null ? null : blobs.resolve(ref)).toEqual(bytes);
    expect(JSON.stringify(node?.raw)).not.toContain('sha256:');
  });

  it('deduplicates equal blobs and keeps references inside nested glyph data', () => {
    const blobs = new CapturedBlobStore();
    const bytes = Uint8Array.of(8, 6, 7, 5, 3, 0, 9);
    const message = {
      blobs: [bytes, bytes.slice()],
      nodeChanges: [
        {
          guid: { sessionID: 1, localID: 2 },
          derivedTextData: { glyphs: [{ commandsBlob: 1 }] },
        },
      ],
    };

    blobs.captureMessage(message);

    const glyph = message.nodeChanges[0]?.derivedTextData.glyphs[0];
    expect(capturedBlobRef(glyph, 'commandsBlob')).toMatch(/^sha256:/);
    expect(blobs.stats).toMatchObject({
      received: 2,
      retained: 1,
      deduplicated: 1,
      rejected: 0,
      unresolvedReferences: 0,
      bytes: bytes.byteLength,
    });
  });

  it('rejects blobs beyond its budgets and resets all session data', () => {
    const blobs = new CapturedBlobStore({ maxBlobBytes: 4, maxTotalBytes: 5, maxBlobs: 1 });
    const message = {
      blobs: [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6), Uint8Array.of(7, 8, 9, 10, 11)],
      nodeChanges: [
        {
          guid: { sessionID: 2, localID: 3 },
          fillGeometry: [{ commandsBlob: 1 }, { commandsBlob: 2 }, { commandsBlob: 99 }],
        },
      ],
    };

    blobs.captureMessage(message);

    expect(blobs.stats).toMatchObject({
      received: 3,
      retained: 1,
      rejected: 2,
      unresolvedReferences: 3,
      bytes: 3,
    });
    blobs.clear();
    expect(blobs.stats).toEqual({
      received: 0,
      retained: 0,
      deduplicated: 0,
      rejected: 0,
      unresolvedReferences: 0,
      bytes: 0,
    });
  });
});
