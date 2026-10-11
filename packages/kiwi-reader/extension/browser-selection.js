// This function is serialized into the attached tab. Keep it self-contained and DOM-only.
export const readBrowserSelection = () => {
  const application = document.querySelector('[role="application"][aria-label^="Figma "]');
  const label = application?.getAttribute('aria-label') ?? '';
  const match = label.match(/, (\d+) items? selected$/);
  const count = match === null ? null : Number(match[1]);
  const roots = document.querySelectorAll(
    '[role="row"][aria-selected="true"][data-fpl-selected-root="true"]',
  );
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
    count,
    nodeIds,
    complete: count !== null && count === roots.length && count === nodeIds.length,
  };
};
