#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = resolve(root, 'artifacts');
const target = resolve(artifactsRoot, 'figlens');
const packageRoot = resolve(root, 'packages', 'kiwi-reader');

const assertInside = (parent, candidate) => {
  const path = relative(parent, candidate);
  if (path === '' || path.startsWith(`..${sep}`) || path === '..') {
    throw new Error(`Refusing to replace a path outside ${parent}: ${candidate}`);
  }
};

assertInside(artifactsRoot, target);

const manifest = JSON.parse(
  await readFile(join(packageRoot, 'extension', 'manifest.json'), 'utf8'),
);
const version = manifest.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('The extension manifest must contain a three-part numeric version.');
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

await Promise.all([
  cp(join(packageRoot, 'dist'), join(target, 'server'), { recursive: true }),
  cp(join(packageRoot, 'extension'), join(target, 'extension'), { recursive: true }),
  cp(join(packageRoot, 'release', 'codex-plugin'), join(target, 'codex-plugin'), {
    recursive: true,
  }),
  cp(join(packageRoot, 'release', 'install.ps1'), join(target, 'install.ps1')),
  cp(join(packageRoot, 'release', 'uninstall.ps1'), join(target, 'uninstall.ps1')),
  cp(join(root, 'README.ru.md'), join(target, 'README.ru.md')),
  cp(join(root, 'LICENSE'), join(target, 'LICENSE')),
]);

await writeFile(join(target, 'VERSION'), `${version}\n`, 'utf8');
console.log(`FigLens ${version} staged at ${target}`);
