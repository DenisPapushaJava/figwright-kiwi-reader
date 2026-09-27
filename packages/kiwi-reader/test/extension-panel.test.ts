import { afterEach, describe, expect, it, vi } from 'vitest';

interface PanelElement {
  textContent: string;
  hidden: boolean;
  checked: boolean;
  disabled: boolean;
  className: string;
  title: string;
  addEventListener: () => void;
}

const panelElement = (): PanelElement => ({
  textContent: '',
  hidden: false,
  checked: false,
  disabled: false,
  className: '',
  title: '',
  addEventListener: () => undefined,
});

afterEach(() => vi.unstubAllGlobals());

describe('FigLens raster availability panel', () => {
  it('shows selected-node counts, recapture guidance, and partial-scope wording', async () => {
    const elements = new Map<string, PanelElement>();
    vi.stubGlobal('document', {
      body: { classList: { contains: (name: string) => name === 'side-panel' } },
      querySelector: (selector: string): PanelElement => {
        const existing = elements.get(selector);
        if (existing !== undefined) return existing;
        const created = panelElement();
        elements.set(selector, created);
        return created;
      },
    });

    let onState: ((message: { type: string; state: unknown }) => void) | undefined;
    const state = {
      tabId: 42,
      attached: true,
      phase: 'ready',
      captureOptionsSupported: true,
      captureImages: true,
      selectedRasterImages: { images: 3, availableImages: 2, truncated: false },
    };
    vi.stubGlobal('chrome', {
      runtime: {
        getManifest: () => ({ version: '0.5.1' }),
        sendMessage: (_message: unknown, callback: (response: unknown) => void) =>
          callback({ ok: true, state }),
        onMessage: {
          addListener: (listener: typeof onState) => {
            onState = listener;
          },
        },
      },
      tabs: {
        query: async () => [{ id: 42, url: 'https://www.figma.com/design/file/Test' }],
        onActivated: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined },
      },
    });

    const moduleUrl = new URL('../extension/popup.js', import.meta.url).href;
    await import(/* @vite-ignore */ `${moduleUrl}?panel-raster-test=${Date.now()}`);
    const availability = elements.get('#image-availability');
    const count = elements.get('#image-availability-count');
    const help = elements.get('#image-availability-help');
    await vi.waitFor(() => expect(count?.textContent).toBe('Доступно 2 из 3 изображений'));
    expect(availability?.hidden).toBe(false);
    expect(help?.textContent).toContain('Считать заново');

    onState?.({
      type: 'kiwi-state',
      state: {
        ...state,
        selectedRasterImages: { images: 3, availableImages: 3, truncated: false },
      },
    });
    expect(count?.textContent).toBe('Доступно 3 из 3 изображений');
    expect(help?.textContent).toBe('');

    onState?.({
      type: 'kiwi-state',
      state: {
        ...state,
        captureImages: false,
        selectedRasterImages: { images: 3, availableImages: 2, truncated: true },
      },
    });
    expect(count?.textContent).toBe('Доступно 2 из 3 в прочитанной части узла');
    expect(help?.textContent).toContain('Включите захват');

    onState?.({ type: 'kiwi-state', state: { ...state, attached: false } });
    expect(availability?.hidden).toBe(true);
  });
});
