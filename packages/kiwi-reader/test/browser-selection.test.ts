import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBrowserSelection } from '../extension/browser-selection.js';

const mockDom = (label: string, roots: string[][], pageName: string | null = null) => {
  vi.stubGlobal('location', { href: 'https://www.figma.com/design/file/Test?node-id=0-1' });
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      if (selector.includes('[role="application"]')) return { getAttribute: () => label };
      if (selector.includes('PagesRowWrapper'))
        return pageName === null ? null : { textContent: pageName };
      if (selector === '[role="row"][aria-selected="true"]')
        return roots[0] === undefined ? null : {};
      throw new Error(`Unexpected selector: ${selector}`);
    },
    querySelectorAll: (selector: string) => {
      // Real Figma also marks descendants selected. Only selected roots identify the selection.
      expect(selector).toContain('[data-fpl-selected-root="true"]');
      return roots.map(ids => ({
        querySelectorAll: () => ids.map(id => ({ getAttribute: () => `${id}-layers-panel-row` })),
      }));
    },
  });
};

afterEach(() => vi.unstubAllGlobals());

describe('Figma DOM selection', () => {
  it('reads both selected checkbox roots while the URL still points to the page', () => {
    mockDom('Figma Design, 2 items selected', [['4990:19595'], ['4990:19603']]);
    expect(readBrowserSelection()).toEqual({
      url: 'https://www.figma.com/design/file/Test?node-id=0-1',
      pageName: null,
      count: 2,
      nodeIds: ['4990:19595', '4990:19603'],
      complete: true,
    });
  });

  it('recognizes the real empty-selection label only with an active page and no selected rows', () => {
    mockDom('Figma Design', [], 'Current page');
    expect(readBrowserSelection()).toMatchObject({
      count: 0,
      complete: true,
      pageName: 'Current page',
    });
    mockDom('Figma Design', [['1:2']], 'Current page');
    expect(readBrowserSelection()).toMatchObject({ count: null, complete: false });
    mockDom('Figma Design, selection unavailable', [], 'Current page');
    expect(readBrowserSelection()).toMatchObject({ count: null, complete: false });
    mockDom('Figma Design', [], 'x'.repeat(2_001));
    expect(readBrowserSelection()).toMatchObject({ count: null, complete: false, pageName: null });
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
  ])('reports completeness for $label, $roots', ({ label, roots, count, complete }) => {
    mockDom(label, roots);
    expect(readBrowserSelection()).toMatchObject({ count, complete });
  });

  it('bounds large selections and rejects identifiers unrelated to layers', () => {
    mockDom(
      'Figma Design, 150 items selected',
      Array.from({ length: 150 }, (_, i) => [`1:${i}`]),
    );
    expect(readBrowserSelection()).toMatchObject({ count: 150, complete: false });
    expect(readBrowserSelection().nodeIds).toHaveLength(100);
    mockDom('Figma Design, 1 item selected', [['not-a-node']]);
    expect(readBrowserSelection()).toMatchObject({ nodeIds: [], complete: false });
  });
});
