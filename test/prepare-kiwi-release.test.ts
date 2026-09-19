import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bumpVersion, prepareKiwiRelease } from '../scripts/prepare-kiwi-release.mjs';

const roots: string[] = [];

async function fixture(extensionVersion = '0.3.1', pluginVersion = extensionVersion) {
  const root = await mkdtemp(join(tmpdir(), 'figwright-kiwi-release-'));
  roots.push(root);
  const extensionDir = join(root, 'packages/kiwi-reader/extension');
  const pluginDir = join(root, 'packages/kiwi-reader/release/codex-plugin/.codex-plugin');
  await Promise.all([
    mkdir(extensionDir, { recursive: true }),
    mkdir(pluginDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(extensionDir, 'manifest.json'),
      `{"manifest_version":3,"version":"${extensionVersion}","name":"Reader"}\n`,
    ),
    writeFile(join(pluginDir, 'plugin.json'), `{"name":"fk","version":"${pluginVersion}"}\n`),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Kiwi Reader release preparation', () => {
  it.each([
    ['patch', '0.3.2'],
    ['minor', '0.4.0'],
    ['major', '1.0.0'],
  ] as const)('applies a %s bump', (bump, expected) => {
    expect(bumpVersion('0.3.1', bump)).toBe(expected);
  });

  it('updates both manifests without rewriting unrelated fields', async () => {
    const root = await fixture();

    await expect(prepareKiwiRelease(root, 'patch')).resolves.toBe('0.3.2');

    const extension = await readFile(
      join(root, 'packages/kiwi-reader/extension/manifest.json'),
      'utf8',
    );
    const plugin = await readFile(
      join(root, 'packages/kiwi-reader/release/codex-plugin/.codex-plugin/plugin.json'),
      'utf8',
    );
    expect(extension).toBe('{"manifest_version":3,"version":"0.3.2","name":"Reader"}\n');
    expect(plugin).toBe('{"name":"fk","version":"0.3.2"}\n');
  });

  it('refuses to bump manifests that have drifted apart', async () => {
    const root = await fixture('0.3.1', '0.3.0');

    await expect(prepareKiwiRelease(root, 'patch')).rejects.toThrow(
      'Kiwi Reader versions do not match',
    );
  });
});
