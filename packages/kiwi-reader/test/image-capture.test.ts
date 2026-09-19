import { describe, expect, it } from 'vitest';

import {
  canForwardImageBody,
  decodedBodySize,
  imageResponseMetadata,
  MAX_IMAGE_BODY_BYTES,
  MAX_IMAGE_BRIDGE_BUFFER_BYTES,
} from '../extension/image-capture.js';

describe('image response capture limits', () => {
  it('accepts only HTTP image responses', () => {
    expect(
      imageResponseMetadata({
        requestId: '42',
        response: { mimeType: 'image/png', url: 'https://www.figma.com/image/42' },
      }),
    ).toEqual({ requestId: '42', mimeType: 'image/png', url: 'https://www.figma.com/image/42' });
    expect(
      imageResponseMetadata({
        requestId: '42',
        response: { mimeType: 'application/json', url: 'https://www.figma.com/api' },
      }),
    ).toBeNull();
    expect(
      imageResponseMetadata({
        requestId: '42',
        response: { mimeType: 'image/png', url: 'data:image/png;base64,AA==' },
      }),
    ).toBeNull();
  });

  it('computes decoded size and enforces body and bridge budgets', () => {
    expect(decodedBodySize('AQIDBA==', true)).toBe(4);
    expect(decodedBodySize('аб', false)).toBe(4);
    expect(canForwardImageBody('AQIDBA==', true, 0)).toBe(true);
    expect(
      canForwardImageBody('A'.repeat(Math.ceil((MAX_IMAGE_BODY_BYTES * 4) / 3) + 8), true, 0),
    ).toBe(false);
    expect(canForwardImageBody('AQIDBA==', true, MAX_IMAGE_BRIDGE_BUFFER_BYTES + 1)).toBe(false);
  });
});
