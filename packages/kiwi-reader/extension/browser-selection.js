// This function is serialized into the attached tab. Keep it self-contained and DOM-only.
/* oxlint-disable unicorn/consistent-function-scoping -- Helpers must travel with the serialized function. */
export const readBrowserSelection = async () => {
  const maxIds = 10_000;
  const maxIdChars = 200_000;
  const deadline = Date.now() + 8_000;
  const rootSelector = '[role="row"][aria-selected="true"][data-fpl-selected-root="true"]';
  const rowId = row => {
    const ids = [...row.querySelectorAll('[data-testid$="-layers-panel-row"]')]
      .map(
        element =>
          element
            .getAttribute('data-testid')
            ?.match(/^((?:I)?\d+:\d+(?:;\d+:\d+)*)-layers-panel-row$/)?.[1],
      )
      .filter(id => id !== undefined && id.length <= 2_000);
    return ids.length === 1 ? ids[0] : null;
  };
  const snapshot = () => {
    const application = document.querySelector('[role="application"][aria-label^="Figma "]');
    const label = application?.getAttribute('aria-label') ?? '';
    const page = document.querySelector(
      '[data-testid="PagesRowWrapper"] button[aria-current="page"]',
    );
    const pageText = page?.textContent ?? '';
    const pageName = pageText.length > 0 && pageText.length <= 2_000 ? pageText : null;
    const match = label.match(/, (\d+) items? selected$/);
    // Missing UI or contradictory selected rows must not become an empty selection.
    const empty =
      label === 'Figma Design' &&
      pageName !== null &&
      document.querySelector('[role="row"][aria-selected="true"]') === null;
    return {
      url: location.href,
      pageName,
      count: match === null ? (empty ? 0 : null) : Number(match[1]),
      roots: [...document.querySelectorAll(rootSelector)],
    };
  };
  const initial = snapshot();
  const ids = new Map();
  let idChars = 0;
  let limited = false;
  const collect = roots => {
    for (const root of roots) {
      const id = rowId(root);
      if (id === null || ids.has(id)) continue;
      if (ids.size >= maxIds || idChars + id.length > maxIdChars) {
        limited = true;
        continue;
      }
      idChars += id.length;
      ids.set(id, Number(root.getAttribute('aria-rowindex')) || ids.size + 1);
    }
  };
  const result = (complete, incompleteReason) => ({
    url: initial.url,
    pageName: initial.pageName,
    count: initial.count,
    nodeIds: [...ids].toSorted((a, b) => a[1] - b[1]).map(([id]) => id),
    complete,
    ...(incompleteReason === undefined ? {} : { incompleteReason }),
  });
  collect(initial.roots);
  if (
    initial.count !== null &&
    initial.count === initial.roots.length &&
    initial.count === ids.size
  ) {
    return result(true);
  }
  if (initial.count === null) return result(false, 'selection-unavailable');
  if (limited || initial.count > maxIds) return result(false, 'selection-limit');

  const tree = document.querySelector('[data-testid="objects-panel"][role="treegrid"]');
  let scroller = tree;
  while (scroller !== null) {
    if (
      scroller.clientHeight > 0 &&
      scroller.scrollHeight > scroller.clientHeight &&
      /^(auto|scroll)$/.test(getComputedStyle(scroller).overflowY)
    ) {
      break;
    }
    scroller = scroller.parentElement;
  }
  if (scroller === null) return result(false, 'rows-unavailable');

  const originalTop = scroller.scrollTop;
  const inputEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  let interrupted = false;
  const onInput = event => {
    if (event.isTrusted) interrupted = true;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 32));
  const viewportRendered = () => {
    const viewport = scroller.getBoundingClientRect();
    const content = tree.getBoundingClientRect();
    const style = getComputedStyle(tree);
    const top = Math.max(viewport.top, content.top + (Number.parseFloat(style.paddingTop) || 0));
    const bottom = Math.min(
      viewport.bottom,
      content.bottom - (Number.parseFloat(style.paddingBottom) || 0),
    );
    let first = Infinity;
    let last = -Infinity;
    for (const row of tree.querySelectorAll('[role="row"]')) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom <= bounds.top) continue;
      first = Math.min(first, bounds.top);
      last = Math.max(last, bounds.bottom);
    }
    return bottom > top && first <= top + 1 && last >= bottom - 1;
  };
  const sameSelection = current =>
    !interrupted &&
    current.url === initial.url &&
    current.pageName === initial.pageName &&
    current.count === initial.count &&
    tree.isConnected;
  let complete = false;
  let incompleteReason = 'scan-timeout';
  for (const event of inputEvents) document.addEventListener(event, onInput, true);
  try {
    let top = 0;
    while (Date.now() < deadline) {
      if (!sameSelection(snapshot())) break;
      scroller.scrollTop = top;
      // Scroll offsets update before Figma renders virtual rows. Do not skip a viewport
      // (or declare the bottom exhausted) while its rows still belong to an earlier one.
      do {
        // oxlint-disable-next-line no-await-in-loop -- Wait for this viewport within the shared deadline.
        await settle();
        if (!sameSelection(snapshot())) break;
      } while (Date.now() < deadline && !viewportRendered());
      const current = snapshot();
      if (!sameSelection(current)) break;
      collect(current.roots);
      if (limited) {
        incompleteReason = 'selection-limit';
        break;
      }
      if (ids.size === initial.count) {
        complete = true;
        break;
      }
      if (ids.size > initial.count) {
        interrupted = true;
        break;
      }
      if (!viewportRendered()) break;
      const bottom = scroller.scrollHeight - scroller.clientHeight;
      if (top >= bottom) {
        incompleteReason = 'rows-unavailable';
        break;
      }
      const next = Math.min(bottom, top + Math.max(1, scroller.clientHeight * 0.75));
      if (next <= top) {
        incompleteReason = 'rows-unavailable';
        break;
      }
      top = next;
    }
  } finally {
    // Do not undo a user's scroll or Figma's navigation to a new selection.
    if (sameSelection(snapshot())) {
      scroller.scrollTop = originalTop;
      await settle();
    }
    for (const event of inputEvents) document.removeEventListener(event, onInput, true);
  }
  if (!sameSelection(snapshot())) {
    // IDs collected before an input or navigation cannot describe the new selection.
    ids.clear();
    return result(false, 'selection-changed');
  }
  return result(complete, complete ? undefined : incompleteReason);
};
