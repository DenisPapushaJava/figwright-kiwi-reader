// This function is serialized into the attached tab. Keep it self-contained and DOM-only.
/* oxlint-disable unicorn/consistent-function-scoping -- Helpers must travel with the serialized function. */
export const readBrowserSelection = async (revealNodeIds = []) => {
  const hints = new Set(revealNodeIds.slice(0, 512));
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
  const collect = (roots, parent) => {
    for (const root of roots) {
      const id = rowId(root);
      if (id === null) continue;
      const index = Number(root.getAttribute('aria-rowindex')) || ids.size + 1;
      const order = parent === undefined ? [index] : [...parent.order, index - parent.index];
      if (ids.has(id)) {
        ids.set(id, order);
        continue;
      }
      if (ids.size >= maxIds || idChars + id.length > maxIdChars) {
        limited = true;
        continue;
      }
      idChars += id.length;
      ids.set(id, order);
    }
  };
  const result = (complete, incompleteReason) => ({
    url: initial.url,
    pageName: initial.pageName,
    count: initial.count,
    nodeIds: [...ids]
      .toSorted((a, b) => {
        for (let i = 0; i < Math.min(a[1].length, b[1].length); i++) {
          if (a[1][i] !== b[1][i]) return a[1][i] - b[1][i];
        }
        return a[1].length - b[1].length;
      })
      .map(([id]) => id),
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
    if (scroller.clientHeight > 0 && /^(auto|scroll)$/.test(getComputedStyle(scroller).overflowY)) {
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
  const findRow = id => [...tree.querySelectorAll('[role="row"]')].find(row => rowId(row) === id);
  const waitFor = async (predicate, until) => {
    do {
      // oxlint-disable-next-line no-await-in-loop -- Poll the same DOM state within a shared deadline.
      await settle();
      if (!sameSelection(snapshot())) return false;
      if (predicate()) return true;
    } while (Date.now() < until);
    return false;
  };
  const scan = async (until, parent) => {
    const candidates = new Map();
    let top = parent?.top ?? 0;
    while (Date.now() < until) {
      if (!sameSelection(snapshot())) break;
      scroller.scrollTop = top;
      // Scroll offsets update before Figma renders virtual rows. Do not skip a viewport
      // (or declare the bottom exhausted) while its rows still belong to an earlier one.
      // oxlint-disable-next-line no-await-in-loop -- Scan consecutive virtual viewports.
      const rendered = await waitFor(viewportRendered, until);
      const current = snapshot();
      if (!sameSelection(current)) break;
      const rows = [...tree.querySelectorAll('[role="row"]')];
      const boundary =
        parent === undefined
          ? undefined
          : rows.find(
              row =>
                Number(row.getAttribute('aria-rowindex')) > parent.index &&
                Number(row.getAttribute('aria-level')) <= parent.level,
            );
      const end =
        boundary === undefined ? Infinity : Number(boundary.getAttribute('aria-rowindex'));
      collect(
        parent === undefined
          ? current.roots
          : current.roots.filter(root => {
              const index = Number(root.getAttribute('aria-rowindex'));
              return index > parent.index && index < end;
            }),
        parent,
      );
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
      if (!rendered) break;
      for (const row of rows) {
        if (
          row.getAttribute('aria-expanded') !== 'false' ||
          row.getAttribute('aria-selected') !== 'false'
        )
          continue;
        const id = rowId(row);
        const index = Number(row.getAttribute('aria-rowindex'));
        const rawLevel = row.getAttribute('aria-level');
        const level = Number(rawLevel);
        if (
          id === null ||
          !Number.isInteger(index) ||
          index < 1 ||
          rawLevel === null ||
          !Number.isInteger(level) ||
          level < 0 ||
          (parent !== undefined && (index <= parent.index || index >= end)) ||
          candidates.has(id) ||
          candidates.size >= 128
        )
          continue;
        candidates.set(id, {
          id,
          index,
          level,
          top:
            scroller.scrollTop +
            row.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top,
          order: parent === undefined ? [index] : [...parent.order, index - parent.index],
        });
      }
      if (boundary !== undefined) return { candidates: [...candidates.values()], exhausted: true };
      const bottom = scroller.scrollHeight - scroller.clientHeight;
      if (top >= bottom) {
        incompleteReason = 'rows-unavailable';
        return { candidates: [...candidates.values()], exhausted: true };
      }
      const next = Math.min(bottom, top + Math.max(1, scroller.clientHeight * 0.75));
      if (next <= top) {
        incompleteReason = 'rows-unavailable';
        break;
      }
      top = next;
    }
    return { candidates: [...candidates.values()], exhausted: false };
  };
  // Search shallow branches first. Keep only the current ancestor path expanded,
  // reserving time to close it before Chrome's evaluation timeout.
  const revealUntil = deadline - 2_000;
  let disclosures = 0;
  let restored = true;
  const reveal = async (candidate, depth, hintedOnly = false) => {
    if (
      !restored ||
      complete ||
      disclosures >= 64 ||
      Date.now() >= revealUntil ||
      !sameSelection(snapshot())
    )
      return;
    scroller.scrollTop = candidate.top;
    if (
      !(await waitFor(() => viewportRendered() && findRow(candidate.id) !== undefined, revealUntil))
    )
      return;
    const row = findRow(candidate.id);
    if (
      row?.getAttribute('aria-expanded') !== 'false' ||
      row.getAttribute('aria-selected') !== 'false'
    )
      return;
    const caret = row.querySelector('button[data-testid="layers-panel-expand-caret"]');
    if (caret === null) return;
    disclosures++;
    try {
      caret.click();
      if (
        !(await waitFor(
          () => findRow(candidate.id)?.getAttribute('aria-expanded') === 'true',
          revealUntil,
        ))
      )
        return;
      const branch = await scan(revealUntil, candidate);
      if (branch.exhausted && depth > 1) {
        for (const child of branch.candidates) {
          if (hintedOnly && !hints.has(child.id)) continue;
          // oxlint-disable-next-line no-await-in-loop -- Restore a child before visiting its sibling.
          await reveal(child, depth - 1, hintedOnly);
          if (complete || !restored || Date.now() >= revealUntil || !sameSelection(snapshot()))
            break;
        }
      }
    } finally {
      if (sameSelection(snapshot())) {
        scroller.scrollTop = candidate.top;
        const ready = await waitFor(
          () => viewportRendered() && findRow(candidate.id) !== undefined,
          deadline,
        );
        const expanded = ready ? findRow(candidate.id) : undefined;
        if (expanded?.getAttribute('aria-expanded') === 'true') {
          expanded.querySelector('button[data-testid="layers-panel-expand-caret"]')?.click();
          if (
            !(await waitFor(
              () => findRow(candidate.id)?.getAttribute('aria-expanded') === 'false',
              deadline,
            ))
          )
            restored = false;
        } else if (!ready) restored = false;
      }
    }
  };
  for (const event of inputEvents) document.addEventListener(event, onInput, true);
  try {
    const visible = await scan(deadline);
    if (visible.exhausted && !complete && !limited) {
      // A stale URL or previous selection can guide disclosure, never supply selected IDs.
      for (const candidate of visible.candidates) {
        if (!hints.has(candidate.id)) continue;
        // oxlint-disable-next-line no-await-in-loop -- Follow only hinted ancestor paths first.
        await reveal(candidate, 8, true);
        if (complete || !restored || Date.now() >= revealUntil || !sameSelection(snapshot())) break;
      }
      for (let depth = 1; depth <= 8; depth++) {
        for (const candidate of visible.candidates) {
          // oxlint-disable-next-line no-await-in-loop -- Reveal one branch and restore it before the next.
          await reveal(candidate, depth);
          if (complete || !restored || Date.now() >= revealUntil || !sameSelection(snapshot()))
            break;
        }
        if (
          Date.now() >= revealUntil ||
          complete ||
          disclosures >= 64 ||
          !restored ||
          !sameSelection(snapshot()) ||
          visible.candidates.length === 0
        )
          break;
      }
      if (!complete && Date.now() >= revealUntil) incompleteReason = 'scan-timeout';
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
  return result(complete && restored, complete && restored ? undefined : incompleteReason);
};
