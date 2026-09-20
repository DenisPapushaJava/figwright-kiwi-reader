import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkStdioServerInstall,
  installStdioServer,
  removeStdioServer,
} from '../src/client-config.js';

const roots: string[] = [];

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'figlens-client-config-'));
  roots.push(root);
  return join(root, 'mcp.json');
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('MCP client configuration', () => {
  it('adds and removes only the owned server while preserving unrelated config', async () => {
    const path = await fixture();
    await writeFile(
      path,
      JSON.stringify({ theme: 'dark', mcpServers: { existing: { command: 'other' } } }),
    );

    await installStdioServer(path, 'fk', {
      type: 'stdio',
      command: 'C:\\Node\\node.exe',
      args: ['C:\\FigLens\\server\\stdio-proxy.mjs'],
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'dark',
      mcpServers: {
        existing: { command: 'other' },
        fk: {
          type: 'stdio',
          command: 'C:\\Node\\node.exe',
          args: ['C:\\FigLens\\server\\stdio-proxy.mjs'],
        },
      },
    });

    await expect(
      removeStdioServer(path, 'fk', {
        command: 'C:\\Node\\node.exe',
        proxyPath: 'C:\\FigLens\\server\\stdio-proxy.mjs',
      }),
    ).resolves.toBe('removed');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'dark',
      mcpServers: { existing: { command: 'other' } },
    });
  });

  it('updates the server only when the existing entry belongs to the previous installation', async () => {
    const path = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          fk: { type: 'stdio', command: 'node-old', args: ['proxy-old'] },
        },
      }),
    );

    await installStdioServer(
      path,
      'fk',
      { type: 'stdio', command: 'node-new', args: ['proxy-new'] },
      { command: 'node-old', proxyPath: 'proxy-old' },
    );
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.fk).toEqual({
      type: 'stdio',
      command: 'node-new',
      args: ['proxy-new'],
    });
  });

  it('does not overwrite or remove a server changed by the user', async () => {
    const path = await fixture();
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { fk: { command: 'custom', args: ['custom-proxy'] } } }),
    );

    await expect(
      checkStdioServerInstall(path, 'fk', {
        type: 'stdio',
        command: 'node',
        args: ['proxy'],
      }),
    ).rejects.toThrow('is not owned by this installation');
    await expect(readFile(path, 'utf8')).resolves.toContain('custom-proxy');
    await expect(
      installStdioServer(path, 'fk', {
        type: 'stdio',
        command: 'node',
        args: ['proxy'],
      }),
    ).rejects.toThrow('is not owned by this installation');
    await expect(
      removeStdioServer(path, 'fk', { command: 'node', proxyPath: 'proxy' }),
    ).resolves.toBe('changed');
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.fk).toEqual({
      command: 'custom',
      args: ['custom-proxy'],
    });
  });

  it('refuses malformed JSON instead of replacing the client config', async () => {
    const path = await fixture();
    await writeFile(path, '{not json');

    await expect(
      installStdioServer(path, 'fk', { type: 'stdio', command: 'node', args: ['proxy'] }),
    ).rejects.toThrow('Could not read MCP config');
    await expect(readFile(path, 'utf8')).resolves.toBe('{not json');
  });
});
