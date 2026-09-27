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

describe('FigLens panel', () => {
  it('shows captured nodes, selection and recapture consequence without wire counters', async () => {
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
      title: 'PM DEV – Figma',
      captureOptionsSupported: true,
      captureImages: true,
      selectedNodeId: '6:140',
      selectedNodeName: 'Business',
      nodes: 14741,
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
    await import(/* @vite-ignore */ `${moduleUrl}?panel-test=${Date.now()}`);
    await vi.waitFor(() =>
      expect(elements.get('#status-title')?.textContent).toBe('Структура макета доступна'),
    );
    expect(elements.get('#file-title')?.textContent).toBe('PM DEV');
    expect(elements.get('#file-card')?.hidden).toBe(false);
    expect(elements.get('#node-name')?.textContent).toBe('Business');
    expect(elements.get('#node-name')?.title).toBe('Business');
    expect(elements.get('#capture-summary')?.hidden).toBe(false);
    expect(elements.get('#node-count')?.textContent).toBe('14 741');
    expect(elements.get('#capture-images')?.checked).toBe(true);
    expect(elements.get('#capture-images-help')?.textContent).toContain('Обновить данные');
    expect(elements.get('#primary-action')?.textContent).toBe('Обновить данные');
    expect(elements.get('#recapture-note')?.hidden).toBe(false);
    expect(elements.get('#error-card')?.hidden).toBe(true);
    expect(elements.has('#image-availability')).toBe(false);

    onState?.({
      type: 'kiwi-state',
      state: { ...state, selectedNodeId: '6:141', selectedNodeName: null },
    });
    expect(elements.get('#node-name')?.textContent).toBe('6:141');

    onState?.({ type: 'kiwi-state', state: { ...state, attached: false } });
    expect(elements.get('#primary-action')?.textContent).toBe('Подключить макет');
    expect(elements.get('#file-card')?.hidden).toBe(true);
    expect(elements.get('#capture-summary')?.hidden).toBe(true);
    expect(elements.get('#recapture-note')?.hidden).toBe(true);

    onState?.({ type: 'kiwi-state', state: { ...state, phase: 'error' } });
    expect(elements.get('#error-card')?.hidden).toBe(false);
  });
});
