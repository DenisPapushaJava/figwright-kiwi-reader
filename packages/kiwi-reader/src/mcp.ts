#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { KiwiCaptureServer } from './capture-server.js';
import { createKiwiMcpServer } from './mcp-server.js';

const capture = new KiwiCaptureServer({
  port: Number.parseInt(process.env.FIGWRIGHT_KIWI_PORT ?? '9224', 10),
});
const port = await capture.start();
console.error(`[figwright-kiwi] capture ready on ws://127.0.0.1:${port}`);

const stdio = serveStdio(() => createKiwiMcpServer(capture), {
  onerror: error => console.error(`[figwright-kiwi] MCP transport error: ${error.message}`),
});
console.error('[figwright-kiwi] read-only MCP server ready on stdio');

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await stdio.close().catch(() => {});
  await capture.stop().catch(() => {});
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());
process.stdin.once('end', () => void shutdown());
process.stdin.once('close', () => void shutdown());
