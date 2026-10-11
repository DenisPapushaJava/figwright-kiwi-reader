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
  const detachedStyle = { guid: guid(4294967295, 4294967295) };
  const bluePaint = [{ type: 'SOLID', color: { r: 0, g: 0.4667, b: 1, a: 1 } }];
  const orangePaint = [{ type: 'SOLID', color: { r: 1, g: 0.4667, b: 0, a: 1 }, opacity: 0.6 }];

  it.each([
    ['styleIdForFill', 'fillPaints', 'fills', 'fill', bluePaint, orangePaint],
    ['styleIdForStrokeFill', 'strokePaints', 'strokes', 'stroke', bluePaint, orangePaint],
    [
      'styleIdForEffect',
      'effects',
      'effects',
      'effect',
      [{ type: 'DROP_SHADOW', color: { r: 0, g: 0.4667, b: 1, a: 1 }, radius: 4 }],
      [{ type: 'DROP_SHADOW', color: { r: 1, g: 0.4667, b: 0, a: 0.6 }, radius: 8 }],
    ],
  ] as const)(
    'preserves a detached instance %s override instead of reapplying the master style',
    (reference, value, normalizedField, styleField, original, override) => {
      const graph = new SceneGraphStore();
      graph.apply({
        nodeChanges: [
          { guid: guid(80, 1), key: 'base-style', styleType: 'FILL', [value]: original },
          { guid: guid(81, 1), name: 'Checkbox', type: 'SYMBOL' },
          {
            guid: guid(81, 2),
            parentIndex: { guid: guid(81, 1) },
            overrideKey: guid(304, 176),
            type: 'VECTOR',
            [reference]: { assetRef: { key: 'base-style' } },
            [value]: original,
          },
          {
            guid: guid(82, 1),
            type: 'INSTANCE',
            symbolData: {
              symbolID: guid(81, 1),
              symbolOverrides: [
                {
                  guidPath: { guids: [guid(304, 176)] },
                  [reference]: detachedStyle,
                  [value]: override,
                },
              ],
            },
            derivedSymbolData: [{ guidPath: { guids: [guid(304, 176)] }, opacity: 0.8 }],
          },
          { guid: guid(82, 2), type: 'INSTANCE', symbolData: { symbolID: guid(81, 1) } },
        ],
      });

      const result = graph.findWithStats('82:1');
      const child = normalizeCapturedNode(result.node!).children?.[0];
      expect(result.node?.children[0]?.raw[reference]).toEqual(detachedStyle);
      expect(child?.[normalizedField]?.[0]).toMatchObject({ color: { r: 1, g: 0.4667, b: 0 } });
      expect(child?.styleIds?.[styleField]).toBeUndefined();
      expect(child?.opacity).toBe(0.8);
      expect(result).toMatchObject({ sharedStyleBindings: 0, unresolvedSharedStyles: 0 });
      expect(
        normalizeCapturedNode(graph.find('82:2')!).children?.[0]?.[normalizedField]?.[0],
      ).toMatchObject({ color: { r: 0, g: 0.4667, b: 1 } });
    },
  );

  it('replaces a keyed style with a GUID style through nested instance overrides', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        { guid: guid(83, 1), key: 'blue-style', styleType: 'FILL', fillPaints: bluePaint },
        redStyle,
        { guid: guid(84, 1), type: 'SYMBOL' },
        {
          guid: guid(84, 2),
          parentIndex: { guid: guid(84, 1) },
          overrideKey: guid(304, 176),
          type: 'VECTOR',
          styleIdForFill: { assetRef: { key: 'blue-style' } },
          fillPaints: bluePaint,
        },
        { guid: guid(85, 1), type: 'SYMBOL' },
        {
          guid: guid(85, 2),
          parentIndex: { guid: guid(85, 1) },
          overrideKey: guid(850, 2),
          type: 'INSTANCE',
          symbolData: {
            symbolID: guid(84, 1),
            symbolOverrides: [
              {
                guidPath: { guids: [guid(304, 176)] },
                styleIdForFill: { guid: redStyle.guid },
              },
            ],
          },
        },
        {
          guid: guid(86, 1),
          type: 'INSTANCE',
          symbolData: {
            symbolID: guid(85, 1),
            symbolOverrides: [
              {
                guidPath: { guids: [guid(850, 2), guid(304, 176)] },
                styleIdForFill: detachedStyle,
                fillPaints: orangePaint,
              },
            ],
          },
        },
      ],
    });

    const direct = normalizeCapturedNode(graph.find('85:2')!).children?.[0];
    expect(direct?.fills?.[0]).toMatchObject({ color: { r: 0.85, g: 0.1253, b: 0.1253 } });
    expect(direct?.styleIds).toEqual({ fill: 'StyleID:8:1072' });
    const nested = normalizeCapturedNode(graph.find('86:1')!).children?.[0]?.children?.[0];
    expect(nested?.fills?.[0]).toMatchObject({ color: { r: 1, g: 0.4667, b: 0 }, opacity: 0.6 });
    expect(nested?.styleIds).toBeUndefined();
  });

  it.each(['styleIdForFill', 'styleIdForStrokeFill', 'styleIdForEffect', 'styleIdForText'])(
    'does not advertise a detached %s as an unresolved style',
    reference => {
      const graph = new SceneGraphStore();
      graph.apply({
        nodeChanges: [{ guid: guid(87, 1), type: 'TEXT', [reference]: detachedStyle }],
      });
      const result = graph.findWithStats('87:1');
      expect(normalizeCapturedNode(result.node!).styleIds).toBeUndefined();
      expect(result).toMatchObject({ sharedStyleBindings: 0, unresolvedSharedStyles: 0 });
    },
  );

  it('keeps gradient and empty-paint overrides after detaching a style and invalidates cached colors', () => {
    const graph = new SceneGraphStore();
    const gradient = [
      {
        type: 'GRADIENT_LINEAR',
        opacity: 0.4,
        transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        stops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
        ],
      },
    ];
    const symbolData = (fillPaints: unknown[]) => ({
      symbolID: guid(88, 1),
      symbolOverrides: [
        {
          guidPath: { guids: [guid(88, 2)] },
          styleIdForFill: detachedStyle,
          fillPaints,
        },
      ],
    });
    graph.apply({
      nodeChanges: [
        { guid: guid(88, 1), type: 'SYMBOL' },
        {
          guid: guid(88, 2),
          parentIndex: { guid: guid(88, 1) },
          type: 'VECTOR',
          styleIdForFill: { guid: redStyle.guid },
          fillPaints: bluePaint,
        },
        redStyle,
        { guid: guid(89, 1), type: 'INSTANCE', symbolData: symbolData(gradient) },
      ],
    });
    const cache = new NormalizedNodeCache();
    const initial = cache.read(graph, '89:1', 8, 2_000);
    expect(cache.normalize(initial)?.children?.[0]).toMatchObject({
      fills: [{ type: 'GRADIENT_LINEAR', opacity: 0.4, gradientStops: gradient[0]!.stops }],
    });
    graph.apply({ nodeChanges: [{ guid: guid(89, 1), symbolData: symbolData([]) }] });
    const updated = cache.read(graph, '89:1', 8, 2_000);
    expect(updated).not.toBe(initial);
    expect(cache.normalize(updated)?.children?.[0]?.fills).toEqual([]);
    expect(cache.normalize(updated)?.children?.[0]?.styleIds).toBeUndefined();
  });

  it('keeps a detached mixed-text run color without reporting a fake style binding', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        {
          guid: guid(90, 1),
          type: 'TEXT',
          fontName: { family: 'Inter', style: 'Regular' },
          fontSize: 14,
          fillPaints: bluePaint,
          textData: {
            characters: 'AB',
            characterStyleIDs: [0, 1],
            styleOverrideTable: [
              { styleID: 1, styleIdForFill: detachedStyle, fillPaints: orangePaint },
            ],
          },
        },
      ],
    });
    const result = graph.findWithStats('90:1');
    const text = normalizeCapturedNode(result.node!);
    expect(text.segments?.[1]).toMatchObject({
      characters: 'B',
      fills: [{ color: { r: 1, g: 0.4667, b: 0 }, opacity: 0.6 }],
    });
    expect(text.segments?.[1]?.styleIds).toBeUndefined();
    expect(result).toMatchObject({ sharedStyleBindings: 0, unresolvedSharedStyles: 0 });
  });

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

  const versionedStyles = [
    { ...redStyle, version: '982:10' },
    { ...redStyle, guid: guid(3159, 13346), version: '572:33', fillPaints: bluePaint },
  ];

  it.each([false, true])(
    'resolves both versions of the same paint style in either order (%s)',
    reverse => {
      const graph = new SceneGraphStore();
      graph.apply({
        nodeChanges: [
          ...(reverse ? versionedStyles.toReversed() : versionedStyles),
          ...versionedStyles.map((style, index) => ({
            ...styledButton,
            guid: guid(91, index),
            styleIdForFill: { assetRef: { key: redStyle.key, version: style.version } },
          })),
        ],
      });
      for (const [index, style] of versionedStyles.entries()) {
        const result = graph.findWithStats(`91:${index}`);
        expect(result.node?.raw.fillPaints).toEqual(style.fillPaints);
        expect(result).toMatchObject({ resolvedSharedStyles: 1, unresolvedSharedStyles: 0 });
      }
    },
  );

  it.each([1, 2])(
    'keeps the captured paint when the requested version is missing (%s definitions)',
    count => {
      const graph = new SceneGraphStore();
      graph.apply({
        nodeChanges: [
          ...versionedStyles.slice(0, count),
          {
            ...styledButton,
            styleIdForFill: { assetRef: { key: redStyle.key, version: 'missing' } },
          },
        ],
      });
      const result = graph.findWithStats('20:1');
      expect(result.node?.raw.fillPaints).toEqual(styledButton.fillPaints);
      expect(result).toMatchObject({
        resolvedSharedStyles: 0,
        unresolvedSharedStyles: 1,
        styles: {},
      });
    },
  );

  it('does not guess an ambiguous unversioned style while keeping exact GUID references', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        ...versionedStyles,
        { ...styledButton, styleIdForFill: { assetRef: { key: redStyle.key } } },
        { ...styledButton, guid: guid(92, 1), styleIdForFill: { guid: redStyle.guid } },
      ],
    });
    const ambiguous = graph.findWithStats('20:1');
    expect(ambiguous.node?.raw.fillPaints).toEqual(styledButton.fillPaints);
    expect(ambiguous).toMatchObject({ resolvedSharedStyles: 0, unresolvedSharedStyles: 1 });
    const exact = graph.findWithStats('92:1');
    expect(exact.node?.raw.fillPaints).toEqual(redStyle.fillPaints);
    expect(exact).toMatchObject({ resolvedSharedStyles: 1, unresolvedSharedStyles: 0 });
  });

  it('invalidates the cache when the requested version arrives beside another version', () => {
    const graph = new SceneGraphStore();
    graph.apply({
      nodeChanges: [
        versionedStyles[1],
        { ...styledButton, styleIdForFill: { assetRef: { key: redStyle.key, version: '982:10' } } },
      ],
    });
    const cache = new NormalizedNodeCache();
    const missing = cache.read(graph, '20:1', 8, 2_000);
    expect(missing.result).toMatchObject({ unresolvedSharedStyles: 1 });
    graph.apply({ nodeChanges: [versionedStyles[0]] });
    const resolved = cache.read(graph, '20:1', 8, 2_000);
    expect(resolved).not.toBe(missing);
    expect(resolved.result.node?.raw.fillPaints).toEqual(redStyle.fillPaints);
    expect(resolved.result).toMatchObject({ resolvedSharedStyles: 1, unresolvedSharedStyles: 0 });
  });

  it.each([{ fillPaints: redStyle.fillPaints }, { fillPaints: [] }])(
    'applies a shared FILL paint style to a stroke, including an empty paint array',
    ({ fillPaints }) => {
      const graph = new SceneGraphStore();
      graph.apply({
        nodeChanges: [
          { ...versionedStyles[0], fillPaints, strokePaints: bluePaint },
          versionedStyles[1],
          {
            guid: guid(93, 1),
            type: 'RECTANGLE',
            styleIdForStrokeFill: { assetRef: { key: redStyle.key, version: '982:10' } },
            strokePaints: bluePaint,
          },
        ],
      });
      const result = graph.findWithStats('93:1');
      expect(result.node?.raw.strokePaints).toEqual(fillPaints);
      expect(result).toMatchObject({ resolvedSharedStyles: 1, unresolvedSharedStyles: 0 });
      expect(normalizeCapturedNode(result.node!).styleIds).toEqual({ stroke: redStyle.key });
    },
  );

  it('keeps separate style versions in mixed text runs and effect bindings', () => {
    const graph = new SceneGraphStore();
    const effects = versionedStyles.map(style => ({
      ...style,
      guid: guid(94, style.guid.localID),
      key: 'versioned-effect',
      styleType: 'EFFECT',
      effects: [{ type: 'DROP_SHADOW', color: { ...style.fillPaints[0]!.color }, radius: 4 }],
    }));
    graph.apply({
      nodeChanges: [
        ...versionedStyles,
        ...effects,
        {
          guid: guid(95, 1),
          type: 'TEXT',
          fontName: { family: 'Inter', style: 'Regular' },
          fontSize: 14,
          styleIdForEffect: { assetRef: { key: 'versioned-effect', version: '982:10' } },
          textData: {
            characters: 'AB',
            characterStyleIDs: [1, 2],
            styleOverrideTable: versionedStyles.map((style, index) => ({
              styleID: index + 1,
              styleIdForFill: { assetRef: { key: redStyle.key, version: style.version } },
              fillPaints: [],
            })),
          },
        },
      ],
    });
    const result = graph.findWithStats('95:1');
    const text = normalizeCapturedNode(result.node!);
    expect(
      text.segments?.map(segment => {
        const paint = segment.fills?.[0];
        return paint?.type === 'SOLID' ? paint.color : undefined;
      }),
    ).toEqual(
      versionedStyles.map(style => ({
        r: style.fillPaints[0]!.color.r,
        g: style.fillPaints[0]!.color.g,
        b: style.fillPaints[0]!.color.b,
      })),
    );
    expect(result.node?.raw.effects).toEqual(effects[0]!.effects);
    expect(result).toMatchObject({ resolvedSharedStyles: 3, unresolvedSharedStyles: 0 });
  });
});
