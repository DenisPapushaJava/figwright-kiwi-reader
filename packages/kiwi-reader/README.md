# FigLens browser reader

This package tests a read-only Figma source that does not require a Figma plugin, REST token, or
OAuth grant. A Chrome extension attaches to the active Figma tab through `chrome.debugger`, forwards
only received binary WebSocket frames to localhost, and the Node bridge decodes the Kiwi schema and
scenegraph already delivered to that authenticated tab.

## Build and run

```powershell
corepack pnpm --filter @figwright/kiwi-reader build
node .\packages\kiwi-reader\dist\serve.mjs
```

`serve.mjs` stays running and keeps an independent cache for every attached Figma tab. The extension
sends the current tab URL, including its selected `node-id`; selecting a layer before clicking the
extension therefore establishes the initial read target. URL changes while attached update that
selection without merging files or tabs.

For the one-shot diagnostic probe instead:

```powershell
node .\packages\kiwi-reader\dist\live-probe.mjs 'https://www.figma.com/design/FILE/NAME?node-id=6-140'
```

The probe prints a compact capture summary by default. Add `--raw` only when the complete decoded
subtree is needed; a large section can produce tens of megabytes of text because Figma includes
glyph positions, component-derived data, and vector geometry.

## Read-only MCP server

The separate browser MCP entry point starts the same capture bridge and exposes only read tools:

```powershell
corepack pnpm --filter @figwright/kiwi-reader build
node .\packages\kiwi-reader\dist\mcp.mjs
```

Configure an MCP client to launch that command from the repository root. It advertises
`browser_status`, `list_files`, `use_file`, `get_selection`, `get_node`, `get_design_context`,
`analyze_project`, `scan_components`, `component_map`, `icon_map`, `token_map`,
`get_implementation_context`, `save_assets`, `capture_reference`, and `compare_screenshots`.
`get_design_context` accepts a pasted Figma URL directly; when `nodeId` is omitted it uses the
selected node from the attached tab's URL.

`compare_screenshots` compares every pixel by default. For live pages whose map, chart, clock, or
data values intentionally differ from the Figma fixture, pass explicit `ignoreRegions` rectangles.
The report records the clipped rectangles, unique ignored/compared pixel counts, the ratio among
compared pixels, and the ratio against the full image so the masked result stays auditable.

For code generation, prefer one `get_implementation_context` call with the codebase's absolute
`rootDir`. It returns full design context, asset inventory, project profile, component/icon reuse,
and observed-color token candidates under one response budget. If the captured tree is truncated or
the combined payload is too large, it returns a `sectionPlan`; call the same tool for each section
with the same `rootDir`. A plan response skips full design projection and project grounding; the
`deferred` list names the fields that appear in the section responses. The separate mapping tools
remain available for focused inspection and retries.

The 1,500,000-byte response limit uses the serialized UTF-8 size rather than JavaScript character
count. Before full normalization, a strict lower bound counts the mandatory projected fields of every
captured node. If that lower bound already exceeds the limit, the read tools return a `sectionPlan`
immediately; otherwise the exact serialized size remains authoritative. This also lets
`get_implementation_context` reject an oversized design before scanning the project. Repeated reads
share a bounded per-session LRU cache for captured and normalized subtrees. Each entry records the
child, parent, and external component-master nodes used to build it, so unrelated scenegraph updates
keep that entry warm while a dependency change invalidates only the affected entry. If the bounded
change history no longer covers an entry's revision, the reader falls back to rebuilding it.

## Shared MCP hub

Use one shared process when Codex, Cursor, Claude, or another MCP client must read the same browser
capture without competing for port 9224:

```powershell
$env:FIGWRIGHT_KIWI_HUB_TOKEN = '<random secret with at least 32 characters>'
node .\packages\kiwi-reader\dist\hub.mjs
```

Connect Streamable HTTP clients to `http://127.0.0.1:9225/mcp` and send the token as
`Authorization: Bearer <token>`. The health endpoint is `http://127.0.0.1:9225/health`. Both ports
are configurable through `FIGWRIGHT_KIWI_PORT` and `FIGWRIGHT_KIWI_HUB_PORT`.

The packaged Codex plugin launches `stdio-proxy.mjs`. The proxy starts the shared hub when needed,
then forwards stdio JSON-RPC to the hub, so several Codex tasks share one capture owner. The Windows
installer also starts the hub immediately, verifies `/health`, and safely replaces its own previous
hub process during updates. `mcp.mjs` remains available as a direct single-client compatibility
entry point.

The hub has no shared active-file switch. After `list_files`, pass `fileKey` or `tabId` to
`get_selection`, `get_node`, `get_design_context`, `save_assets`, or `capture_reference` whenever
more than one captured tab is available. The same explicit target fields apply to `component_map`,
`icon_map`, `token_map`, and `get_implementation_context`. This keeps concurrent clients isolated. If
no hub token is set, the endpoint remains loopback-only and prints a security warning; a token is
recommended for normal use.

Normalized results use Figwright's existing `SerializedNode` contract. They retain geometry,
paints, effects, text and auto-layout fields already confirmed on live Kiwi traffic while dropping
`editInfo`, glyph caches and other private or high-volume wire fields. A response above the hard
UTF-8 byte budget becomes a section plan so an agent can request individual child sections.

Mixed-style text is reconstructed from Kiwi's per-character style ids and explicit override table.
Each uniform run carries its exact UTF-16 range, font face, size, numeric weight when metadata is
available, fills, line height, letter spacing, case and decoration. A malformed or incomplete table
is ignored as a whole instead of emitting partially styled text. Per-run links, lists, variable
bindings and OpenType features remain outside this slice and are reported as caveats.

Component instances whose children are implicit in Kiwi are expanded from their referenced
`SYMBOL` definition. The reader applies component text-property assignments, explicit
`symbolOverrides`, and Figma's resolved `derivedSymbolData` without mutating the cached master.
Boolean component-property assignments control the referenced layer's visibility, and verified
variant axes are emitted as `componentProperties`. A variant also carries its parent component-set
id and name so component grounding can match `Button` instead of a variant-only name such as
`Size=M, State=Enabled`. Variant axes are emitted only when the master's canonical name agrees with
its `variantPropSpecs`; unresolved property names are not guessed.
Instance swaps delivered as `symbolOverrides[].overriddenSymbolID` resolve to the swapped master's
identity and descendants. Kiwi does not always include the corresponding component-property
definition name, so the resolved component is exposed through `mainComponent` while a named
`INSTANCE_SWAP` property is omitted rather than invented.
Expanded descendants receive instance-scoped ids, and recursive or missing component references are
reported in the response capture metadata instead of looping or silently inventing content.

`component_map` joins those grounded Figma component identities to exported components under the
requested local `rootDir` and to installed dependency components discovered from actual imports,
JSX usage, public package `exports` / `types`, and `.d.ts` declarations. Dependency matches carry a
ready import contract instead of a `node_modules` path. No package names are built in. An observed
JSX import wins over an unused same-name export; two actually used same-name imports remain
ambiguous. The portable Kiwi release performs this static analysis without executing project or
dependency code and resolves locally declared prop types, destructured props, common wrappers,
function components and class components. Imported or otherwise unreadable prop contracts remain
explicitly incomplete, so the join never invents missing-prop TODOs. Vue, Svelte and Angular are
still indexed by component name only. A verified `docs/figma-component-map.md` row remains the
authoritative override, while stale file targets are reported instead of returned as usable imports.

`icon_map` first performs its strict near-exact join against existing SVG files, then checks a
dependency registry only when the project's own JSX establishes the component/prop contract and
the package's bounded static asset scan establishes the available SVG names. A dependency result
returns the package, component, prop value, and color contract. Duplicate basenames across registry
folders remain unmapped unless the Figma name carries enough path information to choose exactly.
For an icon node this registry contract is more specific than `component_map`'s possible match to a
generic `Icon` wrapper and should drive code generation.

`token_map` collects colors actually used by the selected subtree (solid fills, strokes, gradient
stops, shadow colors, and mixed-text runs) and joins them by exact value to CSS custom properties,
SCSS variables, statically readable Tailwind or UnoCSS theme tokens under `rootDir`, and public
CSS/SCSS package entrypoints that the project imports. A dependency token carries its package import
source. A unique
match is still reported as `medium` with
`matchedBy: ["value"]`: it is a reuse candidate, not proof that the Figma layer was bound to that
semantic token. Same-value candidates remain ambiguous, and more than three are counted rather than
dumped. Stable Kiwi shared-style ids are returned as opaque `unresolvedStyleRefs`; the reader does
not invent style names or variable collections that are absent from the captured wire data.
JavaScript and TypeScript configs are parsed without executing project code; imported spreads,
computed keys, and function values are skipped and reported in `caveats`.

Load `packages/kiwi-reader/extension` as an unpacked extension in Chrome 116 or newer. After starting
the probe or MCP server, activate the target Figma tab, click **FigLens**, and choose
**Подключить макет**. Chrome shows its normal debugger notification and the extension reloads the tab
once so the initial scenegraph is observable.

The checked-in manifest key pins the unpacked extension ID to
`ppaieabnmndpngcaeafaooajodebhmci`, which lets the local server reject every other extension
origin. If an older unpacked installation shows a different ID after this update, remove that entry
from `chrome://extensions` and load the same directory again once.

The popup reports the actual capture phase, file and selected node, decoded frame count, and number
of nodes received. Its progress bar is intentionally indeterminate while capture is active: the
Kiwi stream does not advertise a total node count from which an honest percentage could be
calculated. Progress notifications are coalesced to at most ten updates per second so a large file
does not turn every wire message into several Chrome action API calls. Chrome always closes an
action popup when it loses focus. Use the pin button in the
popup to move the same controls into Chrome's persistent side panel while selecting frames on the
canvas. The action badge keeps the compact state: `…` while connecting, `SYNC` while nodes arrive,
`✓` when the graph has settled, `WAIT` while reconnecting, and `ERR` on an actionable failure.
Reopen either surface to see the current counters, recapture the file, or detach.

Raster image capture is opt-in and disabled by default. Enable **Захватывать растровые
изображения** before connecting or recapturing when the selected design needs original photo/image
bytes. The option is persisted in `chrome.storage.local`; only eligible `image/*` response bodies
observed during the following reload are forwarded. An opt-in raster recapture bypasses Chrome's
HTTP cache so repeated captures can obtain the response bodies instead of silently losing cached
images; ordinary structure-only captures keep the cache enabled.

After changing files in the unpacked extension directory, press **Reload** on the extension card at
`chrome://extensions` and reopen the popup or side panel. Chrome can otherwise keep the previous
service worker alive while loading the new popup files. The popup detects that UI/worker mismatch,
disables the unsupported option, and reports `EXTENSION_RELOAD_REQUIRED` instead of a generic closed
message port.

Failures include a stable diagnostic code such as `LOCAL_MCP_OFFLINE`, `DEBUGGER_ATTACH_FAILED`,
`FIGMA_STREAM_TIMEOUT`, or `KIWI_DECODE_FAILED`. The popup can copy a compact diagnostic object with
the code, capture phase, file/node identifiers and counters; it deliberately excludes cookies,
tokens, frame payloads and design content.

An unexpected bridge restart triggers bounded reconnect attempts; after reconnect the extension
reloads attached tabs once to recover each session's dynamic Kiwi schema. A clean bridge shutdown
detaches the debugger and clears the badge. Manual, external and tab-close detach paths also remove
their server session, preventing stale files from remaining available to MCP reads.

## Security boundary

- Captures only server-to-browser binary frames; sent frames are never forwarded.
- Does not read or export Figma cookies.
- Does not open a second multiplayer session.
- Binds the bridge to `127.0.0.1` and accepts only the exact origin of the pinned FigLens
  extension ID.
- Stops forwarding when a single encoded frame exceeds 48 MiB or the browser bridge queue exceeds
  32 MiB. The server additionally caps WebSocket messages at 64 MiB and each scenegraph at 250,000
  nodes.
- Contains no encode or mutation API.

This is an experimental decoder for an undocumented protocol. Figma can change the wire format at
any time. The schema is therefore compiled from the `fig-wire` frame seen in each browser session.
