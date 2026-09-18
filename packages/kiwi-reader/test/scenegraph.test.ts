import { describe, expect, it } from 'vitest';

import { SceneGraphLimitError, SceneGraphStore } from '../src/scenegraph.js';

describe('SceneGraphStore', () => {
  it('merges node changes and builds an ordered subtree', () => {
    const graph = new SceneGraphStore();
    expect(
      graph.apply({
        nodeChanges: [
          { guid: { sessionID: 1, localID: 1 }, name: 'Root', type: 'FRAME' },
          {
            guid: { sessionID: 1, localID: 3 },
            parentIndex: { guid: { sessionID: 1, localID: 1 }, position: 'b' },
            name: 'Second',
            type: 'TEXT',
          },
          {
            guid: { sessionID: 1, localID: 2 },
            parentIndex: { guid: { sessionID: 1, localID: 1 }, position: 'a' },
            name: 'First',
            type: 'RECTANGLE',
          },
        ],
      }),
    ).toBe(3);

    const root = graph.find('1-1');
    expect(root?.children.map(child => child.name)).toEqual(['First', 'Second']);
  });

  it('uses deterministic code-point ordering and exposes the parent stack direction', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 5, localID: 1 },
          name: 'Root',
          type: 'FRAME',
          stackMode: 'VERTICAL',
        },
        {
          guid: { sessionID: 5, localID: 2 },
          parentIndex: { guid: { sessionID: 5, localID: 1 }, position: 'a' },
          name: 'Lowercase',
        },
        {
          guid: { sessionID: 5, localID: 3 },
          parentIndex: { guid: { sessionID: 5, localID: 1 }, position: 'B' },
          name: 'Uppercase',
        },
      ],
    });

    const root = graph.find('5:1');
    expect(root?.children.map(child => child.name)).toEqual(['Uppercase', 'Lowercase']);
    expect(root?.children.map(child => child.parentStackMode)).toEqual(['VERTICAL', 'VERTICAL']);
  });

  it('applies partial updates and removals', () => {
    const graph = new SceneGraphStore();
    graph.apply({ nodeChanges: [{ guid: { sessionID: 2, localID: 4 }, name: 'Before' }] });
    graph.apply({ nodeChanges: [{ guid: { sessionID: 2, localID: 4 }, visible: false }] });
    expect(graph.find('2:4')).toMatchObject({ name: 'Before', visible: false });

    graph.apply({
      nodeChanges: [{ guid: { sessionID: 2, localID: 4 }, phase: 'REMOVED' }],
    });
    expect(graph.find('2:4')).toBeNull();
  });

  it('rejects an oversized update before partially mutating the graph', () => {
    const graph = new SceneGraphStore(2);
    expect(() =>
      graph.apply({
        nodeChanges: [
          { guid: { sessionID: 8, localID: 1 }, name: 'One' },
          { guid: { sessionID: 8, localID: 2 }, name: 'Two' },
          { guid: { sessionID: 8, localID: 3 }, name: 'Three' },
        ],
      }),
    ).toThrow(SceneGraphLimitError);
    expect(graph.size).toBe(0);
  });

  it('reports depth and node truncation instead of silently dropping descendants', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 4, localID: 1 }, name: 'Root' },
        {
          guid: { sessionID: 4, localID: 2 },
          parentIndex: { guid: { sessionID: 4, localID: 1 } },
          name: 'Child',
        },
        {
          guid: { sessionID: 4, localID: 3 },
          parentIndex: { guid: { sessionID: 4, localID: 2 } },
          name: 'Grandchild',
        },
      ],
    });

    expect(graph.findWithStats('4:1', 0, 10)).toMatchObject({
      visited: 1,
      depthLimitReached: true,
      nodeLimitReached: false,
    });
    expect(graph.findWithStats('4:1', 10, 2)).toMatchObject({
      visited: 2,
      depthLimitReached: false,
      nodeLimitReached: true,
    });
  });
});
