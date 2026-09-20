---
name: figma-browser-reader
description: Read the current Figma browser selection or a node from a Figma design URL through the local read-only Figwright Kiwi Reader. Use when the user mentions @fk, asks to read or inspect a selected Figma frame, requests design context from a Figma URL, or wants browser Figma data for implementation. Do not use this skill to edit Figma.
---

# Figma browser reader

Use the `fk` MCP tools to read design data captured by the local Chrome extension. This route is
strictly read-only and does not use Figma REST API tokens, OAuth, or the Figma Plugin API.

1. Call `browser_status` before reading. If the extension is not connected or no file has been
   decoded, report the exact status and ask the user to start capture from the FK extension.
2. For implementation in an existing codebase, call `get_implementation_context` with that
   codebase's absolute `rootDir`. It returns full design data, assets, project profile, components,
   icons, and token candidates in one bounded response. Use the individual `get_design_context`,
   `component_map`, `icon_map`, and `token_map` tools only for focused inspection or retrying one
   grounding dimension.
3. Use `get_selection` for a quick identity check and `get_design_context` for design-only inspection
   or a Figma URL. When several decoded tabs make the target ambiguous, call `list_files`. In stdio
   mode, use `use_file`; in shared HTTP mode, pass that tab's `fileKey` or `tabId` to each read.
4. Keep reads bounded. Follow `sectionPlan` and truncation metadata by requesting smaller subtrees
   with the same `rootDir`. Fields listed in `deferred` were intentionally skipped by the planning
   response and become available in those section reads; do not report them as unsupported.
5. Reuse high-confidence component/icon matches, verify medium matches, and treat
   `matchedBy: ['value']` token candidates as name-blind evidence, not proven Figma bindings. Respect
   the portable scan caveat: unknown component props are not evidence that props are absent.
6. Preserve node IDs and report unavailable assets, variables, fonts or component metadata.

Never request Figma cookies, authentication tokens, a personal access token or edit permission.
Never substitute another Figma integration silently when the local reader is unavailable.
