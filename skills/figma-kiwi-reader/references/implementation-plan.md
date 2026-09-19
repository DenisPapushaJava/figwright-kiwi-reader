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

## Phase 5: pixel-fidelity pipeline

Implementation status (2026-09-19):

- **Implemented:** bounded message-local blob preservation; command/vector-network decoding;
  content-addressed SVG and raster asset pack; optional `image/*` CDP body capture (off by default in
  the extension UI); versioned design-context/capability report; viewport reference capture; exact
  PNG diff with heatmap, changed-pixel ratio and bounding box; numeric font weight, PostScript name,
  variable axes, min/max sizing, aspect ratio, overflow/fixed children, truncation/max-lines/wrap;
  UI/service-worker capability detection for unpacked-extension reload skew.
- **Deliberately reported as partial:** gradient/mask/filter-heavy vector SVGs, mixed text runs,
  variables, non-text instance properties and native node crops. The current exporter records an
  unsupported-paint warning and never silently substitutes black for an unsupported vector paint.
- **Live gate still required:** reload the unpacked extension, recapture real files containing a
  photo, composite icon, variable/mixed text and nested instance, then compare against a native or
  viewport PNG before marking Phase 5 complete.

Pixel-perfect is a verification target, not a property of one JSON response. The browser reader
needs four independent layers so an error in one layer is observable instead of being repeated in
both the implementation and its reference:

```text
Kiwi scenegraph -> exact normalized design context -> HTML/CSS implementation
Kiwi blobs/network images -> exported asset pack ----^                |
Figma tab screenshot/native export -> reference image                 |
rendered implementation screenshot <----------- pixel/structural diff+
```

The public design context stays small and textual. Vector paths, raster bytes, glyph outlines and
screenshots live in an asset store and are returned as metadata or written to disk only on an
explicit save call. Every response reports capabilities and missing fidelity dimensions; the agent
must never silently redraw an unavailable icon or substitute a placeholder image.

### 5A: preserve source-message blobs

- Add a bounded, content-addressed blob store per capture session. The decoder currently passes only
  `nodeChanges` into the scenegraph, so numeric `commandsBlob` / `vectorNetworkBlob` indices lose
  their owning message as soon as that frame is merged.
- During ingest, replace known numeric blob indices with internal stable references before merging
  incremental changes. Keep the references out of `SerializedNode`; expose only asset ids and
  availability metadata.
- Cover `fillGeometry`, `strokeGeometry`, `vectorNetworkBlob`, computed text glyph geometry and any
  image/vector override that points into `message.blobs`.
- Bound individual blobs, total bytes per tab and asset count. Reset them with the session and report
  eviction/missing data explicitly.
- Keep diagnostic counters: blobs received, retained, deduplicated, rejected and unresolved. Once a
  referenced blob is retained, do not evict it during that capture session.

Exit criteria: a blob referenced by an early frame is still resolvable after later incremental
updates, two tabs cannot see one another's blobs, and reset/reconnect releases the old store.

### 5B: true vector asset export

- Prefer baked `fillGeometry` / `strokeGeometry` `commandsBlob` paths: they already represent
  booleans and expanded strokes more faithfully than rebuilding editable vector networks.
- Use `vectorNetworkBlob` as a centerline/editable-path fallback. Adapt the pinned MIT decoders from
  `allan-simon/figma-kiwi-protocol`, but add the missing production cases rather than importing its
  CLI/write surface.
- Compose parent and child affine transforms, preserve winding rules, stroke caps/joins/dashes,
  gradients, masks/clip paths, opacity and paint order. Render an entire icon/component subtree to
  one SVG instead of exporting unrelated child vectors.
- Generate exact SVG geometry for ellipse/arc, star, polygon, line and rounded rectangle nodes that
  have parameters but no command blob.
- Add a read-only `save_assets` MCP tool. Its manifest maps node id to file path, kind, dimensions,
  checksum and any unsupported feature. Do not inline large SVG paths into design-context JSON.

Reference implementations to evaluate at pinned commits:

- `allan-simon/figma-kiwi-protocol@2bb4d6a9` for the small blob decoders;
- `echobt/figma-mcp@0e0289a6` for subtree transform composition, masks and asset-pack conventions;
- `KwiTsukasa/figma-local-context-mcp@7661dc0f` for baked geometry, glyph paths and SVG filters.

All are research inputs. Copy only the smallest read-only MIT-compatible units, retain attribution,
and test them against live Kiwi frames. Do not add cookie capture, a standalone multiplayer socket,
mutation code or local `.fig` write support.

Exit criteria: simple and composite icons, nested transforms, masks, boolean shapes and computed
shapes export as reusable SVG files whose bounds match their normalized nodes.

### 5C: raster image recovery

- Extend normalized image paints with a stable image hash, scale mode, paint transform/crop,
  rotation and a `filtersApplied` signal. Keep the byte payload outside JSON.
- The extension already owns an attached `chrome.debugger` session and `Network` is an allowed CDP
  domain. Record bounded metadata from `Network.responseReceived`; after `loadingFinished`, obtain
  eligible image bodies with `Network.getResponseBody`, hash them locally and associate them with
  Kiwi image hashes. Never read or export cookies.
- Capture only image MIME types and enforce per-response and per-tab byte budgets. Do not collect
  arbitrary API/HTML/script response bodies.
- Write original bytes only through explicit `save_assets`; for a cropped, filtered, masked or
  blended image also mark that a composited reference is required because the original bytes alone
  cannot reproduce the visible result.
- If the browser has already evicted a body, report `IMAGE_BODY_UNAVAILABLE` and offer recapture;
  never replace it with a visually similar stock image.

Exit criteria: the photo in the proven violation-card frame is saved from the active Figma session,
and its manifest contains the exact fit/crop data needed to reproduce the visible crop.

### 5D: complete typography and responsive properties

- Preserve numeric `fontWeight`, PostScript name and variable-font axes when present; retain
  `fontName.style` as the source name instead of treating a style-to-weight lookup as ground truth.
- Reconstruct mixed text segments from style ids/override tables with per-run font, size, weight,
  variation axes, fill, line height, letter spacing, case, decoration, hyperlink and list metadata.
- Add truncation/max-lines/wrap, OpenType features and paragraph/list properties when the wire data
  proves them. Keep exact character ranges.
- Complete min/max sizing, GRID tracks and child placement, layout grids, overflow/fixed children,
  aspect ratio, annotations, paint/effect variable bindings and non-text component properties.
- Report missing fonts. Do not copy font files out of Figma network traffic; generated code must use
  a project-owned/licensed font source or an explicit fallback.

Exit criteria: plugin-reader parity tests cover a mixed-style text block, a variable font, a
wrapping/grid layout and an instance with text/boolean/variant/instance-swap properties.

### 5E: visual reference and closed-loop verification

- Add an explicit `capture_reference` action using CDP `Page.captureScreenshot`. It captures the
  visible Figma surface without REST quota or a Figma plugin. Because this is a viewport screenshot,
  record viewport, device scale, current selected node and crop confidence; never label an inferred
  crop as a native node export.
- Prefer a user-provided/native Figma PNG export when available. It is the only reliable oracle for
  complex blur, blend modes, font rasterization and colour-profile behavior; browser-only Kiwi
  cannot promise byte-identical native rendering.
- Provide a deterministic local subtree preview (SVG, optionally rasterized with `resvg`) as a
  second diagnostic reference. It is useful for locating missing assets and transform mistakes, but
  cannot validate its own renderer.
- Add a comparison report for equal-sized PNGs: changed-pixel ratio, perceptual score, bounding box
  of differences and a heatmap/diff file. Ignore no pixels by default; optional tolerances must be
  explicit and recorded.
- Update `figma-codegen` to require this loop for pixel-fidelity work: implement -> fixed-viewport
  screenshot -> diff -> inspect largest regions -> adjust -> repeat. Exact structured values always
  outrank measurements inferred from screenshots.

Exit criteria: the violation-card test produces an asset pack, a fixed 1920x1080 implementation
screenshot, a reference screenshot and a reproducible diff report. The report distinguishes known
renderer/font antialiasing differences from structural, typography and missing-asset failures.

### Accuracy contract

- **Structured parity:** exact node hierarchy, dimensions, transforms, paints, layout and text values
  for every supported property.
- **Asset completeness:** every visible raster/vector asset is saved or explicitly reported missing.
- **Visual convergence:** implementation and reference are compared at the same viewport and scale;
  every remaining difference is visible in the report.
- **No universal native-pixel guarantee:** Figma's private renderer, OS/browser font rasterization,
  shaders, complex blend modes and unavailable fonts can still differ. The tool promises measured,
  explainable convergence rather than claiming perfect equality without evidence.

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
