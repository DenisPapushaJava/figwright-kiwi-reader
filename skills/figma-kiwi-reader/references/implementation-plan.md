# Browser-only Kiwi reader implementation plan

## Target outcome

Provide a production-usable, read-only MCP entry point that reads the Figma document already loaded
in Chrome and returns the existing Figwright read contracts. It must require no Figma plugin, file
administrator approval, REST token, OAuth grant, or REST API quota.

Data path:

```text
Figma tab -> Chrome debugger extension -> localhost capture service
          -> dynamic Kiwi decoder -> session scenegraph/cache
          -> Figwright normalizer -> bounded read-only MCP tools
          -> stdio client OR shared localhost HTTP hub -> agent
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
- A separate read-only MCP entry point advertises bounded browser tools and applies a 2,000-node,
  depth and 1.5-million-character budget before returning data to an agent.
- A shared Streamable HTTP hub can serve several MCP clients from one browser capture process.
  HTTP reads route explicitly by `tabId` or `fileKey`, so one IDE cannot change another IDE's
  active file.

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
properties plus `symbolOverrides` / `derivedSymbolData`. Boolean visibility properties are applied,
verified variant axes are normalized, and variant masters carry their component-set identity for
grounding. Instance swaps encoded as explicit `overriddenSymbolID` values resolve to the swapped
master and subtree; Kiwi does not always expose their property-definition names, which remain
deliberately unnamed. Mixed text runs now preserve the proven style-override fields (font face,
size, numeric weight, fill, spacing, case and decoration) with exact UTF-16 ranges. Per-run links,
lists, variable bindings, variable-bound slots, tokens and remaining assets are still open.

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

Status: initial entry point implemented with status, file routing, bounded context, asset export and
visual-reference tools. The stdio transport has completed a live Codex round-trip.

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

### Phase 3B: shared local multi-client hub

Status: the transport foundation is implemented. `hub.mjs` owns one Kiwi capture socket and exposes
the read tools at `http://127.0.0.1:9225/mcp`; the existing stdio entry remains compatible. The Codex
release uses a lightweight stdio-to-hub adapter, and the Windows installer starts, health-checks, and
safely replaces its own hub during updates. Persistent pre-login startup, clean uninstall, and setup
helpers for clients other than Codex remain open.

- Run exactly one long-lived capture owner per Windows user. Codex, Cursor, Claude and other MCP
  clients connect to that process instead of each trying to bind port 9224.
- Use Streamable HTTP as the client-neutral transport and keep stdio as a compatibility adapter.
- Keep HTTP requests stateless. Every selection-dependent tool accepts `tabId` or `fileKey`; when
  only one decoded tab exists, the most recent tab remains the safe default. Do not persist a global
  `use_file` binding in shared mode.
- Bind both endpoints to loopback, validate `Host` and `Origin`, cap request bodies, and support a
  bearer token through `FIGWRIGHT_KIWI_HUB_TOKEN`. Never log the token.
- Keep decoded graphs and image bytes only in the hub process. Clients receive bounded normalized
  projections, so adding clients does not duplicate capture memory or expose raw Kiwi frames.
- Add small client adapters/config generators only where a client cannot consume Streamable HTTP
  directly. Keep the server contract identical across products.
- Add an installer-managed background lifecycle only after start, update, crash recovery and clean
  uninstall are proven on Windows. Do not silently create an always-on service during development.

Exit criteria: two different MCP clients can concurrently read two captured tabs through one hub,
neither client can change the other's routing, invalid local HTTP origins are rejected, and stopping
one client does not stop browser capture for the other.

## Phase 4: budgets and large-document behavior

Status: node/depth truncation now returns an implementation `sectionPlan` before full design
projection or any project scan. Complete implementation responses analyze the portable project
profile once and reuse it across component, icon and token grounding. Response limits now measure
serialized UTF-8 bytes, and an oversized design slice returns before any project scan. Repeated reads
use a bounded per-session captured/normalized-subtree LRU cache. Each cache entry tracks the source
nodes, parent layout context, component masters and component sets used to construct it. Incremental
updates invalidate only entries intersecting the changed node's old or new ancestor chain; a bounded
change history falls back to conservative rebuilding when an entry is too old. Read tools now compute
a strict UTF-8 lower bound from mandatory projected fields before normalization; only a proven
over-budget tree takes the early `sectionPlan` path, while every other response retains the exact
post-serialization gate. The 65,662-node timing/memory baseline remains open.

A pre-change live baseline on the available 22,391-node file read a 1,838-node selected frame with
626 resolved instances into a 977,472-byte UTF-8 response. Two sequential reads through the previously
installed hub took 179 ms and 213 ms; its process used about 367 MB working set and 414 MB private
memory. These are diagnostic samples from one Windows session, not a stable performance benchmark.
With dependency-aware caching installed, the same response was byte-identical: the cold read took
249 ms and the warm read 108 ms, while cache telemetry changed from one miss/normalization to one hit
with no second normalization. The process then used about 361 MB working set and 333 MB private
memory. These single samples validate the cache path; they do not establish a general speedup.

An additional live sample read the current 22,391-node PM DEV page from root `0:1` after the
pre-normalization budget landed. `get_design_context` visited its bounded 2,000-node slice and
returned 999,587 UTF-8 bytes in 269 ms; a warm repeat took 147 ms with one cache hit and no second
normalization. For the intended cross-client entry point, `get_implementation_context` returned an
848-byte `sectionPlan` in 17 ms, deferred design/project grounding, and did not increment the
normalization counter. The hub then used about 393 MB working set and 370 MB private memory. This is
another single-session diagnostic sample; the separate 65,662-node baseline remains required.

- Reuse Figwright's node-count and response-size guard concepts.
- Apply limits before constructing or JSON-stringifying a complete response.
- Deduplicate repeated component instances while retaining text and visual overrides.
- For an oversized root, return a section plan with child ids and estimated node counts.
- Mark truncated depth/node results explicitly.
- Cache normalized nodes and invalidate only entries depending on changed nodes or affected ancestors.
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

Implementation status (2026-09-20):

- **Implemented:** bounded message-local blob preservation; command/vector-network decoding;
  content-addressed SVG and raster asset pack; optional `image/*` CDP body capture (off by default in
  the extension UI, with an uncached reload only when opted in); versioned
  design-context/capability report; viewport reference capture; exact PNG diff with heatmap,
  changed-pixel ratio and bounding box; explicit auditable dynamic-region masks with both compared
  and whole-image ratios; numeric font weight, PostScript name, variable axes, min/max sizing,
  aspect ratio, overflow/fixed children, truncation/max-lines/wrap; UI/service-worker capability
  detection for unpacked-extension reload skew.
- **Live verified:** frame `56:1424` exported 70 content-addressed assets for 101 usages (69 SVG and
  one 1,685,741-byte PNG). The PNG checksum matched the manifest, the warm-cache recapture recovered
  the original image after an opt-in uncached reload, and a transparent component root no longer
  introduced a black SVG fill. Three unsupported composite vector containers were reported as
  missing while their usable child icons were still exported.
- **Full-screen baseline:** PM DEV frame `380:23063` (`1920x1080`) resolved all 512 component
  instances and exposed 823 vector nodes plus one available raster image. Against the native Figma
  PNG, the live project screenshot changed 430,635/2,073,600 pixels (20.7675%) because it used a
  different map and live dataset. Seven explicit dynamic masks left 361,259 pixels to compare:
  15,220 changed (4.2130% of compared pixels, 0.7340% of the whole image). The remaining diff is
  concentrated in tabs, section headers, time-range controls and the footer. Because the masks cover
  most of the screen, this validates the comparison workflow but is not evidence of full-screen
  pixel parity.
- **Deliberately reported as partial:** gradient/mask/filter-heavy vector SVGs, mixed-text links,
  lists and per-run bindings, variables, variable-bound slot properties and native node crops.
  Boolean visibility assignments, verified variant axes, explicit symbol-override swaps and
  mixed-style text runs are supported. The current exporter records an unsupported-paint warning
  and never silently substitutes black for an unsupported vector paint.
- **Live gate still required:** compare the PM DEV frame with a deterministic fixture matching the
  Figma map/data state so the chart, table, metrics and map remain unmasked. Also recapture a focused
  variable/mixed-text frame before marking Phase 5 complete.

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
  aspect ratio, annotations, paint/effect variable bindings and variable-bound slot component
  properties.
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
  explicit and recorded. Dynamic map/chart/data regions may be excluded only through explicit,
  reported rectangles; report both compared and ignored pixels so a low ratio cannot hide a broadly
  masked screen.
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

Status: component, icon, and observed-color token grounding are available through the isolated Kiwi
MCP. `get_implementation_context` combines the full design tree, asset inventory, project profile,
and all three grounding dimensions in one client-independent, bounded response; large results return
a section plan that preserves the same `rootDir` workflow across Codex and other MCP clients. The
grounders reuse existing pure Figwright scanners against a portable, gitignore-aware project index.
The standalone bundle confirms component exports and names and statically resolves locally declared
React prop contracts through its pure JavaScript parser. Imported/incomplete React contracts and
Vue, Svelte or Angular prop coverage remain explicitly unknown; component-map overrides still work
and stale targets are reported. `token_map` scans CSS custom properties, SCSS variables, and statically
readable Tailwind/UnoCSS JavaScript or TypeScript theme configs, then reports exact color-value
matches as medium-confidence, name-blind candidates. Configs are never executed; runtime imports,
computed keys, and function values are reported as skipped. Stable shared-style ids are surfaced as
opaque references. Figma variable/style-name resolution and broader live UI-kit parity remain open.

- Resolve shared style references to stable names and values when wire evidence becomes available;
  until then preserve their ids and keep value-only project matches explicitly provisional.
- Build variable collections/modes only when the wire data proves them; do not invent REST-only
  metadata.
- Normalize component sets, variants, booleans, text props and instance swaps.
- Keep the Codex skill and MCP server instructions centered on `get_implementation_context`; retain
  the individual maps for focused retries and clients that prefer separate calls.
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
