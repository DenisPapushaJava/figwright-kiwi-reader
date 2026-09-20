---
name: figma-kiwi-reader
description: Develop and validate Figwright's browser-only, read-only Figma source built from Chrome DevTools Protocol capture and the Kiwi wire protocol. Use for Kiwi decoding, the Chrome extension, scenegraph caching, browser MCP tools, payload budgets, SVG/image extraction, or replacing the Figma plugin read path. Do not use for the existing Figma plugin write path.
---

# figma-kiwi-reader

Build a browser-only read source for Figwright that works from an authenticated Figma tab without
the Figma Plugin API, REST tokens, OAuth, or REST request quotas. Keep it strictly read-only.

Before changing this feature, read
[`references/implementation-plan.md`](./references/implementation-plan.md). Follow its phase order
unless current evidence requires a change; when that happens, update the plan with the reason.

## Non-negotiable boundaries

- Capture only server-to-browser traffic. Never forward sent WebSocket frames or implement Kiwi
  mutations.
- Never extract, persist, log, or send Figma cookies or authentication tokens.
- Bind local services to `127.0.0.1` and authenticate the extension-to-server connection.
- Do not commit captures from private Figma files. Use synthetic fixtures for automated tests.
- Filter `editInfo`, per-glyph derived text data, and other personal or high-volume fields before an
  MCP result reaches an agent.
- Treat Kiwi as undocumented and version-unstable. Compile the schema from each session's
  `fig-wire` frame and fail with a useful compatibility error when decoding changes.
- Keep the existing plugin transport and write tools working unchanged. Introduce the Kiwi path as
  a separate read provider and prove parity before considering shared routing.

## Engineering rules

- Preserve message-local `blobs[]` and resolve numeric `*Blob` references before discarding a wire
  frame; SVG extraction cannot be added correctly afterwards.
- Normalize Kiwi data into the existing `@figwright/shared` schemas. Do not establish a second
  long-lived node contract.
- Apply depth, node-count, UTF-8 byte, and field budgets before returning results. Preflight the
  design slice before project scans, and return a section plan or explicit truncation metadata rather
  than a multi-megabyte raw dump.
- Treat fields listed in an implementation response's `deferred` array as intentionally postponed,
  not unavailable. Request every `sectionPlan` node with the same `rootDir` before grounding or code
  generation.
- In the shared HTTP hub, route every read explicitly with `tabId` or `fileKey` after `list_files`
  when more than one tab is available. Never add process-global active-file state to shared mode.
- Keep one capture owner and fan out normalized reads through Streamable HTTP. Preserve the stdio
  entry point as a compatibility adapter; do not start one capture server per connected IDE.
- Keep raw dumps behind an explicit diagnostic flag. They are not MCP responses.
- Validate incremental changes, reconnects, tab/file routing, and deletion independently from the
  initial `CREATED` snapshot.
- Compare the same real node through Kiwi and the ordinary Figwright plugin whenever plugin access
  is available. A screenshot is supporting evidence, not the structural oracle.
- Before generating code in a project with an existing UI kit, call `get_implementation_context`
  with that project's absolute `rootDir`. It combines the full design tree with `component_map`,
  `icon_map`, and `token_map` evidence in one bounded response. Use the separate mapping tools only
  for focused retries. Reuse high-confidence component/icon matches and verify medium matches. Treat
  every Kiwi token candidate marked `matchedBy: ['value']` as name-blind reuse evidence, not a proven
  Figma binding. Never infer missing component props when the result reports the portable name-only
  scan caveat.
- After changes to `mcp` or `shared`, build before live testing because the server runs `dist`.
- When changing scenegraph caching, preserve dependencies outside the requested subtree: parent layout
  context, component masters, component sets, and both ancestor chains of a reparented node.
- Run the repository's canonical root gates before completion: `corepack pnpm typecheck`, `lint`,
  `format:check`, `knip`, `build`, and `test`.

## Proven baseline

Live browser tests decoded a small file with 860 nodes and a large file with 65,662 nodes. The large
section produced about 26.7 MB of raw JSON, demonstrating both that capture works and that projection
and payload budgets are required before agent use.
