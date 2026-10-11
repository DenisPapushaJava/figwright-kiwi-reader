import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBrowserSelection } from '../extension/browser-selection.js';
import { BrowserSelectionSchema } from '../src/browser-selection.js';

const row = (ids: string[], index: number) => ({
  getAttribute: () => String(index + 1),
  querySelectorAll: () => ids.map(id => ({ getAttribute: () => `${id}-layers-panel-row` })),
});

const mockDom = (label: string, roots: string[][], pageName: string | null = null) => {
  vi.stubGlobal('location', { href: 'https://www.figma.com/design/file/Test?node-id=0-1' });
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      if (selector.includes('[role="application"]')) return { getAttribute: () => label };
      if (selector.includes('PagesRowWrapper'))
        return pageName === null ? null : { textContent: pageName };
      if (selector === '[role="row"][aria-selected="true"]')
        return roots[0] === undefined ? null : {};
      if (selector.includes('objects-panel')) return null;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    querySelectorAll: (selector: string) => {
      // Real Figma also marks descendants selected. Only selected roots identify the selection.
      expect(selector).toContain('[data-fpl-selected-root="true"]');
      return roots.map(row);
    },
  });
};

const virtualDom = (selected: number[], totalRows = 100, initialTop = 640, renderDelay = 0) => {
  vi.useFakeTimers();
  const state = {
    label: `Figma Design, ${selected.length} items selected`,
    pageName: 'Current page',
    url: 'https://www.figma.com/design/file/Test',
    top: initialTop,
    renderedTop: initialTop,
    paddingTop: 0,
    paddingBottom: 0,
    writes: [] as number[],
    onScroll: (_top: number) => {},
  };
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  const firstRenderedRow = () =>
    Math.max(0, Math.floor((state.renderedTop - state.paddingTop) / 32));
  const listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
  const scroller = {
    clientHeight: 320,
    scrollHeight: totalRows * 32,
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, bottom: 320 }),
    get scrollTop() {
      return state.top;
    },
    set scrollTop(top: number) {
      state.top = top;
      state.writes.push(top);
      state.onScroll(top);
      if (renderDelay === 0) state.renderedTop = top;
      else {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => {
          state.renderedTop = top;
        }, renderDelay);
      }
    },
  };
  const tree = {
    clientHeight: totalRows * 32,
    scrollHeight: totalRows * 32,
    parentElement: scroller,
    isConnected: true,
    getBoundingClientRect: () => ({
      top: -state.top,
      bottom: totalRows * 32 + state.paddingTop + state.paddingBottom - state.top,
    }),
    querySelectorAll: () =>
      Array.from({ length: Math.min(11, totalRows - firstRenderedRow()) }, (_, i) => {
        const index = firstRenderedRow() + i;
        return {
          getBoundingClientRect: () => ({
            top: index * 32 + state.paddingTop - state.top,
            bottom: (index + 1) * 32 + state.paddingTop - state.top,
          }),
        };
      }),
  };
  const roots = () =>
    selected
      .filter(index => index >= firstRenderedRow() && index < firstRenderedRow() + 11)
      .map(index => row([`1:${index}`], index));
  vi.stubGlobal('location', {
    get href() {
      return state.url;
    },
  });
  vi.stubGlobal('getComputedStyle', (element: unknown) => ({
    overflowY: element === scroller ? 'auto' : 'visible',
    paddingTop: `${state.paddingTop}px`,
    paddingBottom: `${state.paddingBottom}px`,
  }));
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      if (selector.includes('[role="application"]')) return { getAttribute: () => state.label };
      if (selector.includes('PagesRowWrapper'))
        return {
          get textContent() {
            return state.pageName;
          },
        };
      if (selector === '[role="row"][aria-selected="true"]') return roots()[0] ?? null;
      if (selector.includes('objects-panel')) return tree;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    querySelectorAll: () => roots(),
    addEventListener: (event: string, listener: (event: { isTrusted: boolean }) => void) =>
      listeners.set(event, listener),
    removeEventListener: (event: string) => listeners.delete(event),
  });
  return { state, tree, scroller, listeners };
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Figma DOM selection', () => {
  it('reads both selected checkbox roots while the URL still points to the page', async () => {
    mockDom('Figma Design, 2 items selected', [['4990:19595'], ['4990:19603']]);
    expect(await readBrowserSelection()).toEqual({
      url: 'https://www.figma.com/design/file/Test?node-id=0-1',
      pageName: null,
      count: 2,
      nodeIds: ['4990:19595', '4990:19603'],
      complete: true,
    });
  });

  it('recognizes the real empty-selection label only with an active page and no selected rows', async () => {
    mockDom('Figma Design', [], 'Current page');
    expect(await readBrowserSelection()).toMatchObject({
      count: 0,
      complete: true,
      pageName: 'Current page',
    });
    mockDom('Figma Design', [['1:2']], 'Current page');
    expect(await readBrowserSelection()).toMatchObject({ count: null, complete: false });
    mockDom('Figma Design, selection unavailable', [], 'Current page');
    expect(await readBrowserSelection()).toMatchObject({ count: null, complete: false });
    mockDom('Figma Design', [], 'x'.repeat(2_001));
    expect(await readBrowserSelection()).toMatchObject({
      count: null,
      complete: false,
      pageName: null,
    });
  });

  it.each([
    { label: 'Figma Design, 1 item selected', roots: [['1:2']], count: 1, complete: true },
    { label: 'Figma Design, 0 items selected', roots: [], count: 0, complete: true },
    { label: 'Figma Design', roots: [], count: null, complete: false },
    {
      label: 'Figma Design, 3 items selected',
      roots: [['1:2'], ['1:3']],
      count: 3,
      complete: false,
    },
    { label: 'Figma Design, 1 item selected', roots: [[]], count: 1, complete: false },
    {
      label: 'Figma Design, 2 items selected',
      roots: [['1:2'], ['1:2']],
      count: 2,
      complete: false,
    },
    { label: 'Figma Design, 1 item selected', roots: [['I1:2;3:4']], count: 1, complete: true },
  ])('reports completeness for $label, $roots', async ({ label, roots, count, complete }) => {
    mockDom(label, roots);
    expect(await readBrowserSelection()).toMatchObject({ count, complete });
  });

  it('reads more than 100 IDs and keeps the transport contract aligned', async () => {
    mockDom(
      'Figma Design, 150 items selected',
      Array.from({ length: 150 }, (_, i) => [`1:${i}`]),
    );
    const selection = await readBrowserSelection();
    expect(selection).toMatchObject({ count: 150, complete: true });
    expect(selection.nodeIds).toHaveLength(150);
    expect(BrowserSelectionSchema.safeParse(selection).success).toBe(true);
  });

  it('bounds the number and total length of IDs and rejects unrelated identifiers', async () => {
    mockDom(
      'Figma Design, 10001 items selected',
      Array.from({ length: 10_001 }, (_, i) => [`1:${i}`]),
    );
    const selection = await readBrowserSelection();
    expect(selection).toMatchObject({
      count: 10_001,
      complete: false,
      incompleteReason: 'selection-limit',
    });
    expect(selection.nodeIds).toHaveLength(10_000);
    expect(BrowserSelectionSchema.safeParse(selection).success).toBe(true);
    const longIds = Array.from({ length: 200 }, (_, i) => `I1:${i};${'2:3;'.repeat(400)}2:3`);
    mockDom(
      'Figma Design, 200 items selected',
      longIds.map(id => [id]),
    );
    const longSelection = await readBrowserSelection();
    expect(longSelection).toMatchObject({ complete: false, incompleteReason: 'selection-limit' });
    expect(BrowserSelectionSchema.safeParse(longSelection).success).toBe(true);
    expect(BrowserSelectionSchema.safeParse({ ...longSelection, nodeIds: longIds }).success).toBe(
      false,
    );
    mockDom('Figma Design, 1 item selected', [['not-a-node']]);
    expect(await readBrowserSelection()).toMatchObject({ nodeIds: [], complete: false });
    // A row containing multiple different node IDs is ambiguous, not a selection of both.
    mockDom('Figma Design, 2 items selected', [['1:1', '1:2'], []]);
    expect(await readBrowserSelection()).toMatchObject({ nodeIds: [], complete: false });
  });

  it('collects distant virtualized roots in layer order and restores the original scroll', async () => {
    const selected = [0, 5, 20, 40, 70, 99];
    const { state, listeners } = virtualDom(selected);
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      nodeIds: selected.map(index => `1:${index}`),
      count: 6,
      complete: true,
    });
    expect(state.top).toBe(640);
    expect(state.writes.length).toBeGreaterThan(2);
    expect(listeners.size).toBe(0);
  });

  it('does not guess IDs hidden inside collapsed ancestors', async () => {
    const { state } = virtualDom([0, 20]);
    state.label = 'Figma Design, 3 items selected';
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      nodeIds: ['1:0', '1:20'],
      count: 3,
      complete: false,
      incompleteReason: 'rows-unavailable',
    });
    expect(state.top).toBe(640);
  });

  it('waits for delayed virtual rows instead of skipping most of a large selection', async () => {
    const selected = Array.from({ length: 91 }, (_, index) => index);
    const { state, listeners } = virtualDom(selected, 100, 640, 160);
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      nodeIds: selected.map(index => `1:${index}`),
      count: 91,
      complete: true,
    });
    expect(state.top).toBe(640);
    expect(listeners.size).toBe(0);
  });

  it('waits for the last viewport to render before declaring rows unavailable', async () => {
    const { state } = virtualDom([99], 100, 640, 160);
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ nodeIds: ['1:99'], count: 1, complete: true });
    expect(state.top).toBe(640);
  });

  it('allows the layer tree padding at the ends of the rendered range', async () => {
    const { state, scroller } = virtualDom([99], 100, 640, 160);
    state.label = 'Figma Design, 2 items selected';
    state.paddingTop = 4;
    state.paddingBottom = 18;
    scroller.scrollHeight += 22;
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      nodeIds: ['1:99'],
      complete: false,
      incompleteReason: 'rows-unavailable',
    });
    expect(state.top).toBe(640);
  });

  it('keeps the deadline when virtual rows never render and does not skip ahead', async () => {
    const { state, listeners } = virtualDom([0, 99], 100, 640, 20_000);
    const started = Date.now();
    let finished = 0;
    const pending = readBrowserSelection().then(result => {
      finished = Date.now();
      return result;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await pending).toMatchObject({ complete: false, incompleteReason: 'scan-timeout' });
    expect(finished - started).toBeLessThan(8_100);
    expect(state.writes).toEqual([0, 640]);
    expect(listeners.size).toBe(0);
  });

  it('cancels while waiting for virtual rows without undoing user input', async () => {
    const { state, listeners } = virtualDom([0, 20, 99], 100, 640, 160);
    state.onScroll = top => {
      if (top === 0) setTimeout(() => listeners.get('wheel')?.({ isTrusted: true }), 64);
    };
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      nodeIds: [],
      complete: false,
      incompleteReason: 'selection-changed',
    });
    expect(state.writes).toEqual([0]);
    expect(listeners.size).toBe(0);
  });

  it.each(['pointerdown', 'keydown', 'wheel', 'touchstart'])(
    'discards accumulated IDs on trusted %s without fighting the user',
    async event => {
      const { state, listeners } = virtualDom([0, 20, 99]);
      state.onScroll = top => {
        if (top === 240) listeners.get(event)?.({ isTrusted: true });
      };
      const pending = readBrowserSelection();
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        nodeIds: [],
        complete: false,
        incompleteReason: 'selection-changed',
      });
      expect(state.top).toBe(240);
      expect(listeners.size).toBe(0);
    },
  );

  it.each(['url', 'pageName', 'label'] as const)(
    'discards IDs when %s changes during the scan',
    async field => {
      const { state, listeners } = virtualDom([0, 20, 99]);
      state.onScroll = top => {
        if (top === 240) state[field] = 'changed';
      };
      const pending = readBrowserSelection();
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        nodeIds: [],
        complete: false,
        incompleteReason: 'selection-changed',
      });
      expect(state.top).toBe(240);
      expect(listeners.size).toBe(0);
    },
  );

  it('checks for changed selection even during scroll restoration', async () => {
    const { state, listeners } = virtualDom([0, 20, 99]);
    state.onScroll = top => {
      if (top === 640) listeners.get('keydown')?.({ isTrusted: true });
    };
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      nodeIds: [],
      complete: false,
      incompleteReason: 'selection-changed',
    });
    expect(listeners.size).toBe(0);
  });

  it('bounds scanning time and restores scroll when roots remain unavailable', async () => {
    const { state } = virtualDom([0, 20], 1_000_000);
    state.label = 'Figma Design, 3 items selected';
    const started = Date.now();
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ complete: false, incompleteReason: 'scan-timeout' });
    expect(Date.now() - started).toBeLessThan(8_100);
    expect(state.top).toBe(640);
  });
});
