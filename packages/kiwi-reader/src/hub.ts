#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createMcpHandler } from '@modelcontextprotocol/server';

import { KiwiCaptureServer } from './capture-server.js';
import { createKiwiMcpServer } from './mcp-server.js';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const CAPTURE_PORT = Number.parseInt(process.env.FIGWRIGHT_KIWI_PORT ?? '9224', 10);
const HUB_PORT = Number.parseInt(process.env.FIGWRIGHT_KIWI_HUB_PORT ?? '9225', 10);
const configuredToken = process.env.FIGWRIGHT_KIWI_HUB_TOKEN?.trim();
if (configuredToken !== undefined && configuredToken.length > 0 && configuredToken.length < 32) {
  throw new Error('FIGWRIGHT_KIWI_HUB_TOKEN must contain at least 32 characters');
}
const HUB_TOKEN = configuredToken || null;

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
};

const secureEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const authorized = (request: IncomingMessage): boolean => {
  if (HUB_TOKEN === null) return true;
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return secureEqual(header.slice('Bearer '.length), HUB_TOKEN);
};

const validHost = (request: IncomingMessage): boolean => {
  const host = request.headers.host?.toLowerCase();
  return host === `127.0.0.1:${HUB_PORT}` || host === `localhost:${HUB_PORT}`;
};

const validOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${HUB_PORT}` || origin === `http://localhost:${HUB_PORT}`;
};

const readBody = async (request: IncomingMessage): Promise<Buffer | undefined> => {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const toWebRequest = async (request: IncomingMessage): Promise<Request> => {
  const body = await readBody(request);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return new Request(`http://${request.headers.host}${request.url ?? '/mcp'}`, {
    method: request.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

const sendWebResponse = async (source: Response, target: ServerResponse): Promise<void> => {
  target.statusCode = source.status;
  source.headers.forEach((value, name) => target.setHeader(name, value));
  if (source.body === null) {
    target.end();
    return;
  }
  const reader = source.body.getReader();
  try {
    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) return;
      if (!target.write(Buffer.from(value))) {
        await new Promise<void>(resolve => target.once('drain', resolve));
      }
      await pump();
    };
    await pump();
    target.end();
  } finally {
    reader.releaseLock();
  }
};

const capture = new KiwiCaptureServer({ port: CAPTURE_PORT });
const capturePort = await capture.start();
const mcp = createMcpHandler(() => createKiwiMcpServer(capture, { persistentRouting: false }), {
  onerror: error => console.error(`[figwright-kiwi] MCP HTTP error: ${error.message}`),
});

const http = createServer((request, response) => {
  void (async () => {
    if (!validHost(request) || !validOrigin(request)) {
      json(response, 403, { error: 'LOCAL_REQUEST_REQUIRED' });
      return;
    }
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
    if (pathname === '/health' && request.method === 'GET') {
      json(response, 200, {
        ok: true,
        captureConnected: capture.status.connected,
        files: capture.status.sessions.length,
        authentication: HUB_TOKEN === null ? 'loopback-only' : 'bearer',
      });
      return;
    }
    if (pathname !== '/mcp') {
      json(response, 404, { error: 'NOT_FOUND' });
      return;
    }
    if (!authorized(request)) {
      response.setHeader('www-authenticate', 'Bearer realm="figwright-kiwi"');
      json(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    try {
      await sendWebResponse(await mcp.fetch(await toWebRequest(request)), response);
    } catch (error) {
      if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
        json(response, 413, { error: 'REQUEST_TOO_LARGE' });
        return;
      }
      throw error;
    }
  })().catch(error => {
    console.error(`[figwright-kiwi] HTTP request failed: ${String(error)}`);
    if (!response.headersSent) json(response, 500, { error: 'INTERNAL_ERROR' });
    else response.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

await new Promise<void>((resolve, reject) => {
  http.once('error', reject);
  http.listen(HUB_PORT, '127.0.0.1', resolve);
});

console.error(`[figwright-kiwi] capture ready on ws://127.0.0.1:${capturePort}`);
console.error(`[figwright-kiwi] shared MCP hub ready on http://127.0.0.1:${HUB_PORT}/mcp`);
if (HUB_TOKEN === null) {
  console.error(
    '[figwright-kiwi] hub bearer authentication is disabled; set FIGWRIGHT_KIWI_HUB_TOKEN to enable it',
  );
}

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await mcp.close().catch(() => {});
  await new Promise<void>(resolve => http.close(() => resolve()));
  await capture.stop().catch(() => {});
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGHUP', () => void shutdown());
