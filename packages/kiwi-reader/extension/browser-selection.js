// This function is serialized into the attached tab. Keep it self-contained and DOM-only.
export const readBrowserSelection = () => {
  const application = document.querySelector('[role="application"][aria-label^="Figma "]');
  const label = application?.getAttribute('aria-label') ?? '';
  const page = document.querySelector(
    '[data-testid="PagesRowWrapper"] button[aria-current="page"]',
  );
  const pageText = page?.textContent ?? '';
  const pageName = pageText.length > 0 && pageText.length <= 2_000 ? pageText : null;
  const match = label.match(/, (\d+) items? selected$/);
  const roots = document.querySelectorAll(
    '[role="row"][aria-selected="true"][data-fpl-selected-root="true"]',
  );
  // Loaded Figma Design omits the selection suffix when the selection is empty.
  // Require the active page and no selected rows; missing UI or contradictory rows stay unknown.
  const empty =
    label === 'Figma Design' &&
    pageName !== null &&
    document.querySelector('[role="row"][aria-selected="true"]') === null;
  const count = match === null ? (empty ? 0 : null) : Number(match[1]);
  const ids = new Set();
  for (const root of roots) {
    for (const element of root.querySelectorAll('[data-testid$="-layers-panel-row"]')) {
      const id = element
        .getAttribute('data-testid')
        ?.match(/^((?:I)?\d+:\d+(?:;\d+:\d+)*)-layers-panel-row$/)?.[1];
      if (id !== undefined && ids.size < 100) ids.add(id);
    }
  }
  const nodeIds = [...ids];
  return {
    url: location.href,
    pageName,
    count,
    nodeIds,
    complete: count !== null && count === roots.length && count === nodeIds.length,
  };
};
