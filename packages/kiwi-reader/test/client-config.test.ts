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

    await installStdioServer(path, 'fl', {
      type: 'stdio',
      command: 'C:\\Node\\node.exe',
      args: ['C:\\FigLens\\server\\stdio-proxy.mjs'],
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'dark',
      mcpServers: {
        existing: { command: 'other' },
        fl: {
          type: 'stdio',
          command: 'C:\\Node\\node.exe',
          args: ['C:\\FigLens\\server\\stdio-proxy.mjs'],
        },
      },
    });

    await expect(
      removeStdioServer(path, 'fl', {
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
          fl: { type: 'stdio', command: 'node-old', args: ['proxy-old'] },
        },
      }),
    );

    await installStdioServer(
      path,
      'fl',
      { type: 'stdio', command: 'node-new', args: ['proxy-new'] },
      { command: 'node-old', proxyPath: 'proxy-old' },
    );
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.fl).toEqual({
      type: 'stdio',
      command: 'node-new',
      args: ['proxy-new'],
    });
  });

  it('does not overwrite or remove a server changed by the user', async () => {
    const path = await fixture();
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { fl: { command: 'custom', args: ['custom-proxy'] } } }),
    );

    await expect(
      checkStdioServerInstall(path, 'fl', {
        type: 'stdio',
        command: 'node',
        args: ['proxy'],
      }),
    ).rejects.toThrow('is not owned by this installation');
    await expect(readFile(path, 'utf8')).resolves.toContain('custom-proxy');
    await expect(
      installStdioServer(path, 'fl', {
        type: 'stdio',
        command: 'node',
        args: ['proxy'],
      }),
    ).rejects.toThrow('is not owned by this installation');
    await expect(
      removeStdioServer(path, 'fl', { command: 'node', proxyPath: 'proxy' }),
    ).resolves.toBe('changed');
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.fl).toEqual({
      command: 'custom',
      args: ['custom-proxy'],
    });
  });

  it('refuses malformed JSON instead of replacing the client config', async () => {
    const path = await fixture();
    await writeFile(path, '{not json');

    await expect(
      installStdioServer(path, 'fl', { type: 'stdio', command: 'node', args: ['proxy'] }),
    ).rejects.toThrow('Could not read MCP config');
    await expect(readFile(path, 'utf8')).resolves.toBe('{not json');
  });

  it('migrates an owned fk entry to fl while preserving unrelated settings', async () => {
    const path = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        theme: 'dark',
        mcpServers: {
          fk: { command: 'old-node', args: ['old-proxy'] },
          other: { command: 'other-server' },
        },
      }),
    );
    const next = { type: 'stdio' as const, command: 'node', args: ['proxy'] };
    const previous = { name: 'fk', command: 'old-node', proxyPath: 'old-proxy' };

    await checkStdioServerInstall(path, 'fl', next, previous);
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.fk).toBeDefined();
    await installStdioServer(path, 'fl', next, previous);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'dark',
      mcpServers: { fl: next, other: { command: 'other-server' } },
    });
    await installStdioServer(path, 'fl', next, previous);
    await expect(
      removeStdioServer(path, 'fl', { command: 'node', proxyPath: 'proxy' }),
    ).resolves.toBe('removed');
  });

  it('preserves a foreign fk entry during migration', async () => {
    const path = await fixture();
    const foreign = { command: 'custom', args: ['custom-proxy'] };
    await writeFile(path, JSON.stringify({ mcpServers: { fk: foreign } }));
    await installStdioServer(
      path,
      'fl',
      { type: 'stdio', command: 'node', args: ['proxy'] },
      {
        name: 'fk',
        command: 'old-node',
        proxyPath: 'old-proxy',
      },
    );
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.fk).toEqual(foreign);
  });

  it('does not remove fk when fl is already owned by another server', async () => {
    const path = await fixture();
    const source = JSON.stringify({
      mcpServers: {
        fk: { command: 'old-node', args: ['old-proxy'] },
        fl: { command: 'other', args: ['other-proxy'] },
      },
    });
    await writeFile(path, source);
    await expect(
      installStdioServer(
        path,
        'fl',
        {
          type: 'stdio',
          command: 'node',
          args: ['proxy'],
        },
        { name: 'fk', command: 'old-node', proxyPath: 'old-proxy' },
      ),
    ).rejects.toThrow('is not owned by this installation');
    await expect(readFile(path, 'utf8')).resolves.toBe(source);
  });
});
