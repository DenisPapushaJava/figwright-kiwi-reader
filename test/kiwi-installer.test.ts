import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const powershell = process.platform === 'win32' ? 'powershell.exe' : process.env.FIGLENS_TEST_PWSH;

describe.skipIf(!powershell)('FigLens installer migration', () => {
  it.each(['fresh', 'migrate', 'foreign', 'conflict', 'partial'])(
    'installs, updates and removes only owned entries: %s',
    async scenario => {
      const root = await mkdtemp(join(tmpdir(), 'figlens installer '));
      try {
        const result = await run(powershell!, [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve(import.meta.dirname, 'fixtures/kiwi-install.ps1'),
          '-RepoRoot',
          resolve(import.meta.dirname, '..'),
          '-TestRoot',
          root,
          '-NodePath',
          process.execPath,
          '-Scenario',
          scenario,
        ]);
        expect(result.stdout).toContain('FIGLENS_INSTALLER_OK');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
