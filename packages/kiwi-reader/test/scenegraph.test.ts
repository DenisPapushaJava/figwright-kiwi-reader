import { describe, expect, it } from 'vitest';

import { normalizeCapturedNode } from '../src/normalize.js';
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

  it('expands a component master and applies explicit and derived instance overrides', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: { sessionID: 10, localID: 1 },
          name: 'Screen title',
          type: 'SYMBOL',
          key: 'screen-title-key',
        },
        {
          guid: { sessionID: 10, localID: 2 },
          parentIndex: { guid: { sessionID: 10, localID: 1 }, position: 'a' },
          overrideKey: { sessionID: 90, localID: 2 },
          name: 'Project name',
          type: 'TEXT',
          size: { x: 180, y: 20 },
          textData: { characters: 'Default project' },
          fontSize: 14,
        },
        {
          guid: { sessionID: 20, localID: 1 },
          name: 'Screen title',
          type: 'INSTANCE',
          symbolData: {
            symbolID: { sessionID: 10, localID: 1 },
            symbolOverrides: [
              {
                guidPath: { guids: [{ sessionID: 90, localID: 2 }] },
                textData: { characters: 'Кировский механический завод' },
              },
            ],
          },
          derivedSymbolData: [
            {
              guidPath: { guids: [{ sessionID: 90, localID: 2 }] },
              size: { x: 240, y: 24 },
              fontSize: 16,
            },
          ],
        },
      ],
    });

    const result = graph.findWithStats('20:1');
    expect(result).toMatchObject({
      visited: 2,
      resolvedInstances: 1,
      unresolvedInstances: 0,
      instanceCycles: 0,
    });
    expect(result.node).toMatchObject({
      id: '20:1',
      mainComponent: { id: '10:1', name: 'Screen title', key: 'screen-title-key' },
      children: [
        {
          id: '20:1/10:2',
          resolvedParentId: '20:1',
          raw: {
            textData: { characters: 'Кировский механический завод' },
            size: { x: 240, y: 24 },
            fontSize: 16,
          },
        },
      ],
    });

    expect(result.node === null ? null : normalizeCapturedNode(result.node)).toMatchObject({
      id: '20:1',
      mainComponent: { id: '10:1', name: 'Screen title', key: 'screen-title-key' },
      children: [
        {
          id: '20:1/10:2',
          parentId: '20:1',
          characters: 'Кировский механический завод',
          width: 240,
          height: 24,
          fontSize: 16,
        },
      ],
    });
  });

  it('resolves component text properties and nested guid-path overrides', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 30, localID: 1 }, name: 'Breadcrumb', type: 'SYMBOL' },
        {
          guid: { sessionID: 30, localID: 2 },
          parentIndex: { guid: { sessionID: 30, localID: 1 } },
          overrideKey: { sessionID: 300, localID: 2 },
          name: 'Section',
          type: 'TEXT',
          textData: { characters: 'Default section' },
          componentPropRefs: [
            {
              defID: { sessionID: 500, localID: 1 },
              componentPropNodeField: 'TEXT_DATA',
            },
          ],
        },
        { guid: { sessionID: 31, localID: 1 }, name: 'Header', type: 'SYMBOL' },
        {
          guid: { sessionID: 31, localID: 2 },
          parentIndex: { guid: { sessionID: 31, localID: 1 } },
          overrideKey: { sessionID: 310, localID: 2 },
          name: 'Breadcrumb',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 30, localID: 1 } },
          componentPropAssignments: [
            {
              defID: { sessionID: 500, localID: 1 },
              value: { textValue: { characters: 'Безопасность' } },
            },
          ],
        },
        {
          guid: { sessionID: 40, localID: 1 },
          name: 'Header',
          type: 'INSTANCE',
          symbolData: {
            symbolID: { sessionID: 31, localID: 1 },
            symbolOverrides: [
              {
                guidPath: {
                  guids: [
                    { sessionID: 310, localID: 2 },
                    { sessionID: 300, localID: 2 },
                  ],
                },
                textData: { characters: 'Производственная безопасность' },
              },
            ],
          },
        },
      ],
    });

    const result = graph.findWithStats('40:1');
    expect(result).toMatchObject({ resolvedInstances: 2, unresolvedInstances: 0 });
    expect(result.node?.children[0]).toMatchObject({
      id: '40:1/31:2',
      mainComponent: { id: '30:1', name: 'Breadcrumb' },
      children: [
        {
          id: '40:1/31:2/30:2',
          raw: { textData: { characters: 'Производственная безопасность' } },
        },
      ],
    });

    const directBreadcrumb = graph.findWithStats('31:2');
    expect(directBreadcrumb.node?.children[0]?.raw).toMatchObject({
      textData: { characters: 'Безопасность' },
    });
  });

  it('carries exposed text-property assignments through nested instances', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 70, localID: 1 }, name: 'Button', type: 'SYMBOL' },
        {
          guid: { sessionID: 70, localID: 2 },
          parentIndex: { guid: { sessionID: 70, localID: 1 } },
          overrideKey: { sessionID: 700, localID: 2 },
          name: 'Label',
          type: 'TEXT',
          textData: { characters: 'Default action' },
          componentPropRefs: [
            {
              defID: { sessionID: 700, localID: 1 },
              componentPropNodeField: 'TEXT_DATA',
            },
          ],
        },
        { guid: { sessionID: 71, localID: 1 }, name: 'Footer', type: 'SYMBOL' },
        {
          guid: { sessionID: 71, localID: 2 },
          parentIndex: { guid: { sessionID: 71, localID: 1 } },
          overrideKey: { sessionID: 710, localID: 2 },
          name: 'Primary action',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 70, localID: 1 } },
          componentPropAssignments: [
            {
              defID: { sessionID: 700, localID: 1 },
              value: { textValue: { characters: 'Component default' } },
            },
          ],
        },
        {
          guid: { sessionID: 72, localID: 1 },
          name: 'Placed footer',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 71, localID: 1 } },
          componentPropAssignments: [
            {
              defID: { sessionID: 700, localID: 1 },
              value: { textValue: { characters: 'Сформировать отчёт' } },
            },
          ],
        },
        {
          guid: { sessionID: 72, localID: 2 },
          name: 'Placed footer with explicit override',
          type: 'INSTANCE',
          symbolData: {
            symbolID: { sessionID: 71, localID: 1 },
            symbolOverrides: [
              {
                guidPath: {
                  guids: [
                    { sessionID: 710, localID: 2 },
                    { sessionID: 700, localID: 2 },
                  ],
                },
                textData: { characters: 'Явный override' },
              },
            ],
          },
          componentPropAssignments: [
            {
              defID: { sessionID: 700, localID: 1 },
              value: { textValue: { characters: 'Значение свойства' } },
            },
          ],
        },
      ],
    });

    const result = graph.findWithStats('72:1');
    expect(result).toMatchObject({ resolvedInstances: 2, unresolvedInstances: 0 });
    expect(result.node?.children[0]?.children[0]?.raw).toMatchObject({
      textData: { characters: 'Сформировать отчёт' },
    });

    const componentDefault = graph.findWithStats('71:2');
    expect(componentDefault.node?.children[0]?.raw).toMatchObject({
      textData: { characters: 'Component default' },
    });

    const explicit = graph.findWithStats('72:2');
    expect(explicit.node?.children[0]?.children[0]?.raw).toMatchObject({
      textData: { characters: 'Явный override' },
    });
  });

  it('keeps placed-instance overrides ahead of nested component defaults', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 80, localID: 1 }, name: 'Button', type: 'SYMBOL' },
        {
          guid: { sessionID: 80, localID: 2 },
          parentIndex: { guid: { sessionID: 80, localID: 1 } },
          overrideKey: { sessionID: 800, localID: 2 },
          name: 'Label',
          type: 'TEXT',
          textData: { characters: 'Button master' },
        },
        { guid: { sessionID: 81, localID: 1 }, name: 'Footer', type: 'SYMBOL' },
        {
          guid: { sessionID: 81, localID: 2 },
          parentIndex: { guid: { sessionID: 81, localID: 1 } },
          overrideKey: { sessionID: 810, localID: 2 },
          name: 'Secondary action',
          type: 'INSTANCE',
          symbolData: {
            symbolID: { sessionID: 80, localID: 1 },
            symbolOverrides: [
              {
                guidPath: { guids: [{ sessionID: 800, localID: 2 }] },
                textData: { characters: 'Nested component default' },
              },
            ],
          },
        },
        {
          guid: { sessionID: 82, localID: 1 },
          name: 'Placed footer',
          type: 'INSTANCE',
          symbolData: {
            symbolID: { sessionID: 81, localID: 1 },
            symbolOverrides: [
              {
                guidPath: {
                  guids: [
                    { sessionID: 810, localID: 2 },
                    { sessionID: 800, localID: 2 },
                  ],
                },
                textData: { characters: 'Отмена' },
              },
            ],
          },
        },
      ],
    });

    const placed = graph.findWithStats('82:1');
    expect(placed).toMatchObject({ resolvedInstances: 2, unresolvedInstances: 0 });
    expect(placed.node?.children[0]?.children[0]?.raw).toMatchObject({
      textData: { characters: 'Отмена' },
    });

    const nestedDefault = graph.findWithStats('81:2');
    expect(nestedDefault.node?.children[0]?.raw).toMatchObject({
      textData: { characters: 'Nested component default' },
    });
  });

  it('bounds recursive component expansion and reports missing masters', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: { sessionID: 60, localID: 1 }, name: 'Recursive', type: 'SYMBOL' },
        {
          guid: { sessionID: 60, localID: 2 },
          parentIndex: { guid: { sessionID: 60, localID: 1 } },
          name: 'Recursive child',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 60, localID: 1 } },
        },
        {
          guid: { sessionID: 61, localID: 1 },
          name: 'Placed recursive',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 60, localID: 1 } },
        },
        {
          guid: { sessionID: 61, localID: 2 },
          name: 'Missing',
          type: 'INSTANCE',
          symbolData: { symbolID: { sessionID: 999, localID: 1 } },
        },
      ],
    });

    expect(graph.findWithStats('61:1')).toMatchObject({
      resolvedInstances: 1,
      unresolvedInstances: 1,
      instanceCycles: 1,
      node: { children: [{ children: [] }] },
    });
    expect(graph.findWithStats('61:2')).toMatchObject({
      resolvedInstances: 0,
      unresolvedInstances: 1,
      instanceCycles: 0,
      node: { children: [] },
    });
    expect(graph.findWithStats('61:1', 10, 1)).toMatchObject({
      visited: 1,
      nodeLimitReached: true,
    });
  });
});
