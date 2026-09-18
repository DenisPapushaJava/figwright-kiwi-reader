import { describe, expect, it } from 'vitest';

import {
  frameBudgetError,
  MAX_BRIDGE_BUFFERED_BYTES,
  MAX_FRAME_PAYLOAD_CHARS,
} from '../extension/frame-budget.js';

describe('browser capture budgets', () => {
  it('accepts a frame while both hard limits are respected', () => {
    expect(frameBudgetError(MAX_FRAME_PAYLOAD_CHARS, MAX_BRIDGE_BUFFERED_BYTES)).toBeNull();
  });

  it('reports oversized frames before forwarding them', () => {
    expect(frameBudgetError(MAX_FRAME_PAYLOAD_CHARS + 1, 0)).toMatchObject({
      code: 'CAPTURE_FRAME_TOO_LARGE',
    });
  });

  it('reports bridge backpressure before the browser queue grows without bound', () => {
    expect(frameBudgetError(1, MAX_BRIDGE_BUFFERED_BYTES + 1)).toMatchObject({
      code: 'BRIDGE_BACKPRESSURE',
    });
  });
});
