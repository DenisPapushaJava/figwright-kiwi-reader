import { SerializedNodeSchema } from '@figwright/shared';
import { describe, expect, it } from 'vitest';

import { KiwiNormalizationError, normalizeCapturedNode } from '../src/normalize.js';
import type { CapturedNode } from '../src/scenegraph.js';

describe('normalizeCapturedNode', () => {
  it('maps observed Kiwi geometry, paint, layout, effects and text to SerializedNode', () => {
    const captured: CapturedNode = {
      id: '1:2',
      name: 'Button',
      type: 'FRAME',
      visible: true,
      raw: {
        guid: { sessionID: 1, localID: 2 },
        parentIndex: { guid: { sessionID: 1, localID: 1 } },
        size: { x: 160, y: 48 },
        transform: { m00: 1, m01: 0, m02: 24, m10: 0, m11: 1, m12: 32 },
        opacity: 0.8,
        rectangleCornerRadiiIndependent: true,
        rectangleTopLeftCornerRadius: 12,
        rectangleTopRightCornerRadius: 12,
        rectangleBottomRightCornerRadius: 4,
        rectangleBottomLeftCornerRadius: 4,
        fillPaints: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 }, opacity: 1 }],
        effects: [
          {
            type: 'DROP_SHADOW',
            visible: true,
            radius: 8,
            spread: 1,
            color: { r: 0, g: 0, b: 0, a: 0.2 },
            offset: { x: 0, y: 2 },
          },
        ],
        stackMode: 'HORIZONTAL',
        stackSpacing: 8,
        stackHorizontalPadding: 16,
        stackVerticalPadding: 12,
        stackPrimaryAlignItems: 'CENTER',
        stackCounterAlignItems: 'CENTER',
        fontSize: 18,
        fontName: { family: 'Inter', style: 'Semi Bold', postscript: 'Inter-SemiBold' },
        fontWeight: 600,
        minWidth: 120,
        maxWidth: 320,
        overflowDirection: 'VERTICAL',
        numberOfFixedChildren: 1,
        targetAspectRatio: { x: 10, y: 3 },
        textData: {
          characters: 'Continue',
          fontSize: 16,
          fontName: { family: 'Inter', style: 'Medium', postscript: 'Inter-Medium' },
          lineHeight: { value: 24, units: 'PIXELS' },
          letterSpacing: { value: 0, units: 'PIXELS' },
          textAlignHorizontal: 'CENTER',
          textTruncation: 'ENDING',
          maxLines: 2,
          textWrapStyle: 'BALANCE',
          derivedTextData: { glyphs: [1, 2, 3] },
          editInfo: { userId: 'private' },
        },
      },
      children: [],
    };

    const node = normalizeCapturedNode(captured);
    expect(SerializedNodeSchema.safeParse(node).success).toBe(true);
    expect(node).toMatchObject({
      id: '1:2',
      parentId: '1:1',
      x: 24,
      y: 32,
      width: 160,
      height: 48,
      opacity: 0.8,
      cornerRadius: 'mixed',
      cornerRadii: { topLeft: 12, topRight: 12, bottomRight: 4, bottomLeft: 4 },
      fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 0.1, g: 0.2, b: 0.3 } }],
      layout: {
        mode: 'HORIZONTAL',
        paddingTop: 12,
        paddingRight: 16,
        paddingBottom: 12,
        paddingLeft: 16,
        itemSpacing: 8,
      },
      characters: 'Continue',
      fontSize: 18,
      fontName: {
        family: 'Inter',
        style: 'Semi Bold',
        postScriptName: 'Inter-SemiBold',
      },
      fontWeight: 600,
      minWidth: 120,
      maxWidth: 320,
      overflowDirection: 'VERTICAL',
      numberOfFixedChildren: 1,
      targetAspectRatio: { x: 10, y: 3 },
      textTruncation: 'ENDING',
      maxLines: 2,
      textWrapStyle: 'BALANCE',
      lineHeight: { value: 24, unit: 'PIXELS' },
    });
    expect(JSON.stringify(node)).not.toMatch(/derivedTextData|editInfo|userId/);
  });

  it('omits no-op defaults and normalizes children recursively', () => {
    const node = normalizeCapturedNode({
      id: '3:1',
      name: 'Root',
      type: 'FRAME',
      visible: true,
      raw: {
        guid: { sessionID: 3, localID: 1 },
        opacity: 1,
        blendMode: 'PASS_THROUGH',
        cornerRadius: 0,
      },
      children: [
        {
          id: '3:2',
          name: 'Hidden',
          type: 'RECTANGLE',
          visible: false,
          raw: {
            guid: { sessionID: 3, localID: 2 },
            parentIndex: { guid: { sessionID: 3, localID: 1 } },
          },
          children: [],
        },
      ],
    });

    expect(node).not.toHaveProperty('opacity');
    expect(node).not.toHaveProperty('blendMode');
    expect(node).not.toHaveProperty('cornerRadius');
    expect(node.children?.[0]).toMatchObject({ id: '3:2', visible: false, parentId: '3:1' });
  });

  it('maps child sizing against the parent axis and accepts array transforms', () => {
    const node = normalizeCapturedNode({
      id: '7:2',
      name: 'Child',
      type: 'FRAME',
      visible: true,
      parentStackMode: 'VERTICAL',
      raw: {
        guid: { sessionID: 7, localID: 2 },
        transform: [
          [0, -1, 120],
          [1, 0, 240],
        ],
        stackMode: 'HORIZONTAL',
        stackPrimarySizing: 'HUG',
        stackCounterSizing: 'FILL',
      },
      children: [],
    });

    expect(node).toMatchObject({
      x: 120,
      y: 240,
      rotation: 90,
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
    });
  });

  it('reports a compact normalization error without serializing the raw node', () => {
    const invalid = {
      id: '9:9',
      name: 42,
      type: 'FRAME',
      visible: true,
      raw: { guid: { sessionID: 9, localID: 9 }, privatePayload: 'do-not-report' },
      children: [],
    } as unknown as CapturedNode;

    expect(() => normalizeCapturedNode(invalid)).toThrow(KiwiNormalizationError);
    expect(() => normalizeCapturedNode(invalid)).toThrow(/Invalid normalized Kiwi node 9:9: name/);
    let capturedError: unknown;
    try {
      normalizeCapturedNode(invalid);
    } catch (error) {
      capturedError = error;
    }
    expect(String(capturedError)).not.toContain('do-not-report');
  });
});
