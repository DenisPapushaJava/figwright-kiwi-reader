import { describe, expect, it, vi } from 'vitest';

import { waitForWebSocketOpen } from '../extension/bridge-connection.js';

class FakeSocket extends EventTarget {
  closed = false;

  close() {
    this.closed = true;
  }
}

describe('waitForWebSocketOpen', () => {
  it('resolves when the socket opens', async () => {
    const socket = new FakeSocket();
    const connected = waitForWebSocketOpen(socket, 1_000);
    socket.dispatchEvent(new Event('open'));
    await expect(connected).resolves.toBeUndefined();
  });

  it('rejects when the socket closes before opening', async () => {
    const socket = new FakeSocket();
    const connected = waitForWebSocketOpen(socket, 1_000);
    const event = new Event('close');
    Object.defineProperty(event, 'code', { value: 1006 });
    socket.dispatchEvent(event);
    await expect(connected).rejects.toThrow(/closed before connecting.*1006/);
  });

  it('closes and rejects a connection attempt that times out', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const connected = waitForWebSocketOpen(socket, 50);
      const rejected = connected.catch(error => error as Error);
      await vi.advanceTimersByTimeAsync(50);
      const error = (await rejected) as Error;
      expect(error.message).toMatch(/Timed out connecting/);
      expect(socket.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
