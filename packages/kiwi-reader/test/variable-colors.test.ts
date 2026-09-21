import { describe, expect, it } from 'vitest';

import { normalizeCapturedNode } from '../src/normalize.js';
import { NormalizedNodeCache } from '../src/normalized-node-cache.js';
import { SceneGraphStore } from '../src/scenegraph.js';

const guid = (sessionID: number, localID: number) => ({ sessionID, localID });

const colorVariableFixture = () =>
  [
    {
      guid: guid(90, 1),
      name: 'UI 2.0/Indicator/Red',
      key: 'indicator-set',
      type: 'VARIABLE_SET',
      variableSetModes: [
        { id: guid(91, 1), name: 'Light' },
        { id: guid(91, 2), name: 'Dark' },
      ],
    },
    {
      guid: guid(92, 1),
      name: 'UI 2.0/Indicator/Red',
      key: 'indicator-red',
      type: 'VARIABLE',
      variableSetID: { guid: guid(90, 1), assetRef: { key: 'indicator-set' } },
      variableResolvedType: 'COLOR',
      variableDataValues: {
        entries: [
          {
            modeID: guid(91, 1),
            variableData: { value: { colorValue: { r: 0.847, g: 0.125, b: 0.125, a: 1 } } },
          },
          {
            modeID: guid(91, 2),
            variableData: { value: { colorValue: { r: 1, g: 0.4, b: 0.4, a: 1 } } },
          },
        ],
      },
    },
  ] as const;

describe('Kiwi color variable resolution', () => {
  it('uses the inherited collection mode instead of the static paint fallback', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        ...colorVariableFixture(),
        {
          guid: guid(1, 1),
          name: 'Light screen',
          type: 'FRAME',
          variableModeBySetMap: {
            entries: [
              {
                variableSetID: { assetRef: { key: 'indicator-set' } },
                variableModeID: guid(91, 1),
              },
            ],
          },
        },
        {
          guid: guid(1, 2),
          parentIndex: { guid: guid(1, 1) },
          name: 'Danger button',
          type: 'FRAME',
          fillPaints: [
            {
              type: 'SOLID',
              color: { r: 0, g: 0.4667, b: 1, a: 1 },
              colorVar: { value: { alias: { guid: guid(92, 1) } } },
            },
          ],
        },
      ],
    });

    const result = graph.findWithStats('1:2');
    const normalized = normalizeCapturedNode(result.node!);

    expect(normalized.fills).toEqual([
      {
        type: 'SOLID',
        visible: true,
        opacity: 1,
        color: { r: 0.847, g: 0.125, b: 0.125 },
        boundVariables: { color: 'VariableID:92:1' },
      },
    ]);
    expect(result).toMatchObject({
      variableColorBindings: 1,
      resolvedVariableColors: 1,
      unresolvedVariableColors: 0,
      variableModeFallbacks: 0,
      variables: {
        'VariableID:92:1': { name: 'UI 2.0/Indicator/Red', type: 'COLOR' },
      },
    });
  });

  it('resolves aliases and applies the default collection mode when none is explicit', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        ...colorVariableFixture(),
        {
          guid: guid(92, 2),
          name: 'Semantic/Danger',
          type: 'VARIABLE',
          variableSetID: { guid: guid(90, 1) },
          variableResolvedType: 'COLOR',
          variableDataValues: {
            entries: [
              {
                modeID: guid(91, 1),
                variableData: { value: { alias: { assetRef: { key: 'indicator-red' } } } },
              },
            ],
          },
        },
        {
          guid: guid(2, 1),
          name: 'Danger button',
          type: 'FRAME',
          fillPaints: [
            {
              type: 'SOLID',
              color: { r: 0, g: 0.4667, b: 1, a: 1 },
              colorVar: { value: { alias: { guid: guid(92, 2) } } },
            },
          ],
        },
      ],
    });

    const result = graph.findWithStats('2:1');
    const normalized = normalizeCapturedNode(result.node!);

    expect(normalized.fills?.[0]).toMatchObject({
      color: { r: 0.847, g: 0.125, b: 0.125 },
      boundVariables: { color: 'VariableID:92:2' },
    });
    expect(result.variableModeFallbacks).toBe(2);
  });

  it('resolves bound gradient stops and effect colors from the same mode', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        ...colorVariableFixture(),
        {
          guid: guid(5, 1),
          name: 'Variable visuals',
          type: 'FRAME',
          fillPaints: [
            {
              type: 'GRADIENT_LINEAR',
              transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
              stopsVar: [
                {
                  position: 0,
                  color: { r: 0, g: 0.4667, b: 1, a: 1 },
                  colorVar: { value: { alias: { guid: guid(92, 1) } } },
                },
                { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
              ],
            },
          ],
          effects: [
            {
              type: 'DROP_SHADOW',
              visible: true,
              radius: 4,
              color: { r: 0, g: 0.4667, b: 1, a: 0.2 },
              colorVar: { value: { alias: { guid: guid(92, 1) } } },
            },
          ],
        },
      ],
    });

    const result = graph.findWithStats('5:1');
    const normalized = normalizeCapturedNode(result.node!);

    expect(normalized.fills?.[0]).toMatchObject({
      gradientStops: [
        {
          color: { r: 0.847, g: 0.125, b: 0.125, a: 1 },
          boundVariables: { color: 'VariableID:92:1' },
        },
        { color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    });
    expect(normalized.effects?.[0]).toMatchObject({
      color: { r: 0.847, g: 0.125, b: 0.125, a: 1 },
      boundVariables: { color: 'VariableID:92:1' },
    });
    expect(result).toMatchObject({
      variableColorBindings: 2,
      resolvedVariableColors: 2,
      unresolvedVariableColors: 0,
    });
  });

  it('keeps the static fallback and reports an unresolved or cyclic alias', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: guid(93, 1),
          name: 'Cycle A',
          type: 'VARIABLE',
          variableData: { value: { alias: { guid: guid(93, 2) } } },
        },
        {
          guid: guid(93, 2),
          name: 'Cycle B',
          type: 'VARIABLE',
          variableData: { value: { alias: { guid: guid(93, 1) } } },
        },
        {
          guid: guid(3, 1),
          name: 'Fallback button',
          type: 'FRAME',
          fillPaints: [
            {
              type: 'SOLID',
              color: { r: 0, g: 0.4667, b: 1, a: 1 },
              colorVar: { value: { alias: { guid: guid(93, 1) } } },
            },
          ],
        },
      ],
    });

    const result = graph.findWithStats('3:1');
    expect(normalizeCapturedNode(result.node!).fills?.[0]).toMatchObject({
      color: { r: 0, g: 0.4667, b: 1 },
      boundVariables: { color: 'VariableID:93:1' },
    });
    expect(result).toMatchObject({
      variableColorBindings: 1,
      resolvedVariableColors: 0,
      unresolvedVariableColors: 1,
    });
  });

  it('invalidates a cached fallback when the referenced variable arrives later', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: guid(4, 1),
          name: 'Late token button',
          type: 'FRAME',
          fillPaints: [
            {
              type: 'SOLID',
              color: { r: 0, g: 0.4667, b: 1, a: 1 },
              colorVar: { value: { alias: { guid: guid(92, 1) } } },
            },
          ],
        },
      ],
    });
    const cache = new NormalizedNodeCache();
    const fallback = cache.read(graph, '4:1', 8, 2_000);
    expect(cache.normalize(fallback)?.fills?.[0]).toMatchObject({
      color: { r: 0, g: 0.4667, b: 1 },
    });

    graph.apply({ nodeChanges: [...colorVariableFixture()] });
    const resolved = cache.read(graph, '4:1', 8, 2_000);

    expect(resolved).not.toBe(fallback);
    expect(cache.normalize(resolved)?.fills?.[0]).toMatchObject({
      color: { r: 0.847, g: 0.125, b: 0.125 },
    });
    expect(cache.stats).toMatchObject({ misses: 2, invalidations: 1 });
  });
});
