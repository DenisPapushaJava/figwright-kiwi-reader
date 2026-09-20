import type { DetailLevel } from '@figwright/shared';
import { describe, expect, it } from 'vitest';

import { minimumProjectedNodeBytes } from '../src/projection-budget.js';
import type { CapturedNode } from '../src/scenegraph.js';

const captured = (
  id: string,
  name: string,
  type: string,
  children: CapturedNode[] = [],
): CapturedNode => ({
  id,
  name,
  type,
  visible: true,
  raw: {},
  children,
});

const projected = (node: CapturedNode, detail: DetailLevel): Record<string, unknown> => ({
  id: node.id,
  name: node.name,
  type: node.type,
  ...(detail === 'minimal' ? {} : { x: -123.5, y: 0, width: 640, height: 480 }),
  opacity: 0.5,
  ...(node.children.length === 0
    ? {}
    : { children: node.children.map(child => projected(child, detail)) }),
});

describe('minimumProjectedNodeBytes', () => {
  it.each<DetailLevel>(['minimal', 'compact', 'full'])(
    'never exceeds a representative %s projection',
    detail => {
      const root = captured('6:140', 'Root "Ж"', 'FRAME', [
        captured('6:141', 'Child\\name', 'TEXT'),
        captured('6:142', '\ud800', 'INSTANCE'),
      ]);

      const minimum = minimumProjectedNodeBytes(root, detail);
      const actual = Buffer.byteLength(JSON.stringify(projected(root, detail)), 'utf8');

      expect(minimum).toBeLessThan(actual);
      expect(minimumProjectedNodeBytes(root, detail)).toBe(minimum);
    },
  );

  it('counts multibyte and escaped names in UTF-8 bytes', () => {
    const short = captured('1:1', 'A', 'FRAME');
    const unicode = captured('1:1', 'Ж'.repeat(100), 'FRAME');
    const escaped = captured('1:1', '"\\'.repeat(100), 'FRAME');

    expect(minimumProjectedNodeBytes(unicode, 'minimal')).toBeGreaterThan(
      minimumProjectedNodeBytes(short, 'minimal') + 100,
    );
    expect(minimumProjectedNodeBytes(escaped, 'minimal')).toBeGreaterThan(
      minimumProjectedNodeBytes(short, 'minimal') + 100,
    );
  });

  it('handles a 65,662-node wide tree without argument or recursion limits', () => {
    const root = captured(
      '1:1',
      'Root',
      'FRAME',
      Array.from({ length: 65_661 }, (_, index) =>
        captured(`1:${index + 2}`, `Layer ${index}`, 'RECTANGLE'),
      ),
    );

    expect(minimumProjectedNodeBytes(root, 'full')).toBeGreaterThan(1_500_000);
  });
});
