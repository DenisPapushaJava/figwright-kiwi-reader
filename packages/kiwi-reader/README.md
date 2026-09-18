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

Load `packages/kiwi-reader/extension` as an unpacked Chrome extension. After starting the probe,
activate the target Figma tab and click **Figwright Kiwi Reader**. Chrome shows its normal debugger
notification and the extension reloads the tab once so the initial scenegraph is observable.

The action is a toggle: click it again to detach. An unexpected bridge restart triggers bounded
reconnect attempts and a `WAIT` badge; after reconnect the extension reloads attached tabs once to
recover each session's dynamic Kiwi schema. A clean bridge shutdown detaches the debugger and clears
the badge.

## Security boundary

- Captures only server-to-browser binary frames; sent frames are never forwarded.
- Does not read or export Figma cookies.
- Does not open a second multiplayer session.
- Binds the bridge to `127.0.0.1` and accepts browser connections only from an extension origin.
- Contains no encode or mutation API.

This is an experimental decoder for an undocumented protocol. Figma can change the wire format at
any time. The schema is therefore compiled from the `fig-wire` frame seen in each browser session.
