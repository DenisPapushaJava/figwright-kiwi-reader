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
});
