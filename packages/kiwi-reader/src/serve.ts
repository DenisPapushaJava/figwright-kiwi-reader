#!/usr/bin/env node
import { type CaptureStatus, KiwiCaptureServer } from './index.js';

const server = new KiwiCaptureServer();
const port = await server.start();
console.error(`FigLens capture service is listening on ws://127.0.0.1:${port}`);
console.error('Open a Figma file in Chrome and click the FigLens extension.');

let lastStatus = '';
server.on('status', (status: CaptureStatus) => {
  const summary = status.sessions
    .map(
      session =>
        `${session.fileKey} tab=${session.tabId} selected=${session.selectedNodeId ?? 'none'} ` +
        `schema=${session.schemaReady} nodes=${session.nodes}`,
    )
    .join(' | ');
  const line = `browser=${status.connected}${summary === '' ? '' : ` | ${summary}`}`;
  if (line === lastStatus) return;
  lastStatus = line;
  console.error(line);
});

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await server.stop();
};

await new Promise<void>(resolve => {
  const onSignal = (): void => {
    void stop().finally(resolve);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
});
