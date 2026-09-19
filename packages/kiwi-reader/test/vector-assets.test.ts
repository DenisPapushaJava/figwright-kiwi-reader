import { describe, expect, it } from 'vitest';

import { CapturedBlobStore } from '../src/blob-store.js';
import type { CapturedNode } from '../src/scenegraph.js';
import {
  commandsBlobToPath,
  renderVectorSubtree,
  vectorNetworkBlobToPath,
} from '../src/vector-assets.js';

const commandBlob = (): Uint8Array => {
  const bytes = new Uint8Array(1 + 8 + 1 + 8 + 1 + 8 + 1);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const point = (command: number, x: number, y: number): void => {
    bytes[offset++] = command;
    view.setFloat32(offset, x, true);
    offset += 4;
    view.setFloat32(offset, y, true);
    offset += 4;
  };
  point(1, 0, 0);
  point(2, 24, 0);
  point(2, 24, 24);
  bytes[offset] = 3;
  return bytes;
};

const vectorNetworkBlob = (): Uint8Array => {
  const bytes = new Uint8Array(12 + 2 * 12 + 28);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 2, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;
  for (const [x, y] of [
    [0, 0],
    [10, 20],
  ]) {
    view.setUint32(offset, 0, true);
    offset += 4;
    view.setFloat32(offset, x as number, true);
    offset += 4;
    view.setFloat32(offset, y as number, true);
    offset += 4;
  }
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setFloat32(offset, 0, true);
  offset += 4;
  view.setFloat32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setFloat32(offset, 0, true);
  offset += 4;
  view.setFloat32(offset, 0, true);
  return bytes;
};

describe('Kiwi vector assets', () => {
  it('decodes bounded command and vector-network paths', () => {
    expect(commandsBlobToPath(commandBlob())).toBe('M 0 0 L 24 0 L 24 24 Z');
    expect(vectorNetworkBlobToPath(vectorNetworkBlob())).toBe('M 0 0 L 10 20');
    expect(commandsBlobToPath(Uint8Array.of(1, 0))).toBeNull();
    expect(vectorNetworkBlobToPath(Uint8Array.of(1, 2, 3))).toBeNull();
  });

  it('renders real geometry with paint and nested affine transforms', () => {
    const blobs = new CapturedBlobStore();
    const message = {
      blobs: [{ bytes: commandBlob() }],
      nodeChanges: [
        {
          guid: { sessionID: 1, localID: 2 },
          name: 'Icon',
          type: 'FRAME',
          size: { x: 32, y: 32 },
        },
        {
          guid: { sessionID: 1, localID: 3 },
          name: 'Path',
          type: 'VECTOR',
          size: { x: 24, y: 24 },
          transform: { m00: 1, m01: 0, m02: 4, m10: 0, m11: 1, m12: 5 },
          fillGeometry: [{ commandsBlob: 0, windingRule: 'ODD' }],
          fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0 }, opacity: 0.75 }],
        },
      ],
    };
    blobs.captureMessage(message);
    const root: CapturedNode = {
      id: '1:2',
      name: 'Icon',
      type: 'FRAME',
      visible: true,
      raw: message.nodeChanges[0] as CapturedNode['raw'],
      children: [
        {
          id: '1:3',
          name: 'Path',
          type: 'VECTOR',
          visible: true,
          raw: message.nodeChanges[1] as CapturedNode['raw'],
          children: [],
        },
      ],
    };

    const rendered = renderVectorSubtree(root, blobs);
    expect(rendered).toMatchObject({ width: 32, height: 32, renderedNodes: 1, warnings: [] });
    expect(rendered?.svg).toContain('viewBox="0 0 32 32"');
    expect(rendered?.svg).toContain('transform="matrix(1 0 0 1 4 5)"');
    expect(rendered?.svg).toContain('fill="#ff8000"');
    expect(rendered?.svg).toContain('fill-rule="evenodd"');
    expect(rendered?.svg).not.toContain('Uint8Array');
  });

  it('reports a missing source blob instead of inventing a path', () => {
    const node: CapturedNode = {
      id: '4:2',
      name: 'Missing',
      type: 'VECTOR',
      visible: true,
      raw: {
        guid: { sessionID: 4, localID: 2 },
        size: { x: 16, y: 16 },
        fillGeometry: [{ commandsBlob: 7 }],
      },
      children: [],
    };
    expect(renderVectorSubtree(node, new CapturedBlobStore())).toBeNull();
  });

  it('marks unsupported vector paints instead of silently replacing a gradient with black', () => {
    const blobs = new CapturedBlobStore();
    const message = {
      blobs: [{ bytes: commandBlob() }],
      nodeChanges: [
        {
          guid: { sessionID: 5, localID: 1 },
          name: 'Gradient icon',
          type: 'VECTOR',
          size: { x: 24, y: 24 },
          fillGeometry: [{ commandsBlob: 0 }],
          fillPaints: [{ type: 'GRADIENT_LINEAR', visible: true }],
        },
      ],
    };
    blobs.captureMessage(message);
    const node: CapturedNode = {
      id: '5:1',
      name: 'Gradient icon',
      type: 'VECTOR',
      visible: true,
      raw: message.nodeChanges[0] as CapturedNode['raw'],
      children: [],
    };
    const rendered = renderVectorSubtree(node, blobs);
    expect(rendered?.warnings).toContain('unsupported-vector-fill-paint');
    expect(rendered?.svg).toContain('fill="none"');
    expect(rendered?.svg).not.toContain('fill="#000000"');
  });

  it('keeps paintless parent geometry transparent around a painted child', () => {
    const blobs = new CapturedBlobStore();
    const message = {
      blobs: [{ bytes: commandBlob() }],
      nodeChanges: [
        {
          guid: { sessionID: 6, localID: 1 },
          name: 'Transparent instance root',
          type: 'INSTANCE',
          size: { x: 32, y: 32 },
          fillGeometry: [{ commandsBlob: 0 }],
        },
        {
          guid: { sessionID: 6, localID: 2 },
          name: 'Arrow',
          type: 'VECTOR',
          size: { x: 24, y: 24 },
          fillGeometry: [{ commandsBlob: 0 }],
          fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0.25, b: 0.5 } }],
        },
      ],
    };
    blobs.captureMessage(message);
    const rendered = renderVectorSubtree(
      {
        id: '6:1',
        name: 'Transparent instance root',
        type: 'INSTANCE',
        visible: true,
        raw: message.nodeChanges[0] as CapturedNode['raw'],
        children: [
          {
            id: '6:2',
            name: 'Arrow',
            type: 'VECTOR',
            visible: true,
            raw: message.nodeChanges[1] as CapturedNode['raw'],
            children: [],
          },
        ],
      },
      blobs,
    );

    expect(rendered?.svg).toContain('fill="none"');
    expect(rendered?.svg).toContain('fill="#004080"');
    expect(rendered?.svg).not.toContain('fill="#000000"');
  });
});
