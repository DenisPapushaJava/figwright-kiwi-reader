export interface WebSocketConnectionTarget extends EventTarget {
  close(): void;
}

export const waitForWebSocketOpen: (
  socket: WebSocketConnectionTarget,
  timeoutMs: number,
) => Promise<void>;
