import { describe, expect, it } from 'vitest';

import { SceneGraphStore } from '../src/scenegraph.js';

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
});
