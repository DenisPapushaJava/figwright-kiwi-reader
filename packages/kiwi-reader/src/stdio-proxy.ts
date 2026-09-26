#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const HUB_PORT = Number.parseInt(process.env.FIGWRIGHT_KIWI_HUB_PORT ?? '9225', 10);
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const MCP_URL = `${HUB_URL}/mcp`;
const HEALTH_URL = `${HUB_URL}/health`;
const HUB_START_TIMEOUT_MS = 15_000;
const HUB_RETRY_MS = 150;
const persistHub = process.env.FIGWRIGHT_KIWI_PROXY_PERSIST !== '0';
let launchedHub: ChildProcess | null = null;
let protocolVersion = '2025-11-25';

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const hubReady = async (): Promise<boolean> => {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
};

const startHub = (): void => {
  if (launchedHub !== null) return;
  launchedHub = spawn(process.execPath, [join(import.meta.dirname, 'hub.mjs')], {
    cwd: import.meta.dirname,
    env: process.env,
    detached: persistHub,
    windowsHide: true,
    stdio: 'ignore',
  });
  launchedHub.once('error', error => {
    console.error(`[figwright-kiwi] failed to launch shared hub: ${error.message}`);
  });
  if (persistHub) launchedHub.unref();
};

const ensureHub = async (): Promise<void> => {
  if (await hubReady()) return;
  startHub();
  const deadline = Date.now() + HUB_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- readiness polling must remain sequential
    if (await hubReady()) return;
    // eslint-disable-next-line no-await-in-loop -- bounded retry delay avoids a startup spin loop
    await delay(HUB_RETRY_MS);
  }
  throw new Error(`Shared Kiwi MCP hub did not become ready at ${HEALTH_URL}`);
};

const responseMessages = async (response: Response): Promise<string[]> => {
  const body = await response.text();
  if (body.trim() === '') return [];
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return body
      .split(/\r?\n\r?\n/)
      .map(event =>
        event
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice('data:'.length).trimStart())
          .join('\n'),
      )
      .filter(Boolean);
  }
  return [body];
};

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string };
}

const writeError = (request: JsonRpcMessage, error: unknown): void => {
  if (request.id === undefined) return;
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32_000, message: error instanceof Error ? error.message : String(error) },
    })}\n`,
  );
};

const forward = async (request: JsonRpcMessage, line: string): Promise<void> => {
  if (request.method === 'initialize' && typeof request.params?.protocolVersion === 'string') {
    protocolVersion = request.params.protocolVersion;
  }
  try {
    await ensureHub();
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': protocolVersion,
    };
    const token = process.env.FIGWRIGHT_KIWI_HUB_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(MCP_URL, { method: 'POST', headers, body: line });
    if (!response.ok) {
      throw new Error(`Shared Kiwi MCP hub returned HTTP ${response.status}`);
    }
    for (const message of await responseMessages(response)) process.stdout.write(`${message}\n`);
  } catch (error) {
    writeError(request, error);
  }
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const inFlight = new Set<Promise<void>>();
for await (const line of input) {
  if (line.trim() === '') continue;
  let request: JsonRpcMessage;
  try {
    request = JSON.parse(line) as JsonRpcMessage;
    if (typeof request !== 'object' || request === null) throw new Error('Expected an object');
  } catch (error) {
    console.error(`[figwright-kiwi] invalid stdio JSON: ${String(error)}`);
    continue;
  }
  if (request.method !== 'tools/call') {
    // Preserve initialization and notification ordering around tool calls.
    await Promise.all(inFlight);
    await forward(request, line);
    continue;
  }
  let call: Promise<void>;
  call = forward(request, line).finally(() => inFlight.delete(call));
  inFlight.add(call);
  if (inFlight.size >= 8) await Promise.race(inFlight);
}
await Promise.all(inFlight);

const childHub = launchedHub as ChildProcess | null;
if (!persistHub && childHub !== null && childHub.exitCode === null) childHub.kill('SIGTERM');
