import { describe, expect, it } from 'vitest';

import { NormalizedNodeCache } from '../src/normalized-node-cache.js';
import { SceneGraphStore } from '../src/scenegraph.js';

describe('NormalizedNodeCache', () => {
  it('reuses a bounded normalized subtree until the scenegraph changes', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 1, localID: 1 }, name: 'Root', type: 'FRAME' },
        {
          guid: { sessionID: 1, localID: 2 },
          parentIndex: { guid: { sessionID: 1, localID: 1 }, position: 'a' },
          name: 'Before',
          type: 'TEXT',
          textData: { characters: 'Before' },
        },
      ],
    });
    const cache = new NormalizedNodeCache();

    const first = cache.read(graph, '1:1', 8, 2_000);
    const firstNormalized = cache.normalize(first);
    const second = cache.read(graph, '1:1', 8, 2_000);

    expect(second).toBe(first);
    expect(cache.normalize(second)).toBe(firstNormalized);
    expect(cache.stats).toEqual({
      entries: 1,
      hits: 1,
      misses: 1,
      invalidations: 0,
      evictions: 0,
      normalizations: 1,
    });

    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 1, localID: 2 },
          name: 'After',
          textData: { characters: 'After' },
        },
      ],
    });
    const updated = cache.read(graph, '1:1', 8, 2_000);

    expect(updated).not.toBe(first);
    expect(cache.normalize(updated)?.children?.[0]).toMatchObject({
      name: 'After',
      characters: 'After',
    });
    expect(cache.stats).toMatchObject({
      entries: 1,
      hits: 1,
      misses: 2,
      invalidations: 1,
      normalizations: 2,
    });
  });

  it('evicts the least-recently-used query when its entry bound is reached', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 2, localID: 1 }, name: 'One' },
        { guid: { sessionID: 2, localID: 2 }, name: 'Two' },
        { guid: { sessionID: 2, localID: 3 }, name: 'Three' },
      ],
    });
    const cache = new NormalizedNodeCache(2);

    cache.read(graph, '2:1', 8, 2_000);
    cache.read(graph, '2:2', 8, 2_000);
    cache.read(graph, '2:1', 8, 2_000);
    cache.read(graph, '2:3', 8, 2_000);
    cache.read(graph, '2:2', 8, 2_000);

    expect(cache.stats).toMatchObject({ entries: 2, hits: 1, misses: 4, evictions: 2 });
  });
});
