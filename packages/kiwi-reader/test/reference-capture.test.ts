import { describe, expect, it } from 'vitest';

import { decodeReferencePng, pngDimensions } from '../src/reference-capture.js';

const pngHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
};

describe('browser reference capture', () => {
  it('validates PNG payloads and reads their pixel dimensions', () => {
    const bytes = pngHeader(1920, 1080);
    const decoded = decodeReferencePng(Buffer.from(bytes).toString('base64'));
    expect(decoded).toEqual(bytes);
    expect(pngDimensions(decoded)).toEqual({ width: 1920, height: 1080 });
  });

  it('rejects malformed and non-PNG bodies', () => {
    expect(() => decodeReferencePng('***')).toThrow('REFERENCE_INVALID_BASE64');
    expect(() =>
      decodeReferencePng(Buffer.from('not a png body at all.......').toString('base64')),
    ).toThrow('REFERENCE_NOT_PNG');
  });
});
