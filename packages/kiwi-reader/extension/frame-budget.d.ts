export const MAX_FRAME_PAYLOAD_CHARS: number;
export const MAX_BRIDGE_BUFFERED_BYTES: number;
export const frameBudgetError: (
  payloadLength: number,
  bufferedAmount: number,
) => { code: string; message: string } | null;
