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

  it('retains an unrelated subtree across incremental updates', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 3, localID: 1 }, name: 'Left root', type: 'FRAME' },
        {
          guid: { sessionID: 3, localID: 2 },
          parentIndex: { guid: { sessionID: 3, localID: 1 } },
          name: 'Left child',
        },
        { guid: { sessionID: 4, localID: 1 }, name: 'Right root', type: 'FRAME' },
        {
          guid: { sessionID: 4, localID: 2 },
          parentIndex: { guid: { sessionID: 4, localID: 1 } },
          name: 'Right child',
        },
      ],
    });
    const cache = new NormalizedNodeCache();
    const left = cache.read(graph, '3:1', 8, 2_000);
    const right = cache.read(graph, '4:1', 8, 2_000);

    graph.apply({
      nodeChanges: [{ guid: { sessionID: 3, localID: 2 }, name: 'Updated left child' }],
    });

    expect(cache.read(graph, '4:1', 8, 2_000)).toBe(right);
    expect(cache.read(graph, '3:1', 8, 2_000)).not.toBe(left);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 3, invalidations: 1 });
  });

  it('invalidates an instance when its external master subtree changes', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 10, localID: 1 }, name: 'Card', type: 'SYMBOL' },
        {
          guid: { sessionID: 10, localID: 2 },
          parentIndex: { guid: { sessionID: 10, localID: 1 } },
          name: 'Label',
          type: 'TEXT',
          textData: { characters: 'Before' },
        },
        {
          guid: { sessionID: 20, localID: 1 },
          name: 'Card instance',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 10, localID: 1 } },
        },
        { guid: { sessionID: 30, localID: 1 }, name: 'Unrelated' },
      ],
    });
    const cache = new NormalizedNodeCache();
    const first = cache.read(graph, '20:1', 8, 2_000);
    expect(cache.normalize(first)?.children?.[0]?.characters).toBe('Before');

    graph.apply({ nodeChanges: [{ guid: { sessionID: 30, localID: 1 }, name: 'Changed' }] });
    expect(cache.read(graph, '20:1', 8, 2_000)).toBe(first);

    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 10, localID: 2 },
          textData: { characters: 'After' },
        },
      ],
    });
    const updated = cache.read(graph, '20:1', 8, 2_000);

    expect(updated).not.toBe(first);
    expect(cache.normalize(updated)?.children?.[0]?.characters).toBe('After');
    expect(cache.stats).toMatchObject({ hits: 1, misses: 2, invalidations: 1 });
  });

  it('invalidates an unresolved instance when its missing master arrives', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 60, localID: 1 },
          name: 'Late instance',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 61, localID: 1 } },
        },
      ],
    });
    const cache = new NormalizedNodeCache();
    const unresolved = cache.read(graph, '60:1', 8, 2_000);
    expect(unresolved.result.unresolvedInstances).toBe(1);

    graph.apply({
      nodeChanges: [{ guid: { sessionID: 61, localID: 1 }, name: 'Late master', type: 'SYMBOL' }],
    });
    const resolved = cache.read(graph, '60:1', 8, 2_000);

    expect(resolved).not.toBe(unresolved);
    expect(resolved.result.resolvedInstances).toBe(1);
    expect(cache.stats).toMatchObject({ misses: 2, invalidations: 1 });
  });

  it('invalidates an instance when its missing component set arrives', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 65, localID: 2 },
          parentIndex: { guid: { sessionID: 65, localID: 1 } },
          name: 'Size=M',
          type: 'SYMBOL',
          variantPropSpecs: [{ value: 'M' }],
        },
        {
          guid: { sessionID: 66, localID: 1 },
          name: 'Button instance',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 65, localID: 2 } },
        },
      ],
    });
    const cache = new NormalizedNodeCache();
    const withoutSet = cache.read(graph, '66:1', 8, 2_000);
    expect(withoutSet.result.node?.mainComponent?.componentSetId).toBeUndefined();

    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 65, localID: 1 },
          name: 'Button',
          type: 'SYMBOL_SET',
          componentKey: 'button-set-key',
        },
      ],
    });
    const withSet = cache.read(graph, '66:1', 8, 2_000);

    expect(withSet).not.toBe(withoutSet);
    expect(withSet.result.node?.mainComponent).toMatchObject({
      componentSetId: '65:1',
      componentSetName: 'Button',
    });
    expect(cache.stats).toMatchObject({ misses: 2, invalidations: 1 });
  });

  it('invalidates a node when its missing parent layout context arrives', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 70, localID: 2 },
          parentIndex: { guid: { sessionID: 70, localID: 1 } },
          name: 'Child',
          stackPrimarySizing: 'HUG',
        },
      ],
    });
    const cache = new NormalizedNodeCache();
    const withoutParent = cache.read(graph, '70:2', 8, 2_000);
    expect(cache.normalize(withoutParent)?.layoutSizingVertical).toBeUndefined();

    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 70, localID: 1 },
          name: 'Parent',
          type: 'FRAME',
          stackMode: 'VERTICAL',
        },
      ],
    });
    const withParent = cache.read(graph, '70:2', 8, 2_000);

    expect(withParent).not.toBe(withoutParent);
    expect(cache.normalize(withParent)?.layoutSizingVertical).toBe('HUG');
    expect(cache.stats).toMatchObject({ misses: 2, invalidations: 1 });
  });

  it('invalidates both ancestor chains when a node is reparented', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 50, localID: 1 }, name: 'Old parent', type: 'FRAME' },
        { guid: { sessionID: 51, localID: 1 }, name: 'New parent', type: 'FRAME' },
        {
          guid: { sessionID: 50, localID: 2 },
          parentIndex: { guid: { sessionID: 50, localID: 1 } },
          name: 'Moving child',
        },
      ],
    });
    const cache = new NormalizedNodeCache();
    const oldParent = cache.read(graph, '50:1', 8, 2_000);
    const newParent = cache.read(graph, '51:1', 8, 2_000);

    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 50, localID: 2 },
          parentIndex: { guid: { sessionID: 51, localID: 1 } },
        },
      ],
    });

    const updatedOldParent = cache.read(graph, '50:1', 8, 2_000);
    const updatedNewParent = cache.read(graph, '51:1', 8, 2_000);
    expect(updatedOldParent).not.toBe(oldParent);
    expect(updatedNewParent).not.toBe(newParent);
    expect(updatedOldParent.result.node?.children).toEqual([]);
    expect(updatedNewParent.result.node?.children).toHaveLength(1);
    expect(cache.stats).toMatchObject({ misses: 4, invalidations: 2 });
  });

  it('falls back to conservative invalidation after bounded change history is exhausted', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 40, localID: 1 }, name: 'Cached' },
        { guid: { sessionID: 41, localID: 1 }, name: 'Changing' },
      ],
    });
    const cache = new NormalizedNodeCache();
    const first = cache.read(graph, '40:1', 8, 2_000);

    for (let index = 0; index < 257; index++) {
      graph.apply({
        nodeChanges: [{ guid: { sessionID: 41, localID: 1 }, name: `Changing ${index}` }],
      });
    }

    expect(cache.read(graph, '40:1', 8, 2_000)).not.toBe(first);
    expect(cache.stats).toMatchObject({ hits: 0, misses: 2, invalidations: 1 });
  });
});
