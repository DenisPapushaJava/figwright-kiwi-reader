import { describe, expect, it } from 'vitest';

import { normalizeCapturedNode } from '../src/normalize.js';
import { NormalizedNodeCache } from '../src/normalized-node-cache.js';
import { SceneGraphStore } from '../src/scenegraph.js';

const guid = (sessionID: number, localID: number) => ({ sessionID, localID });

const redStyle = {
  guid: guid(8, 1072),
  name: 'UI 2.0. Light Mode/Indicator/Red/100%',
  type: 'ROUNDED_RECTANGLE',
  key: 'indicator-red-style',
  styleType: 'FILL',
  fillPaints: [
    {
      type: 'SOLID',
      color: { r: 0.85, g: 0.1253, b: 0.1253, a: 1 },
      opacity: 1,
      visible: true,
    },
  ],
} as const;

const styledButton = {
  guid: guid(20, 1),
  name: 'Danger button',
  type: 'INSTANCE',
  styleIdForFill: { assetRef: { key: 'indicator-red-style', version: '272:48' } },
  fillPaints: [
    {
      type: 'SOLID',
      color: { r: 0, g: 0.4667, b: 1, a: 1 },
      opacity: 1,
      visible: true,
    },
  ],
} as const;

describe('Kiwi shared style resolution', () => {
  it('uses the shared fill style instead of the stale inline paint fallback', () => {
    const graph = new SceneGraphStore();
    graph.apply({ nodeChanges: [redStyle, styledButton] });

    const result = graph.findWithStats('20:1');
    const normalized = normalizeCapturedNode(result.node!);

    expect(normalized).toMatchObject({
      fills: [
        {
          type: 'SOLID',
          color: { r: 0.85, g: 0.1253, b: 0.1253 },
        },
      ],
      styleIds: { fill: 'indicator-red-style' },
    });
    expect(result).toMatchObject({
      sharedStyleBindings: 1,
      resolvedSharedStyles: 1,
      unresolvedSharedStyles: 0,
      styles: {
        'indicator-red-style': {
          name: 'UI 2.0. Light Mode/Indicator/Red/100%',
          type: 'FILL',
        },
      },
    });
  });

  it('resolves stroke and effect style payloads without changing their references', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: guid(30, 1),
          name: 'Danger border',
          type: 'RECTANGLE',
          key: 'danger-border',
          styleType: 'STROKE',
          strokePaints: redStyle.fillPaints,
        },
        {
          guid: guid(30, 2),
          name: 'Danger shadow',
          type: 'RECTANGLE',
          key: 'danger-shadow',
          styleType: 'EFFECT',
          effects: [
            {
              type: 'DROP_SHADOW',
              color: { r: 0.85, g: 0.1253, b: 0.1253, a: 0.25 },
              radius: 4,
              visible: true,
            },
          ],
        },
        {
          guid: guid(31, 1),
          name: 'Styled card',
          type: 'FRAME',
          styleIdForStrokeFill: { assetRef: { key: 'danger-border' } },
          styleIdForEffect: { assetRef: { key: 'danger-shadow' } },
          strokePaints: [],
          effects: [],
        },
      ],
    });

    const normalized = normalizeCapturedNode(graph.findWithStats('31:1').node!);
    expect(normalized.strokes?.[0]).toMatchObject({ color: { r: 0.85, g: 0.1253, b: 0.1253 } });
    expect(normalized.effects?.[0]).toMatchObject({
      color: { r: 0.85, g: 0.1253, b: 0.1253, a: 0.25 },
    });
    expect(normalized.styleIds).toEqual({ stroke: 'danger-border', effect: 'danger-shadow' });
  });

  it('resolves a fill style referenced by a mixed-text run', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        redStyle,
        {
          guid: guid(32, 1),
          name: 'Mixed label',
          type: 'TEXT',
          fontName: { family: 'Inter', style: 'Regular' },
          fontSize: 14,
          fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
          textData: {
            characters: 'AB',
            characterStyleIDs: [0, 1],
            styleOverrideTable: [
              {
                styleID: 1,
                fontName: { family: 'Inter', style: 'Regular' },
                fontSize: 14,
                styleIdForFill: { assetRef: { key: 'indicator-red-style' } },
                fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0.4667, b: 1, a: 1 } }],
              },
            ],
          },
        },
      ],
    });

    const normalized = normalizeCapturedNode(graph.findWithStats('32:1').node!);
    expect(normalized.segments?.[1]).toMatchObject({
      characters: 'B',
      fills: [{ color: { r: 0.85, g: 0.1253, b: 0.1253 } }],
      styleIds: { fill: 'indicator-red-style' },
    });
  });

  it('invalidates a cached fallback when a missing style definition arrives', () => {
    const graph = new SceneGraphStore();
    graph.apply({ nodeChanges: [styledButton] });
    const cache = new NormalizedNodeCache();
    const fallback = cache.read(graph, '20:1', 8, 2_000);
    expect(cache.normalize(fallback)?.fills?.[0]).toMatchObject({
      color: { r: 0, g: 0.4667, b: 1 },
    });

    graph.apply({ nodeChanges: [redStyle] });
    const resolved = cache.read(graph, '20:1', 8, 2_000);

    expect(resolved).not.toBe(fallback);
    expect(cache.normalize(resolved)?.fills?.[0]).toMatchObject({
      color: { r: 0.85, g: 0.1253, b: 0.1253 },
    });
    expect(cache.stats).toMatchObject({ misses: 2, invalidations: 1 });
  });
});
