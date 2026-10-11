import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBrowserSelection } from '../extension/browser-selection.js';
import { BrowserSelectionSchema } from '../src/browser-selection.js';

const row = (ids: string[], index: number) => ({
  getAttribute: (name: string) => (name === 'aria-rowindex' ? String(index + 1) : null),
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
          ...row([], index),
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

type Layer = { id: string; selected?: boolean; open?: boolean; children?: Layer[] };

// Disclosure changes the flattened row indices and scroll height, just as in Figma.
const collapsedDom = (layers: Layer[], renderDelay = 0, initialTop = 0) => {
  vi.useFakeTimers();
  const flatten = (
    nodes: Layer[],
    level = 0,
    inherited = false,
  ): { layer: Layer; level: number; expanded: boolean; selected: boolean; root: boolean }[] =>
    nodes.flatMap(layer => [
      {
        layer,
        level,
        expanded: layer.open === true,
        selected: inherited || layer.selected === true,
        root: !inherited && layer.selected === true,
      },
      ...(layer.open
        ? flatten(layer.children ?? [], level + 1, inherited || layer.selected === true)
        : []),
    ]);
  const count = (nodes: Layer[]): number =>
    nodes.reduce((sum, layer) => sum + (layer.selected ? 1 : count(layer.children ?? [])), 0);
  const state = {
    label: `Figma Design, ${count(layers)} items selected`,
    page: 'Current page',
    top: initialTop,
    renderedTop: initialTop,
    rendered: flatten(layers),
    toggles: [] as string[],
    onToggle: (_id: string) => {},
    refuseToggle: false,
  };
  const listeners = new Map<string, (event: { isTrusted: boolean }) => void>();
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  const render = () => {
    state.rendered = flatten(layers);
    state.renderedTop = state.top;
  };
  const schedule = () => {
    clearTimeout(renderTimer);
    if (renderDelay === 0) render();
    else renderTimer = setTimeout(render, renderDelay);
  };
  const scroller = {
    clientHeight: 320,
    get scrollHeight() {
      return state.rendered.length * 32;
    },
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, bottom: 320 }),
    get scrollTop() {
      return state.top;
    },
    set scrollTop(value: number) {
      state.top = Math.max(0, Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight)));
      schedule();
    },
  };
  const rows = () => {
    const first = Math.max(0, Math.floor(state.renderedTop / 32));
    return state.rendered.slice(first, first + 11).map((entry, offset) =>
      Object.assign(row([entry.layer.id], first + offset), {
        getAttribute: (name: string) =>
          ({
            'aria-rowindex': String(first + offset + 1),
            'aria-level': String(entry.level),
            'aria-selected': String(entry.selected),
            'data-fpl-selected-root': String(entry.root),
            ...(entry.layer.children === undefined
              ? {}
              : { 'aria-expanded': String(entry.expanded) }),
          })[name] ?? null,
        getBoundingClientRect: () => ({
          top: (first + offset) * 32 - state.top,
          bottom: (first + offset + 1) * 32 - state.top,
        }),
        querySelector: () =>
          entry.layer.children === undefined
            ? null
            : {
                click: () => {
                  state.toggles.push(entry.layer.id);
                  if (!state.refuseToggle) entry.layer.open = !entry.layer.open;
                  state.onToggle(entry.layer.id);
                  schedule();
                },
              },
      }),
    );
  };
  const roots = () =>
    rows().filter(entry => entry.getAttribute('data-fpl-selected-root') === 'true');
  const tree = {
    parentElement: scroller,
    clientHeight: 0,
    isConnected: true,
    getBoundingClientRect: () => ({
      top: -state.top,
      bottom: state.rendered.length * 32 - state.top,
    }),
    querySelectorAll: rows,
  };
  vi.stubGlobal('location', { href: 'https://www.figma.com/design/file/Test' });
  vi.stubGlobal('getComputedStyle', (element: unknown) => ({
    overflowY: element === scroller ? 'auto' : 'visible',
  }));
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      if (selector.includes('[role="application"]')) return { getAttribute: () => state.label };
      if (selector.includes('PagesRowWrapper'))
        return {
          get textContent() {
            return state.page;
          },
        };
      if (selector.includes('objects-panel')) return tree;
      return roots()[0] ?? null;
    },
    querySelectorAll: roots,
    addEventListener: (name: string, listener: (event: { isTrusted: boolean }) => void) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  return { state, listeners, scroller };
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

  it('reveals 91 selected roots under a collapsed parent and restores its state and scroll', async () => {
    const children = Array.from({ length: 91 }, (_, i) => ({ id: `2:${i}`, selected: true }));
    const parent = { id: '1:1', open: false, children };
    const { state, listeners } = collapsedDom(
      [parent, ...Array.from({ length: 30 }, (_, i) => ({ id: `3:${i}` }))],
      160,
      320,
    );
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      count: 91,
      complete: true,
      nodeIds: children.map(child => child.id),
    });
    expect(parent.open).toBe(false);
    expect(state.top).toBe(320);
    expect(state.toggles).toEqual(['1:1', '1:1']);
    expect(listeners.size).toBe(0);
  });

  it('handles a tree that fits the viewport and preserves ordering across hidden and visible roots', async () => {
    const layers: Layer[] = [
      { id: '1:1', selected: true },
      {
        id: '1:2',
        children: [
          { id: '2:1', children: [{ id: '3:1', selected: true }] },
          { id: '2:2', selected: true },
        ],
      },
      { id: '1:3', selected: true },
    ];
    const { state } = collapsedDom(layers);
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ complete: true, nodeIds: ['1:1', '3:1', '2:2', '1:3'] });
    expect(layers[1]!.open).toBe(false);
    expect(layers[1]!.children![0]!.open).toBe(false);
    expect(state.top).toBe(0);
  });

  it('preserves existing expanded descendants and does not expand selected component roots', async () => {
    const nested: Layer = { id: '2:1', open: true, children: [{ id: '3:1', selected: true }] };
    const layers: Layer[] = [
      { id: '1:1', selected: true, children: [{ id: '4:1' }] },
      { id: '1:2', children: [nested] },
    ];
    const { state } = collapsedDom(layers);
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ complete: true, nodeIds: ['1:1', '3:1'] });
    expect(nested.open).toBe(true);
    expect(state.toggles).toEqual(['1:2', '1:2']);
  });

  it('stops disclosing branches on trusted input without undoing the user action', async () => {
    const parent = { id: '1:1', children: [{ id: '2:1', selected: true }] };
    const { state, listeners } = collapsedDom([parent]);
    state.onToggle = () => listeners.get('pointerdown')?.({ isTrusted: true });
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      complete: false,
      nodeIds: [],
      incompleteReason: 'selection-changed',
    });
    expect(state.toggles).toEqual(['1:1']);
    expect(listeners.size).toBe(0);
  });

  it('bounds a disclosure that Figma does not apply and keeps the result incomplete', async () => {
    const { state } = collapsedDom([{ id: '1:1', children: [{ id: '2:1', selected: true }] }]);
    state.refuseToggle = true;
    const start = Date.now();
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ complete: false, nodeIds: [] });
    expect(Date.now() - start).toBeLessThan(8_100);
    expect(state.toggles).toEqual(['1:1']);
  });

  it.each(['page', 'label'] as const)(
    'discards hidden roots if %s changes during disclosure',
    async field => {
      const { state, listeners } = collapsedDom([
        { id: '1:1', children: [{ id: '2:1', selected: true }] },
      ]);
      state.onToggle = () => {
        state[field] = 'changed';
      };
      const pending = readBrowserSelection();
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        complete: false,
        nodeIds: [],
        incompleteReason: 'selection-changed',
      });
      expect(state.toggles).toEqual(['1:1']);
      expect(listeners.size).toBe(0);
    },
  );

  it('restores the ancestor path when a deeper selection exceeds the search budget', async () => {
    const deepest: Layer = { id: '9:1', selected: true };
    const layers: Layer[] = [
      Array.from({ length: 12 }, (_, i) => i).reduce<Layer>(
        (child, i) => ({ id: `1:${i}`, children: [child] }),
        deepest,
      ),
    ];
    const { state } = collapsedDom(layers, 160);
    const started = Date.now();
    const pending = readBrowserSelection();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ complete: false, nodeIds: [] });
    const closed = (nodes: Layer[]): boolean =>
      nodes.every(node => !node.open && closed(node.children ?? []));
    expect(closed(layers)).toBe(true);
    expect(state.top).toBe(0);
    expect(Date.now() - started).toBeLessThan(8_500);
    expect(state.toggles.length).toBeLessThanOrEqual(128);
  });

  it('follows hinted ancestors through seven collapsed parents ahead of unrelated branches', async () => {
    const target: Layer = { id: '9:1', selected: true };
    const hints: string[] = [];
    const path = Array.from({ length: 7 }, (_, i) => i).reduce<Layer>((child, i) => {
      const id = `2:${i}`;
      hints.push(id);
      return { id, children: [child] };
    }, target);
    const unrelated = Array.from({ length: 40 }, (_, i) => ({
      id: `1:${i}`,
      children: [{ id: `3:${i}` }],
    }));
    const { state } = collapsedDom([...unrelated, path], 32);
    const pending = readBrowserSelection(hints);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ complete: true, nodeIds: ['9:1'] });
    expect(state.toggles.every(id => hints.includes(id))).toBe(true);
    expect(state.toggles).toHaveLength(14);
    expect(path.open).toBe(false);
  });

  it('never treats stale search hints as selected IDs', async () => {
    const { state } = collapsedDom([
      { id: '1:1', children: [{ id: '2:1' }] },
      { id: '1:2', children: [{ id: '2:2', selected: true }] },
    ]);
    const pending = readBrowserSelection(['1:1', '2:1', '999:999']);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ complete: true, nodeIds: ['2:2'] });
    expect(state.toggles).toContain('1:1');
    expect(state.toggles).toContain('1:2');
  });
});
