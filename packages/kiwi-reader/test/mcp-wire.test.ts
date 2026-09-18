import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DIST_ENTRY = join(import.meta.dirname, '..', 'dist', 'mcp.mjs');

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
};

describe.skipIf(!existsSync(DIST_ENTRY))('Kiwi read-only MCP wire (built dist)', () => {
  it('advertises only the bounded browser read tools and exits with its client', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [DIST_ENTRY], {
      env: { ...process.env, FIGWRIGHT_KIWI_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let nextId = 1;
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    child.once('exit', code => {
      for (const resolve of pending.values()) {
        resolve({ error: { code, message: `server exited\n${stderr}` } });
      }
      pending.clear();
    });
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === '') continue;
        const message = JSON.parse(line) as { id?: number } & Record<string, unknown>;
        if (message.id !== undefined) pending.get(message.id)?.(message);
      }
    });

    const send = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId++;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${method}\n${stderr}`)),
          10_000,
        );
        pending.set(id, value => {
          clearTimeout(timeout);
          pending.delete(id);
          resolve(value);
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    };

    try {
      const initialized = await send('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'kiwi-wire-test', version: '0' },
      });
      expect(initialized).not.toHaveProperty('error');
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );

      const listed = await send('tools/list');
      const result = listed.result as { tools: Array<{ name: string }> };
      expect(result.tools.map(tool => tool.name)).toEqual([
        'browser_status',
        'list_files',
        'use_file',
        'get_selection',
        'get_node',
        'get_design_context',
      ]);

      const status = await send('tools/call', { name: 'browser_status', arguments: {} });
      expect(status).not.toHaveProperty('error');
    } finally {
      let code = child.exitCode;
      if (code === null) {
        const exited = once(child, 'exit');
        child.stdin.end();
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
        [code] = (await exited) as [number | null];
        clearTimeout(timeout);
      }
      expect(code).toBe(0);
    }
  }, 15_000);
});
