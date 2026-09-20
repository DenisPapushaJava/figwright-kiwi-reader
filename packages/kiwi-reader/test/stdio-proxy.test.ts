import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const DIST_ENTRY = join(import.meta.dirname, '..', 'dist', 'stdio-proxy.mjs');

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
};

const proxyClient = (capturePort: number, hubPort: number) => {
  const child = spawn(process.execPath, [DIST_ENTRY], {
    env: {
      ...process.env,
      FIGWRIGHT_KIWI_PORT: String(capturePort),
      FIGWRIGHT_KIWI_HUB_PORT: String(hubPort),
      FIGWRIGHT_KIWI_PROXY_PERSIST: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString('utf8');
    for (let newline = stdout.indexOf('\n'); newline >= 0; newline = stdout.indexOf('\n')) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line) as { id?: number } & Record<string, unknown>;
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString('utf8');
  });
  child.once('exit', code => {
    for (const resolve of pending.values()) {
      resolve({ error: { code, message: `proxy exited\n${stderr}` } });
    }
    pending.clear();
  });
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for ${method}\n${stderr}`)),
        20_000,
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
  return { child, send };
};

const closeProxy = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.stdin.end();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timeout);
};

describe.skipIf(!existsSync(DIST_ENTRY))('Kiwi stdio-to-hub proxy (built dist)', () => {
  it('starts one shared hub and serves two Codex-style stdio clients', async () => {
    const capturePort = await freePort();
    const hubPort = await freePort();
    const first = proxyClient(capturePort, hubPort);
    const second = proxyClient(capturePort, hubPort);
    try {
      for (const client of [first, second]) {
        await expect(
          client.send('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'codex-proxy-test', version: '0' },
          }),
        ).resolves.not.toHaveProperty('error');
      }
      const lists = await Promise.all([first.send('tools/list'), second.send('tools/list')]);
      for (const listed of lists) {
        const result = listed.result as { tools: Array<{ name: string }> };
        expect(result.tools.map(tool => tool.name)).toContain('get_implementation_context');
      }
      const status = await first.send('tools/call', {
        name: 'browser_status',
        arguments: {},
      });
      expect(status).not.toHaveProperty('error');
    } finally {
      await closeProxy(second.child);
      await closeProxy(first.child);
    }
  }, 30_000);
});
