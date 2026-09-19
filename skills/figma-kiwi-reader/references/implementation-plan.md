# Browser-only Kiwi reader implementation plan

## Target outcome

Provide a production-usable, read-only MCP entry point that reads the Figma document already loaded
in Chrome and returns the existing Figwright read contracts. It must require no Figma plugin, file
administrator approval, REST token, OAuth grant, or REST API quota.

Data path:

```text
Figma tab -> Chrome debugger extension -> localhost capture service
          -> dynamic Kiwi decoder -> session scenegraph/cache
          -> Figwright normalizer -> bounded read-only MCP tools -> agent
```

## Current status

### Complete: feasibility baseline

- Chrome MV3 extension attaches through `chrome.debugger`.
- Only `Network.webSocketFrameReceived` binary frames are forwarded.
- The dynamic schema is decoded from the session's `fig-wire` frame.
- Initial node changes are merged into an addressable tree.
- A one-shot probe reads a node from a pasted Figma URL.
- Extension disconnect state and origin checks are covered.
- Synthetic unit/integration tests pass.
- Live tests succeeded on files containing 860 and 65,662 nodes.
- Probe output is compact by default; `--raw` is explicit.
- A persistent `serve.mjs` process now keeps capture state after the initial read.
- Browser messages carry `tabId`; independent caches and selected `node-id` values are maintained
  for multiple attached tabs, including two tabs showing the same Figma file.
- The extension reports reconnect states and retries an unexpectedly lost local bridge with bounded
  backoff.
- The extension has a stable manifest identity; the server accepts only that exact origin.
- Per-tab detach messages remove stale sessions, capture progress is throttled, and frame, bridge
  queue, WebSocket message and scenegraph node limits fail explicitly.
- A pure Kiwi-to-`SerializedNode` normalizer now validates geometry, solid/gradient/image paints,
  effects, corner/stroke data, text and horizontal/vertical auto-layout against the shared schema.
- A separate read-only MCP entry point advertises six browser tools and applies a 2,000-node,
  depth and 1.5-million-character budget before returning data to an agent.

The implementation is under `packages/kiwi-reader`. The upstream research source and pinned commit
are recorded in `packages/kiwi-reader/THIRD_PARTY.md`.

## Phase 1: durable capture and session model

Build this before exposing MCP tools.

- Replace the one-shot lifecycle with a persistent capture service.
- Add extension reconnect with bounded backoff and clear ON/OFF/ERR state.
- Include extension tab id, Figma file key, URL, and title in every session identity.
- Support multiple Figma tabs without replacing one global socket/session.
- Pin the unpacked extension to a stable manifest public key and accept only its exact
  `chrome-extension://` origin. This avoids an out-of-band pairing-secret workflow while preventing
  unrelated installed extensions from replacing the local capture connection.
- Bound frame size, queued bytes, decoded-node count, and memory; report the limiting condition.
- Preserve `blobs[]` per decoded message and resolve each node's numeric `*Blob` references into a
  stable blob store before the next message arrives.
- Verify incremental node updates, reparenting, removal, reconnect, full reload, and schema reset on
  a real file. Do not assume the initial `CREATED` snapshot proves update semantics.

Exit criteria: two tabs can stay connected, each file remains isolated, edits in one tab update only
its cache, reconnect recovers automatically, and memory/queue limits fail explicitly.

## Phase 2: Kiwi-to-Figwright normalization

Status: the observed-property slice and read-only instance expansion are implemented. Instances are
resolved through `symbolData.symbolID`, cloned with instance-scoped ids, and receive text component
properties plus `symbolOverrides` / `derivedSymbolData`. Live parity for additional component
property kinds, tokens, mixed text and assets is still open.

Create a pure normalizer that emits the existing `SerializedNode` contract from `@figwright/shared`.
Start with properties already observed live:

- `guid` -> `id`; `parentIndex.guid` -> `parentId`.
- `size` -> `width`/`height`; `transform` -> `x`/`y` and rotation.
- visibility, opacity, blend mode, corner radii, masks, clipping and constraints.
- `fillPaints`, `strokePaints`, weights, alignment, caps, joins and effects.
- stack/auto-layout mode, padding, gaps, alignment, wrapping, child sizing and absolute positioning.
- `textData.characters`, font, size, line height, letter spacing, alignment, case, decoration and
  paragraph properties. Drop glyph positions and other derived rendering caches.
- `symbolData`, component property assignments, main component identity and instance overrides.
- shared-style ids and variable bindings when their names/values can be resolved faithfully.

Preserve unknown Kiwi properties only in an internal diagnostic view. They must not leak into the
public node schema merely because they exist on the wire.

Exit criteria: schema validation passes, compact output for representative nodes matches the plugin
result field by field, and every intentional difference is documented with a fidelity note.

## Phase 3: isolated read-only MCP entry point

Status: initial entry point implemented with `browser_status`, `list_files`, `use_file`,
`get_selection`, `get_node`, and `get_design_context`; live Codex configuration and round-trip remain
to be completed.

Keep the first usable server separate from the bidirectional `@figwright/mcp` entry point so the
experiment cannot regress plugin routing or writes. Reuse existing tool specs, schemas, node-id URL
normalization, design-context projection and payload guards where possible.

Initial tools, in order:

1. `ping` or `browser_status` for connection, schema, file and cache state.
2. `list_files` and `use_file` for deterministic multi-tab routing.
3. `get_node` and `get_nodes_info`.
4. `search_nodes`, `scan_text_nodes`, and `scan_nodes_by_types`.
5. `get_design_context` with `minimal`, `compact`, and `full` detail.

Do not advertise write tools in this entry point. Avoid a server that lists writes only to reject
them at runtime; the advertised capability surface should be honestly read-only.

Exit criteria: a standard MCP client can start the server, bind a browser tab, read a pasted node
URL, search its tree, and receive a bounded design context with no Figma plugin running.

## Phase 4: budgets and large-document behavior

- Reuse Figwright's node-count and response-size guard concepts.
- Apply limits before constructing or JSON-stringifying a complete response.
- Deduplicate repeated component instances while retaining text and visual overrides.
- For an oversized root, return a section plan with child ids and estimated node counts.
- Mark truncated depth/node results explicitly.
- Cache normalized nodes and invalidate only changed nodes and affected ancestors.
- Measure capture time, normalization time, memory, and output bytes on the proven 65,662-node file;
  establish limits from those measurements rather than guesses.

Exit criteria: requesting the large tested section never produces the previous 26.7 MB raw output,
and the agent receives enough section ids to ground the design incrementally.

### Context projection strategy

Use a layered, retrieval-first model inspired by MemPalace's useful architectural idea: retain the
verbatim source locally and load progressively richer slices on demand. Do not use its AAAK dialect
on design data; AAAK is lossy text summarization and cannot preserve exact visual properties.

- **L0 — status:** file identity, connection state, capabilities, schema version and cache metrics.
- **L1 — outline:** pages/top-level sections with ids, names, types, dimensions and descendant
  counts. This is the default response for a whole file or oversized root.
- **L2 — compact subtree:** exact hierarchy, geometry, text, auto-layout and style references for a
  requested section, with repeated component structures deduplicated.
- **L3 — full node/subtree:** every supported normalized property for an explicit node id, still
  subject to hard byte/node budgets and asset references rather than inline binary data.

Keep the full decoded Kiwi graph and blob store outside the model context. Build deterministic
indexes for id, name, type and visible text so search selects a small exact subtree before
projection. Consider embeddings only after deterministic search is measured insufficient on real
files; a vector database is unnecessary for direct node URLs and exact layer names.

Optimize tokens without damaging semantics:

- omit no-op defaults such as `visible: true`, `opacity: 1` and `rotation: 0`;
- intern repeated paints, effects, text styles and component structures into referenced tables;
- preserve user-visible text, layer/component/token names, ids and numeric values verbatim;
- never remove vowels or abbreviate arbitrary strings: tokenizer cost can increase and the agent
  loses searchable names and meaning;
- do not abbreviate public field names unless a versioned dictionary has measured end-to-end token
  savings greater than its decoding cost and passes fidelity tests;
- use MessagePack/Zstandard only between processes or for disk/cache size; transport compression
  does not reduce model tokens after the MCP payload is decoded;
- measure the final serialized result with the target model tokenizer, not a characters-per-token
  estimate.

MemPalace's lightweight three-tool MCP surface reduces tool-schema tokens, but Figwright should keep
typed read tools initially: existing agents and `figma-codegen` already understand them, and their
schemas prevent ambiguous design queries. Reconsider a consolidated query tool only after measuring
tool-schema cost against the loss of discoverability and validation.

## Phase 5: vectors, images and visual verification

### Vectors

- Resolve `commandsBlob` and `vectorNetworkBlob` against the `blobs[]` belonging to their source
  message.
- Adapt the upstream MIT SVG decoders with attribution and focused tests.
- Generate computed shapes such as ellipse, star, polygon and rounded rectangle from parameters
  when no blob exists.

### Raster images

- First preserve image hashes, scale mode, transform and crop metadata in normalized paints.
- Investigate read-only CDP capture of image response bodies already loaded by the tab.
- Do not obtain images by exporting cookies or opening a second authenticated multiplayer session.
- Store assets only when an MCP save/export tool explicitly requests a local destination.

### Visual fallback

- Add an optional CDP screenshot of the visible Figma tab for comparison.
- Treat screenshots as verification and fallback context; do not infer layout values from pixels
  when structured Kiwi data exists.

Exit criteria: representative vectors export as valid SVG, image-fill metadata round-trips into the
design context, and unavailable assets are reported rather than silently replaced.

## Phase 6: tokens, components and codegen integration

- Resolve shared style references to stable names and values.
- Build variable collections/modes only when the wire data proves them; do not invent REST-only
  metadata.
- Normalize component sets, variants, booleans, text props and instance swaps.
- Feed the resulting design context into existing `component_map`, `token_map`, `icon_map`, and the
  `figma-codegen` skill where their required contracts are satisfied.
- Mark unavailable grounding dimensions in one leading capabilities/caveats block.

Exit criteria: an agent can implement one real 1920x1080 screen using the browser reader, reuse code
components/tokens, and identify every missing asset or unresolved binding explicitly.

## Phase 7: packaging and regression proof

- Package the unpacked extension reproducibly with the browser MCP release artifact.
- Document Chrome's debugger banner and the single-click attach flow.
- Keep localhost ports configurable and compatible with multiple MCP client processes.
- Add compatibility diagnostics for an unrecognized Kiwi schema/protocol change.
- Run live parity cases: simple frame, large section, mixed-style text, nested instances, vectors,
  raster fills, incremental text edit, layout edit, deletion, reconnect and two open tabs.
- Run all root CI gates and a live browser round-trip before claiming a phase complete.

## Scope exclusions

- No Figma mutation, simulated editing, or replay of sent frames.
- No cookie/token extraction or storage.
- No claim that an undocumented protocol is permanently stable.
- No raw private-file fixtures in git.
- No direct merge into the normal plugin read path until the isolated server passes parity tests.
