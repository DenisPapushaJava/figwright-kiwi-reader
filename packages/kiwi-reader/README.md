# Figwright Kiwi Reader experiment

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
`browser_status`, `list_files`, `use_file`, `get_selection`, `get_node`, and
`get_design_context`. The latter accepts a pasted Figma URL directly; when `nodeId` is omitted it
uses the selected node from the attached tab's URL.

Normalized results use Figwright's existing `SerializedNode` contract. They retain geometry,
paints, effects, text and auto-layout fields already confirmed on live Kiwi traffic while dropping
`editInfo`, glyph caches and other private or high-volume wire fields. A response above the hard
payload budget becomes a section plan so an agent can request individual child sections.

Load `packages/kiwi-reader/extension` as an unpacked extension in Chrome 116 or newer. After starting
the probe or MCP server, activate the target Figma tab, click **Figwright Kiwi Reader**, and choose
**Подключить макет**. Chrome shows its normal debugger notification and the extension reloads the tab
once so the initial scenegraph is observable.

The popup reports the actual capture phase, file and selected node, decoded frame count, and number
of nodes received. Its progress bar is intentionally indeterminate while capture is active: the
Kiwi stream does not advertise a total node count from which an honest percentage could be
calculated. Chrome always closes an action popup when it loses focus. Use the pin button in the
popup to move the same controls into Chrome's persistent side panel while selecting frames on the
canvas. The action badge keeps the compact state: `…` while connecting, `SYNC` while nodes arrive,
`✓` when the graph has settled, `WAIT` while reconnecting, and `ERR` on an actionable failure.
Reopen either surface to see the current counters, recapture the file, or detach.

Failures include a stable diagnostic code such as `LOCAL_MCP_OFFLINE`, `DEBUGGER_ATTACH_FAILED`,
`FIGMA_STREAM_TIMEOUT`, or `KIWI_DECODE_FAILED`. The popup can copy a compact diagnostic object with
the code, capture phase, file/node identifiers and counters; it deliberately excludes cookies,
tokens, frame payloads and design content.

An unexpected bridge restart triggers bounded reconnect attempts; after reconnect the extension
reloads attached tabs once to recover each session's dynamic Kiwi schema. A clean bridge shutdown
detaches the debugger and clears the badge.

## Security boundary

- Captures only server-to-browser binary frames; sent frames are never forwarded.
- Does not read or export Figma cookies.
- Does not open a second multiplayer session.
- Binds the bridge to `127.0.0.1` and accepts browser connections only from an extension origin.
- Contains no encode or mutation API.

This is an experimental decoder for an undocumented protocol. Figma can change the wire format at
any time. The schema is therefore compiled from the `fig-wire` frame seen in each browser session.
