export const MAX_FRAME_PAYLOAD_CHARS = 48 * 1024 * 1024;
export const MAX_BRIDGE_BUFFERED_BYTES = 32 * 1024 * 1024;

export const frameBudgetError = (payloadLength, bufferedAmount) => {
  if (payloadLength > MAX_FRAME_PAYLOAD_CHARS) {
    return {
      code: 'CAPTURE_FRAME_TOO_LARGE',
      message: `Figma frame exceeds the ${MAX_FRAME_PAYLOAD_CHARS} character capture limit`,
    };
  }
  if (bufferedAmount > MAX_BRIDGE_BUFFERED_BYTES) {
    return {
      code: 'BRIDGE_BACKPRESSURE',
      message: `Local bridge queue exceeds ${MAX_BRIDGE_BUFFERED_BYTES} bytes`,
    };
  }
  return null;
};
