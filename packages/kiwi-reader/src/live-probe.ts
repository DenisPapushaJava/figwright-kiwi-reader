#!/usr/bin/env node
import { type CaptureStatus, KiwiCaptureServer, jsonSafe, parseFigmaLocation } from './index.js';

const input = process.argv[2];
if (input === undefined) {
  console.error('Usage: node packages/kiwi-reader/dist/live-probe.mjs <Figma node URL> [--raw]');
  process.exitCode = 1;
} else {
  const url = new URL(input);
  const location = parseFigmaLocation(url.href);
  if (location === null) throw new Error('The URL is not a supported Figma file URL');
  if (location.selectedNodeId === null) throw new Error('The Figma URL has no node-id parameter');
  const nodeId = location.selectedNodeId;

  const server = new KiwiCaptureServer();
  const port = await server.start();
  console.error(`Kiwi capture bridge is listening on ws://127.0.0.1:${port}`);
  console.error('Open the target file in Chrome, then click the FigLens extension.');
  console.error(
    'The extension will attach read-only network capture and reload the Figma tab once.',
  );

  let lastLine = '';
  server.on('status', (status: CaptureStatus) => {
    const session = status.sessions.find(item => item.fileKey === location.fileKey);
    const line = `connected=${status.connected} schema=${session?.schemaReady ?? false} nodes=${session?.nodes ?? 0}`;
    if (line !== lastLine) console.error(line);
    lastLine = line;
  });

  try {
    await server.waitForNode(nodeId, 120_000, location.fileKey);
    const node = server.findNode(nodeId, location.fileKey);
    if (process.argv.includes('--raw')) {
      console.log(JSON.stringify(jsonSafe(node), null, 2));
    } else if (node !== null) {
      console.log(
        JSON.stringify(
          jsonSafe({
            capture: server.status,
            node: {
              id: node.id,
              name: node.name,
              type: node.type,
              visible: node.visible,
              size: node.raw.size,
              transform: node.raw.transform,
              layout: {
                mode: node.raw.stackMode,
                spacing: node.raw.stackSpacing,
                horizontalPadding: node.raw.stackHorizontalPadding,
                verticalPadding: node.raw.stackVerticalPadding,
              },
              directChildren: node.children.map(child => ({
                id: child.id,
                name: child.name,
                type: child.type,
                size: child.raw.size,
              })),
            },
          }),
          null,
          2,
        ),
      );
    }
  } finally {
    await server.stop();
  }
}
