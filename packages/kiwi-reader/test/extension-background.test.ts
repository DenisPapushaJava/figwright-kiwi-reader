import { afterEach, describe, expect, it, vi } from 'vitest';

type RuntimeMessageListener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

const event = <T extends (...args: never[]) => unknown>(capture?: (listener: T) => void) => ({
  addListener: vi.fn<(listener: T) => void>((listener: T) => capture?.(listener)),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Kiwi extension background messages', () => {
  it('persists raster capture and still answers when error-state publication fails', async () => {
    let onMessage: RuntimeMessageListener | undefined;
    const storageSet = vi.fn<(value: unknown) => Promise<void>>(async () => undefined);
    const setBadgeText = vi.fn<(details: unknown) => Promise<void>>(async () => undefined);
    const setBadgeBackgroundColor = vi.fn<(details: unknown) => Promise<void>>(
      async () => undefined,
    );
    const setTitle = vi.fn<(details: unknown) => Promise<void>>(async () => undefined);

    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn<() => Promise<{ captureImages: boolean }>>(async () => ({
            captureImages: false,
          })),
          set: storageSet,
        },
      },
      action: { setBadgeText, setBadgeBackgroundColor, setTitle },
      runtime: {
        onMessage: event<RuntimeMessageListener>(listener => {
          onMessage = listener;
        }),
        sendMessage: vi.fn<(message: unknown) => Promise<void>>(async () => undefined),
      },
      debugger: {
        onEvent: event(),
        onDetach: event(),
      },
      tabs: {
        onUpdated: event(),
        onRemoved: event(),
      },
    });

    const moduleUrl = new URL('../extension/background.js', import.meta.url).href;
    await import(/* @vite-ignore */ `${moduleUrl}?runtime-message-test=${Date.now()}`);
    expect(onMessage).toBeTypeOf('function');

    const invoke = (message: Record<string, unknown>): Promise<unknown> =>
      new Promise(resolve => {
        expect(onMessage?.(message, {}, resolve)).toBe(true);
      });

    await expect(
      invoke({ type: 'set-capture-options', tabId: 42, captureImages: true }),
    ).resolves.toMatchObject({
      ok: true,
      state: { tabId: 42, captureImages: true, captureOptionsSupported: true },
    });
    expect(storageSet).toHaveBeenCalledWith({ captureImages: true });

    storageSet.mockRejectedValueOnce(new Error('storage unavailable'));
    setBadgeText.mockRejectedValueOnce(new Error('tab closed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      invoke({ type: 'set-capture-options', tabId: 42, captureImages: false }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'storage unavailable',
      code: 'UNEXPECTED_EXTENSION_ERROR',
    });
  });

  it('sends an image again after the bridge reconnects and resets the capture', async () => {
    let onMessage: RuntimeMessageListener | undefined;
    let onDebuggerEvent:
      | ((source: { tabId: number }, method: string, params: Record<string, unknown>) => void)
      | undefined;
    const sockets: FakeSocket[] = [];
    class FakeSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      sent: Array<Record<string, unknown>> = [];

      constructor(_url: string) {
        super();
        sockets.push(this);
        queueMicrotask(() => {
          this.readyState = FakeSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(data: string) {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
      }

      close(code = 1000) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        const closeEvent = new Event('close');
        Object.defineProperty(closeEvent, 'code', { value: code });
        this.dispatchEvent(closeEvent);
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn<() => Promise<{ captureImages: boolean }>>(async () => ({
            captureImages: true,
          })),
          set: vi.fn<(value: unknown) => Promise<void>>(async () => undefined),
        },
      },
      action: {
        setBadgeText: vi.fn<(details: unknown) => Promise<void>>(async () => undefined),
        setBadgeBackgroundColor: vi.fn<(details: unknown) => Promise<void>>(async () => undefined),
        setTitle: vi.fn<(details: unknown) => Promise<void>>(async () => undefined),
      },
      runtime: {
        onMessage: event<RuntimeMessageListener>(listener => {
          onMessage = listener;
        }),
        sendMessage: vi.fn<(message: unknown) => Promise<void>>(async () => undefined),
      },
      debugger: {
        attach: vi.fn<(target: unknown, version: string) => Promise<void>>(async () => undefined),
        detach: vi.fn<(target: unknown) => Promise<void>>(async () => undefined),
        sendCommand: vi.fn<
          (
            target: unknown,
            command: string,
          ) => Promise<{ body: string; base64Encoded: boolean } | undefined>
        >(async (_target: unknown, command: string) =>
          command === 'Network.getResponseBody'
            ? { body: 'aGVsbG8=', base64Encoded: true }
            : undefined,
        ),
        onEvent: event<NonNullable<typeof onDebuggerEvent>>(listener => {
          onDebuggerEvent = listener;
        }),
        onDetach: event(),
      },
      tabs: {
        get: vi.fn<(tabId: number) => Promise<{ id: number; url: string; title: string }>>(
          async () => ({
            id: 42,
            url: 'https://www.figma.com/design/file/Test',
            title: 'Test',
          }),
        ),
        onUpdated: event(),
        onRemoved: event(),
      },
    });

    const moduleUrl = new URL('../extension/background.js', import.meta.url).href;
    await import(/* @vite-ignore */ `${moduleUrl}?raster-reconnect-test=${Date.now()}`);
    const invoke = (message: Record<string, unknown>): Promise<unknown> =>
      new Promise(resolve => {
        expect(onMessage?.(message, {}, resolve)).toBe(true);
      });
    await expect(invoke({ type: 'connect', tabId: 42 })).resolves.toMatchObject({ ok: true });
    const first = sockets[0];
    expect(first).toBeDefined();
    const imageUrl = 'https://www.figma.com/image/asset.png';
    const receiveImage = (requestId: string) => {
      onDebuggerEvent?.({ tabId: 42 }, 'Network.responseReceived', {
        requestId,
        response: { url: imageUrl, mimeType: 'image/png' },
      });
      onDebuggerEvent?.({ tabId: 42 }, 'Network.loadingFinished', { requestId });
    };
    const assets = (socket: FakeSocket | undefined) =>
      socket?.sent.filter(message => message.type === 'asset') ?? [];

    receiveImage('first');
    await vi.waitFor(() => expect(assets(first)).toHaveLength(1));

    first?.close(1006);
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 3_000 });
    const second = sockets[1];
    await vi.waitFor(() =>
      expect(second?.sent).toContainEqual(expect.objectContaining({ type: 'hello', reset: true })),
    );
    receiveImage('second');
    await vi.waitFor(() => expect(assets(second)).toHaveLength(1));
    second?.close();
  }, 5_000);
});
