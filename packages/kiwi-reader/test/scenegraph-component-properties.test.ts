import { describe, expect, it } from 'vitest';

import { normalizeCapturedNode } from '../src/normalize.js';
import { SceneGraphStore } from '../src/scenegraph.js';

describe('nested component property overrides', () => {
  it.each([
    ['array', 'array'],
    ['array', 'entries'],
    ['entries', 'array'],
    ['entries', 'entries'],
  ] as const)(
    'preserves unrelated properties when %s assignments receive %s overrides',
    (format, overrideFormat) => {
      const guid = (localID: number) => ({ sessionID: 110, localID });
      const assignments = (entries: unknown[]) => (format === 'array' ? entries : { entries });
      const bool = (localID: number, value: boolean) => ({
        defID: guid(localID),
        value: { boolValue: value },
        varValue: { value: { boolValue: value }, dataType: 'BOOLEAN' },
      });
      const override = (entries: unknown[]) => ({
        guidPath: { guids: [guid(20)] },
        componentPropAssignments: overrideFormat === 'array' ? entries : { entries },
      });
      const graph = new SceneGraphStore();
      graph.apply({
        nodeChanges: [
          {
            guid: guid(1),
            name: 'Input',
            type: 'SYMBOL',
            componentPropDefs: [
              { id: guid(101), name: 'Label', type: 'BOOL', initialValue: { boolValue: true } },
              { id: guid(102), name: 'Icon', type: 'BOOL', initialValue: { boolValue: true } },
            ],
          },
          {
            guid: guid(2),
            parentIndex: { guid: guid(1), position: 'a' },
            name: 'Error',
            type: 'TEXT',
            visible: true,
            textData: { characters: 'Default error' },
            componentPropRefs: [{ defID: guid(103), componentPropNodeField: 'TEXT_DATA' }],
            parameterConsumptionMap: {
              entries: [
                {
                  variableField: 'VISIBLE',
                  variableData: { value: { propRefValue: { defId: guid(101) } } },
                },
              ],
            },
          },
          {
            guid: guid(3),
            parentIndex: { guid: guid(1), position: 'b' },
            name: 'Icon',
            type: 'FRAME',
            componentPropRefs: [{ defID: guid(102), componentPropNodeField: 'VISIBLE' }],
          },
          { guid: guid(10), name: 'Input state', type: 'SYMBOL' },
          {
            guid: guid(11),
            parentIndex: { guid: guid(10), position: 'a' },
            overrideKey: guid(20),
            name: 'Input',
            type: 'INSTANCE',
            symbolData: { symbolID: guid(1) },
            componentPropAssignments: assignments([
              bool(101, false),
              { defID: guid(103), value: { textValue: { characters: 'Validation error' } } },
            ]),
          },
          {
            guid: guid(12),
            parentIndex: { guid: guid(10), position: 'b' },
            name: 'Sibling input',
            type: 'INSTANCE',
            symbolData: { symbolID: guid(1) },
            componentPropAssignments: assignments([bool(101, true)]),
          },
          {
            guid: guid(30),
            type: 'INSTANCE',
            symbolData: { symbolID: guid(10), symbolOverrides: [override([bool(102, false)])] },
          },
          {
            guid: guid(31),
            type: 'INSTANCE',
            symbolData: {
              symbolID: guid(10),
              symbolOverrides: [
                override([bool(102, false)]),
                override([{ defID: guid(101), varValue: { value: { boolValue: true } } }]),
              ],
            },
          },
          {
            guid: guid(32),
            type: 'INSTANCE',
            symbolData: { symbolID: guid(10), symbolOverrides: [override([])] },
          },
        ],
      });

      const read = (id: string) => normalizeCapturedNode(graph.find(id)!);
      const hidden = read('110:30');
      expect(hidden.children?.[0]).toMatchObject({
        componentProperties: {
          'Label#110:101': { type: 'BOOLEAN', value: false },
          'Icon#110:102': { type: 'BOOLEAN', value: false },
        },
        children: [{ characters: 'Validation error', visible: false }, { visible: false }],
      });
      expect(hidden.children?.[1]).toMatchObject({
        componentProperties: { 'Label#110:101': { type: 'BOOLEAN', value: true } },
        children: [{ characters: 'Default error' }, {}],
      });
      expect(graph.find('110:30')?.children[1]?.children[0]?.visible).toBe(true);

      // Two sparse patches of the same nested instance must both survive; an explicit
      // true must still override false, and the error text remains available in either state.
      expect(read('110:31').children?.[0]).toMatchObject({
        componentProperties: {
          'Label#110:101': { type: 'BOOLEAN', value: true },
          'Icon#110:102': { type: 'BOOLEAN', value: false },
        },
        children: [{ characters: 'Validation error' }, { visible: false }],
      });
      expect(graph.find('110:31')?.children[0]?.children[0]?.visible).toBe(true);
      expect(graph.find('110:32')?.children[0]?.children[0]?.visible).toBe(false);
      expect(graph.find('110:11')?.children[0]?.visible).toBe(false);

      graph.apply({
        nodeChanges: [
          {
            guid: guid(30),
            symbolData: { symbolID: guid(10), symbolOverrides: [override([bool(101, true)])] },
            componentPropAssignments: assignments([bool(101, false)]),
          },
        ],
      });
      // A placed exposed property keeps its established precedence over a nested override.
      expect(graph.find('110:30')?.children[0]?.children[0]?.visible).toBe(false);

      // A new wire snapshot replaces assignments rather than merging with stale values.
      graph.apply({ nodeChanges: [{ guid: guid(11), componentPropAssignments: assignments([]) }] });
      expect(read('110:11').componentProperties?.['Label#110:101']?.value).toBe(true);
      expect(graph.find('110:11')?.children[0]?.visible).toBe(true);
      expect(read('110:11').children?.[0]?.characters).toBe('Default error');
    },
  );
});
