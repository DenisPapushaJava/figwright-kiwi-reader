import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMPS = new Set(['patch', 'minor', 'major']);
const VERSION_PATHS = [
  'packages/kiwi-reader/extension/manifest.json',
  'packages/kiwi-reader/release/codex-plugin/.codex-plugin/plugin.json',
];

function parseVersion(version, source) {
  const match = SEMVER_RE.exec(version);
  if (!match) throw new Error(`${source} has an invalid version: ${version}`);
  return match.slice(1).map(Number);
}

export function bumpVersion(version, bump) {
  if (!BUMPS.has(bump)) throw new Error(`Unknown bump: ${bump}`);

  const [major, minor, patch] = parseVersion(version, 'Current Kiwi Reader version');
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function replaceVersion(source, current, next, path) {
  const versionProperty = /("version"\s*:\s*")([^"]+)(")/;
  const match = versionProperty.exec(source);
  if (!match) throw new Error(`${path} has no version property`);
  if (match[2] !== current) {
    throw new Error(`${path} changed while preparing the release`);
  }
  return source.replace(versionProperty, `$1${next}$3`);
}

export async function prepareKiwiRelease(repoRoot, bump) {
  const files = await Promise.all(
    VERSION_PATHS.map(async path => {
      const absolutePath = join(repoRoot, path);
      const source = await readFile(absolutePath, 'utf8');
      const parsed = JSON.parse(source);
      if (typeof parsed.version !== 'string') {
        throw new Error(`${path} has no string version`);
      }
      parseVersion(parsed.version, path);
      return { absolutePath, path, source, version: parsed.version };
    }),
  );

  const versions = new Set(files.map(file => file.version));
  if (versions.size !== 1) {
    throw new Error(
      `Kiwi Reader versions do not match: ${files.map(file => `${file.path}=${file.version}`).join(', ')}`,
    );
  }

  const current = files[0].version;
  const next = bumpVersion(current, bump);
  await Promise.all(
    files.map(file =>
      writeFile(file.absolutePath, replaceVersion(file.source, current, next, file.path), 'utf8'),
    ),
  );
  return next;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const bump = process.argv[2];
  if (!bump || process.argv.length !== 3) {
    console.error('Usage: node scripts/prepare-kiwi-release.mjs <patch|minor|major>');
    process.exit(1);
  }

  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    console.log(await prepareKiwiRelease(repoRoot, bump));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
